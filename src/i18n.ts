import vscode from 'vscode';

/**
 * Lightweight i18n module — zero dependencies, follows VS Code display language.
 *
 *  - en / en-US / en-*      → English (default)
 *  - zh-cn                  → Simplified Chinese
 *  - all other locales      → English until translated
 */

function isZh(): boolean {
	const lang = vscode.env.language.toLowerCase();
	return lang === 'zh-cn';
}

// ---- Translation dictionaries ----

type Translations = Record<string, string>;

const zh: Translations = {
	// Model descriptions
	'model.flash.detail': '快速高效',
	'model.pro.detail': '深度推理',

	// API Key
	'auth.apiKeyRequiredDetail': '请先配置 API Key',
	'auth.prompt': '请输入 MiMo / DeepSeek API Key',
	'auth.placeholder': 'sk-...',
	'auth.emptyValidation': 'API Key 不能为空',
	'auth.prefixValidation': 'API Key 应以 "sk-" 开头',
	'auth.saved': 'API Key 已安全保存。',
	'auth.removed': 'API Key 已移除。',
	'auth.notConfigured': 'API Key 未配置，请在命令面板运行 "MiMo: 设置 API Key"。',
	'auth.chooseProviderTitle': '选择服务商',
	'auth.chooseProvider': '请选择要配置 API Key 的服务商',
	'auth.promptForProvider': '请输入 {0} 的 API Key',
	'auth.savedForProvider': '{0} 的 API Key 已安全保存。',
	'auth.chooseProviderToClear': '请选择要清除 API Key 的服务商',
	'auth.clearProviderTitle': '清除 API Key',
	'auth.allProviders': '全部 (全局 + 所有服务商)',

	// Thinking Effort — short labels for model picker dropdown
	'status.thinking': '思考模式',
	'thinking.none': 'No Thinking',
	'thinking.none.desc': '停用思考，响应更快',
	'thinking.high': 'High',
	'thinking.high.desc': '推荐日常使用',
	'thinking.max': 'Max',
	'thinking.max.desc': '深度推理，适合复杂任务',
	'thinking.on': 'On',
	'thinking.on.desc': '启用推理',
	'thinking.off': 'Off',
	'thinking.off.desc': '停用推理',

	// Vision
	'vision.vendorLabel': '提供商：{0}',
	'vision.noModel': '当前环境中没有可用的非 MiMo 视觉代理模型。',
	'vision.pickPlaceholder': '选择用于描述图片的模型 (默认 {0})',
	'vision.current': '当前',
	'vision.proxyUsing': '视觉代理：{0}',
	'vision.notFound': '未找到视觉模型 "{0}"',
	'vision.unavailable': '无可用视觉模型，图片已忽略。',
	'vision.proxyError': '视觉代理异常：',

	// Extension
	'extension.activateFailed': 'MiMo 激活失败，请运行 "MiMo: 显示日志" 查看详情。',
	'extension.deactivateFailed': 'MiMo 停用异常',
	'extension.welcomeFailed': '欢迎引导加载异常',
};

const en: Translations = {
	// Model descriptions
	'model.flash.detail': 'Fast, general-purpose model',
	'model.pro.detail': 'Most capable reasoning model',

	// API Key
	'auth.apiKeyRequiredDetail': 'Please run MiMo: Set API Key to configure.',
	'auth.prompt': 'Enter your MiMo / DeepSeek API key',
	'auth.placeholder': 'sk-...',
	'auth.emptyValidation': 'API key cannot be empty',
	'auth.prefixValidation': 'API key should start with "sk-"',
	'auth.saved': 'API key saved.',
	'auth.removed': 'API key removed.',
	'auth.notConfigured': 'API key not configured. Run "MiMo: Set API Key" from the Command Palette.',
	'auth.chooseProviderTitle': 'Choose Provider',
	'auth.chooseProvider': 'Select which provider to configure an API key for',
	'auth.promptForProvider': 'Enter your {0} API key',
	'auth.savedForProvider': '{0} API key saved.',
	'auth.chooseProviderToClear': 'Select which provider to clear the API key for',
	'auth.clearProviderTitle': 'Clear API Key',
	'auth.allProviders': 'All (Global + All Providers)',

	// Thinking Effort
	'status.thinking': 'Thinking Effort',
	'thinking.none': 'No Thinking',
	'thinking.none.desc': 'Disable thinking for faster responses',
	'thinking.high': 'High',
	'thinking.high.desc': 'Recommended for most tasks',
	'thinking.max': 'Max',
	'thinking.max.desc': 'Maximum reasoning depth for complex agent tasks',
	'thinking.on': 'On',
	'thinking.on.desc': 'Enable reasoning',
	'thinking.off': 'Off',
	'thinking.off.desc': 'Disable reasoning',

	// Vision
	// NOTE: vision.unableToDescribe has been moved to consts.ts as
	// IMAGE_DESCRIPTION_UNAVAILABLE — it is prompt content, not UI text.
	'vision.vendorLabel': 'vendor: {0}',
	'vision.noModel': 'No non-MiMo vision proxy models are available in the current environment',
	'vision.pickPlaceholder': 'Select a model for image description (default: {0})',
	'vision.current': 'Current',
	'vision.proxyUsing': 'Vision proxy: {0}',
	'vision.notFound': 'Vision model "{0}" not found',
	'vision.unavailable': 'No vision models available, image(s) ignored',
	'vision.proxyError': 'Vision proxy error:',

	// Extension
	'extension.activateFailed': 'MiMo failed to activate. Run "MiMo: Show Logs" for details.',
	'extension.deactivateFailed': 'Failed to prepare MiMo provider for deactivate',
	'extension.welcomeFailed': 'Failed to show MiMo welcome prompt',
};

/**
 * Resolve a translation key for the current VS Code display language.
 * Supports positional placeholders {0}, {1}, ...
 */
export function t(key: string, ...args: (string | number)[]): string {
	const dict = isZh() ? zh : en;
	let text = dict[key];
	if (text === undefined) {
		// Fall back to English when a key is missing from the active locale.
		text = en[key];
	}
	if (text === undefined) {
		return key;
	}
	// Replace all occurrences of each positional placeholder.
	for (let i = 0; i < args.length; i++) {
		text = text.replaceAll(`{${i}}`, String(args[i]));
	}
	return text;
}
