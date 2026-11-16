// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/*
 * Fake VS Code host for the webview UI tests.
 *
 * Runs in the browser (injected via page.addInitScript before any page
 * script). It installs `window.acquireVsCodeApi()` — the only contact
 * surface the webviews have with VS Code — and answers the message contract
 * the extension-side managers implement, from an in-memory store seeded by
 * the test:
 *
 *   hub-manager.ts          ready → hubState, setActiveEnvironment,
 *                           setDbmnSetting, openEndpointAsTab, addEndpoint,
 *                           openEnvironmentAsTab, addEnvironment, createSystem,
 *                           renameSystem, mergeSystem, accountReady,
 *                           openTagManager, __embeddedFromTab__ routing
 *   endpoint-manager.ts     ready → systemsList + populateEndpointData,
 *                           getEndpointData, getCurrentEnvironment, saveEndpoint,
 *                           checkEndpointTransactions, showX / validationError → dbmnToast
 *   environment-manager.ts  ready → systemsList + environmentLoaded,
 *                           loadEnvironment, saveEnvironment, setActiveEnvironment,
 *                           checkEnvironmentTransactions
 *   webview-base.ts         dbmnModalRequest / dbmnModalActionPending /
 *                           dbmnModalResult (host-driven modals)
 *
 * Hub editor tabs work the same way they do in the extension: the Hub asks
 * for `openEndpointAsTab`, the host answers `mountEmbeddedTab` with the
 * editor's full HTML, hub-tabs.js mounts it in a blob: iframe with its own
 * `acquireVsCodeApi` shim that envelopes messages as `__embeddedFromTab__`,
 * and the host routes them to a per-tab "manager" here.
 *
 * This is deliberately a stateful fake and not a table of canned replies —
 * it is the seed of the `IHostBridge` web adapter described in
 * docs/portability/spa-migration.md (Phase 1). Keep it free of Playwright
 * or test-only assumptions.
 *
 * Test-facing API (window.__dbmnFakeHost):
 *   sent      every message the UI posted: { tabId|null, message, at }
 *   received  every message delivered to the UI: { tabId|null, message, at }
 *   state()   the live store (endpoints, systems, environments, …)
 *   push(m)   deliver a message to the top-level webview
 *   pushToTab(tabId, m)  deliver a message into an editor tab
 *   tabs()    open tab ids
 */
(function () {
    'use strict';

    // Top frame only. Editor tab iframes get hub-tabs.js's own shim, which
    // runs after init scripts and must win there.
    if (window.parent !== window) return;
    if (window.__dbmnFakeHost) return;

    var cfg = window.__DBMN_FAKE_HOST__;
    if (!cfg) return;
    var T = window.DbmnTemplate;

    /* ─── Store ──────────────────────────────────────────────────────── */

    function clone(x) {
        return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
    }

    var store = clone(cfg.seed || {});
    store.endpoints = store.endpoints || [];
    store.systems = store.systems || [];
    store.environments = store.environments || [];
    store.transactions = store.transactions || [];
    store.recentEndpoints = store.recentEndpoints || [];
    store.dbmnSettings = store.dbmnSettings || {};
    store.hubPreferences = store.hubPreferences || {};
    store.workspaceInfo = store.workspaceInfo || {};
    store.isSignedIn = !!store.isSignedIn;

    var sent = [];
    var received = [];
    var tabs = {};
    var pendingModals = {};
    var persistedState = null;
    var idCounter = 0;

    function nextId(prefix) {
        idCounter += 1;
        return prefix + '-' + String(idCounter).padStart(3, '0');
    }

    function byName(a, b) {
        return String(a.name || '').localeCompare(String(b.name || ''));
    }

    function findEndpoint(id) { return store.endpoints.find(function (e) { return e.id === id; }) || null; }
    function findEnvironment(id) { return store.environments.find(function (e) { return e.id === id; }) || null; }
    function findSystem(id) { return store.systems.find(function (s) { return s.id === id; }) || null; }
    function activeEnvironment() { return store.environments.find(function (e) { return e.isActive; }) || null; }

    function upsert(list, record) {
        var idx = list.findIndex(function (r) { return r.id === record.id; });
        if (idx >= 0) list[idx] = record; else list.push(record);
        return record;
    }

    function setActiveEnvironment(environmentId) {
        var env = findEnvironment(environmentId);
        if (!env) return;
        store.environments.forEach(function (e) { e.isActive = e.id === environmentId; });
    }

    /** environmentManager.getHeaderVariables(): each variable the header shows, options as typed (#424) */
    function headerVariablesOf(env) {
        if (Array.isArray(env.headerVariables)) return clone(env.headerVariables);
        var settings = env.variableSettings || {};
        return Object.keys(settings).filter(function (name) { return settings[name].showInHeader; }).map(function (name) {
            return { name: name, value: (env.variables || {})[name] || '', options: (settings[name].options || []).slice() };
        });
    }

    function collectTags() {
        var counts = {};
        store.endpoints.forEach(function (e) {
            (e.tags || []).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
        });
        return Object.keys(counts).sort().map(function (t) { return { name: t, count: counts[t] }; });
    }

    /* ─── Payload builders (mirror the extension-side shapes) ───────── */

    function systemsListMessage(selectedSystemId) {
        return {
            type: 'systemsList',
            systems: store.systems.slice().sort(byName).map(function (s) { return { id: s.id, name: s.name }; }),
            selectedSystemId: selectedSystemId
        };
    }

    /** endpoint-editor.controller.ts → broadcastTags() (#432): tags in use, most used first */
    function tagsListMessage() {
        var counts = {};
        store.endpoints.forEach(function (e) { (e.tags || []).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; }); });
        var tags = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); });
        return { type: 'tagsList', tags: tags };
    }

    /** hub-manager.ts → assembleInitialState() */
    function hubStatePayload() {
        var environments = store.environments.map(function (e) {
            return Object.assign({}, clone(e), { headerVariables: headerVariablesOf(e) });
        });
        var active = environments.find(function (e) { return e.isActive; }) || null;
        return {
            endpoints: clone(store.endpoints),
            recentEndpoints: clone(store.recentEndpoints || []),
            hubPreferences: clone(store.hubPreferences || {}),
            systems: clone(store.systems),
            environments: environments,
            activeEnvironmentId: active ? active.id : undefined,
            activeSystemId: active ? active.systemId : undefined,
            transactions: clone(store.transactions),
            dbmnSettings: clone(store.dbmnSettings),
            workspaceInfo: clone(store.workspaceInfo),
            isSignedIn: store.isSignedIn,
            dbmnSessionExpired: store.isSignedIn && store.dbmnSessionExpired === true
        };
    }

    /** endpoint-manager.ts → handleGetCurrentEnvironment() */
    function currentEnvironmentData() {
        var env = activeEnvironment();
        if (!env) {
            return { id: null, name: null, baseUrl: null,
                parallelProcessing: { enabled: false, maxConcurrency: 1 }, headers: undefined, variables: undefined };
        }
        var variables = Object.assign({}, env.variables || {});
        return {
            id: env.id,
            name: env.name,
            baseUrl: env.baseUrl || null,
            parallelProcessing: env.parallelProcessing || { enabled: false, maxConcurrency: 1 },
            headers: env.headers || undefined,
            variables: Object.keys(variables).length > 0 ? variables : undefined
        };
    }

    /* ─── Delivery to the UI ────────────────────────────────────────── */

    function deliver(message) {
        received.push({ tabId: null, message: clone(message), at: Date.now() });
        window.postMessage(message, '*');
    }

    function deliverToTab(tabId, payload) {
        received.push({ tabId: tabId, message: clone(payload), at: Date.now() });
        window.postMessage({ type: '__embeddedToTab__', tabId: tabId, payload: payload }, '*');
    }

    function broadcastHubState() {
        if (cfg.view !== 'hub') return;
        deliver(Object.assign({ type: 'hubState' }, hubStatePayload()));
    }

    /* ─── Shared messages (webview-base.ts handleSharedMessages) ────── */

    var TOAST_LEVELS = { showSuccess: 'success', showInfo: 'info', showError: 'error', showWarning: 'warn', validationError: 'warn' };

    function requestModal(post, spec, handlers) {
        var requestId = 'modal-' + nextId('req');
        pendingModals[requestId] = handlers || {};
        post({ type: 'dbmnModalRequest', requestId: requestId, spec: spec });
        return requestId;
    }

    /** Returns true when the message was consumed. */
    function handleShared(msg, post) {
        if (!msg || typeof msg.type !== 'string') return true;
        if (TOAST_LEVELS[msg.type]) {
            post({ type: 'dbmnToast', level: TOAST_LEVELS[msg.type], message: msg.message });
            return true;
        }
        if (msg.type === 'dbmnModalActionPending') {
            var pending = pendingModals[msg.requestId];
            var handler = pending && pending.submit && pending.submit[msg.actionId];
            if (!handler) {
                post({ type: 'dbmnModalActionResult', submitId: msg.submitId, success: false,
                    error: 'No submit handler registered for this action.' });
                return true;
            }
            var outcome = handler(msg.fields || {});
            if (outcome && outcome.error) {
                post(Object.assign({ type: 'dbmnModalActionResult', submitId: msg.submitId, success: false,
                    error: outcome.error }, outcome.fieldErrors ? { fieldErrors: outcome.fieldErrors } : {}));
            } else {
                post({ type: 'dbmnModalActionResult', submitId: msg.submitId, success: true });
            }
            return true;
        }
        if (msg.type === 'dbmnModalResult') {
            var entry = pendingModals[msg.requestId];
            delete pendingModals[msg.requestId];
            if (entry && entry.result) entry.result(msg.result || { actionId: 'dismiss', fields: {} });
            return true;
        }
        if (msg.type === 'unsavedChangesResponse' || msg.type === 'saveCurrentContext') return true;
        if (msg.type === 'openExternalUrl') {
            // webview-base.ts: only dbmn.io links (help mode, docs links) open, in a new tab
            var url = msg.payload && msg.payload.url;
            if (typeof url === 'string' && /^https:\/\/(www\.)?dbmn\.io\//.test(url)) {
                window.open(url, '_blank', 'noopener');
            }
            return true;
        }
        return false;
    }

    /** services/ui/dbmn-prompts.ts → promptForNewSystemName() */
    /** `forEditor`: the endpoint/environment editors get `systemsList` with the new System
     *  selected (endpoint-manager / environment-manager handleCreateSystem); the Hub gets
     *  `systemCreated` (hub-manager). */
    function createSystemFlow(post, forEditor) {
        var created = null;
        requestModal(post, {
            title: 'New System',
            body: 'Short lowercase name — letters and digits only (a–z 0–9), max 16 characters.',
            fields: [{ id: 'name', type: 'text', label: 'System name', placeholder: 'e.g. WMS, ERP, Training Ground', autoFocus: true }],
            actions: [
                { id: 'cancel', label: 'Cancel', variant: 'secondary' },
                { id: 'create', label: 'Create', variant: 'primary', awaitsHostSubmit: true }
            ]
        }, {
            submit: {
                create: function (fields) {
                    var raw = String(fields.name || '').trim();
                    var err = null;
                    if (!raw) err = 'System name is required';
                    else if (!/^[a-z0-9]{1,16}$/i.test(raw)) err = 'System name must be 1–16 letters or digits';
                    else if (store.systems.some(function (s) { return s.name.toLowerCase() === raw.toLowerCase(); })) err = 'A System with that name already exists';
                    if (err) return { error: err, fieldErrors: { name: err } };
                    created = { id: nextId('sys'), name: raw.toLowerCase(), createdAt: 0 };
                    store.systems.push(created);
                    return null;
                }
            },
            result: function () {
                if (!created) return;
                broadcastHubState();
                post(forEditor ? systemsListMessage(created.id) : { type: 'systemCreated', systemId: created.id });
            }
        });
    }

    /* ─── Editor managers ───────────────────────────────────────────── */

    /** endpoint-manager.ts. `post` targets the editor's own webview
     *  (top page or tab); `ctx.tabId` is set when embedded in the Hub. */
    function endpointManager(config, post, ctx) {
        ctx = ctx || {};
        return function handle(msg) {
            switch (msg.type) {
                case 'getTagsList':
                    post(tagsListMessage());
                    return;
                case 'ready': {
                    var lookupId = config.duplicateFromId || config.itemId;
                    var existing = lookupId ? findEndpoint(lookupId) : null;
                    var active = activeEnvironment();
                    post(systemsListMessage(existing ? existing.systemId : (active ? active.systemId : undefined)));
                    post(tagsListMessage());
                    if (config.duplicateFromId) {
                        var source = findEndpoint(config.duplicateFromId);
                        if (source) {
                            post({ type: 'populateEndpointData',
                                endpoint: Object.assign({}, clone(source), { id: undefined, name: 'COPY ' + source.name }),
                                body: source.body || '', isDuplicate: true });
                        }
                        return;
                    }
                    if (config.itemId) {
                        var ep = findEndpoint(config.itemId);
                        if (ep) post({ type: 'populateEndpointData', endpoint: clone(ep), body: ep.body || '' });
                    }
                    return;
                }
                case 'getEndpointData': {
                    var found = findEndpoint(msg.endpointId);
                    post(found ? { type: 'endpointData', endpoint: clone(found) }
                        : { type: 'endpointDataError', error: 'Endpoint not found' });
                    return;
                }
                case 'getCurrentEnvironment':
                    post({ type: 'currentEnvironmentData', environment: currentEnvironmentData() });
                    return;
                case 'saveEndpoint': {
                    if (!msg.endpoint) {
                        post({ type: 'endpointSaveError', error: 'No endpoint data provided' });
                        return;
                    }
                    var saved = clone(msg.endpoint);
                    if (!saved.id) saved.id = nextId('ep');
                    upsert(store.endpoints, saved);
                    post({ type: 'endpointSaved', endpoint: clone(saved) });
                    if (ctx.tabId) deliver({ type: 'embeddedTabName', tabId: ctx.tabId, name: saved.name });
                    broadcastHubState();
                    return;
                }
                case 'confirmDeleteEndpoint': {
                    // endpoint-manager.handleConfirmDeleteEndpoint → confirmDestructive → delete
                    var doomed = findEndpoint(msg.endpointId);
                    if (!doomed) return;
                    var count = Number(msg.transactionCount) || 0;
                    var body = count > 0
                        ? '⚠️ WARNING: This endpoint has ' + count + ' recorded transaction' + (count === 1 ? '' : 's') +
                          '.\n\nDeleting "' + doomed.name + '" will not delete the transaction history.\n\nThis action cannot be undone. Are you sure?'
                        : 'Are you sure you want to delete "' + doomed.name + '"?\n\nThis action cannot be undone.';
                    requestModal(post, {
                        title: 'Delete endpoint?', body: body,
                        actions: [{ id: 'cancel', label: 'Cancel', variant: 'secondary' }, { id: 'confirm', label: 'Delete', variant: 'danger' }]
                    }, {
                        result: function (r) {
                            if (!r || r.actionId !== 'confirm') return;
                            store.endpoints = store.endpoints.filter(function (e) { return e.id !== doomed.id; });
                            post({ type: 'endpointDeleted', endpointId: doomed.id });
                            if (ctx.tabId) {
                                deliver({ type: 'closeEmbeddedTabFromHost', tabId: ctx.tabId });
                                delete tabs[ctx.tabId];
                            }
                            broadcastHubState();
                        }
                    });
                    return;
                }
                case 'checkEndpointTransactions':
                    post({ type: 'transactionCountResponse', count: store.transactions.filter(function (t) {
                        return t.endpointId === msg.endpointId; }).length });
                    return;
                case 'createSystem':
                    createSystemFlow(post, true);
                    return;
                default:
                    return;
            }
        };
    }

    /** environment-manager.ts */
    function environmentManager(config, post, ctx) {
        ctx = ctx || {};

        function load(environmentId) {
            var env = findEnvironment(environmentId);
            if (!env) return;
            // Systems list first so the dropdown exists when the form populates.
            post(systemsListMessage(env.systemId));
            post({ type: 'environmentLoaded', environment: clone(env) });
        }
        return function handle(msg) {
            switch (msg.type) {
                case 'ready':
                    if (config.itemId) load(config.itemId); else post(systemsListMessage(undefined));
                    return;
                case 'loadEnvironment':
                    load(msg.environmentId);
                    return;
                case 'saveEnvironment': {
                    if (!msg.environment) {
                        post({ type: 'environmentSaveError', error: 'No environment data provided' });
                        return;
                    }
                    var incoming = clone(msg.environment);
                    var existing = incoming.id ? findEnvironment(incoming.id) : null;
                    var saved = Object.assign({}, existing || { createdAt: 0, isActive: false }, incoming);
                    if (!saved.id) saved.id = nextId('env');
                    upsert(store.environments, saved);
                    post({ type: 'environmentSaved', environment: clone(saved) });
                    if (ctx.tabId) deliver({ type: 'embeddedTabName', tabId: ctx.tabId, name: saved.name });
                    broadcastHubState();
                    return;
                }
                case 'setActiveEnvironment':
                    setActiveEnvironment(msg.environmentId);
                    broadcastHubState();
                    return;
                case 'checkEnvironmentTransactions':
                    post({ type: 'transactionCountResponse', count: 0 });
                    return;
                case 'createSystem':
                    createSystemFlow(post, true);
                    return;
                default:
                    return;
            }
        };
    }

    /* ─── Hub tabs ──────────────────────────────────────────────────── */

    var templateCache = {};
    function loadTemplate(name) {
        if (!templateCache[name]) {
            templateCache[name] = fetch(cfg.templates[name]).then(function (r) {
                if (!r.ok) throw new Error('Template fetch failed: ' + cfg.templates[name] + ' → ' + r.status);
                return r.text();
            });
        }
        return templateCache[name];
    }

    /** hub-manager.ts → openEndpointAsTab() */
    function openEndpointTab(endpointId, preview, options) {
        options = options || {};
        var tabId = 'endpoint:' + endpointId;
        var endpoint = findEndpoint(endpointId);
        if (tabs[tabId]) {
            deliver({ type: 'focusEmbeddedTab', tabId: tabId, refId: endpointId, name: endpoint ? endpoint.name : endpointId });
            return;
        }
        var name;
        if (endpoint && endpoint.name) name = endpoint.name;
        else if (options.duplicateFromId) {
            var src = findEndpoint(options.duplicateFromId);
            name = src ? 'COPY ' + src.name : 'New Endpoint';
        } else if (endpointId.indexOf('new-') === 0) name = 'New Endpoint';
        else name = endpointId;

        loadTemplate('endpoint').then(function (tpl) {
            var config = { context: 'endpoint', itemId: endpointId, duplicateFromId: options.duplicateFromId };
            var html = T.buildEndpoint(tpl, cfg.assetBase, endpoint, config);
            var post = function (p) { deliverToTab(tabId, p); };
            tabs[tabId] = { type: 'endpoint', config: config, handle: endpointManager(config, post, { tabId: tabId }) };
            deliver({ type: 'mountEmbeddedTab', tabId: tabId, tabType: 'endpoint', refId: endpointId,
                name: name, preview: !!preview, html: html });
        });
    }

    /** hub-manager.ts → openEnvironmentAsTab() */
    function openEnvironmentTab(environmentId) {
        var tabId = 'environment:' + environmentId;
        var env = findEnvironment(environmentId);
        var name = env && env.name ? env.name : 'New Environment';
        if (tabs[tabId]) {
            deliver({ type: 'focusEmbeddedTab', tabId: tabId, refId: environmentId, name: name });
            return;
        }
        loadTemplate('environment').then(function (tpl) {
            var config = { context: 'environment', itemId: env ? environmentId : undefined };
            var html = T.buildEnvironment(tpl, cfg.assetBase, env, config);
            var post = function (p) { deliverToTab(tabId, p); };
            tabs[tabId] = { type: 'environment', config: config, handle: environmentManager(config, post, { tabId: tabId }) };
            deliver({ type: 'mountEmbeddedTab', tabId: tabId, tabType: 'environment', refId: environmentId,
                name: name, preview: false, html: html });
        });
    }

    /** hub-manager.ts → handleMessage case '__embeddedFromTab__' */
    function handleFromTab(tabId, payload) {
        if (!tabId || !payload) return;
        switch (payload.type) {
            case 'closeWebview':
                deliver({ type: 'closeEmbeddedTabFromHost', tabId: tabId });
                delete tabs[tabId];
                return;
            case 'runWorkbenchCommand':
                return;
            case 'duplicateEndpointAsTab':
                if (payload.sourceEndpointId) {
                    openEndpointTab('new-' + Date.now(), false, { duplicateFromId: payload.sourceEndpointId });
                }
                return;
            case '__tabDirty__':
                deliver({ type: 'embeddedTabDirty', tabId: tabId, dirty: !!payload.dirty });
                return;
            case '__embeddedReady__':
                return;
            default:
                break;
        }
        var entry = tabs[tabId];
        if (!entry) return;
        var post = function (p) { deliverToTab(tabId, p); };
        if (handleShared(payload, post)) return;
        entry.handle(payload);
    }

    /* ─── Hub ───────────────────────────────────────────────────────── */

    /** hub-manager.ts → postHomeInfo() (Issue #348) */
    function deliverHomeInfo() {
        var prev = store.previousTabs || [];
        deliver({
            type: 'hubHomeInfo',
            reopen: prev.length ? { count: prev.length, names: prev.map(function (t) { return t.name || t.refId; }) } : null,
            whatsNew: store.whatsNew || null
        });
    }

    /** hub-manager.ts → handleMessage() */
    function hubHandle(msg) {
        if (handleShared(msg, deliver)) return;
        switch (msg.type) {
            case 'ready':
                deliver(Object.assign({ type: 'hubState' }, hubStatePayload()));
                deliverHomeInfo();
                return;
            case 'reopenTabs':
                // hub-manager restorePersistedTabs(): reopen, then the offer goes.
                (store.previousTabs || []).forEach(function (t) {
                    if (t.type === 'endpoint') openEndpointTab(t.refId, false, {});
                    else if (t.type === 'environment') openEnvironmentTab(t.refId);
                    else if (t.type === 'page') deliver({ type: 'openPageTab', page: t.refId, name: t.name });
                });
                store.previousTabs = [];
                deliverHomeInfo();
                return;
            case 'setActiveEnvironment':
                setActiveEnvironment(msg.environmentId);
                broadcastHubState();
                return;
            case 'setHubPreferences': {
                store.hubPreferences = clone(msg.preferences || {});
                return;
            }
            case 'setDbmnSetting': {
                // hub-manager whitelists `dbmn.<group>.<key>`; the Hub payload
                // is keyed by the leaf name.
                var leaf = String(msg.key || '').split('.').pop();
                if (leaf) {
                    store.dbmnSettings[leaf] = msg.value;
                }
                broadcastHubState();
                return;
            }
            case 'openEndpointAsTab':
                openEndpointTab(msg.endpointId, !!msg.preview, {});
                return;
            case 'addEndpoint':
                openEndpointTab('new-' + Date.now(), false, { fromClipboard: !!msg.fromClipboard });
                return;
            case 'openEnvironmentAsTab':
                openEnvironmentTab(msg.environmentId);
                return;
            case 'addEnvironment':
                openEnvironmentTab('new-' + Date.now());
                return;
            case 'createSystem':
                createSystemFlow(deliver);
                return;
            case 'renameSystem': {
                var sys = findSystem(msg.systemId);
                if (!sys) { deliver({ type: 'renameSystemError', error: 'System not found' }); return; }
                sys.name = String(msg.newName || '').trim().toLowerCase();
                broadcastHubState();
                return;
            }
            case 'mergeSystem': {
                var target = findSystem(msg.targetSystemId);
                if (!target || msg.systemId === msg.targetSystemId) return;
                store.endpoints.forEach(function (e) {
                    if (e.systemId === msg.systemId) e.systemId = target.id;
                });
                store.environments.forEach(function (e) {
                    if (e.systemId === msg.systemId) e.systemId = target.id;
                });
                store.systems = store.systems.filter(function (s) { return s.id !== msg.systemId; });
                broadcastHubState();
                return;
            }
            case 'requestCloseEditors':
                // hub-manager.handleRequestCloseEditors: close every open
                // editor tab (prompting on dirty ones), then confirm. The
                // fake never has a dirty-prompt to show, so always ok.
                Object.keys(tabs).forEach(function (tabId) {
                    if (tabs[tabId].type === 'endpoint' || tabs[tabId].type === 'environment') {
                        deliver({ type: 'closeEmbeddedTabFromHost', tabId: tabId });
                        delete tabs[tabId];
                    }
                });
                deliver({ type: 'closeEditorsResult', ok: true });
                return;
            case 'accountReady':
                deliver({
                    type: 'authStateUpdate',
                    isAuthenticated: store.isSignedIn,
                    displayName: store.isSignedIn ? 'Test User' : null,
                    email: store.isSignedIn ? 'test@example.com' : null,
                    license: null,
                    userLicense: null,
                    usage: null,
                    telemetryStats: null,
                    connectivityStatus: store.isSignedIn && store.dbmnSessionExpired === true ? 'auth_error' : 'ok'
                });
                return;
            case 'openTagManager':
                deliver({ type: 'tagManagerData', tags: collectTags() });
                return;
            case '__embeddedFromTab__':
                handleFromTab(msg.tabId, msg.payload);
                return;
            default:
                return;
        }
    }

    /* ─── Routing + install ─────────────────────────────────────────── */

    var standalone = null;
    if (cfg.view === 'endpoint') standalone = endpointManager(cfg.config || {}, deliver, {});
    if (cfg.view === 'environment') standalone = environmentManager(cfg.config || {}, deliver, {});

    function route(message) {
        if (cfg.view === 'hub') { hubHandle(message); return; }
        if (!standalone) return;
        if (handleShared(message, deliver)) return;
        standalone(message);
    }

    var api = {
        postMessage: function (message) {
            var m = clone(message) || {};
            var envelope = m.type === '__embeddedFromTab__';
            sent.push({ tabId: envelope ? m.tabId : null, message: envelope ? m.payload : m, at: Date.now() });
            // The real bridge is asynchronous; keep that ordering.
            setTimeout(function () { route(message); }, 0);
        },
        getState: function () { return persistedState; },
        setState: function (s) { persistedState = s; return s; }
    };

    window.acquireVsCodeApi = function () { return api; };
    window.vscode = api;

    if (cfg.view === 'hub') {
        // hub-manager embeds the initial state inline so the first paint is
        // populated; hub.js reads it before posting `ready`.
        window.__HUB_INITIAL_STATE__ = hubStatePayload();
    }

    window.__dbmnFakeHost = {
        sent: sent,
        received: received,
        state: function () { return store; },
        push: deliver,
        pushToTab: deliverToTab,
        tabs: function () { return Object.keys(tabs); }
    };
}());
