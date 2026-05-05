import vscode from 'vscode';
import { CONFIG_SECTION } from './consts';
import type { ProviderDefinition, UserModelConfig } from './types';

/**
 * Get DeepSeek API base URL from settings.
 * Falls back to the official endpoint when not configured.
 */
export function getBaseUrl(): string {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<string>('baseUrl') || 'https://api.deepseek.com';
}

/**
 * Resolve the API model ID to send to the endpoint.
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

/** Get the list of user-configured providers. */
export function getProviders(): ProviderDefinition[] {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<ProviderDefinition[]>('providers') ?? [];
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

/**
 * Resolve the effective base URL and API key for a model.
 *
 * Auto-cascades to sibling providers when the model's preferred
 * provider has no key but a related provider does (e.g. MiMo
 * model linked to `mimo` will use `mimo-tp` if available).
 */
export function resolveProviderForModel(modelProviderId: string | undefined): {
	baseUrl: string;
	providerId: string;
} {
	const globalBaseUrl = getBaseUrl();
	if (!modelProviderId || modelProviderId === 'default') {
		return { baseUrl: globalBaseUrl, providerId: 'default' };
	}
	// Try the configured provider first, then cascade to siblings
	let provider = getProviderById(modelProviderId);
	if (!provider) {
		for (const sibling of getRelatedProviders(modelProviderId)) {
			provider = getProviderById(sibling);
			if (provider) { break; }
		}
	}
	if (!provider) {
		return { baseUrl: globalBaseUrl, providerId: modelProviderId };
	}
	return { baseUrl: provider.baseUrl, providerId: provider.id };
}

/** Return related provider IDs that can serve as fallbacks. */
export function getRelatedProviders(providerId: string): string[] {
	const cascades: Record<string, string[]> = {
		'mimo': ['mimo-tp'],
		'mimo-tp': ['mimo'],
	};
	return cascades[providerId] ?? [];
}
