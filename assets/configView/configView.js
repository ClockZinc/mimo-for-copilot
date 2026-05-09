// @ts-nocheck
/* eslint-disable */
(function () {
	const vscode = acquireVsCodeApi();

	// ---- State ----
	let providers = [];
	let providerKeys = {};
	let models = [];
	let memorySettings = { enabled: false, recallModel: 'mimo-v2-pro', modelOptions: [] };
	let strings = {};
	let editingProviderId = null;
	let editingModelId = null;

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
					strings = msg.payload.strings || strings;
					renderMemorySettings();
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
				actions = '<button class="btn primary small show-m" data-id="' + esc(m.id) + '">' + esc(strings.modelsShowButton) + '</button>';
			} else {
				actions =
					'<button class="btn secondary small edit-m" data-id="' + esc(m.id) + '">' + esc(strings.modelsEditButton) + '</button>' +
					'<button class="btn danger small del-m" data-id="' + esc(m.id) + '">' + esc(m.builtin ? strings.modelsHideButton : strings.modelsDeleteButton) + '</button>';
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
			var m = models.find(function (x) { return x.id === modelId; });
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
			document.getElementById('mf-enhancedVision').value = 'true';
			document.getElementById('mf-thinking').value = 'true';
			document.getElementById('mf-requiresThinkingParam').value = 'true';
		}
	}

	document.getElementById('mf-save').addEventListener('click', function () {
		var id = document.getElementById('mf-id').value.trim();
		var name = document.getElementById('mf-name').value.trim();
		var providerId = document.getElementById('mf-providerId').value;
		var maxIn = parseInt(document.getElementById('mf-maxInputTokens').value, 10);
		var maxOut = parseInt(document.getElementById('mf-maxOutputTokens').value, 10);
		var temp = parseFloat(document.getElementById('mf-temperature').value);
		var topP = parseFloat(document.getElementById('mf-topP').value);
		if (!id) { alert(strings.modelsIdRequired); return; }
		if (!name) { alert(strings.modelsNameRequired); return; }
		if (!providerId) { alert(strings.modelsProviderRequired); return; }
		if (isNaN(maxIn) || maxIn <= 0) { alert(strings.modelsMaxInputRequired); return; }
		if (isNaN(maxOut) || maxOut <= 0) { alert(strings.modelsMaxOutputRequired); return; }
		var model = {
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
		var m = models.find(function (x) { return x.id === id; });
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
		// Unhide a built-in model by deleting it from hiddenModels (backend handles this)
		// We re-save the model with its current config to trigger unhide
		var m = models.find(function (x) { return x.id === id; });
		if (!m) return;
		post({
			type: 'updateModel',
			model: {
				id: m.id,
				name: m.name,
				providerId: m.providerId,
				maxInputTokens: m.maxInputTokens,
				maxOutputTokens: m.maxOutputTokens,
				toolCalling: m.toolCalling,
				nativeVision: m.nativeVision,
				enhancedVision: m.enhancedVision,
				thinking: m.thinking,
				requiresThinkingParam: m.requiresThinkingParam,
				temperature: m.temperature,
				topP: m.topP,
			},
			originalId: m.id,
		});
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
