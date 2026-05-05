// @ts-nocheck
/* eslint-disable */
(function () {
	const vscode = acquireVsCodeApi();

	// ---- State ----
	let providers = [];
	let providerKeys = {};
	let models = [];
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

	function post(msg) { vscode.postMessage(msg); }

	// ---- VS Code messaging ----
	window.addEventListener('message', function (e) {
		var msg = e.data;
		switch (msg.type) {
			case 'init':
				providers = msg.payload.providers || [];
				providerKeys = msg.payload.providerKeys || {};
				models = msg.payload.models || [];
				renderProviders();
				renderModels();
				break;
			case 'modelsFetched':
				renderFetchedModels(msg.providerId, msg.models);
				break;
			case 'modelsFetchError':
				alert('Failed to fetch models: ' + msg.error);
				break;
			case 'confirmResponse':
				break;
		}
	});

	post({ type: 'requestInit' });

	// ===== PROVIDER RENDER =====

	function renderProviders() {
		if (!providers.length) {
			providerList.innerHTML = '<div class="empty">No providers configured.</div>';
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
					'<div class="meta">' + esc(p.baseUrl) + (hasKey ? ' · API Key ✓' : ' · No API Key') + '</div>' +
				'</div>' +
				'<div class="card-actions">' +
					'<button class="btn secondary small edit-p" data-id="' + esc(p.id) + '">Edit</button>' +
					'<button class="btn danger small del-p" data-id="' + esc(p.id) + '">Delete</button>' +
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
			modelList.innerHTML = '<div class="empty">No models configured. Click "+ Add Model" to add one.</div>';
			return;
		}
		modelList.innerHTML = '';
		for (var i = 0; i < models.length; i++) {
			var m = models[i];
			var card = document.createElement('div');
			card.className = 'card' + (m.hidden ? ' card-hidden' : '');
			var badges = [];
			if (m.builtin) badges.push('⭐ Built-in');
			if (m.hidden) badges.push('🚫 Hidden');
			if (m.toolCalling) badges.push('🔧 Tools');
			if (m.vision) badges.push('👁 Vision');
			if (m.thinking) badges.push('🧠 Thinking');
			var actions = '';
			if (m.hidden) {
				actions = '<button class="btn primary small show-m" data-id="' + esc(m.id) + '">Show</button>';
			} else {
				actions =
					'<button class="btn secondary small edit-m" data-id="' + esc(m.id) + '">Edit</button>' +
					'<button class="btn danger small del-m" data-id="' + esc(m.id) + '">' + (m.builtin ? 'Hide' : 'Delete') + '</button>';
			}
			card.innerHTML =
				'<div class="card-info">' +
					'<div class="name">' + esc(m.name) + ' <span style="color:var(--vscode-descriptionForeground);font-size:11px">(' + esc(m.id) + ')</span></div>' +
					'<div class="meta">' +
						'Provider: ' + esc(m.providerId) +
						' · Context: ' + formatNum(m.maxInputTokens) +
						' · Output: ' + formatNum(m.maxOutputTokens) +
						(m.temperature !== undefined && m.temperature !== null ? ' · Temp: ' + m.temperature : '') +
						(m.topP !== undefined && m.topP !== null ? ' · TopP: ' + m.topP : '') +
						' · ' + badges.join(' ') +
					'</div>' +
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
			document.getElementById('pfTitle').textContent = 'Edit Provider: ' + (p ? p.name : providerId);
			document.getElementById('pf-id').value = p ? p.id : '';
			document.getElementById('pf-id').disabled = true;
			document.getElementById('pf-name').value = p ? p.name : '';
			document.getElementById('pf-baseUrl').value = p ? p.baseUrl : '';
			document.getElementById('pf-apiKey').value = providerKeys[providerId] || '';
			document.getElementById('pf-apiKey').placeholder = providerKeys[providerId] ? '•••••••• (keep to retain)' : 'sk-...';
		} else {
			document.getElementById('pfTitle').textContent = 'Add Provider';
			document.getElementById('pf-id').value = '';
			document.getElementById('pf-id').disabled = false;
			document.getElementById('pf-name').value = '';
			document.getElementById('pf-baseUrl').value = '';
			document.getElementById('pf-apiKey').value = '';
			document.getElementById('pf-apiKey').placeholder = 'sk-...';
		}
	}

	document.getElementById('pf-save').addEventListener('click', function () {
		var id = document.getElementById('pf-id').value.trim();
		var name = document.getElementById('pf-name').value.trim();
		var baseUrl = document.getElementById('pf-baseUrl').value.trim();
		var apiKey = document.getElementById('pf-apiKey').value;
		if (!id) { alert('Provider ID is required'); return; }
		if (!name) { alert('Display Name is required'); return; }
		if (!baseUrl) { alert('Base URL is required'); return; }
		post({
			type: editingProviderId ? 'updateProvider' : 'addProvider',
			provider: { id: id, name: name, baseUrl: baseUrl },
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
		if (!baseUrl) { alert('Base URL is required'); return; }
		if (!apiKey) { alert('API Key is required to fetch models'); return; }
		post({ type: 'fetchModels', providerId: providerId, baseUrl: baseUrl, apiKey: apiKey });
	});

	function renderFetchedModels(providerId, fetchedModels) {
		fetchedModelsSection.style.display = 'block';
		if (!fetchedModels.length) {
			fetchedModelsList.innerHTML = '<div class="empty">No models found.</div>';
			return;
		}
		fetchedModelsList.innerHTML = '';
		for (var i = 0; i < fetchedModels.length; i++) {
			var m = fetchedModels[i];
			var row = document.createElement('div');
			row.className = 'model-row';
			row.innerHTML = '<span class="model-id">' + esc(m.id) + '</span>' +
				'<button class="btn small secondary use-model" data-id="' + esc(m.id) + '">Use as Model</button>';
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
		post({ type: 'requestConfirm', id: 'dp-' + id, message: 'Delete provider "' + id + '" and its API key?' });
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
		sel.innerHTML = '<option value="">Select Provider</option>';
		for (var i = 0; i < providers.length; i++) {
			sel.innerHTML += '<option value="' + esc(providers[i].id) + '">' + esc(providers[i].name) + '</option>';
		}
		if (modelId) {
			var m = models.find(function (x) { return x.id === modelId; });
			document.getElementById('mfTitle').textContent = 'Edit Model: ' + (m ? m.name : modelId);
			document.getElementById('mf-id').value = m ? m.id : '';
			document.getElementById('mf-id').disabled = true;
			document.getElementById('mf-name').value = m ? m.name : '';
			document.getElementById('mf-providerId').value = m ? m.providerId : '';
			document.getElementById('mf-maxInputTokens').value = m ? m.maxInputTokens : '';
			document.getElementById('mf-maxOutputTokens').value = m ? m.maxOutputTokens : '';
			document.getElementById('mf-temperature').value = m && m.temperature !== undefined ? m.temperature : '';
			document.getElementById('mf-topP').value = m && m.topP !== undefined ? m.topP : '';
			document.getElementById('mf-toolCalling').value = m ? String(!!m.toolCalling) : 'true';
			document.getElementById('mf-vision').value = m ? String(!!m.vision) : 'false';
			document.getElementById('mf-thinking').value = m ? String(!!m.thinking) : 'true';
		} else {
			document.getElementById('mfTitle').textContent = 'Add Model';
			document.getElementById('mf-id').value = '';
			document.getElementById('mf-id').disabled = false;
			document.getElementById('mf-name').value = '';
			document.getElementById('mf-providerId').value = '';
			document.getElementById('mf-maxInputTokens').value = '';
			document.getElementById('mf-maxOutputTokens').value = '';
			document.getElementById('mf-temperature').value = '';
			document.getElementById('mf-topP').value = '';
			document.getElementById('mf-toolCalling').value = 'true';
			document.getElementById('mf-vision').value = 'false';
			document.getElementById('mf-thinking').value = 'true';
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
		if (!id) { alert('Model ID is required'); return; }
		if (!name) { alert('Display Name is required'); return; }
		if (!providerId) { alert('Provider is required'); return; }
		if (isNaN(maxIn) || maxIn <= 0) { alert('Context Window is required'); return; }
		if (isNaN(maxOut) || maxOut <= 0) { alert('Max Output Tokens is required'); return; }
		var model = {
			id: id,
			name: name,
			providerId: providerId,
			maxInputTokens: maxIn,
			maxOutputTokens: maxOut,
			toolCalling: document.getElementById('mf-toolCalling').value === 'true',
			vision: document.getElementById('mf-vision').value === 'true',
			thinking: document.getElementById('mf-thinking').value === 'true',
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
		var msg = isBuiltin ? 'Hide built-in model "' + id + '" from the model picker?' : 'Delete model "' + id + '"?';
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
				vision: m.vision,
				thinking: m.thinking,
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
