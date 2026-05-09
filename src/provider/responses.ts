import vscode from 'vscode';
import type { CancellationToken } from 'vscode';
import type sharp from 'sharp';
import { getApiModelId, getToolOutputCompressionSettings } from '../config';
import type { ToolImageOutputFormat, ToolOutputCompressionSettings } from '../config';
import { t } from '../i18n';
import { logger } from '../logger';
import { updateStatusBarFromUsage } from '../statusBar';
import type {
	DeepSeekToolCall,
	ModelDefinition,
	ResponsesFunctionCallItem,
	ResponsesInputItem,
	ResponsesMessageContentPart,
	ResponsesRequest,
	ResponsesTool,
	StreamCallbacks,
	UserModelConfig,
} from '../types';
import { AUTOPILOT_COMPAT_PROMPT } from './convert';

type ResponsesConfigurationSchema = { readonly properties: Record<string, unknown> };
type ResponsesVerbosity = 'low' | 'medium' | 'high';
type ResponsesReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

type ResponsesModelConfigurationOptions = vscode.ProvideLanguageModelChatResponseOptions & {
	readonly modelConfiguration?: Record<string, unknown>;
	readonly configuration?: Record<string, unknown>;
};

type HandleResponsesChatRequestArgs = {
	baseUrl: string;
	apiKey: string;
	modelInfo: vscode.LanguageModelChatInformation;
	modelDef?: ModelDefinition;
	userModelDef?: UserModelConfig;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	options: vscode.ProvideLanguageModelChatResponseOptions;
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	token: vscode.CancellationToken;
	maxTokens: number | undefined;
	thinkingEffort: string | undefined;
	unsupportedPreviousResponseIdBaseUrls: Set<string>;
	previousResponseIdsByConversation: Map<string, string>;
	reportedCompressionNotices: Set<string>;
	updateCharsPerToken: (observedRatio: number) => void;
};

type ResponsesStreamState = {
	pendingToolCalls: Map<number, DeepSeekToolCall>;
	emittedTextKeys: Set<string>;
	emittedReasoningKeys: Set<string>;
	emittedToolCallKeys: Set<string>;
	currentThinkingId: string | null;
	thinkingBuffer: string;
	thinkingFlushTimer: NodeJS.Timeout | null;
	hasEmittedThinking: boolean;
	hasEmittedAssistantText: boolean;
	emittedBeginToolCallsHint: boolean;
	reasoningEventCount: number;
	textEventCount: number;
	toolEventCount: number;
	unknownEventTypes: Set<string>;
	usedNonStreamFallback: boolean;
};

type ResponsesStatefulMarkerLocation = {
	marker: string;
	index: number;
};

type ResponsesConversationState = {
	key: string;
	previousResponseId?: string;
	markerIndex?: number;
	source: 'marker' | 'memory' | 'none';
};

type ToolOutputCompressionStats = {
	imageOutputsTranscoded: number;
	imageOutputsCompressed: number;
	imageBytesCompressed: number;
	imageBytesAfterCompression: number;
	imageOutputsOmitted: number;
	toolOutputsTruncated: number;
	toolCharsOmitted: number;
	structuredOutputsSummarized: number;
};

type ToolImageResult = {
	mimeType: string;
	dataUrl: string;
	originalBytes: number;
	compressedBytes: number;
	compressed: boolean;
	note: string;
};

type ToolOutputCollectionResult = {
	text: string;
	images: ToolImageResult[];
	stats: ToolOutputCompressionStats;
};

type ToolOutputPolicy = {
	maxChars: number;
	headRatio: number;
};

type EncodedToolImageFormat = Exclude<ToolImageOutputFormat, 'auto'>;
type SharpModule = typeof sharp;

type ToolImageEncodingAttempt = {
	label: string;
	maxEdge?: number;
	quality: number;
};

type EffectiveToolOutputCompressionSettings = ToolOutputCompressionSettings & {
	effectiveCompressImages: boolean;
	effectiveTruncateLongToolOutputs: boolean;
	effectiveSummarizeStructuredOutputs: boolean;
	effectiveUseToolTypePolicies: boolean;
	effectiveShowCompressionNotice: boolean;
};

type StructuredToolOutputSummary = {
	text: string;
	summarized: boolean;
};

type ResponsesMessagesConversion = {
	input: ResponsesInputItem[];
	instructions?: string;
	compressionStats: ToolOutputCompressionStats;
};

const RESPONSES_STATEFUL_MARKER_MIME = 'application/vnd.mimo-copilot.responses-stateful-marker';
const INCLUDE_RESPONSES_REASONING_IN_REQUEST = false;
const LOG_RESPONSE_BODY_MAX = 1200;
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 8000;
const TRANSIENT_NOTICE_PREFIX = '\u2063MiMo 提示：';
let sharpModulePromise: Promise<SharpModule | undefined> | undefined;

async function getSharpModule(): Promise<SharpModule | undefined> {
	sharpModulePromise ??= import('sharp')
		.then((module) => module.default ?? module as unknown as SharpModule)
		.catch((error) => {
			logger.warn('[Responses] sharp is unavailable; image tool outputs will be omitted instead of compressed', error);
			return undefined;
		});
	return sharpModulePromise;
}

function resolveToolOutputCompressionSettings(): EffectiveToolOutputCompressionSettings {
	const settings = getToolOutputCompressionSettings();
	return {
		...settings,
		effectiveCompressImages: settings.enabled && settings.compressImages,
		effectiveTruncateLongToolOutputs: settings.enabled && settings.truncateLongToolOutputs,
		effectiveSummarizeStructuredOutputs: settings.enabled && settings.summarizeStructuredOutputs,
		effectiveUseToolTypePolicies: settings.enabled && settings.truncateLongToolOutputs && settings.useToolTypePolicies,
		effectiveShowCompressionNotice: settings.enabled && settings.showCompressionNotice,
	};
}

function getToolOutputPolicy(
	toolName: string | undefined,
	settings: EffectiveToolOutputCompressionSettings,
): ToolOutputPolicy {
	if (!settings.effectiveTruncateLongToolOutputs) {
		return { maxChars: Number.MAX_SAFE_INTEGER, headRatio: 0.45 };
	}
	const defaultPolicy = { maxChars: settings.maxToolOutputChars, headRatio: 0.45 };
	if (!settings.effectiveUseToolTypePolicies) {
		return defaultPolicy;
	}
	const normalized = toolName?.toLowerCase() ?? '';
	if (normalized === 'run_in_terminal' || normalized === 'get_terminal_output') {
		return { maxChars: Math.max(settings.maxToolOutputChars, 12000), headRatio: 0.25 };
	}
	if (normalized === 'get_errors' || normalized.includes('diagnostic')) {
		return { maxChars: Math.max(settings.maxToolOutputChars, 20000), headRatio: 0.3 };
	}
	if (normalized === 'read_file' || normalized === 'grep_search' || normalized === 'semantic_search') {
		return { maxChars: Math.max(settings.maxToolOutputChars, 12000), headRatio: 0.5 };
	}
	if (normalized === 'apply_patch' || normalized === 'create_file' || normalized === 'edit_notebook_file') {
		return { maxChars: Math.max(settings.maxToolOutputChars, 10000), headRatio: 0.45 };
	}
	return defaultPolicy;
}

function createEmptyToolOutputCompressionStats(): ToolOutputCompressionStats {
	return {
		imageOutputsTranscoded: 0,
		imageOutputsCompressed: 0,
		imageBytesCompressed: 0,
		imageBytesAfterCompression: 0,
		imageOutputsOmitted: 0,
		toolOutputsTruncated: 0,
		toolCharsOmitted: 0,
		structuredOutputsSummarized: 0,
	};
}

function addToolOutputCompressionStats(
	target: ToolOutputCompressionStats,
	source: ToolOutputCompressionStats,
): void {
	target.imageOutputsCompressed += source.imageOutputsCompressed;
	target.imageOutputsTranscoded += source.imageOutputsTranscoded;
	target.imageBytesCompressed += source.imageBytesCompressed;
	target.imageBytesAfterCompression += source.imageBytesAfterCompression;
	target.imageOutputsOmitted += source.imageOutputsOmitted;
	target.toolOutputsTruncated += source.toolOutputsTruncated;
	target.toolCharsOmitted += source.toolCharsOmitted;
	target.structuredOutputsSummarized += source.structuredOutputsSummarized;
}

function hasToolOutputCompression(stats: ToolOutputCompressionStats): boolean {
	return stats.imageOutputsTranscoded > 0
		|| stats.imageOutputsCompressed > 0
		|| stats.imageOutputsOmitted > 0
		|| stats.toolOutputsTruncated > 0
		|| stats.structuredOutputsSummarized > 0;
}

function estimateToolOutputCompressionSavedChars(stats: ToolOutputCompressionStats): number {
	const imageBytesSaved = Math.max(0, stats.imageBytesCompressed - stats.imageBytesAfterCompression);
	return stats.toolCharsOmitted + Math.ceil(imageBytesSaved * 4 / 3);
}

function formatByteSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	const kib = bytes / 1024;
	if (kib < 1024) {
		return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
	}
	const mib = kib / 1024;
	return `${mib.toFixed(mib >= 10 ? 1 : 2)} MB`;
}

function formatToolOutputCompressionNotice(stats: ToolOutputCompressionStats): string | undefined {
	if (!hasToolOutputCompression(stats)) {
		return undefined;
	}

	const parts: string[] = [];
	const forcedParts: string[] = [];
	if (stats.imageOutputsTranscoded > 0) {
		parts.push(
			`图片转码 ${stats.imageOutputsTranscoded} 次`
			+ `（${formatByteSize(stats.imageBytesCompressed)} → ${formatByteSize(stats.imageBytesAfterCompression)}）`,
		);
	}
	if (stats.imageOutputsCompressed > 0) {
		parts.push(
			`图片缩放压缩 ${stats.imageOutputsCompressed} 次`
			+ `（${formatByteSize(stats.imageBytesCompressed)} → ${formatByteSize(stats.imageBytesAfterCompression)}）`,
		);
	}
	if (stats.imageOutputsOmitted > 0) {
		parts.push(`图片移除 ${stats.imageOutputsOmitted} 次`);
		forcedParts.push(`**MiMo: ${stats.imageOutputsOmitted} 张图片过大，已被 mimo-for-copilot 移除，未发送给模型。**`);
	}
	if (stats.structuredOutputsSummarized > 0) {
		parts.push(`结构化摘要 ${stats.structuredOutputsSummarized} 次`);
	}
	if (stats.toolOutputsTruncated > 0) {
		parts.push(
			`长输出截断 ${stats.toolOutputsTruncated} 次`
			+ `（-${stats.toolCharsOmitted} 字符）`,
		);
	}

	return `${TRANSIENT_NOTICE_PREFIX}${[...forcedParts, parts.join(' · ')].filter(Boolean).join(' · ')}\n\n`;
}

function formatForcedToolOutputCompressionNotice(stats: ToolOutputCompressionStats): string | undefined {
	if (stats.imageOutputsOmitted <= 0) {
		return undefined;
	}
	return `${TRANSIENT_NOTICE_PREFIX}**MiMo: ${stats.imageOutputsOmitted} 张图片过大，已被 mimo-for-copilot 移除，未发送给模型。**\n\n`;
}

function stripTransientNoticeText(text: string): string {
	if (!text) {
		return text;
	}
	return text
		.replace(/^\u2063MiMo 提示：.*(?:\r?\n){0,2}/gm, '')
		.replace(/^(\s*\r?\n){3,}/gm, '\n\n')
		.trim();
}

function getToolOutputCompressionNoticeKey(stats: ToolOutputCompressionStats): string {
	return [
		stats.imageOutputsTranscoded,
		stats.imageOutputsCompressed,
		Math.round(stats.imageBytesCompressed / 1024),
		Math.round(stats.imageBytesAfterCompression / 1024),
		stats.imageOutputsOmitted,
		stats.toolOutputsTruncated,
		Math.round(stats.toolCharsOmitted / 1000),
		stats.structuredOutputsSummarized,
	].join(':');
}

function previewText(text: string, maxLength = 100): string {
	const normalized = text.replace(/\s+/g, ' ').trim();
	if (!normalized) {
		return '';
	}
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function generateResponsesItemId(prefix: string): string {
	return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function previewJson(value: unknown, maxLength = LOG_RESPONSE_BODY_MAX): string {
	try {
		const json = JSON.stringify(value);
		return json.length > maxLength ? `${json.slice(0, maxLength)}…` : json;
	} catch {
		return '[unserializable]';
	}
}

function summarizeResponsesRequest(request: ResponsesRequest): Record<string, unknown> {
	const itemTypes: Record<string, number> = {};
	const messageStatuses: Record<string, number> = {};
	let functionCalls = 0;
	let functionOutputs = 0;
	let reasoningItems = 0;
	let imageParts = 0;
	let textChars = 0;

	for (const item of request.input) {
		itemTypes[item.type] = (itemTypes[item.type] ?? 0) + 1;
		if (item.type === 'message') {
			if (item.status) {
				messageStatuses[item.status] = (messageStatuses[item.status] ?? 0) + 1;
			}
			for (const part of item.content) {
				if (part.type === 'input_image') {
					imageParts += 1;
				}
				textChars += part.text?.length ?? 0;
			}
			continue;
		}
		if (item.type === 'function_call') {
			functionCalls += 1;
			textChars += item.name.length + item.arguments.length;
			continue;
		}
		if (item.type === 'function_call_output') {
			functionOutputs += 1;
			textChars += item.output.length;
			continue;
		}
		reasoningItems += 1;
		for (const summary of item.summary) {
			textChars += summary.text.length;
		}
	}

	return {
		model: request.model,
		stream: request.stream,
		inputItems: request.input.length,
		itemTypes,
		messageStatuses,
		functionCalls,
		functionOutputs,
		reasoningItems,
		imageParts,
		textChars,
		instructionsChars: request.instructions?.length ?? 0,
		hasTools: !!request.tools?.length,
		toolCount: request.tools?.length ?? 0,
		toolChoice: request.tool_choice,
		hasReasoning: !!request.reasoning,
		reasoning: request.reasoning,
		hasTextConfig: !!request.text,
		text: request.text,
		hasPreviousResponseId: !!request.previous_response_id,
		hasPromptCacheKey: !!request.prompt_cache_key,
	};
}

function sanitizeResponsesRequestForLog(request: ResponsesRequest): Record<string, unknown> {
	return {
		...request,
		input: request.input.map((item) => {
			if (item.type === 'message') {
				return {
					...item,
					content: item.content.map((part) => ({
						...part,
						text: part.text ? previewText(part.text, 240) : undefined,
						image_url: part.image_url ? `[image:${part.image_url.length} chars]` : undefined,
					})),
				};
			}
			if (item.type === 'function_call') {
				return {
					...item,
					arguments: previewText(item.arguments, 500),
				};
			}
			if (item.type === 'function_call_output') {
				return {
					...item,
					output: previewText(item.output, 500),
				};
			}
			return {
				...item,
				summary: item.summary.map((summary) => ({
					...summary,
					text: previewText(summary.text, 240),
				})),
			};
		}),
		instructions: request.instructions ? previewText(request.instructions, 500) : undefined,
		tools: request.tools?.map((tool) => ({
			...tool,
			description: tool.description ? previewText(tool.description, 160) : undefined,
		})),
	};
}

function isToolResultPartLike(value: unknown): value is { callId: string; content?: readonly unknown[] } {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const record = value as Record<string, unknown>;
	return typeof record.callId === 'string' && 'content' in record;
}

function summarizeStructuredToolOutput(
	value: unknown,
	settings: EffectiveToolOutputCompressionSettings,
): StructuredToolOutputSummary | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	if (!settings.effectiveSummarizeStructuredOutputs) {
		try {
			return { text: JSON.stringify(value), summarized: false };
		} catch {
			return undefined;
		}
	}
	let summarized = false;
	try {
		const summary = JSON.stringify(value, (_key, nestedValue) => {
			if (typeof nestedValue === 'string' && nestedValue.length > 500) {
				summarized = true;
				return `${nestedValue.slice(0, 240)}…[${nestedValue.length - 480} chars omitted]…${nestedValue.slice(-240)}`;
			}
			if (Array.isArray(nestedValue) && nestedValue.length > 8) {
				summarized = true;
				return [
					...nestedValue.slice(0, 4),
					`[${nestedValue.length - 8} array items omitted]`,
					...nestedValue.slice(-4),
				];
			}
			return nestedValue;
		});
		if (summary.length > settings.maxToolOutputChars) {
			summarized = true;
			const half = Math.floor(settings.maxToolOutputChars / 2);
			return {
				text: `${summary.slice(0, half)}\n[structured tool output summarized by mimo-for-copilot]\n${summary.slice(-half)}`,
				summarized,
			};
		}
		return { text: summary, summarized };
	} catch {
		return undefined;
	}
}

async function compressToolImage(
	item: vscode.LanguageModelDataPart,
	settings: EffectiveToolOutputCompressionSettings,
): Promise<ToolImageResult | undefined> {
	const originalBytes = item.data.byteLength;
	const originalBuffer = Buffer.from(item.data);
	if (!settings.effectiveCompressImages && !settings.keepOriginalImagesWhenDisabled) {
		return undefined;
	}
	if (!settings.effectiveCompressImages || originalBytes <= settings.smallToolImageBytes) {
		return {
			mimeType: item.mimeType,
			dataUrl: `data:${item.mimeType};base64,${originalBuffer.toString('base64')}`,
			originalBytes,
			compressedBytes: originalBytes,
			compressed: false,
			note: settings.effectiveCompressImages ? 'kept original small tool image' : 'kept original tool image; image compression disabled',
		};
	}

	const sharp = await getSharpModule();
	if (!sharp) {
		return undefined;
	}

	let metadata: sharp.Metadata | undefined;
	try {
		metadata = await sharp(originalBuffer, { failOn: 'none' }).metadata();
	} catch {
		metadata = undefined;
	}

	const formatCandidates = getToolImageFormatCandidates(item.mimeType, metadata, settings.imageOutputFormat);
	const hasAlpha = !!metadata?.hasAlpha;
	let lastError: unknown;

	for (const format of formatCandidates) {
		try {
			const output = await encodeToolImageVariant(
				originalBuffer,
				sharp,
				format,
				{ label: 'convert-only', quality: settings.primaryImageQuality },
				hasAlpha,
			);
			if (output.byteLength <= settings.maxCompressedImageBytes && output.byteLength < originalBytes) {
				return {
					mimeType: getToolImageMimeType(format),
					dataUrl: `data:${getToolImageMimeType(format)};base64,${output.toString('base64')}`,
					originalBytes,
					compressedBytes: output.byteLength,
					compressed: true,
					note: `converted tool image format=${format} quality=${settings.primaryImageQuality} without resize`,
				};
			}
		} catch (error) {
			lastError = error;
		}
	}

	if (originalBytes <= settings.maxCompressedImageBytes) {
		return {
			mimeType: item.mimeType,
			dataUrl: `data:${item.mimeType};base64,${originalBuffer.toString('base64')}`,
			originalBytes,
			compressedBytes: originalBytes,
			compressed: false,
			note: 'kept original tool image; format conversion did not reduce size and original already fit target budget',
		};
	}

	for (const attempt of [
		{ label: 'primary-resize', maxEdge: settings.primaryImageMaxEdge, quality: settings.primaryImageQuality },
		{ label: 'fallback-resize', maxEdge: settings.fallbackImageMaxEdge, quality: settings.fallbackImageQuality },
	] satisfies ToolImageEncodingAttempt[]) {
		for (const format of formatCandidates) {
			try {
				const output = await encodeToolImageVariant(originalBuffer, sharp, format, attempt, hasAlpha);
				if (output.byteLength <= settings.maxCompressedImageBytes) {
					return {
						mimeType: getToolImageMimeType(format),
						dataUrl: `data:${getToolImageMimeType(format)};base64,${output.toString('base64')}`,
						originalBytes,
						compressedBytes: output.byteLength,
						compressed: true,
						note: `compressed tool image stage=${attempt.label} format=${format} maxEdge=${attempt.maxEdge} quality=${attempt.quality}`,
					};
				}
			} catch (error) {
				lastError = error;
			}
		}
	}

	if (lastError) {
		logger.warn(`[Responses] tool image compression failed mime=${item.mimeType} bytes=${originalBytes}`, lastError);
	}

	return undefined;
}

function getToolImageFormatCandidates(
	mimeType: string,
	metadata: sharp.Metadata | undefined,
	preferredFormat: ToolImageOutputFormat,
): EncodedToolImageFormat[] {
	if (preferredFormat === 'jpeg' || preferredFormat === 'webp' || preferredFormat === 'png') {
		return [preferredFormat];
	}
	const normalizedMime = mimeType.toLowerCase();
	if (metadata?.hasAlpha || normalizedMime === 'image/png') {
		return ['webp', 'jpeg', 'png'];
	}
	if (normalizedMime === 'image/webp') {
		return ['webp', 'jpeg'];
	}
	return ['jpeg', 'webp'];
}

function getToolImageMimeType(format: EncodedToolImageFormat): string {
	switch (format) {
		case 'jpeg':
			return 'image/jpeg';
		case 'webp':
			return 'image/webp';
		case 'png':
			return 'image/png';
	}
}

async function encodeToolImageVariant(
	originalBuffer: Buffer,
	sharp: SharpModule,
	format: EncodedToolImageFormat,
	attempt: ToolImageEncodingAttempt,
	hasAlpha: boolean,
): Promise<Buffer> {
	let pipeline = sharp(originalBuffer, { failOn: 'none' }).rotate();
	if (attempt.maxEdge) {
		pipeline = pipeline.resize({
			width: attempt.maxEdge,
			height: attempt.maxEdge,
			fit: 'inside',
			withoutEnlargement: true,
		});
	}
	switch (format) {
		case 'jpeg':
			if (hasAlpha) {
				pipeline = pipeline.flatten({ background: '#ffffff' });
			}
			return pipeline.jpeg({ quality: attempt.quality, mozjpeg: true }).toBuffer();
		case 'webp':
			return pipeline.webp({ quality: attempt.quality, alphaQuality: attempt.quality, effort: 6 }).toBuffer();
		case 'png':
			return pipeline.png({
				compressionLevel: 9,
				palette: true,
				quality: attempt.quality,
				effort: 8,
				adaptiveFiltering: true,
			}).toBuffer();
	}
}

async function collectToolResultText(
	part: { content?: readonly unknown[] },
	toolName?: string,
	settings = resolveToolOutputCompressionSettings(),
): Promise<ToolOutputCollectionResult> {
	let text = '';
	const images: ToolImageResult[] = [];
	const stats = createEmptyToolOutputCompressionStats();
	const policy = getToolOutputPolicy(toolName, settings);
	for (const item of part.content ?? []) {
		if (item instanceof vscode.LanguageModelTextPart) {
			text += item.value;
			continue;
		}
		if (typeof item === 'string') {
			text += item;
			continue;
		}
		if (item instanceof vscode.LanguageModelDataPart) {
			if (item.mimeType === 'cache_control') {
				continue;
			}
			if (item.mimeType.startsWith('image/')) {
				const compressed = await compressToolImage(item, settings);
				if (compressed) {
					images.push(compressed);
					if (compressed.compressed) {
						if (compressed.note.startsWith('converted tool image')) {
							stats.imageOutputsTranscoded += 1;
						} else {
							stats.imageOutputsCompressed += 1;
						}
						stats.imageBytesCompressed += compressed.originalBytes;
						stats.imageBytesAfterCompression += compressed.compressedBytes;
					}
					text += `[${item.mimeType} tool image ${compressed.note}; original=${compressed.originalBytes} bytes; sent=${compressed.compressedBytes} bytes as ${compressed.mimeType}]`;
				} else {
					stats.imageOutputsOmitted += 1;
					stats.imageBytesCompressed += item.data.byteLength;
					text += `[${item.mimeType} tool image omitted after compression attempts: ${item.data.byteLength} bytes]`;
				}
				continue;
			}
		}
		const structuredSummary = summarizeStructuredToolOutput(item, settings);
		if (structuredSummary) {
			if (structuredSummary.summarized) {
				stats.structuredOutputsSummarized += 1;
			}
			text += structuredSummary.text;
			continue;
		}
		try {
			text += JSON.stringify(item);
		} catch {
			// Ignore non-serializable tool output fragments.
		}
	}
	const truncated = truncateToolOutput(text, policy);
	addToolOutputCompressionStats(stats, truncated.stats);
	return {
		text: truncated.text,
		images,
		stats,
	};
}

function truncateToolOutput(
	text: string,
	policy: ToolOutputPolicy = { maxChars: DEFAULT_MAX_TOOL_OUTPUT_CHARS, headRatio: 0.45 },
): ToolOutputCollectionResult {
	const stats = createEmptyToolOutputCompressionStats();
	if (text.length <= policy.maxChars) {
		return { text, images: [], stats };
	}
	const omittedChars = text.length - policy.maxChars;
	const headChars = Math.floor(policy.maxChars * policy.headRatio);
	const tailChars = policy.maxChars - headChars;
	stats.toolOutputsTruncated = 1;
	stats.toolCharsOmitted = omittedChars;
	return {
		text: `${text.slice(0, headChars)}`
			+ `\n\n[tool output truncated by mimo-for-copilot: ${omittedChars} chars omitted; showing first ${headChars} and last ${tailChars} chars]\n\n`
			+ text.slice(-tailChars),
		images: [],
		stats,
	};
}

class ResponsesHttpError extends Error {
	constructor(
		readonly status: number,
		readonly responseText: string,
	) {
		super(`OpenAI Responses API error (${status}): ${parseResponsesError(responseText)}`);
		this.name = 'ResponsesHttpError';
	}
}

export function buildResponsesConfigurationSchema(modelId: string): ResponsesConfigurationSchema {
	const isLitePreset = modelId === 'gpt-5.5';
	return {
		properties: {
			reasoningEffort: {
				type: 'string',
				title: t('status.thinking'),
				enum: ['none', 'low', 'medium', 'high', 'xhigh'],
				enumItemLabels: [t('thinking.none'), t('thinking.low'), t('thinking.medium'), t('thinking.high'), t('thinking.xhigh')],
				enumDescriptions: [
					t('thinking.none.desc'),
					t('thinking.low.desc'),
					t('thinking.medium.desc'),
					t('thinking.high.desc'),
					t('thinking.xhigh.desc'),
				],
				default: isLitePreset ? 'medium' : 'none',
				group: 'navigation',
			},
			verbosity: {
				type: 'string',
				title: t('responses.verbosity.title'),
				enum: ['low', 'medium', 'high'],
				enumItemLabels: [t('responses.verbosity.low'), t('responses.verbosity.medium'), t('responses.verbosity.high')],
				default: isLitePreset ? 'medium' : 'high',
				group: 'navigation',
			},
		},
	} as const;
}

export function getConfiguredResponsesVerbosity(
	options: ResponsesModelConfigurationOptions,
	modelId: string,
): ResponsesVerbosity | undefined {
	const configuredVerbosity = options.modelConfiguration?.verbosity ?? options.configuration?.verbosity;
	if (configuredVerbosity === 'low' || configuredVerbosity === 'medium' || configuredVerbosity === 'high') {
		return configuredVerbosity;
	}
	return modelId === 'gpt-5.5' ? 'medium' : undefined;
}

export function normalizeResponsesEffort(
	modelId: string,
	effort: string | undefined,
): ResponsesReasoningEffort {
	if (effort === 'on' || effort === 'off') {
		return effort === 'off' ? 'none' : 'medium';
	}
	if (effort === 'max') {
		return 'high';
	}
	if (effort === 'none' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') {
		return effort;
	}
	return modelId === 'gpt-5.5' ? 'medium' : 'none';
}

function getResponsesReasoningSummary(
	effort: ResponsesReasoningEffort,
): 'auto' | 'concise' | 'detailed' {
	if (effort === 'none') {
		return 'auto';
	}
	return 'auto';
}

export async function handleResponsesChatRequest(args: HandleResponsesChatRequestArgs): Promise<void> {
	const isThinkingModel = args.modelDef?.capabilities.thinking ?? args.userModelDef?.thinking ?? false;
	const needsThinkingParam = args.modelDef?.requiresThinkingParam ?? args.userModelDef?.requiresThinkingParam ?? true;
	const userTemp = args.userModelDef?.temperature ?? args.modelDef?.temperature;
	const userTopP = args.userModelDef?.topP ?? args.modelDef?.topP;
	const statefulModelId = getApiModelId(args.modelInfo.id);
	const normalizedBaseUrl = args.baseUrl.replace(/\/+$/, '');
	const fullMessages = await convertResponsesMessages(args.messages);
	const marker = findLastResponsesStatefulMarker(statefulModelId, args.messages);
	const conversationState = resolveResponsesConversationState(
		statefulModelId,
		normalizedBaseUrl,
		args.messages,
		marker,
		args.previousResponseIdsByConversation,
	);
	let deltaMessages: ResponsesMessagesConversion | undefined;
	if (conversationState.markerIndex !== undefined && conversationState.markerIndex >= 0 && conversationState.markerIndex < args.messages.length - 1) {
		deltaMessages = await convertResponsesMessages(args.messages.slice(conversationState.markerIndex + 1));
	} else if (conversationState.previousResponseId && args.messages.length > 0) {
		deltaMessages = await convertResponsesMessages(args.messages.slice(-1));
	}
	const canUsePreviousResponseId =
		!!conversationState.previousResponseId
		&& !args.unsupportedPreviousResponseIdBaseUrls.has(normalizedBaseUrl)
		&& !!deltaMessages
		&& deltaMessages.input.length > 0;
	logger.debug(
		`[Responses] stateful source=${conversationState.source}`
		+ ` hasPrevious=${conversationState.previousResponseId ? 'yes' : 'no'}`
		+ ` markerIndex=${conversationState.markerIndex ?? 'n/a'}`
		+ ` deltaItems=${deltaMessages?.input.length ?? 0}`,
	);
	const requestMessages = canUsePreviousResponseId && deltaMessages
		? {
			input: deltaMessages.input,
			instructions: deltaMessages.instructions ?? fullMessages.instructions,
			compressionStats: deltaMessages.compressionStats,
		}
		: fullMessages;
	const responsesTools = convertResponsesTools(args.options.tools);
	const isAutopilotLike = args.options.tools?.some((tool) => tool.name === 'task_complete') ?? false;
	const requestInstructions = isAutopilotLike
		? [AUTOPILOT_COMPAT_PROMPT, requestMessages.instructions].filter(Boolean).join('\n\n')
		: requestMessages.instructions;
	const requestChars = countResponsesRequestChars(requestMessages.input, requestInstructions);
	const responsesVerbosity = getConfiguredResponsesVerbosity(
		args.options as ResponsesModelConfigurationOptions,
		args.modelInfo.id,
	);
	const normalizedEffort = normalizeResponsesEffort(args.modelInfo.id, args.thinkingEffort);
	const compressionSettings = resolveToolOutputCompressionSettings();
	const client = new ResponsesClient(args.baseUrl, args.apiKey);
	let currentThinkingId: string | null = null;

	const reportThinkingChunk = (text: string) => {
		if (!text) {
			if (!currentThinkingId) {
				return;
			}
			args.progress.report(
				new vscode.LanguageModelThinkingPart('', currentThinkingId) as unknown as vscode.LanguageModelResponsePart,
			);
			currentThinkingId = null;
			return;
		}

		if (!currentThinkingId) {
			currentThinkingId = generateThinkingId();
		}

		args.progress.report(
			new vscode.LanguageModelThinkingPart(text, currentThinkingId) as unknown as vscode.LanguageModelResponsePart,
		);
	};

	const buildRequest = (input: ResponsesInputItem[], instructions?: string, previousResponseId?: string): ResponsesRequest => ({
		model: getApiModelId(args.modelInfo.id),
		input,
		stream: true,
		prompt_cache_key: `mimo-copilot-${statefulModelId}`,
		...(instructions ? { instructions } : {}),
		...(typeof args.maxTokens === 'number' && args.maxTokens > 0 ? { max_output_tokens: args.maxTokens } : {}),
		...(userTemp !== undefined ? { temperature: userTemp } : {}),
		...(userTopP !== undefined ? { top_p: userTopP } : {}),
		...(responsesTools.tools
			? {
				tools: responsesTools.tools,
				tool_choice: responsesTools.toolChoice,
			}
			: {}),
		...(responsesVerbosity ? { text: { verbosity: responsesVerbosity } } : {}),
		...(isThinkingModel && needsThinkingParam
			? {
				reasoning: {
					effort: normalizedEffort,
					summary: getResponsesReasoningSummary(normalizedEffort),
				},
			}
			: {}),
		...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
	});

	let responseId: string | undefined;
	const streamWithCallbacks = async (
		request: ResponsesRequest,
		requestChars: number,
		stats: ToolOutputCompressionStats,
	): Promise<void> => {
		return new Promise<void>((resolve, reject) => {
			client.stream(
				request,
				{
					onContent: (content: string) => {
						args.progress.report(new vscode.LanguageModelTextPart(content));
					},
					onThinking: (text: string) => {
						reportThinkingChunk(text);
					},
					onToolCall: (toolCall: DeepSeekToolCall) => {
						try {
							const parsedArgs = JSON.parse(toolCall.function.arguments);
							args.progress.report(
								new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.function.name, parsedArgs),
							);
						} catch {
							args.progress.report(
								new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.function.name, {}),
							);
						}
					},
					onResponseId: (nextResponseId: string) => {
						responseId = nextResponseId;
					},
					onError: reject,
					onDone: () => {
						reportThinkingChunk('');
						resolve();
					},
					onUsage: (usage) => {
						let observedRatio = requestChars > 0 && usage.prompt_tokens > 0
							? requestChars / usage.prompt_tokens
							: undefined;
						if (typeof observedRatio === 'number' && Number.isFinite(observedRatio) && observedRatio > 0) {
							args.updateCharsPerToken(observedRatio);
						}
						const savedCharsEstimate = estimateToolOutputCompressionSavedChars(stats);
						const charsPerToken = observedRatio && Number.isFinite(observedRatio) && observedRatio > 0
							? observedRatio
							: 4;
						const beforePromptTokensEstimate = savedCharsEstimate > 0
							? usage.prompt_tokens + Math.ceil(savedCharsEstimate / charsPerToken)
							: undefined;
						updateStatusBarFromUsage(usage, args.modelInfo.maxInputTokens, {
							beforePromptTokensEstimate,
							afterPromptTokens: usage.prompt_tokens,
							ratio: beforePromptTokensEstimate
								? beforePromptTokensEstimate / Math.max(1, usage.prompt_tokens)
								: 1,
							description: beforePromptTokensEstimate ? 'Responses tool-output compression' : undefined,
							notice: 'Compression notices can be turned off in the Provider Configuration UI.',
						});
					},
				},
				args.token,
			);
		});
	};

	let request = buildRequest(
		requestMessages.input,
		requestInstructions,
		canUsePreviousResponseId ? conversationState.previousResponseId : undefined,
	);
	let reportedCompressionNotice = false;
	const reportCompressionNotice = (stats: ToolOutputCompressionStats) => {
		if (reportedCompressionNotice) {
			return;
		}
		const notice = formatToolOutputCompressionNotice(stats);
		if (!notice) {
			return;
		}
		const noticeKey = getToolOutputCompressionNoticeKey(stats);
		if (args.reportedCompressionNotices.has(noticeKey)) {
			reportedCompressionNotice = true;
			return;
		}
		args.reportedCompressionNotices.add(noticeKey);
		logger.info(
			`[Responses] tool output compression notice imageOutputs=${stats.imageOutputsCompressed}`
			+ ` imageBytes=${stats.imageBytesCompressed}`
			+ ` imageBytesAfter=${stats.imageBytesAfterCompression}`
			+ ` imageOmitted=${stats.imageOutputsOmitted}`
			+ ` truncatedOutputs=${stats.toolOutputsTruncated}`
			+ ` omittedChars=${stats.toolCharsOmitted}`
			+ ` structuredSummaries=${stats.structuredOutputsSummarized}`,
		);
		const visibleNotice = compressionSettings.effectiveShowCompressionNotice
			? notice
			: formatForcedToolOutputCompressionNotice(stats);
		if (visibleNotice) {
			args.progress.report(
				new vscode.LanguageModelTextPart(visibleNotice),
			);
		}
		reportedCompressionNotice = true;
	};

	try {
		reportCompressionNotice(requestMessages.compressionStats);
		await streamWithCallbacks(request, requestChars, requestMessages.compressionStats);
	} catch (error) {
		const shouldRetryWithoutPreviousResponseId =
			canUsePreviousResponseId
			&& error instanceof ResponsesHttpError
			&& error.status >= 400
			&& error.status < 500
			&& error.status !== 429;

		if (!shouldRetryWithoutPreviousResponseId) {
			throw error;
		}

		args.unsupportedPreviousResponseIdBaseUrls.add(normalizedBaseUrl);
		responseId = undefined;
		const fullInstructions = isAutopilotLike
			? [AUTOPILOT_COMPAT_PROMPT, fullMessages.instructions].filter(Boolean).join('\n\n')
			: fullMessages.instructions;
		request = buildRequest(fullMessages.input, fullInstructions);
		reportCompressionNotice(fullMessages.compressionStats);
		await streamWithCallbacks(
			request,
			countResponsesRequestChars(fullMessages.input, fullInstructions),
			fullMessages.compressionStats,
		);
	}

	if (responseId) {
		args.previousResponseIdsByConversation.set(conversationState.key, responseId);
		args.progress.report(
			createResponsesStatefulMarkerPart(statefulModelId, responseId) as unknown as vscode.LanguageModelResponsePart,
		);
	}
}

async function convertResponsesMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): Promise<ResponsesMessagesConversion> {
	const input: ResponsesInputItem[] = [];
	const instructionParts: string[] = [];
	const compressionStats = createEmptyToolOutputCompressionStats();
	const toolNamesByCallId = new Map<string, string>();
	const compressionSettings = resolveToolOutputCompressionSettings();

	for (const message of messages) {
		const textParts: string[] = [];
		const imageParts: vscode.LanguageModelDataPart[] = [];
		const toolCalls: DeepSeekToolCall[] = [];
		const toolResults: Array<{ callId: string; content: string; images: ToolImageResult[] }> = [];
		const thinkingParts: string[] = [];

		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				textParts.push(part.value);
			} else if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
				imageParts.push(part);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolNamesByCallId.set(part.callId, part.name);
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: {
						name: part.name,
						arguments: JSON.stringify(part.input ?? {}),
					},
				});
			} else if (isToolResultPartLike(part)) {
				const toolContent = await collectToolResultText(
					part,
					toolNamesByCallId.get(part.callId),
					compressionSettings,
				);
				addToolOutputCompressionStats(compressionStats, toolContent.stats);
				toolResults.push({
					callId: part.callId,
					content: toolContent.text || ' ',
					images: toolContent.images,
				});
			} else if (INCLUDE_RESPONSES_REASONING_IN_REQUEST && part instanceof vscode.LanguageModelThinkingPart) {
				const value = Array.isArray(part.value) ? part.value.join('') : part.value;
				thinkingParts.push(value);
			}
		}

		const text = textParts.join('').trim();
		const sanitizedText = stripTransientNoticeText(text);
		const thinking = thinkingParts.join('').trim();

		for (const toolResult of toolResults) {
			if (!toolResult.callId) {
				logger.warn('[Responses] skip tool result without callId');
				continue;
			}
			input.push({
				type: 'function_call_output',
				id: generateResponsesItemId('fco'),
				call_id: toolResult.callId,
				output: toolResult.content,
				status: 'completed',
			});
			if (toolResult.images.length > 0) {
				input.push({
					type: 'message',
					id: generateResponsesItemId('msg'),
					role: 'user',
					content: [
						{
							type: 'input_text',
							text: `Compressed image output for tool call ${toolResult.callId}.`,
						},
						...toolResult.images.map((image) => ({
							type: 'input_image' as const,
							image_url: image.dataUrl,
						})),
					],
					status: 'completed',
				});
			}
		}

		if (message.role === vscode.LanguageModelChatMessageRole.User) {
			const content: ResponsesMessageContentPart[] = [];
			if (sanitizedText) {
				content.push({ type: 'input_text', text: sanitizedText });
			}
			for (const imagePart of imageParts) {
				const dataUrl = `data:${imagePart.mimeType};base64,${Buffer.from(imagePart.data).toString('base64')}`;
				content.push({ type: 'input_image', image_url: dataUrl });
			}
			if (content.length > 0) {
				input.push({
					type: 'message',
					id: generateResponsesItemId('msg'),
					role: 'user',
					content,
					status: 'completed',
				});
			}
			continue;
		}

		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			if (sanitizedText) {
				input.push({
					type: 'message',
					id: generateResponsesItemId('msg'),
					role: 'assistant',
					content: [{ type: 'output_text', text: sanitizedText }],
					status: 'completed',
				});
			}
			if (thinking) {
				input.push({
					type: 'reasoning',
					id: generateResponsesItemId('tk'),
					summary: [{ type: 'summary_text', text: thinking }],
					status: 'completed',
				});
			}
			for (const toolCall of toolCalls) {
				input.push({
					type: 'function_call',
					id: generateResponsesItemId('fc'),
					call_id: toolCall.id,
					name: toolCall.function.name,
					arguments: toolCall.function.arguments,
					status: 'completed',
				});
			}
			continue;
		}

		if (sanitizedText) {
			instructionParts.push(sanitizedText);
		}
	}

	const lastItem = input[input.length - 1];
	if (lastItem?.type === 'message' && lastItem.role === 'user') {
		lastItem.status = 'incomplete';
	}

	const functionCallIds = new Set(
		input.filter((item) => item.type === 'function_call').map((item) => item.call_id),
	);
	const functionOutputIds = new Set(
		input.filter((item) => item.type === 'function_call_output').map((item) => item.call_id),
	);
	const missingOutputs = Array.from(functionCallIds).filter((callId) => !functionOutputIds.has(callId));
	if (missingOutputs.length > 0) {
		logger.warn(
			`[Responses] request history has function_call without function_call_output count=${missingOutputs.length}`
			+ ` callIds=${missingOutputs.slice(0, 5).join(',')}`,
		);
	}

	return {
		input,
		instructions: instructionParts.length > 0 ? instructionParts.join('\n\n') : undefined,
		compressionStats,
	};
}

function convertResponsesTools(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
): { tools?: ResponsesTool[]; toolChoice?: 'auto' | { type: 'function'; name: string } } {
	if (!tools || tools.length === 0) {
		return {};
	}

	return {
		tools: tools.map((tool) => ({
			type: 'function',
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema as Record<string, unknown> | undefined,
		})),
		toolChoice: 'auto',
	};
}

function countResponsesRequestChars(input: ResponsesInputItem[], instructions?: string): number {
	let total = instructions?.length ?? 0;

	for (const item of input) {
		if (item.type === 'message') {
			for (const part of item.content) {
				total += part.text?.length ?? 0;
			}
			continue;
		}

		if (item.type === 'reasoning') {
			for (const summary of item.summary) {
				total += summary.text?.length ?? 0;
			}
			continue;
		}

		if (item.type === 'function_call') {
			total += item.name.length + item.arguments.length;
			continue;
		}

		total += item.output.length;
	}

	return total;
}

class ResponsesClient {
	constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
	) {}

	async stream(
		request: ResponsesRequest,
		callbacks: StreamCallbacks,
		cancellationToken?: CancellationToken,
	): Promise<void> {
		const controller = new AbortController();
		let emittedResponsePart = false;
		let streamConnected = false;
		const cancelListener = cancellationToken?.onCancellationRequested(() => {
			controller.abort();
		});

		try {
			logger.debug(
				`[Responses] stream.start url=${this.baseUrl}/responses`
				+ ` model=${request.model} inputItems=${request.input.length}`
				+ ` previousResponseId=${request.previous_response_id ? 'yes' : 'no'}`
				+ ` reasoning=${request.reasoning ? JSON.stringify(request.reasoning) : 'none'}`,
			);
			logger.debug(`[Responses] request.summary mode=stream ${previewJson(summarizeResponsesRequest(request))}`);
			logger.debug(`[Responses] request.body mode=stream ${previewJson(sanitizeResponsesRequestForLog(request))}`);

			const response = await this.fetchWithRetry(request, controller.signal, 'stream');

			if (!response.ok) {
				const errorText = await response.text();
				logger.warn(
					`[Responses] stream.http_error status=${response.status}`
					+ ` statusText=${response.statusText}`
					+ ` body=${errorText.slice(0, LOG_RESPONSE_BODY_MAX)}`,
				);
				if (request.stream && shouldFallbackToNonStream(response.status, errorText)) {
					logger.warn(
						`[Responses] Streaming failed with ${response.status}; falling back to non-stream. ${errorText.slice(0, 200)}`,
					);
					await this.fetchWithoutStreaming({ ...request, stream: false }, callbacks, controller.signal);
					callbacks.onDone();
					return;
				}
				throw new ResponsesHttpError(response.status, errorText);
			}

			const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
			if (!contentType.includes('text/event-stream')) {
				logger.debug('[Responses] fallback.nonstream reason=content_type');
				logger.warn(
					`[Responses] Expected SSE but received ${contentType || 'unknown content type'}; using JSON fallback.`,
				);
				const responseJson = await response.json() as Record<string, unknown>;
				const state: ResponsesStreamState = {
					pendingToolCalls: new Map<number, DeepSeekToolCall>(),
					emittedTextKeys: new Set<string>(),
					emittedReasoningKeys: new Set<string>(),
					emittedToolCallKeys: new Set<string>(),
					currentThinkingId: null,
					thinkingBuffer: '',
					thinkingFlushTimer: null,
					hasEmittedThinking: false,
					hasEmittedAssistantText: false,
					emittedBeginToolCallsHint: false,
					reasoningEventCount: 0,
					textEventCount: 0,
					toolEventCount: 0,
					unknownEventTypes: new Set<string>(),
					usedNonStreamFallback: true,
				};
				this.emitJsonResponse(responseJson, callbacks);
				logResponsesSummary(state);
				callbacks.onDone();
				return;
			}

			if (!response.body) {
				throw new Error('No response body received');
			}
			streamConnected = true;
			logger.debug(
				`[Responses] stream.connected contentType=${contentType || 'unknown'}`,
			);

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			const state: ResponsesStreamState = {
				pendingToolCalls: new Map<number, DeepSeekToolCall>(),
				emittedTextKeys: new Set<string>(),
				emittedReasoningKeys: new Set<string>(),
				emittedToolCallKeys: new Set<string>(),
				currentThinkingId: null,
				thinkingBuffer: '',
				thinkingFlushTimer: null,
				hasEmittedThinking: false,
				hasEmittedAssistantText: false,
				emittedBeginToolCallsHint: false,
				reasoningEventCount: 0,
				textEventCount: 0,
				toolEventCount: 0,
				unknownEventTypes: new Set<string>(),
				usedNonStreamFallback: false,
			};

			while (true) {
				if (cancellationToken?.isCancellationRequested) {
					controller.abort();
					break;
				}

				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) {
						continue;
					}

					const data = trimmed.slice(5).trim();
					if (data === '[DONE]') {
						logger.debug('[Responses] stream.done');
						logResponsesSummary(state);
						flushPendingToolCalls(state, callbacks);
						callbacks.onDone();
						return;
					}

					let event: Record<string, unknown>;
					try {
						event = JSON.parse(data) as Record<string, unknown>;
					} catch (error) {
						logger.error('[Responses] Failed to parse SSE chunk:', data.slice(0, 200), error);
						continue;
					}
					emittedResponsePart = true;
					this.handleEvent(event, callbacks, state);
				}
			}

			reportEndThinking(state, callbacks);
			logResponsesSummary(state);
			flushPendingToolCalls(state, callbacks);
			callbacks.onDone();
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				reportEndThinking(undefined, callbacks);
				callbacks.onDone();
				return;
			}

			if (request.stream && !emittedResponsePart && !streamConnected) {
				try {
					logger.debug('[Responses] fallback.nonstream reason=no_stream_events');
					logger.warn('[Responses] Streaming threw before content; retrying without streaming.', error);
					await this.fetchWithoutStreaming({ ...request, stream: false }, callbacks, controller.signal);
					callbacks.onDone();
					return;
				} catch (fallbackError) {
					callbacks.onError(fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError)));
					return;
				}
			}

			callbacks.onError(error instanceof Error ? error : new Error(String(error)));
		} finally {
			cancelListener?.dispose();
		}
	}

	private async fetchWithoutStreaming(
		request: ResponsesRequest,
		callbacks: StreamCallbacks,
		signal: AbortSignal,
	): Promise<void> {
		logger.debug(
			`[Responses] json.start url=${this.baseUrl}/responses`
			+ ` model=${request.model} inputItems=${request.input.length}`
				+ ` previousResponseId=${request.previous_response_id ? 'yes' : 'no'}`,
		);
		logger.debug(`[Responses] request.summary mode=json ${previewJson(summarizeResponsesRequest(request))}`);
		logger.debug(`[Responses] request.body mode=json ${previewJson(sanitizeResponsesRequestForLog(request))}`);

		const response = await this.fetchWithRetry(request, signal, 'json');

		if (!response.ok) {
			const errorText = await response.text();
			logger.warn(
				`[Responses] json.http_error status=${response.status}`
				+ ` statusText=${response.statusText}`
				+ ` body=${errorText.slice(0, LOG_RESPONSE_BODY_MAX)}`,
			);
			throw new ResponsesHttpError(response.status, errorText);
		}

		const responseJson = await response.json() as Record<string, unknown>;
		this.emitJsonResponse(responseJson, callbacks);
	}

	private async fetchWithRetry(
		request: ResponsesRequest,
		signal: AbortSignal,
		mode: 'stream' | 'json',
	): Promise<Response> {
		const url = `${this.baseUrl}/responses`;
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				logger.debug(
					`[Responses] ${mode}.fetch attempt=${attempt + 1}`
					+ ` bytes=${Buffer.byteLength(JSON.stringify(request), 'utf8')}`,
				);
				const response = await fetch(url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${this.apiKey}`,
					},
					body: JSON.stringify(request),
					signal,
				});
				logger.debug(
					`[Responses] ${mode}.fetch.response attempt=${attempt + 1}`
					+ ` status=${response.status} contentType=${response.headers.get('content-type') ?? ''}`,
				);
				return response;
			} catch (error) {
				lastError = error;
				if (attempt === 0) {
					logger.warn(
						`[Responses] ${mode}.fetch.retry attempt=${attempt + 1} error=${error instanceof Error ? error.message : String(error)}`,
					);
					await new Promise((resolve) => setTimeout(resolve, 800));
				}
			}
		}

		throw lastError instanceof Error
			? lastError
			: new Error(`Responses ${mode} fetch failed`);
	}

	private emitJsonResponse(
		responseJson: Record<string, unknown>,
		callbacks: StreamCallbacks,
	): void {
		const responseId = typeof responseJson.id === 'string' ? responseJson.id : undefined;
		let hasOpenThinking = false;
		logger.debug(
			`[Responses] json.response id=${responseId ?? 'n/a'} status=${String(responseJson.status ?? 'unknown')}`,
		);
		if (responseId && callbacks.onResponseId) {
			callbacks.onResponseId(responseId);
		}

		const topLevelReasoning = responseJson.reasoning as Record<string, unknown> | undefined;
		if (topLevelReasoning) {
			const summaryItems = Array.isArray(topLevelReasoning.summary)
				? topLevelReasoning.summary as Array<Record<string, unknown>>
				: [];
			for (const summary of summaryItems) {
				const text = coerceText(summary.text ?? summary);
				if (text && !looksLikeReasoningConfigValue(text)) {
					logger.debug(
						`[Responses] json.reasoning type=top-level.summary len=${text.length} preview=${previewText(text)}`,
					);
					hasOpenThinking = true;
					callbacks.onThinking(text);
				}
			}
		}

		const outputItems = Array.isArray(responseJson.output)
			? responseJson.output as Array<Record<string, unknown>>
			: [];
		for (const item of outputItems) {
			const itemType = typeof item.type === 'string' ? item.type : '';
			if (itemType === 'message') {
				const contentParts = Array.isArray(item.content)
					? item.content as Array<Record<string, unknown>>
					: [];
				for (const part of contentParts) {
					const partType = typeof part.type === 'string' ? part.type : '';
					const text = coerceText(part.text ?? part.delta ?? part.content);
					if (!text) {
						continue;
					}
					if (partType === 'output_text' || partType === 'refusal') {
						if (hasOpenThinking) {
							callbacks.onThinking('');
							hasOpenThinking = false;
						}
						logger.debug(
							`[Responses] json.text type=${partType} len=${text.length} preview=${previewText(text)}`,
						);
						callbacks.onContent(text);
						continue;
					}
					if ((partType === 'reasoning_text' || partType === 'summary_text') && !looksLikeReasoningConfigValue(text)) {
						logger.debug(
							`[Responses] json.reasoning type=${partType} len=${text.length} preview=${previewText(text)}`,
						);
						hasOpenThinking = true;
						callbacks.onThinking(text);
					}
				}
				continue;
			}

			if (itemType === 'reasoning') {
				const summaries = Array.isArray(item.summary)
					? item.summary as Array<Record<string, unknown>>
					: [];
				for (const summary of summaries) {
					const text = coerceText(summary.text ?? summary);
					if (text && !looksLikeReasoningConfigValue(text)) {
						logger.debug(
							`[Responses] json.reasoning type=reasoning.summary len=${text.length} preview=${previewText(text)}`,
						);
						hasOpenThinking = true;
						callbacks.onThinking(text);
					}
				}
				continue;
			}

			if (itemType === 'function_call') {
				if (hasOpenThinking) {
					callbacks.onThinking('');
					hasOpenThinking = false;
				}
				const callId = typeof item.call_id === 'string'
					? item.call_id
					: typeof item.id === 'string'
						? item.id
						: 'call_0';
				const name = typeof item.name === 'string' ? item.name : '';
				const args = typeof item.arguments === 'string' ? item.arguments : '{}';
				logger.debug(`[Responses] json.tool name=${name || 'unknown'} callId=${callId}`);
				callbacks.onToolCall({
					id: callId,
					type: 'function',
					function: { name, arguments: args },
				});
			}
		}

		if (hasOpenThinking) {
			callbacks.onThinking('');
		}

		const usage = responseJson.usage as Record<string, unknown> | undefined;
		if (usage && callbacks.onUsage) {
			const inputTokens = Number(usage.input_tokens ?? 0);
			const outputTokens = Number(usage.output_tokens ?? 0);
			const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens);
			const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
			callbacks.onUsage({
				prompt_tokens: inputTokens,
				completion_tokens: outputTokens,
				total_tokens: totalTokens,
				prompt_cache_hit_tokens: Number(inputDetails?.cached_tokens ?? 0),
			});
		}

		const responseError = responseJson.error as Record<string, unknown> | null | undefined;
		if (responseError && typeof responseError.message === 'string') {
			throw new Error(responseError.message);
		}
	}

	private handleEvent(
		event: Record<string, unknown>,
		callbacks: StreamCallbacks,
		state: ResponsesStreamState,
	): void {
		const eventType = typeof event.type === 'string' ? event.type : '';
		captureResponseIdFromEvent(event, callbacks);

		switch (eventType) {
			case 'response.created':
			case 'response.in_progress': {
				logger.debug(`[Responses] event type=${eventType}`);
				return;
			}
			case 'response.content_part.added':
			case 'response.content_part.done':
			case 'response.reasoning_summary_part.added':
			case 'response.reasoning_summary_part.done':
			case 'response.reasoning_part.added':
			case 'response.reasoning_part.done': {
				return;
			}
			case 'response.output_text.delta':
			case 'response.refusal.delta': {
				const delta = coerceText(event.delta);
				if (!delta) {
					return;
				}
				state.textEventCount += 1;
				reportEndThinking(state, callbacks);
				const key = buildEventKey(event, 'item');
				state.emittedTextKeys.add(key);
				state.hasEmittedAssistantText = true;
				callbacks.onContent(delta);
				return;
			}
			case 'response.output_text.done':
			case 'response.refusal.done': {
				const key = buildEventKey(event, 'item');
				const text = coerceText(event.text);
				if (text && !state.emittedTextKeys.has(key)) {
					logger.debug(
						`[Responses] text.done type=${eventType} len=${text.length} preview=${previewText(text)}`,
					);
					state.textEventCount += 1;
					reportEndThinking(state, callbacks);
					state.emittedTextKeys.add(key);
					state.hasEmittedAssistantText = true;
					callbacks.onContent(text);
				}
				return;
			}
			case 'response.reasoning.delta':
			case 'response.reasoning_text.delta':
			case 'response.reasoning_summary.delta':
			case 'response.reasoning_summary_text.delta':
			case 'response.thinking.delta':
			case 'response.thinking_summary.delta':
			case 'response.thought.delta':
			case 'response.thought_summary.delta': {
				const delta = extractReasoningText(event);
				if (!delta || looksLikeReasoningConfigValue(delta)) {
					return;
				}
				state.reasoningEventCount += 1;
				state.emittedReasoningKeys.add(buildEventKey(event, 'reasoning'));
				bufferThinkingContent(delta, state, callbacks);
				return;
			}
			case 'response.reasoning.done':
			case 'response.reasoning_text.done':
			case 'response.reasoning_summary.done':
			case 'response.reasoning_summary_text.done':
			case 'response.thinking.done':
			case 'response.thinking_summary.done':
			case 'response.thought.done':
			case 'response.thought_summary.done': {
				const key = buildEventKey(event, 'reasoning');
				const text = extractReasoningText(event);
				if (text && !looksLikeReasoningConfigValue(text) && !state.emittedReasoningKeys.has(key)) {
					state.reasoningEventCount += 1;
					state.emittedReasoningKeys.add(key);
					bufferThinkingContent(text, state, callbacks);
				}
				reportEndThinking(state, callbacks);
				return;
			}
			case 'response.function_call_arguments.delta':
			case 'response.function_call_arguments.done': {
				reportEndThinking(state, callbacks);
				if (!state.emittedBeginToolCallsHint && state.hasEmittedAssistantText) {
					callbacks.onContent(' ');
					state.emittedBeginToolCallsHint = true;
				}
				const outputIndex = typeof event.output_index === 'number' ? event.output_index : 0;
				state.toolEventCount += 1;
				const pending = state.pendingToolCalls.get(outputIndex) ?? {
					id: getCallIdFromEvent(event, outputIndex),
					type: 'function' as const,
					function: { name: '', arguments: '' },
				};
				const name = typeof event.name === 'string' ? event.name : '';
				if (name && !pending.function.name) {
					pending.function.name = name;
				}
				const argsChunk = eventType === 'response.function_call_arguments.delta'
					? coerceText(event.delta)
					: coerceText(event.arguments);
				if (eventType === 'response.function_call_arguments.delta') {
					pending.function.arguments += argsChunk;
				} else if (argsChunk) {
					pending.function.arguments = argsChunk;
				}
				state.pendingToolCalls.set(outputIndex, pending);
				if (eventType === 'response.function_call_arguments.done') {
					logger.debug(
						`[Responses] tool.arguments.done outputIndex=${outputIndex}`
						+ ` name=${pending.function.name || '(pending)'}`
						+ ` argsChars=${pending.function.arguments.length}`,
					);
					flushPendingToolCall(outputIndex, state, callbacks);
				}
				return;
			}
			case 'response.output_item.added':
			case 'response.output_item.done': {
				const item = event.item as ResponsesFunctionCallItem | undefined;
				if (!item || item.type !== 'function_call') {
					return;
				}
				logger.debug(`[Responses] tool.output_item name=${item.name} callId=${item.call_id}`);
				state.toolEventCount += 1;
				reportEndThinking(state, callbacks);
				if (!state.emittedBeginToolCallsHint && state.hasEmittedAssistantText) {
					callbacks.onContent(' ');
					state.emittedBeginToolCallsHint = true;
				}
				const outputIndex = typeof event.output_index === 'number' ? event.output_index : 0;
				state.pendingToolCalls.set(outputIndex, {
					id: item.call_id,
					type: 'function',
					function: {
						name: item.name,
						arguments: item.arguments,
					},
				});
				if (eventType === 'response.output_item.done') {
					flushPendingToolCall(outputIndex, state, callbacks);
				}
				return;
			}
			case 'response.completed':
			case 'response.done': {
				logger.debug(`[Responses] event type=${eventType}`);
				reportEndThinking(state, callbacks);
				flushPendingToolCalls(state, callbacks);
				reportUsageFromEvent(event, callbacks);
				return;
			}
			case 'response.failed':
			case 'error': {
				const responseObject = event.response as Record<string, unknown> | undefined;
				const error = (responseObject?.error ?? event.error) as Record<string, unknown> | undefined;
				logger.debug(`[Responses] event type=${eventType} error=${String(error?.message ?? 'unknown')}`);
				throw new Error(
					typeof error?.message === 'string'
						? error.message
						: 'Responses API request failed',
				);
			}
			default: {
				if (eventType) {
					state.unknownEventTypes.add(eventType);
					logger.debug(
						`[Responses] event.unhandled type=${eventType} payload=${JSON.stringify(summarizeUnknownEvent(event))}`,
					);
				}
				return;
			}
		}
	}
}

function logResponsesSummary(state: ResponsesStreamState): void {
	logger.debug(
		`[Responses] summary reasoningEvents=${state.reasoningEventCount}`
		+ ` textEvents=${state.textEventCount}`
		+ ` toolEvents=${state.toolEventCount}`
		+ ` usedNonStreamFallback=${state.usedNonStreamFallback ? 'yes' : 'no'}`
		+ ` unknownEvents=${state.unknownEventTypes.size > 0 ? [...state.unknownEventTypes].join('|') : 'none'}`,
	);
}

function summarizeUnknownEvent(event: Record<string, unknown>): Record<string, unknown> {
	const summary: Record<string, unknown> = {};
	for (const key of ['type', 'item_id', 'output_index', 'content_index', 'part_index', 'summary_index']) {
		if (key in event) {
			summary[key] = event[key];
		}
	}

	const part = event.part;
	if (part && typeof part === 'object' && !Array.isArray(part)) {
		const record = part as Record<string, unknown>;
		summary.part = {
			type: record.type,
			text: typeof record.text === 'string' ? previewText(record.text, 160) : undefined,
			summary: typeof record.summary === 'string' ? previewText(record.summary, 160) : undefined,
			reasoning: typeof record.reasoning === 'string' ? previewText(record.reasoning, 160) : undefined,
		};
	}

	const item = event.item;
	if (item && typeof item === 'object' && !Array.isArray(item)) {
		const record = item as Record<string, unknown>;
		summary.item = {
			type: record.type,
			status: record.status,
			role: record.role,
		};
	}

	if (typeof event.delta === 'string') {
		summary.delta = previewText(event.delta, 160);
	}
	if (typeof event.text === 'string') {
		summary.text = previewText(event.text, 160);
	}

	return summary;
}

function captureResponseIdFromEvent(
	event: Record<string, unknown>,
	callbacks: StreamCallbacks,
): void {
	const responseObject = event.response as Record<string, unknown> | undefined;
	const responseId = typeof event.response_id === 'string'
		? event.response_id
		: typeof responseObject?.id === 'string'
			? responseObject.id
			: undefined;
	if (responseId && callbacks.onResponseId) {
		callbacks.onResponseId(responseId);
	}
}

function reportUsageFromEvent(event: Record<string, unknown>, callbacks: StreamCallbacks): void {
	const responseObject = event.response as Record<string, unknown> | undefined;
	const usage = responseObject?.usage as Record<string, unknown> | undefined;
	if (!usage || !callbacks.onUsage) {
		return;
	}
	const inputTokens = Number(usage.input_tokens ?? 0);
	const outputTokens = Number(usage.output_tokens ?? 0);
	const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens);
	const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
	callbacks.onUsage({
		prompt_tokens: inputTokens,
		completion_tokens: outputTokens,
		total_tokens: totalTokens,
		prompt_cache_hit_tokens: Number(inputDetails?.cached_tokens ?? 0),
	});
}

function flushPendingToolCall(
	outputIndex: number,
	state: ResponsesStreamState,
	callbacks: StreamCallbacks,
): void {
	const pending = state.pendingToolCalls.get(outputIndex);
	if (!pending || state.emittedToolCallKeys.has(pending.id)) {
		state.pendingToolCalls.delete(outputIndex);
		return;
	}
	if (!isCompleteToolCall(pending)) {
		logger.warn(
			`[Responses] drop incomplete tool call outputIndex=${outputIndex}`
			+ ` id=${pending.id || '(empty)'} name=${pending.function.name || '(empty)'}`,
		);
		state.pendingToolCalls.delete(outputIndex);
		return;
	}
	pending.function.arguments = normalizeToolArguments(pending.function.arguments);
	callbacks.onToolCall(pending);
	state.emittedToolCallKeys.add(pending.id);
	state.pendingToolCalls.delete(outputIndex);
}

function normalizeToolArguments(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) {
		return '{}';
	}
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? trimmed
			: '{}';
	} catch {
		return '{}';
	}
}

function isCompleteToolCall(toolCall: DeepSeekToolCall): boolean {
	if (!toolCall.id?.trim() || !toolCall.function.name?.trim()) {
		return false;
	}
	const trimmed = toolCall.function.arguments.trim();
	if (!trimmed) {
		return true;
	}
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
	} catch {
		return false;
	}
}

function flushPendingToolCalls(state: ResponsesStreamState, callbacks: StreamCallbacks): void {
	for (const outputIndex of Array.from(state.pendingToolCalls.keys())) {
		flushPendingToolCall(outputIndex, state, callbacks);
	}
}

function generateThinkingId(): string {
	return `responses_thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function bufferThinkingContent(
	text: string,
	state: ResponsesStreamState | undefined,
	callbacks: StreamCallbacks,
): void {
	if (!state) {
		callbacks.onThinking(text);
		return;
	}
	state.hasEmittedThinking = true;
	if (!state.currentThinkingId) {
		state.currentThinkingId = generateThinkingId();
	}
	state.thinkingBuffer += text;
	if (!state.thinkingFlushTimer) {
		state.thinkingFlushTimer = setTimeout(() => {
			flushThinkingBuffer(state, callbacks);
		}, 100);
	}
}

function flushThinkingBuffer(
	state: ResponsesStreamState,
	callbacks: StreamCallbacks,
): void {
	if (state.thinkingFlushTimer) {
		clearTimeout(state.thinkingFlushTimer);
		state.thinkingFlushTimer = null;
	}
	if (state.thinkingBuffer && state.currentThinkingId) {
		const text = state.thinkingBuffer;
		state.thinkingBuffer = '';
		callbacks.onThinking(text);
	}
}

function reportEndThinking(
	state: ResponsesStreamState | undefined,
	callbacks: StreamCallbacks,
): void {
	if (!state?.currentThinkingId) {
		return;
	}
	flushThinkingBuffer(state, callbacks);
	callbacks.onThinking('');
	state.currentThinkingId = null;
	state.thinkingBuffer = '';
	state.hasEmittedThinking = false;
	if (state.thinkingFlushTimer) {
		clearTimeout(state.thinkingFlushTimer);
		state.thinkingFlushTimer = null;
	}
}

function buildEventKey(event: Record<string, unknown>, fallbackItemId: string): string {
	const itemId = typeof event.item_id === 'string' ? event.item_id : fallbackItemId;
	const contentIndex = typeof event.content_index === 'number'
		? event.content_index
		: typeof event.summary_index === 'number'
			? event.summary_index
			: 0;
	return `${itemId}:${contentIndex}`;
}

function extractReasoningText(event: Record<string, unknown>): string {
	const candidates = [
		coerceText(event.delta),
		coerceText(event.text),
		coerceText(event.reasoning),
		coerceText(event.summary),
	].filter(Boolean);
	return candidates[0] ?? '';
}

function getCallIdFromEvent(event: Record<string, unknown>, outputIndex: number): string {
	const raw = event.call_id ?? event.callId ?? event.id ?? event.item_id;
	return typeof raw === 'string' && raw.trim() ? raw : `call_${outputIndex}`;
}

function coerceText(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item) => coerceText(item)).join('');
	}
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		if (typeof record.text === 'string') {
			return record.text;
		}
		if (typeof record.content === 'string') {
			return record.content;
		}
	}
	return '';
}

function looksLikeReasoningConfigValue(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return normalized === 'none'
		|| normalized === 'low'
		|| normalized === 'medium'
		|| normalized === 'high'
		|| normalized === 'xhigh'
		|| normalized === 'minimal'
		|| normalized === 'auto'
		|| normalized === 'concise'
		|| normalized === 'detailed';
}

function shouldFallbackToNonStream(status: number, errorText: string): boolean {
	if (status >= 500) {
		return true;
	}
	const normalized = errorText.toLowerCase();
	return normalized.includes('stream')
		&& (
			normalized.includes('unsupported')
			|| normalized.includes('not support')
			|| normalized.includes('not implemented')
		);
}

function resolveResponsesConversationState(
	modelId: string,
	baseUrl: string,
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	marker: ResponsesStatefulMarkerLocation | null,
	previousResponseIdsByConversation: Map<string, string>,
): ResponsesConversationState {
	const key = buildResponsesConversationKey(modelId, baseUrl, messages);
	if (marker?.marker) {
		previousResponseIdsByConversation.set(key, marker.marker);
		return {
			key,
			previousResponseId: marker.marker,
			markerIndex: marker.index,
			source: 'marker',
		};
	}

	const previousResponseId = previousResponseIdsByConversation.get(key);
	return {
		key,
		previousResponseId,
		source: previousResponseId ? 'memory' : 'none',
	};
}

function buildResponsesConversationKey(
	modelId: string,
	baseUrl: string,
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): string {
	const firstText = messages.length > 0 ? firstTextFromMessage(messages[0]) : '';
	return `${baseUrl}|${modelId}|${stableHash(firstText)}`;
}

function firstTextFromMessage(message: vscode.LanguageModelChatRequestMessage): string {
	for (const part of message.content ?? []) {
		if (part instanceof vscode.LanguageModelTextPart) {
			return part.value;
		}
	}
	return '';
}

function stableHash(text: string): string {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

function createResponsesStatefulMarkerPart(modelId: string, marker: string): vscode.LanguageModelDataPart {
	const payload = `${modelId}\\${marker}`;
	const bytes = new TextEncoder().encode(payload);
	return new vscode.LanguageModelDataPart(bytes, RESPONSES_STATEFUL_MARKER_MIME);
}

function parseResponsesStatefulMarkerPart(part: unknown): { modelId: string; marker: string } | null {
	const maybe = part as { mimeType?: unknown; data?: unknown };
	if (!maybe || typeof maybe !== 'object') {
		return null;
	}
	if (typeof maybe.mimeType !== 'string') {
		return null;
	}
	if (!(maybe.data instanceof Uint8Array)) {
		return null;
	}
	if (maybe.mimeType !== RESPONSES_STATEFUL_MARKER_MIME) {
		return null;
	}

	try {
		const decoded = new TextDecoder().decode(maybe.data);
		const separator = decoded.indexOf('\\');
		if (separator <= 0) {
			return null;
		}
		const modelId = decoded.slice(0, separator).trim();
		const marker = decoded.slice(separator + 1).trim();
		if (!modelId || !marker) {
			return null;
		}
		return { modelId, marker };
	} catch {
		return null;
	}
}

function findLastResponsesStatefulMarker(
	modelId: string,
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): ResponsesStatefulMarkerLocation | null {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role !== vscode.LanguageModelChatMessageRole.Assistant) {
			continue;
		}
		for (const part of messages[index].content ?? []) {
			const parsed = parseResponsesStatefulMarkerPart(part);
			if (parsed && parsed.modelId === modelId) {
				return { marker: parsed.marker, index };
			}
		}
	}
	return null;
}

function parseResponsesError(errorText: string): string {
	try {
		const errorJson = JSON.parse(errorText) as Record<string, unknown>;
		const error = errorJson.error as Record<string, unknown> | undefined;
		return typeof error?.message === 'string'
			? error.message
			: typeof errorJson.message === 'string'
				? errorJson.message
				: errorText;
	} catch {
		return errorText;
	}
}
