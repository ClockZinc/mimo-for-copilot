// @ts-nocheck
/* eslint-disable */
(function () {
	const vscode = acquireVsCodeApi();

	// ---- State ----
	let providers = [];
	let providerKeys = {};
	let models = [];
	let memorySettings = { enabled: false, recallModel: 'mimo-v2-pro', modelOptions: [] };
	let compressionSettings = {
		enabled: true,
		compressImages: true,
		truncateLongToolOutputs: false,
		summarizeStructuredOutputs: false,
		useToolTypePolicies: false,
		showCompressionNotice: false,
		maxToolOutputChars: 8000,
		smallToolImageBytes: 262144,
		maxCompressedImageBytes: 524288,
		imageOutputFormat: 'auto',
		primaryImageMaxEdge: 1024,
		primaryImageQuality: 80,
		fallbackImageMaxEdge: 512,
		fallbackImageQuality: 70,
		keepOriginalImagesWhenDisabled: false,
	};
	let responsesRuntimeSettings = {
		waitingForResponseThresholdSeconds: 15,
		noFeedbackReconnectSeconds: 30,
		maxNoFeedbackReconnectAttempts: 3,
	};
	let strings = {};
	let editingProviderId = null;
	let editingModelId = null;
	const DEFAULT_REASONING_EFFORTS = ['none', 'high', 'max'];
	const DEFAULT_VERBOSITY_OPTIONS = ['low', 'medium', 'high'];
	const MODEL_TEMPLATES = {
		'gpt-5.5': {
			name: 'GPT-5.5', maxInputTokens: 258000, maxOutputTokens: 128000,
			toolCalling: true, nativeVision: true, enhancedVision: false, thinking: true, requiresThinkingParam: true,
			temperature: 1, supportedApiModes: ['responses'],
			reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'medium',
			verbosityOptions: ['low', 'medium', 'high'], defaultVerbosity: 'medium',
		},
		'gpt-5.4': {
			name: 'GPT-5.4', maxInputTokens: 1050000, maxOutputTokens: 128000,
			toolCalling: true, nativeVision: true, enhancedVision: false, thinking: true, requiresThinkingParam: true,
			temperature: 1, supportedApiModes: ['responses'],
			reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'none',
			verbosityOptions: ['low', 'medium', 'high'], defaultVerbosity: 'high',
		},
	};

	// ---- DOM refs ----
	const providerList = document.getElementById('providerList');
	const providerForm = document.getElementById('providerForm');
	const addProviderBtn = document.getElementById('addProviderBtn');
	const modelList = document.getElementById('modelList');
	const modelForm = document.getElementById('modelForm');
	const addModelBtn = document.getElementById('addModelBtn');
	const fetchedModelsSection = document.getElementById('fetchedModels');
	const fetchedModelsList = document.getElementById('fetchedModelsList');
	const memoryEnabled = document.getElementById('memoryEnabled');
	const memoryRecallModel = document.getElementById('memoryRecallModel');
	const memorySaveBtn = document.getElementById('memorySaveBtn');
	const compressionEnabled = document.getElementById('compressionEnabled');
	const compressionNotice = document.getElementById('compressionNotice');
	const compressionImages = document.getElementById('compressionImages');
	const compressionStructured = document.getElementById('compressionStructured');
	const compressionTruncate = document.getElementById('compressionTruncate');
	const compressionToolPolicies = document.getElementById('compressionToolPolicies');
	const compressionMaxChars = document.getElementById('compressionMaxChars');
	const compressionSmallImageKb = document.getElementById('compressionSmallImageKb');
	const compressionImageOutputFormat = document.getElementById('compressionImageOutputFormat');
	const compressionMaxImageKb = document.getElementById('compressionMaxImageKb');
	const compressionPrimaryImageMaxEdge = document.getElementById('compressionPrimaryImageMaxEdge');
	const compressionPrimaryImageQuality = document.getElementById('compressionPrimaryImageQuality');
	const compressionFallbackImageMaxEdge = document.getElementById('compressionFallbackImageMaxEdge');
	const compressionFallbackImageQuality = document.getElementById('compressionFallbackImageQuality');
	const compressionKeepOriginalImages = document.getElementById('compressionKeepOriginalImages');
	const waitingForResponseThresholdSecondsInput = document.getElementById('waitingForResponseThresholdSeconds');
	const noFeedbackReconnectSecondsInput = document.getElementById('noFeedbackReconnectSeconds');
	const maxNoFeedbackReconnectAttemptsInput = document.getElementById('maxNoFeedbackReconnectAttempts');
	const responsesRuntimeSaveBtn = document.getElementById('responsesRuntimeSaveBtn');
	const compressionCouplingHint = document.getElementById('compressionCouplingHint');
	const compressionSaveBtn = document.getElementById('compressionSaveBtn');

	function post(msg) { vscode.postMessage(msg); }

	// ---- VS Code messaging ----
	window.addEventListener('message', function (e) {
		var msg = e.data;
		switch (msg.type) {
			case 'init':
				providers = msg.payload.providers || [];
				providerKeys = msg.payload.providerKeys || {};
				models = msg.payload.models || [];
				memorySettings = msg.payload.memorySettings || memorySettings;
				compressionSettings = msg.payload.compressionSettings || compressionSettings;
				responsesRuntimeSettings = msg.payload.responsesRuntimeSettings || responsesRuntimeSettings;
				strings = msg.payload.strings || strings;
				renderMemorySettings();
				renderCompressionSettings();
				renderResponsesRuntimeSettings();
				renderProviders();
				renderModels();
				break;
			case 'modelsFetched':
				renderFetchedModels(msg.providerId, msg.models);
				break;
			case 'modelsFetchError':
				alert(format(strings.providersFetchFailed, msg.error));
				break;
			case 'confirmResponse':
				break;
		}
	});

	post({ type: 'requestInit' });

	function format(text) {
		var args = Array.prototype.slice.call(arguments, 1);
		return String(text || '').replace(/\{(\d+)\}/g, function (_, index) {
			var value = args[Number(index)];
			return value === undefined ? '' : String(value);
		});
	}

	function normalizeModelTemplateId(id) {
		return String(id || '').trim().toLowerCase().replace(/^gpt(\d)/, 'gpt-$1');
	}

	function checkedValues(containerId) {
		var el = document.getElementById(containerId);
		return Array.prototype.slice.call(el.querySelectorAll('input[type="checkbox"]:checked')).map(function (input) { return input.value; });
	}

	function setCheckedValues(containerId, values) {
		var set = new Set(values || []);
		var el = document.getElementById(containerId);
		Array.prototype.slice.call(el.querySelectorAll('input[type="checkbox"]')).forEach(function (input) {
			input.checked = set.has(input.value);
		});
	}

	function renderSelectOptions(selectId, values, selected) {
		var select = document.getElementById(selectId);
		select.innerHTML = '';
		(values || []).forEach(function (value) {
			var option = document.createElement('option');
			option.value = value;
			option.textContent = value;
			select.appendChild(option);
		});
		if (selected && values && values.indexOf(selected) >= 0) select.value = selected;
	}

	function updateModelOptionSelects(defaultReasoning, defaultVerbosity) {
		var efforts = checkedValues('mf-reasoningEfforts');
		var verbosity = checkedValues('mf-verbosityOptions');
		renderSelectOptions('mf-defaultReasoningEffort', efforts, defaultReasoning || document.getElementById('mf-defaultReasoningEffort').value || efforts[0]);
		renderSelectOptions('mf-defaultVerbosity', verbosity, defaultVerbosity || document.getElementById('mf-defaultVerbosity').value || verbosity[0]);
	}

	function applyModelTemplateIfKnown(force) {
		if (editingModelId && !force) return;
		var id = normalizeModelTemplateId(document.getElementById('mf-id').value);
		var template = MODEL_TEMPLATES[id];
		if (!template) return;
		function setIfEmpty(elementId, value) {
			var el = document.getElementById(elementId);
			if (force || !el.value) el.value = value === undefined || value === null ? '' : String(value);
		}
		setIfEmpty('mf-name', template.name);
		setIfEmpty('mf-maxInputTokens', template.maxInputTokens);
		setIfEmpty('mf-maxOutputTokens', template.maxOutputTokens);
		setIfEmpty('mf-temperature', template.temperature);
		setIfEmpty('mf-topP', template.topP);
		document.getElementById('mf-toolCalling').value = String(!!template.toolCalling);
		document.getElementById('mf-nativeVision').value = String(!!template.nativeVision);
		document.getElementById('mf-enhancedVision').value = String(!!template.enhancedVision);
		document.getElementById('mf-thinking').value = String(!!template.thinking);
		document.getElementById('mf-requiresThinkingParam').value = String(!!template.requiresThinkingParam);
		setCheckedValues('mf-supportedApiModes', template.supportedApiModes);
		setCheckedValues('mf-reasoningEfforts', template.reasoningEfforts);
		setCheckedValues('mf-verbosityOptions', template.verbosityOptions);
		updateModelOptionSelects(template.defaultReasoningEffort, template.defaultVerbosity);
	}

	function renderMemorySettings() {
		memoryEnabled.checked = !!memorySettings.enabled;
		memoryRecallModel.innerHTML = '';
		var options = memorySettings.modelOptions || [];
		for (var i = 0; i < options.length; i++) {
			var option = document.createElement('option');
			option.value = options[i].id;
			option.textContent = options[i].name + ' (' + options[i].id + ')';
			memoryRecallModel.appendChild(option);
		}
		if (!options.length) {
			var fallback = document.createElement('option');
			fallback.value = 'mimo-v2-pro';
			fallback.textContent = 'MiMo V2 Pro (mimo-v2-pro)';
			memoryRecallModel.appendChild(fallback);
		}
		memoryRecallModel.value = memorySettings.recallModel || 'mimo-v2-pro';
	}

	memorySaveBtn.addEventListener('click', function () {
		post({
			type: 'saveMemorySettings',
			enabled: !!memoryEnabled.checked,
			recallModel: memoryRecallModel.value || 'mimo-v2-pro',
		});
	});

	function renderCompressionSettings() {
		compressionEnabled.checked = !!compressionSettings.enabled;
		compressionImages.checked = !!compressionSettings.compressImages;
		compressionTruncate.checked = !!compressionSettings.truncateLongToolOutputs;
		compressionStructured.checked = !!compressionSettings.summarizeStructuredOutputs;
		compressionToolPolicies.checked = !!compressionSettings.useToolTypePolicies;
		compressionNotice.checked = !!compressionSettings.showCompressionNotice;
		compressionMaxChars.value = compressionSettings.maxToolOutputChars || 8000;
		compressionSmallImageKb.value = Math.round((compressionSettings.smallToolImageBytes || 262144) / 1024);
		compressionImageOutputFormat.value = compressionSettings.imageOutputFormat || 'auto';
		compressionMaxImageKb.value = Math.round((compressionSettings.maxCompressedImageBytes || 524288) / 1024);
		compressionPrimaryImageMaxEdge.value = compressionSettings.primaryImageMaxEdge || 1024;
		compressionPrimaryImageQuality.value = compressionSettings.primaryImageQuality || 80;
		compressionFallbackImageMaxEdge.value = compressionSettings.fallbackImageMaxEdge || 512;
		compressionFallbackImageQuality.value = compressionSettings.fallbackImageQuality || 70;
		compressionKeepOriginalImages.checked = !!compressionSettings.keepOriginalImagesWhenDisabled;
		updateCompressionInterlocks();
	}

	function renderResponsesRuntimeSettings() {
		waitingForResponseThresholdSecondsInput.value = responsesRuntimeSettings.waitingForResponseThresholdSeconds || 15;
		noFeedbackReconnectSecondsInput.value = responsesRuntimeSettings.noFeedbackReconnectSeconds || 30;
		maxNoFeedbackReconnectAttemptsInput.value = responsesRuntimeSettings.maxNoFeedbackReconnectAttempts || 3;
	}

	function updateCompressionInterlocks() {
		var enabled = !!compressionEnabled.checked;
		var truncation = !!compressionTruncate.checked;
		[
			compressionImages,
			compressionTruncate,
			compressionStructured,
			compressionNotice,
			compressionMaxChars,
			compressionSmallImageKb,
			compressionImageOutputFormat,
			compressionMaxImageKb,
			compressionPrimaryImageMaxEdge,
			compressionPrimaryImageQuality,
			compressionFallbackImageMaxEdge,
			compressionFallbackImageQuality,
			compressionKeepOriginalImages,
		].forEach(function (el) { el.disabled = !enabled; });
		[
			compressionMaxChars,
			compressionSmallImageKb,
			compressionImageOutputFormat,
			compressionMaxImageKb,
			compressionPrimaryImageMaxEdge,
			compressionPrimaryImageQuality,
			compressionFallbackImageMaxEdge,
			compressionFallbackImageQuality,
		].forEach(function (el) { el.disabled = !enabled || !compressionImages.checked; });
		compressionMaxChars.disabled = !enabled || !truncation;
		compressionKeepOriginalImages.disabled = !enabled || compressionImages.checked;
		compressionToolPolicies.disabled = !enabled || !truncation;
		if (!truncation) {
			compressionToolPolicies.checked = false;
		}
		var hints = [];
		if (!enabled) hints.push(strings.compressionMasterOffHint);
		if (enabled && !truncation) hints.push(strings.compressionPolicyDisabledHint);
		if (enabled && !compressionImages.checked) hints.push(strings.compressionImageDisabledHint);
		compressionCouplingHint.textContent = hints.join(' ');
	}

	[
		compressionEnabled,
		compressionImages,
		compressionTruncate,
		compressionStructured,
		compressionToolPolicies,
		compressionNotice,
		compressionKeepOriginalImages,
	].forEach(function (el) {
		el.addEventListener('change', updateCompressionInterlocks);
	});

	compressionSaveBtn.addEventListener('click', function () {
		post({
			type: 'saveCompressionSettings',
			settings: {
				enabled: !!compressionEnabled.checked,
				compressImages: !!compressionImages.checked,
				truncateLongToolOutputs: !!compressionTruncate.checked,
				summarizeStructuredOutputs: !!compressionStructured.checked,
				useToolTypePolicies: !!compressionToolPolicies.checked,
				showCompressionNotice: !!compressionNotice.checked,
				maxToolOutputChars: parseInt(compressionMaxChars.value, 10) || 8000,
				smallToolImageBytes: (parseInt(compressionSmallImageKb.value, 10) || 256) * 1024,
				imageOutputFormat: compressionImageOutputFormat.value || 'auto',
				maxCompressedImageBytes: (parseInt(compressionMaxImageKb.value, 10) || 512) * 1024,
				primaryImageMaxEdge: parseInt(compressionPrimaryImageMaxEdge.value, 10) || 1024,
				primaryImageQuality: parseInt(compressionPrimaryImageQuality.value, 10) || 80,
				fallbackImageMaxEdge: parseInt(compressionFallbackImageMaxEdge.value, 10) || 512,
				fallbackImageQuality: parseInt(compressionFallbackImageQuality.value, 10) || 70,
				keepOriginalImagesWhenDisabled: !!compressionKeepOriginalImages.checked,
			},
		});
	});

	responsesRuntimeSaveBtn.addEventListener('click', function () {
		post({
			type: 'saveResponsesRuntimeSettings',
			settings: {
				waitingForResponseThresholdSeconds: parseInt(waitingForResponseThresholdSecondsInput.value, 10) || 15,
				noFeedbackReconnectSeconds: parseInt(noFeedbackReconnectSecondsInput.value, 10) || 30,
				maxNoFeedbackReconnectAttempts: parseInt(maxNoFeedbackReconnectAttemptsInput.value, 10) || 3,
			},
		});
	});

	// ===== PROVIDER RENDER =====

	function renderProviders() {
		if (!providers.length) {
			providerList.innerHTML = '<div class="empty">' + esc(strings.providersEmpty) + '</div>';
			return;
		}
		providerList.innerHTML = '';
		for (var i = 0; i < providers.length; i++) {
			var p = providers[i];
			var hasKey = !!providerKeys[p.id];
			var card = document.createElement('div');
			card.className = 'card';
			card.innerHTML =
				'<div class="card-info">' +
					'<div class="name">' + esc(p.name) + ' <span style="color:var(--vscode-descriptionForeground);font-size:11px">(' + esc(p.id) + ')</span></div>' +
					'<div class="meta">' + esc(p.baseUrl) + (hasKey ? strings.providersApiKeyPresent : strings.providersApiKeyMissing) + '</div>' +
				'</div>' +
				'<div class="card-actions">' +
					'<button class="btn secondary small edit-p" data-id="' + esc(p.id) + '">' + esc(strings.providersEditButton) + '</button>' +
					'<button class="btn danger small del-p" data-id="' + esc(p.id) + '">' + esc(strings.providersDeleteButton) + '</button>' +
				'</div>';
			providerList.appendChild(card);
		}
		providerList.querySelectorAll('.edit-p').forEach(function (b) {
			b.addEventListener('click', function () { showProviderForm(b.dataset.id); });
		});
		providerList.querySelectorAll('.del-p').forEach(function (b) {
			b.addEventListener('click', function () { deleteProvider(b.dataset.id); });
		});
	}

	// ===== MODEL RENDER =====

	function renderModels() {
		if (!models.length) {
			modelList.innerHTML = '<div class="empty">' + esc(strings.modelsEmpty) + '</div>';
			return;
		}
		modelList.innerHTML = '';
		for (var i = 0; i < models.length; i++) {
			var m = models[i];
			var card = document.createElement('div');
			card.className = 'card' + (m.hidden ? ' card-hidden' : '');
			var badges = [];
			if (m.builtin) badges.push(strings.modelsBadgeBuiltin);
			if (m.hidden) badges.push(strings.modelsBadgeHidden);
			if (m.toolCalling) badges.push(strings.modelsBadgeTools);
			if (m.nativeVision) badges.push(strings.modelsBadgeNativeVision);
			if (m.enhancedVision) badges.push(strings.modelsBadgeEnhancedVision);
			if (m.thinking) badges.push(strings.modelsBadgeThinking);
			var actions = '';
			if (m.hidden) {
				actions = '<button class="btn primary small show-m" data-id="' + esc(m.key || m.id) + '">' + esc(strings.modelsShowButton) + '</button>';
			} else {
				actions =
					'<button class="btn secondary small edit-m" data-id="' + esc(m.key || m.id) + '">' + esc(strings.modelsEditButton) + '</button>' +
					'<button class="btn danger small del-m" data-id="' + esc(m.key || m.id) + '">' + esc(m.builtin ? strings.modelsHideButton : strings.modelsDeleteButton) + '</button>';
			}
			var metaParts = [
				format(strings.modelsMetaProvider, m.providerId),
				format(strings.modelsMetaContext, formatNum(m.maxInputTokens)),
				format(strings.modelsMetaOutput, formatNum(m.maxOutputTokens))
			];
			if (m.temperature !== undefined && m.temperature !== null) metaParts.push(format(strings.modelsMetaTemp, m.temperature));
			if (m.topP !== undefined && m.topP !== null) metaParts.push(format(strings.modelsMetaTopP, m.topP));
			if (badges.length) metaParts.push(badges.join(' '));
			card.innerHTML =
				'<div class="card-info">' +
					'<div class="name">' + esc(m.name) + ' <span style="color:var(--vscode-descriptionForeground);font-size:11px">(' + esc(m.id) + ')</span></div>' +
					'<div class="meta">' + metaParts.join(' · ') + '</div>' +
				'</div>' +
				'<div class="card-actions">' + actions + '</div>';
			modelList.appendChild(card);
		}
		modelList.querySelectorAll('.edit-m').forEach(function (b) {
			b.addEventListener('click', function () { showModelForm(b.dataset.id); });
		});
		modelList.querySelectorAll('.del-m').forEach(function (b) {
			b.addEventListener('click', function () { deleteModel(b.dataset.id); });
		});
		modelList.querySelectorAll('.show-m').forEach(function (b) {
			b.addEventListener('click', function () { showModel(b.dataset.id); });
		});
	}

	// ===== PROVIDER FORM =====

	addProviderBtn.addEventListener('click', function () { showProviderForm(null); });

	function showProviderForm(providerId) {
		editingProviderId = providerId;
		providerForm.style.display = 'block';
		modelForm.style.display = 'none';
		fetchedModelsSection.style.display = 'none';
		if (providerId) {
			var p = providers.find(function (x) { return x.id === providerId; });
			document.getElementById('pfTitle').textContent = format(strings.providersFormEditTitle, p ? p.name : providerId);
			document.getElementById('pf-id').value = p ? p.id : '';
			document.getElementById('pf-id').disabled = true;
			document.getElementById('pf-name').value = p ? p.name : '';
			document.getElementById('pf-apiMode').value = p && p.apiMode === 'responses' ? 'responses' : 'chat-completions';
			document.getElementById('pf-baseUrl').value = p ? p.baseUrl : '';
			document.getElementById('pf-apiKey').value = providerKeys[providerId] || '';
			document.getElementById('pf-apiKey').placeholder = providerKeys[providerId] ? strings.providersFormApiKeyRetainPlaceholder : strings.providersFormApiKeyPlaceholder;
		} else {
			document.getElementById('pfTitle').textContent = strings.providersFormAddTitle;
			document.getElementById('pf-id').value = '';
			document.getElementById('pf-id').disabled = false;
			document.getElementById('pf-name').value = '';
			document.getElementById('pf-apiMode').value = 'chat-completions';
			document.getElementById('pf-baseUrl').value = '';
			document.getElementById('pf-apiKey').value = '';
			document.getElementById('pf-apiKey').placeholder = strings.providersFormApiKeyPlaceholder;
		}
	}

	document.getElementById('pf-save').addEventListener('click', function () {
		var id = document.getElementById('pf-id').value.trim();
		var name = document.getElementById('pf-name').value.trim();
		var apiMode = document.getElementById('pf-apiMode').value;
		var baseUrl = document.getElementById('pf-baseUrl').value.trim();
		var apiKey = document.getElementById('pf-apiKey').value;
		if (!id) { alert(strings.providersIdRequired); return; }
		if (!name) { alert(strings.providersNameRequired); return; }
		if (!baseUrl) { alert(strings.providersBaseUrlRequired); return; }
		post({
			type: editingProviderId ? 'updateProvider' : 'addProvider',
			provider: { id: id, name: name, baseUrl: baseUrl, apiMode: apiMode === 'responses' ? 'responses' : undefined },
			apiKey: apiKey || undefined,
		});
		providerForm.style.display = 'none';
		editingProviderId = null;
	});

	document.getElementById('pf-cancel').addEventListener('click', function () {
		providerForm.style.display = 'none';
		editingProviderId = null;
	});

	document.getElementById('pf-apiKey-toggle').addEventListener('click', function () {
		var input = document.getElementById('pf-apiKey');
		input.type = input.type === 'password' ? 'text' : 'password';
	});

	document.getElementById('pf-fetchModels').addEventListener('click', function () {
		var baseUrl = document.getElementById('pf-baseUrl').value.trim();
		var apiKey = document.getElementById('pf-apiKey').value;
		var providerId = document.getElementById('pf-id').value.trim();
		if (!baseUrl) { alert(strings.providersBaseUrlRequired); return; }
		if (!apiKey) { alert(strings.providersFetchApiKeyRequired); return; }
		post({ type: 'fetchModels', providerId: providerId, baseUrl: baseUrl, apiKey: apiKey });
	});

	function renderFetchedModels(providerId, fetchedModels) {
		fetchedModelsSection.style.display = 'block';
		if (!fetchedModels.length) {
			fetchedModelsList.innerHTML = '<div class="empty">' + esc(strings.providersNoModelsFound) + '</div>';
			return;
		}
		fetchedModelsList.innerHTML = '';
		for (var i = 0; i < fetchedModels.length; i++) {
			var m = fetchedModels[i];
			var row = document.createElement('div');
			row.className = 'model-row';
			row.innerHTML = '<span class="model-id">' + esc(m.id) + '</span>' +
				'<button class="btn small secondary use-model" data-id="' + esc(m.id) + '">' + esc(strings.providersUseAsModel) + '</button>';
			fetchedModelsList.appendChild(row);
		}
		fetchedModelsList.querySelectorAll('.use-model').forEach(function (b) {
			b.addEventListener('click', function () {
				showModelForm(null);
				document.getElementById('mf-id').value = b.dataset.id;
				document.getElementById('mf-name').value = b.dataset.id;
				document.getElementById('mf-providerId').value = providerId;
				applyModelTemplateIfKnown(true);
			});
		});
	}

	function deleteProvider(id) {
		post({ type: 'requestConfirm', id: 'dp-' + id, message: format(strings.providersDeleteConfirm, id) });
		var handler = function (e) {
			if (e.data.type === 'confirmResponse' && e.data.id === 'dp-' + id) {
				window.removeEventListener('message', handler);
				if (e.data.confirmed) { post({ type: 'deleteProvider', providerId: id }); }
			}
		};
		window.addEventListener('message', handler);
	}

	// ===== MODEL FORM =====

	addModelBtn.addEventListener('click', function () { showModelForm(null); });

	function showModelForm(modelId) {
		editingModelId = modelId;
		modelForm.style.display = 'block';
		providerForm.style.display = 'none';
		// Populate provider dropdown
		var sel = document.getElementById('mf-providerId');
		sel.innerHTML = '<option value="">' + esc(strings.modelsFormProviderPlaceholder) + '</option>';
		for (var i = 0; i < providers.length; i++) {
			sel.innerHTML += '<option value="' + esc(providers[i].id) + '">' + esc(providers[i].name) + '</option>';
		}
		if (modelId) {
			var m = models.find(function (x) { return (x.key || x.id) === modelId; });
			document.getElementById('mfTitle').textContent = format(strings.modelsFormEditTitle, m ? m.name : modelId);
			document.getElementById('mf-id').value = m ? m.id : '';
			document.getElementById('mf-id').disabled = true;
			document.getElementById('mf-name').value = m ? m.name : '';
			document.getElementById('mf-providerId').value = m ? m.providerId : '';
			document.getElementById('mf-maxInputTokens').value = m ? m.maxInputTokens : '';
			document.getElementById('mf-maxOutputTokens').value = m ? m.maxOutputTokens : '';
			document.getElementById('mf-temperature').value = m && m.temperature !== undefined ? m.temperature : '';
			document.getElementById('mf-topP').value = m && m.topP !== undefined ? m.topP : '';
			document.getElementById('mf-toolCalling').value = m ? String(!!m.toolCalling) : 'true';
			document.getElementById('mf-nativeVision').value = m ? String(!!m.nativeVision) : 'false';
			document.getElementById('mf-enhancedVision').value = m ? String(!!m.enhancedVision) : 'true';
			document.getElementById('mf-thinking').value = m ? String(!!m.thinking) : 'true';
			document.getElementById('mf-requiresThinkingParam').value = m && m.requiresThinkingParam !== undefined ? String(!!m.requiresThinkingParam) : 'true';
			setCheckedValues('mf-supportedApiModes', m && m.supportedApiModes && m.supportedApiModes.length ? m.supportedApiModes : []);
			setCheckedValues('mf-reasoningEfforts', m && m.reasoningEfforts && m.reasoningEfforts.length ? m.reasoningEfforts : DEFAULT_REASONING_EFFORTS);
			setCheckedValues('mf-verbosityOptions', m && m.verbosityOptions && m.verbosityOptions.length ? m.verbosityOptions : DEFAULT_VERBOSITY_OPTIONS);
			updateModelOptionSelects(m ? m.defaultReasoningEffort : undefined, m ? m.defaultVerbosity : undefined);
		} else {
			document.getElementById('mfTitle').textContent = strings.modelsFormAddTitle;
			document.getElementById('mf-id').value = '';
			document.getElementById('mf-id').disabled = false;
			document.getElementById('mf-name').value = '';
			document.getElementById('mf-providerId').value = '';
			document.getElementById('mf-maxInputTokens').value = '';
			document.getElementById('mf-maxOutputTokens').value = '';
			document.getElementById('mf-temperature').value = '';
			document.getElementById('mf-topP').value = '';
			document.getElementById('mf-toolCalling').value = 'true';
			document.getElementById('mf-nativeVision').value = 'false';
			document.getElementById('mf-enhancedVision').value = 'false';
			document.getElementById('mf-thinking').value = 'true';
			document.getElementById('mf-requiresThinkingParam').value = 'true';
			setCheckedValues('mf-supportedApiModes', []);
			setCheckedValues('mf-reasoningEfforts', DEFAULT_REASONING_EFFORTS);
			setCheckedValues('mf-verbosityOptions', DEFAULT_VERBOSITY_OPTIONS);
			updateModelOptionSelects('high', 'high');
		}
		applyModelTemplateIfKnown(false);
	}

	['mf-reasoningEfforts', 'mf-verbosityOptions'].forEach(function (id) {
		document.getElementById(id).addEventListener('change', function () { updateModelOptionSelects(); });
	});
	document.getElementById('mf-id').addEventListener('input', function () { applyModelTemplateIfKnown(false); });

	document.getElementById('mf-save').addEventListener('click', function () {
		var id = document.getElementById('mf-id').value.trim();
		var name = document.getElementById('mf-name').value.trim();
		var providerId = document.getElementById('mf-providerId').value;
		var maxIn = parseInt(document.getElementById('mf-maxInputTokens').value, 10);
		var maxOut = parseInt(document.getElementById('mf-maxOutputTokens').value, 10);
		var temp = parseFloat(document.getElementById('mf-temperature').value);
		var topP = parseFloat(document.getElementById('mf-topP').value);
		var supportedApiModes = checkedValues('mf-supportedApiModes');
		var reasoningEfforts = checkedValues('mf-reasoningEfforts');
		var verbosityOptions = checkedValues('mf-verbosityOptions');
		if (!id) { alert(strings.modelsIdRequired); return; }
		if (!name) { alert(strings.modelsNameRequired); return; }
		if (!providerId) { alert(strings.modelsProviderRequired); return; }
		if (isNaN(maxIn) || maxIn <= 0) { alert(strings.modelsMaxInputRequired); return; }
		if (isNaN(maxOut) || maxOut <= 0) { alert(strings.modelsMaxOutputRequired); return; }
		var model = {
				key: editingModelId || ('user_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
			id: id,
			name: name,
			providerId: providerId,
			maxInputTokens: maxIn,
			maxOutputTokens: maxOut,
			toolCalling: document.getElementById('mf-toolCalling').value === 'true',
			nativeVision: document.getElementById('mf-nativeVision').value === 'true',
			enhancedVision: document.getElementById('mf-enhancedVision').value === 'true',
			thinking: document.getElementById('mf-thinking').value === 'true',
			requiresThinkingParam: document.getElementById('mf-requiresThinkingParam').value === 'true',
		};
		if (supportedApiModes.length) model.supportedApiModes = supportedApiModes;
		if (reasoningEfforts.length) model.reasoningEfforts = reasoningEfforts;
		if (reasoningEfforts.indexOf(document.getElementById('mf-defaultReasoningEffort').value) >= 0) model.defaultReasoningEffort = document.getElementById('mf-defaultReasoningEffort').value;
		if (verbosityOptions.length) model.verbosityOptions = verbosityOptions;
		if (verbosityOptions.indexOf(document.getElementById('mf-defaultVerbosity').value) >= 0) model.defaultVerbosity = document.getElementById('mf-defaultVerbosity').value;
		if (!isNaN(temp) && temp >= 0) model.temperature = temp;
		if (!isNaN(topP) && topP >= 0) model.topP = topP;
		post({
			type: editingModelId ? 'updateModel' : 'addModel',
			model: model,
			originalId: editingModelId || undefined,
		});
		modelForm.style.display = 'none';
		editingModelId = null;
	});

	document.getElementById('mf-cancel').addEventListener('click', function () {
		modelForm.style.display = 'none';
		editingModelId = null;
	});

	function deleteModel(id) {
		var m = models.find(function (x) { return (x.key || x.id) === id; });
		var isBuiltin = m && m.builtin;
		var msg = isBuiltin ? format(strings.modelsHideConfirm, id) : format(strings.modelsDeleteConfirm, id);
		post({ type: 'requestConfirm', id: 'dm-' + id, message: msg });
		var handler = function (e) {
			if (e.data.type === 'confirmResponse' && e.data.id === 'dm-' + id) {
				window.removeEventListener('message', handler);
				if (e.data.confirmed) { post({ type: 'deleteModel', modelId: id }); }
			}
		};
		window.addEventListener('message', handler);
	}

	function showModel(id) {
		post({ type: 'showModel', modelId: id });
	}

	// ===== Utils =====
	function esc(s) {
		var d = document.createElement('div');
		d.appendChild(document.createTextNode(s || ''));
		return d.innerHTML;
	}
	function formatNum(n) {
		if (n >= 1048576) return (n / 1048576).toFixed(1) + 'M';
		if (n >= 1024) return (n / 1024).toFixed(0) + 'K';
		return String(n);
	}
})();
