import vscode from 'vscode';
import { API_KEY_SECRET, CONFIG_SECTION } from './consts';
import { t } from './i18n';

/**
 * Manages API keys via VS Code SecretStorage (secure) with
 * fallback to extension settings (less secure, for CI/automation).
 */
export class AuthManager {
	private readonly secretStorage: vscode.SecretStorage;

	constructor(context: vscode.ExtensionContext) {
		this.secretStorage = context.secrets;
	}

	/**
	 * Get API key. Tries SecretStorage first, then falls back to settings.
	 */
	async getApiKey(): Promise<string | undefined> {
		const secretKey = await this.secretStorage.get(API_KEY_SECRET);
		if (secretKey) {
			return secretKey;
		}

		const config = vscode.workspace.getConfiguration('mimo-copilot');
		const settingsKey = config.get<string>('apiKey');
		if (settingsKey?.trim()) {
			return settingsKey.trim();
		}

		return undefined;
	}

	/**
	 * Get API key for a specific provider.
	 * Falls back to the global API key **only** for the `deepseek` / default
	 * provider. Other providers (mimo, mimo-tp, openai-responses) must have
	 * their own per-provider key so that a DeepSeek key is never accidentally
	 * sent to a relay, MiMo, or OpenAI endpoint.
	 */
	async getApiKeyForProvider(providerId: string | undefined): Promise<string | undefined> {
		if (providerId && providerId !== 'default') {
			const providerKey = await this.secretStorage.get(`${CONFIG_SECTION}.apiKey.${providerId}`);
			if (providerKey) {
				return providerKey;
			}
		}
		// Only fall back to the global key for deepseek / default.
		if (!providerId || providerId === 'default' || providerId === 'deepseek') {
			return this.getApiKey();
		}
		return undefined;
	}

	/**
	 * Get ONLY the provider-specific API key (no global fallback).
	 * Used for cascade resolution: if mimo has no specific key,
	 * we should cascade to mimo-tp instead of falling back to a wrong global key.
	 */
	async getProviderSpecificKey(providerId: string): Promise<string | undefined> {
		return this.secretStorage.get(`${CONFIG_SECTION}.apiKey.${providerId}`);
	}

	/**
	 * Store API key in SecretStorage.
	 */
	async setApiKey(apiKey: string): Promise<void> {
		await this.secretStorage.store(API_KEY_SECRET, apiKey.trim());
	}

	/**
	 * Delete stored API key.
	 */
	async deleteApiKey(): Promise<void> {
		await this.secretStorage.delete(API_KEY_SECRET);
	}

	/**
	 * Delete API key for a specific provider.
	 */
	async deleteProviderKey(providerId: string): Promise<void> {
		await this.secretStorage.delete(`${CONFIG_SECTION}.apiKey.${providerId}`);
	}

	/**
	 * Check if ANY API key is configured (global or per-provider).
	 */
	async hasApiKey(): Promise<boolean> {
		const globalKey = await this.getApiKey();
		if (globalKey) {
			return true;
		}
		// Also check per-provider keys
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const providers = config.get<Array<{ id: string }>>('providers') ?? [];
		for (const p of providers) {
			const key = await this.secretStorage.get(`${CONFIG_SECTION}.apiKey.${p.id}`);
			if (key) {
				return true;
			}
		}
		return false;
	}

	async hasProviderSpecificKey(providerId: string): Promise<boolean> {
		const key = await this.secretStorage.get(`${CONFIG_SECTION}.apiKey.${providerId}`);
		return !!key?.trim();
	}

	/**
	 * Prompt user to choose a provider, then enter its API key.
	 * Returns true if a key was saved.
	 */
	async promptForApiKey(): Promise<boolean> {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const providers: Array<{ id: string; name: string; baseUrl?: string; apiMode?: string }> =
			config.get<Array<{ id: string; name: string; baseUrl?: string; apiMode?: string }>>('providers') ?? [];

		// Build provider choices
		const items: vscode.QuickPickItem[] = providers.map((p) => ({
			label: p.name,
			description: p.id,
		}));
		if (items.length === 0) {
			items.push({ label: 'Default', description: 'Global API Key' });
		}

		const chosen = await vscode.window.showQuickPick(items, {
			placeHolder: t('auth.chooseProvider'),
			title: t('auth.chooseProviderTitle'),
		});
		if (!chosen) {
			return false;
		}

		const providerId = chosen.description === 'Global API Key' ? undefined : chosen.description;
		const selectedProvider = providers.find((provider) => provider.id === providerId);

		if (providerId === 'openai-responses') {
			const currentName = selectedProvider?.name?.trim() || 'OpenAI Responses';
			const providerName = await vscode.window.showInputBox({
				prompt: t('auth.responses.namePrompt'),
				value: currentName,
				ignoreFocusOut: true,
				validateInput: (value: string) => value.trim() ? undefined : t('auth.responses.nameRequired'),
			});
			if (!providerName) {
				return false;
			}

			const currentBaseUrl = selectedProvider?.baseUrl?.trim() || 'https://api.anyone.ai/v1';
			const baseUrl = await vscode.window.showInputBox({
				prompt: t('auth.responses.baseUrlPrompt'),
				value: currentBaseUrl,
				ignoreFocusOut: true,
				validateInput: (value: string) => value.trim() ? undefined : t('auth.responses.baseUrlRequired'),
			});
			if (!baseUrl) {
				return false;
			}

			const updatedProviders = [...providers];
			const providerIndex = updatedProviders.findIndex((provider) => provider.id === providerId);
			const nextProvider = { id: 'openai-responses', name: providerName.trim(), baseUrl: baseUrl.trim(), apiMode: 'responses' };
			if (providerIndex >= 0) {
				updatedProviders[providerIndex] = nextProvider;
			} else {
				updatedProviders.push(nextProvider);
			}
			await config.update('providers', updatedProviders, vscode.ConfigurationTarget.Global);
		}

		const apiKey = await vscode.window.showInputBox({
			prompt: providerId ? t('auth.promptForProvider', chosen.label) : t('auth.prompt'),
			placeHolder: t('auth.placeholder'),
			password: true,
			ignoreFocusOut: true,
			validateInput: (value: string) => {
				if (!value?.trim()) {
					return t('auth.emptyValidation');
				}
				return undefined;
			},
		});

		if (apiKey) {
			if (providerId) {
				await this.secretStorage.store(`${CONFIG_SECTION}.apiKey.${providerId}`, apiKey.trim());
				// Auto-update MiMo models' providerId when a MiMo-family provider key is set
				await updateMiMoModelProviders(providerId);
			} else {
				await this.setApiKey(apiKey);
			}
			vscode.window.showInformationMessage(t('auth.savedForProvider', chosen.label));
			return true;
		}

		return false;
	}
}

/** MiMo provider family — setting key for any of these updates MiMo models' providerId. */
const MIMO_PROVIDER_FAMILY = ['mimo', 'mimo-tp'];

/**
 * When user sets API key for a MiMo-family provider (mimo or mimo-tp),
 * automatically update all built-in MiMo models' providerId to that provider.
 * Creates model overrides if they don't exist yet.
 */
export async function updateMiMoModelProviders(providerId: string): Promise<void> {
	if (!MIMO_PROVIDER_FAMILY.includes(providerId)) { return; }

	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const models = config.get<Array<{ id: string; providerId?: string }>>('models') ?? [];
	const TOKEN_PLAN_SUPPORTED_MIMO_MODELS = ['mimo-v2.5-pro', 'mimo-v2.5'];
	let changed = false;
	for (const m of models) {
		if (providerId === 'mimo-tp') {
			if (TOKEN_PLAN_SUPPORTED_MIMO_MODELS.includes(m.id) && m.providerId !== providerId) {
				m.providerId = providerId;
				changed = true;
			}
		} else if (TOKEN_PLAN_SUPPORTED_MIMO_MODELS.includes(m.id) && m.providerId !== providerId) {
			m.providerId = providerId;
			changed = true;
		}
	}
	// Create overrides for MiMo models that don't exist in user config yet
	for (const modelId of TOKEN_PLAN_SUPPORTED_MIMO_MODELS) {
		if (!models.some((m) => m.id === modelId)) {
			models.push({ id: modelId, providerId });
			changed = true;
		}
	}
	if (changed) {
		await config.update('models', models, vscode.ConfigurationTarget.Global);
	}
}
