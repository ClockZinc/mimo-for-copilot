import vscode from 'vscode';
import { WALKTHROUGH_ID, WELCOME_SHOWN_KEY, OPEN_CONFIG_COMMAND } from './consts';
import { getProviders, resolveProviderForModel, getRelatedProviders } from './config';
import { t } from './i18n';
import { logger } from './logger';
import { DeepSeekChatProvider } from './provider';
import { initStatusBar } from './statusBar';
import { ConfigViewPanel } from './views/configView';
import { MemoryManager } from './memory/manager';
import { registerMemoryCommands } from './memory/commands';

let activeProvider: DeepSeekChatProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
	logger.info('Activating extension');

	// Initialize token usage status bar
	initStatusBar(context);

	context.subscriptions.push(
		vscode.commands.registerCommand('mimo-copilot.showLogs', () => logger.show()),
		vscode.commands.registerCommand('mimo-copilot.getApiKey', () =>
			vscode.env.openExternal(vscode.Uri.parse('https://platform.deepseek.com/api_keys')),
		),
		vscode.commands.registerCommand('mimo-copilot.openSettings', () =>
			vscode.commands.executeCommand('workbench.action.openSettings', 'mimo-copilot'),
		),
		vscode.commands.registerCommand(OPEN_CONFIG_COMMAND, () =>
			ConfigViewPanel.openPanel(context.extensionUri, context.secrets),
		),
	);

	try {
		const provider = new DeepSeekChatProvider(context);
		activeProvider = provider;

		// 初始化 Agentic Memory（仅在开关开启时）
		const config = vscode.workspace.getConfiguration('mimo-copilot');
		const agenticMemoryEnabled = config.get<boolean>('agenticMemory', false);
		if (agenticMemoryEnabled) {
			const memoryManager = new MemoryManager(context);
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

			// 异步初始化：复用主 provider 的级联逻辑
			(async () => {
				try {
					const allProviders = getProviders();
					const keyStatus = new Map<string, boolean>();
					for (const p of allProviders) {
						const key = await context.secrets.get(`mimo-copilot.apiKey.${p.id}`);
						keyStatus.set(p.id, !!key && key.length > 0);
					}
					const globalKey = await context.secrets.get('mimo-copilot.apiKey');
					if (globalKey && globalKey.length > 0) {
						for (const p of allProviders) {
							if (!keyStatus.get(p.id)) keyStatus.set(p.id, true);
						}
					}

					// resolve agent model 的 provider（自动级联 mimo ↔ mimo-tp）
					const { baseUrl, providerId } = resolveProviderForModel('mimo', keyStatus);
					const apiKey = await context.secrets.get(`mimo-copilot.apiKey.${providerId}`)
						?? await context.secrets.get('mimo-copilot.apiKey');

					if (apiKey) {
						memoryManager.initialize(workspaceRoot, apiKey, baseUrl);
						// provider.setMemoryManager(memoryManager); // removed — method does not exist
						registerMemoryCommands(context, memoryManager);
						logger.info(`[Extension] Agentic Memory enabled (provider=${providerId}, baseUrl=${baseUrl})`);
					} else {
						memoryManager.initialize(workspaceRoot, undefined);
						logger.info('[Extension] Agentic Memory enabled but no API key — recall will use keyword fallback');
					}
				} catch (e) {
					logger.warn('[Extension] Agentic Memory initialization failed:', e);
				}
			})();
		} else {
			logger.info('[Extension] Agentic Memory disabled (enable via mimo-copilot.agenticMemory)');
		}

		// 监听 agenticMemory 开关变更
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('mimo-copilot.agenticMemory')) {
					vscode.window.showInformationMessage(
						t('extension.agenticMemory.changed'),
						t('extension.agenticMemory.reload'),
					).then(action => {
						if (action) vscode.commands.executeCommand('workbench.action.reloadWindow');
					});
				}
			}),
		);

		context.subscriptions.push(
			vscode.commands.registerCommand('mimo-copilot.setApiKey', () => provider.configureApiKey()),
			vscode.commands.registerCommand('mimo-copilot.clearApiKey', () => provider.clearApiKey()),
			vscode.commands.registerCommand('mimo-copilot.setVisionModel', () =>
				provider.setVisionProxyModel(),
			),
			vscode.lm.registerLanguageModelChatProvider('mimo', provider),
		);

		// Fix(#12): configurationSchema (Thinking Effort dropdown) is a non-public
		// field that Copilot Chat does not persist in its chatLanguageModels.json
		// cache. On startup, Copilot Chat initialises the model picker from cache
		// and silently drops configurationSchema, so the per-model config menu
		// never appears on first launch.
		//
		// Re-firing onDidChangeLanguageModelChatInformation here forces Copilot
		// Chat to re-query our provider through the full (non-cached) path, which
		// correctly picks up configurationSchema.
		//
		// This works because registerLanguageModelChatProvider() is synchronous,
		// so the provider is fully registered before we fire the refresh and the
		// host has already subscribed to receive the change. Copilot Chat can then
		// re-query complete model information through the non-cached path. The
		// extensionDependencies on github.copilot-chat in package.json
		// additionally guarantees Copilot Chat is fully activated before this
		// extension's activate() runs, eliminating any activation ordering race.
		provider.refreshModelPicker();

		void showWelcomeIfNeeded(context, provider).catch((error) => {
			logger.warn(t('extension.welcomeFailed'), error);
		});

		logger.info('Extension activated');
	} catch (error) {
		activeProvider = undefined;
		logger.error('Failed to activate DeepSeek extension', error);
		void vscode.window.showErrorMessage(t('extension.activateFailed'));
		throw error;
	}
}

async function showWelcomeIfNeeded(
	context: vscode.ExtensionContext,
	provider: DeepSeekChatProvider,
): Promise<void> {
	if (context.globalState.get<boolean>(WELCOME_SHOWN_KEY)) {
		return;
	}
	if (await provider.hasApiKey()) {
		await context.globalState.update(WELCOME_SHOWN_KEY, true);
		return;
	}

	await vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false);
	await context.globalState.update(WELCOME_SHOWN_KEY, true);
}

export async function deactivate() {
	try {
		await activeProvider?.prepareForDeactivate();
	} catch (error) {
		logger.warn(t('extension.deactivateFailed'), error);
	} finally {
		activeProvider = undefined;
		logger.info('Extension deactivated');
		logger.dispose();
	}
}
