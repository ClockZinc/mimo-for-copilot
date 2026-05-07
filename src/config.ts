import vscode from 'vscode';
import { CONFIG_SECTION, DEFAULT_PROVIDERS } from './consts';
import type { ProviderDefinition, UserModelConfig } from './types';

const MODEL_PROVIDER_COMPATIBILITY: Record<string, string[]> = {
	'mimo-v2.5-pro': ['mimo', 'mimo-tp'],
	'mimo-v2.5': ['mimo', 'mimo-tp'],
	'mimo-v2-pro': ['mimo', 'mimo-tp'],
	'mimo-v2-flash': ['mimo'],
};

/**
 * Get DeepSeek API base URL from settings.
 * Falls back to the official endpoint when not configured.
 */
export function getBaseUrl(): string {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<string>('baseUrl') || 'https://api.deepseek.com';
}

/**
 * Get the resolved API model ID to send to the endpoint.
 *
 * Users can override model IDs via the `modelIdOverrides` setting object
 * (e.g. for third-party API proxies). Falls back to the VS Code model ID
 * when no override is configured.
 */
export function getApiModelId(vscodeModelId: string): string {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const overrides = config.get<Record<string, string>>('modelIdOverrides');
	const override = overrides?.[vscodeModelId]?.trim();
	return override || vscodeModelId;
}

/**
 * Get the configured max output tokens limit.
 * Returns `undefined` when set to 0 (API default — no limit).
 */
export function getMaxTokens(): number | undefined {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const value = config.get<number>('maxTokens', 0);
	return value > 0 ? value : undefined;
}

// ---- Multi-provider management ----

/**
 * Get the list of all available providers (user-configured + DEFAULT_PROVIDERS).
 * User entries take precedence over defaults with the same ID.
 */
export function getProviders(): ProviderDefinition[] {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const userProviders = config.get<ProviderDefinition[]>('providers') ?? [];
	// Merge: user providers override defaults with the same ID
	const merged = new Map<string, ProviderDefinition>();
	for (const dp of DEFAULT_PROVIDERS) {
		merged.set(dp.id, dp);
	}
	for (const up of userProviders) {
		// Migrate old known MiMo Token Plan URL from SGP to CN
		if (
			up.id === 'mimo-tp' &&
			up.baseUrl === 'https://token-plan-sgp.xiaomimimo.com/v1'
		) {
			merged.set(up.id, { ...up, baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' });
		} else {
			merged.set(up.id, up);
		}
	}
	return [...merged.values()];
}

/** Get the list of user-configured models. */
export function getUserModels(): UserModelConfig[] {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<UserModelConfig[]>('models') ?? [];
}

/** Get the list of hidden built-in model IDs. */
export function getHiddenModels(): string[] {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<string[]>('hiddenModels') ?? [];
}

/** Find a provider by ID. Returns undefined if not found. */
export function getProviderById(providerId: string): ProviderDefinition | undefined {
	return getProviders().find((p) => p.id === providerId);
}

export function isProviderSupportedForModel(modelId: string | undefined, providerId: string): boolean {
	if (!modelId) {
		return true;
	}
	const supportedProviders = MODEL_PROVIDER_COMPATIBILITY[modelId];
	return !supportedProviders || supportedProviders.includes(providerId);
}

export function getCandidateProvidersForModel(
	modelId: string | undefined,
	preferredProviderId: string | undefined,
): string[] {
	if (!preferredProviderId || preferredProviderId === 'default') {
		return preferredProviderId ? [preferredProviderId] : [];
	}

	const candidates = new Set<string>();
	if (isProviderSupportedForModel(modelId, preferredProviderId)) {
		candidates.add(preferredProviderId);
	}
	for (const sibling of getRelatedProviders(preferredProviderId)) {
		if (isProviderSupportedForModel(modelId, sibling)) {
			candidates.add(sibling);
		}
	}
	if (candidates.size === 0) {
		for (const provider of getProviders()) {
			if (isProviderSupportedForModel(modelId, provider.id)) {
				candidates.add(provider.id);
			}
		}
	}
	return [...candidates];
}

/**
 * Resolve the effective base URL and provider ID for a model.
 *
 * Priority: configured provider → sibling provider (mimo ↔ mimo-tp) → global fallback.
 * Does NOT check keys — just resolves which provider to use.
 */
export function resolveProviderForModel(
	modelProviderId: string | undefined,
	providerKeyStatus?: Map<string, boolean>,
	modelId?: string,
): { baseUrl: string; providerId: string } {
	const globalBaseUrl = getBaseUrl();
	if (!modelProviderId || modelProviderId === 'default') {
		return { baseUrl: globalBaseUrl, providerId: 'default' };
	}
	const candidates = getCandidateProvidersForModel(modelId, modelProviderId);
	if (providerKeyStatus) {
		for (const candidateProviderId of candidates) {
			if (providerKeyStatus.get(candidateProviderId)) {
				const candidateProvider = getProviderById(candidateProviderId);
				if (candidateProvider) {
					return { baseUrl: candidateProvider.baseUrl, providerId: candidateProvider.id };
				}
			}
		}
	}
	for (const candidateProviderId of candidates) {
		const candidateProvider = getProviderById(candidateProviderId);
		if (candidateProvider) {
			return { baseUrl: candidateProvider.baseUrl, providerId: candidateProvider.id };
		}
	}
	return { baseUrl: globalBaseUrl, providerId: modelProviderId };
}

/** Related providers that can serve as fallbacks for each other. */
export function getRelatedProviders(providerId: string): string[] {
	const cascades: Record<string, string[]> = {
		'mimo': ['mimo-tp'],
		'mimo-tp': ['mimo'],
	};
	return cascades[providerId] ?? [];
}
