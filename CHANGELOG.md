# Changelog

## [0.4.0](https://github.com/ClockZinc/mimo-for-copilot/compare/v0.3.1...v0.4.0) (2026-05-05)


### Features

* MiMo For Copilot — fork from deepseek-v4-for-copilot, add MiMo V2.5 Pro + multi-provider config UI ([f683f20](https://github.com/ClockZinc/mimo-for-copilot/commit/f683f20493ab335f434ea21384041f57c0d427ad))


### Bug Fixes

* format code with oxfmt to pass CI ([277c243](https://github.com/ClockZinc/mimo-for-copilot/commit/277c2438f6709ce817b16b45d23e6e93fc33b603))
* lint errors in CI (unused import, unused variable) ([33206d1](https://github.com/ClockZinc/mimo-for-copilot/commit/33206d115c4c4303fa9883dfc9fe9da10f2d9262))
* separate thinking capability from thinking param — MiMo keeps reasoning but no effort dropdown ([458e3c3](https://github.com/ClockZinc/mimo-for-copilot/commit/458e3c3a55dcbc3d5026c89f24aed193551e9efb))

## [0.3.1](https://github.com/Vizards/deepseek-v4-for-copilot/compare/v0.3.0...v0.3.1) (2026-05-02)


### Bug Fixes

* thinking effort dropdown missing on first launch ([#13](https://github.com/Vizards/deepseek-v4-for-copilot/issues/13)) ([27deac1](https://github.com/Vizards/deepseek-v4-for-copilot/commit/27deac14cb69a3e51eaf908919ded9db8fcb1ab6))


### Documentation

* **readme:** document model ID overrides ([#22](https://github.com/Vizards/deepseek-v4-for-copilot/issues/22)) ([7d38322](https://github.com/Vizards/deepseek-v4-for-copilot/commit/7d38322818d15380eba7c28058de45140a7aa73a))

## [0.3.0](https://github.com/Vizards/deepseek-v4-for-copilot/compare/v0.2.0...v0.3.0) (2026-04-29)


### Features

* add configurable API model IDs for DeepSeek V4 Flash and Pro models ([#4](https://github.com/Vizards/deepseek-v4-for-copilot/issues/4)) ([de132ca](https://github.com/Vizards/deepseek-v4-for-copilot/commit/de132ca14f46a03584932e646c76ebe2add01aef))

## 0.2.0

- Show DeepSeek models in the Copilot Chat model picker as soon as the extension is active, even before an API key is configured.
- Add model picker warning state for missing API keys, with guidance to run `DeepSeek: Set API Key`.
- Add a first-run walkthrough with inline actions for getting an API key, setting an API key, and opening VS Code's Language Models manager.
- Move Thinking Effort from extension settings into Copilot Chat's native model picker configuration, with `None`, `High`, and `Max` options. `High` remains the default to match DeepSeek's default behavior.
- Remove the obsolete `deepseek-copilot.thinking` and `deepseek-copilot.thinkingEffort` settings.
- Refresh model metadata after setting or clearing the API key, and refresh provider state during extension deactivation so DeepSeek models are removed when the extension unloads.
- Fix vision proxy lookup so it only starts when actual `image/*` attachments are present, avoiding unnecessary model selection for text-only requests.
- Simplify DeepSeek model descriptions and update README setup/configuration guidance.

## 0.1.1

- Rename display name to `DeepSeek V4 for Copilot Chat` to avoid Marketplace name collision

## 0.1.0

- Initial release
- **DeepSeek V4 Pro & Flash** available in the GitHub Copilot Chat model picker
- **Thinking mode** with `reasoning_content` multi-turn caching
- **Reasoning effort** control (`high` / `max`)
- **Vision proxy** — route image attachments through any other installed Copilot Chat model
- **Tool calling** — full agent-mode support (file edits, terminal, search, Git, tests, MCP, skills)
- **Prompt cache stats** logged to output channel (hit / miss / rate)
- **BYOK** — API key stored in VS Code `SecretStorage` (OS keychain)
- Configurable `baseUrl`, `maxTokens`, `visionModel`, `visionPrompt`
- First-run welcome message to guide API key setup
