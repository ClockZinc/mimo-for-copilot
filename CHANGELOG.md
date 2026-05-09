# Changelog

## [Unreleased]

### Features

* show actual post-compression prompt tokens and MiMo compression ratio in the token status tooltip
* always show a bold warning when oversized image tool outputs are removed before sending to the model
* set GPT-5.5 default limits to 258K input and 128K output tokens while keeping model overrides editable

### Bug Fixes

* avoid loading sharp during extension activation so commands still register on Linux when optional native packages are missing

### Documentation

* rename README screenshots with descriptive filenames
* credit the OAI-compatible Copilot-style configuration UI inspiration
* refresh the README hero section and extension metadata for a Marketplace-style landing page
* document Chat Completions provider API mode selection with a configuration screenshot

## [1.1.0](https://github.com/ClockZinc/mimo-for-copilot/compare/v1.0.1...v1.1.0) (2026-05-10)

### Features

* add Responses tool-output compression configuration page
* add real image compression with format-first strategy for tool image replay
* add image format selection, resize, quality, and replay controls
* add tool-type truncation policies and optional structured output summaries
* add transient compression notices that are shown once and filtered from replay history
* improve provider config UX with token-indicator entry workflow documentation

### Documentation

* rewrite README quick start and configuration guidance
* add screenshots for model picker, Agentic Memory, and Responses compression settings

## [1.0.1](https://github.com/ClockZinc/mimo-for-copilot/compare/v1.0.0...v1.0.1) (2026-05-06)


### Bug Fixes

* cascade uses provider-specific key only, not global fallback
* check sibling provider keys even if not in providers config
* configView cascade providerId + create model overrides when setting key
* merge DEFAULT_PROVIDERS into getProviders so cascade can find mimo-tp
* use user override providerId for model picker display


### Features

* add token usage status bar with click-to-config
* default enhancedVision off to improve response latency


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
