// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/*
 * Webview template builder shared by the Node side of the UI harness (the
 * Playwright fixture that serves /hub, /endpoint, /environment) and the
 * browser side (the fake host, which builds the HTML for editor tabs the Hub
 * mounts in iframes).
 *
 * It mirrors what the extension-side managers do in `getHtmlContent()`:
 *   - hub-manager.ts            → buildHub
 *   - endpoint-manager.ts       → buildEndpoint
 *   - environment-manager.ts    → buildEnvironment
 *
 * Only the asset URIs differ: `webview.asWebviewUri()` becomes a plain URL
 * under `assetBase` (the static server's /webviews mount).
 *
 * UMD so the same file loads via `require()` in Node and via
 * `page.addInitScript({ path })` in the browser (global `DbmnTemplate`).
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.DbmnTemplate = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /** `{{KEY}}` → value. Split/join rather than String.replace so `$` in
     *  values (JSON payloads, header templates) is never treated as a
     *  backreference — the same pitfall hub-manager.ts works around. */
    function substitute(template, vars) {
        var out = template;
        Object.keys(vars).forEach(function (key) {
            var value = vars[key] === undefined || vars[key] === null ? '' : String(vars[key]);
            out = out.split('{{' + key + '}}').join(value);
        });
        return out;
    }

    function asset(base, rel) {
        return base.replace(/\/$/, '') + '/' + rel.replace(/^\//, '');
    }

    /** Mirrors WebviewBase.getSharedCssUris(). */
    function sharedCss(base) {
        return {
            atomic: asset(base, 'shared/atomic.css'),
            core: asset(base, 'shared/core.css'),
            modals: asset(base, 'shared/modals.css'),
            tables: asset(base, 'shared/tables.css'),
            tabs: asset(base, 'shared/tabs.css'),
            toast: asset(base, 'shared/toast.css')
        };
    }

    function linkTags(hrefs) {
        return hrefs.map(function (h) { return '<link rel="stylesheet" href="' + h + '">'; }).join('\n');
    }

    /** hub-manager.ts → getHtmlContent(). `initialState` (optional) is
     *  embedded as `window.__HUB_INITIAL_STATE__` exactly as the extension
     *  does, so first paint is populated without a ready→hubState round trip. */
    function buildHub(template, base, initialState) {
        var css = sharedCss(base);
        var initialStateScript = '';
        if (initialState) {
            var safeJson = JSON.stringify(initialState).replace(/</g, '\\u003c');
            initialStateScript = '<script>window.__HUB_INITIAL_STATE__ = ' + safeJson + ';</script>';
        }
        var html = substitute(template, {
            ATOMIC_CSS_URI: css.atomic,
            CORE_CSS_URI: css.core,
            MODALS_CSS_URI: css.modals,
            TABLES_CSS_URI: css.tables,
            HUB_CSS_URI: asset(base, 'shared/hub.css'),
            IMPORT_EXPORT_CSS_URI: asset(base, 'import-export/import-export.css'),
            SYSTEM_PICKER_CSS_URI: css.core,
            HUB_JS_URI: asset(base, 'hub/hub.js'),
            EXECUTION_ACTIONS_JS_URI: asset(base, 'shared/execution-actions.js'),
            DBMN_CONTEXT_MENU_JS_URI: asset(base, 'shared/dbmn-context-menu.js'),
            SEARCH_WORDS_JS_URI: asset(base, 'shared/search-words.js'), // #444
            SEARCH_MATCHER_JS_URI: asset(base, 'shared/search-matcher.js'),
            SEARCH_CSS_URI: asset(base, 'shared/search.css'),
            HUB_TABS_JS_URI: asset(base, 'hub/hub-tabs.js'),
            HELP_MODE_JS_URI: asset(base, 'shared/help-mode.js'),
            THEME_PICKER_JS_URI: asset(base, 'shared/theme-picker.js'),
            THEME_PICKER_CSS_URI: asset(base, 'shared/theme-picker.css'),
            BUTTON_CONTRAST_JS_URI: asset(base, 'shared/button-contrast.js'),
            HUB_HELP_JS_URI: asset(base, 'hub/hub-help.js'),
            HUB_LAYOUT_JS_URI: asset(base, 'hub/hub-layout.js'),
            HUB_LOGO_URI: asset(base, 'shared/dbmn-logo.svg'),
            HUB_ACTIVITY_JS_URI: asset(base, 'hub/hub-activity.js'),
            CATALOGUE_JS_URI: asset(base, 'hub/catalogue.js'),
            HUB_TAG_MANAGER_JS_URI: asset(base, 'hub/hub-tag-manager.js'),
            TRANSACTIONS_JS_URI: asset(base, 'hub/transactions.js'),
            // Reporting's list (it never drew in UI tests without it)
            COMPARE_LIST_JS_URI: asset(base, 'hub/compare-list.js'),
            HUB_HOME_JS_URI: asset(base, 'hub/hub-home.js'),
            // The real host prints package.json's version; a fixed one keeps
            // screenshots stable across releases.
            HUB_VERSION: 'v0.0.0',
            IMPORT_EXPORT_JS_URI: asset(base, 'hub/import-export-frontend.js'),
            ACCOUNT_FRONTEND_JS_URI: asset(base, 'hub/account-frontend.js'),
            SYSTEM_PICKER_JS_URI: asset(base, 'shared/system-picker.js'),
            DBMN_ACTIONS_JS_URI: asset(base, 'shared/dbmn-actions.js'),
            ICONS_JS_URI: asset(base, 'shared/icons.js'),
            BADGES_JS_URI: asset(base, 'shared/badges.js'),
            DBMN_MODAL_JS_URI: asset(base, 'shared/dbmn-modal.js'),
            LOOKUP_NEW_JS_URI: asset(base, 'shared/lookup-new.js'),
            ROW_PASTE_JS_URI: asset(base, 'shared/row-paste.js'),
            DBMN_TOAST_JS_URI: asset(base, 'shared/dbmn-toast.js'),
            DBMN_CLIPBOARD_JS_URI: asset(base, 'shared/dbmn-clipboard.js'),
            TOAST_CSS_URI: css.toast,
            // devBackendMarkup() for a packaged build: no DEV pill, no backend note.
            DEV_BACKEND_PILL: '',
            DEV_BACKEND_NOTE: ''
        });
        return html.split('{{INITIAL_STATE_SCRIPT}}').join(initialStateScript);
    }

    /** endpoint-manager.ts → getHtmlContent() + getCssLinks().
     *  `opts`: { itemId, defaultFolder, duplicateFromId }. `endpoint` is the
     *  stored record for opts.itemId, or null for a new endpoint. */
    function buildEndpoint(template, base, endpoint, opts) {
        opts = opts || {};
        var css = sharedCss(base);
        var cssLinks = linkTags([
            css.atomic, css.core, css.modals, css.tables, css.toast,
            asset(base, 'shared/data-transformer.css')
        ]);
        var method = endpoint ? endpoint.method : undefined;
        return substitute(template, {
            SHARED_STYLES: cssLinks,
            ZOD_SCRIPT: '',
            ZOD_SCHEMAS_SCRIPT: '',
            JSON_COMMENT_STRIPPER_SCRIPT: asset(base, 'shared/json-comment-stripper.js'),
            JSONC_PARSER_SCRIPT: asset(base, 'shared/jsonc-parser.js'),
            QUERY_PARAM_BUILDER_SCRIPT: asset(base, 'shared/query-param-builder.js'),
            SYSTEM_PICKER_SCRIPT: asset(base, 'shared/system-picker.js'),
            TAG_SUGGEST_SCRIPT: asset(base, 'shared/tag-suggest.js'),
            ICONS_SCRIPT: asset(base, 'shared/icons.js'),
            DBMN_FOOTER_SCRIPT: asset(base, 'shared/dbmn-footer.js'),
            DBMN_FOOTER_CSS: asset(base, 'shared/dbmn-footer.css'),
            EDITOR_WINDOW_CONTROLS_SCRIPT: asset(base, 'shared/editor-window-controls.js'),
            DBMN_MODAL_SCRIPT: asset(base, 'shared/dbmn-modal.js'),
            ROW_PASTE_SCRIPT: asset(base, 'shared/row-paste.js'),
            DBMN_TOAST_SCRIPT: asset(base, 'shared/dbmn-toast.js'),
            DBMN_CLIPBOARD_SCRIPT: asset(base, 'shared/dbmn-clipboard.js'),
            DOCUMENTATION_HELPERS_SCRIPT: asset(base, 'shared/documentation-helpers.js'),
            HELP_MODE_SCRIPT: asset(base, 'shared/help-mode.js'),
            BUTTON_CONTRAST_SCRIPT: asset(base, 'shared/button-contrast.js'),
            DT_DATA_ENTRY_GRID_SCRIPT: asset(base, 'shared/dt-data-entry-grid.js'),
            DT_TYPE_COERCION_SCRIPT: asset(base, 'shared/dt-type-coercion.js'),
            DT_DATA_INGESTION_SCRIPT: asset(base, 'shared/dt-data-ingestion.js'),
            DT_DATA_PREVIEW_SCRIPT: asset(base, 'shared/dt-data-preview.js'),
            DT_MISMATCH_REPAIR_SCRIPT: asset(base, 'shared/dt-mismatch-repair.js'),
            DT_BATCH_CONFIG_SCRIPT: asset(base, 'shared/dt-batch-config.js'),
            CSV_HANDLER_SCRIPT: asset(base, 'shared/data-transformer.js'),
            FORM_MANAGER_SCRIPT: asset(base, 'endpoint/modules/form-manager.js'),
            TEMPLATE_COMPLETIONS_SCRIPT: asset(base, 'endpoint/modules/template-completions.js'),
            MONACO_THEME_SCRIPT: asset(base, 'shared/monaco-theme.js'),
            MONACO_LOADER_CONFIG_SCRIPT: asset(base, 'shared/monaco-loader-config.js'),
            DBMN_ACTIONS_SCRIPT: asset(base, 'shared/dbmn-actions.js'),
            MODULE_BRIDGE_SCRIPT: asset(base, 'endpoint/modules/module-bridge.js'),
            ENDPOINT_SCRIPT: asset(base, 'endpoint/endpoint.js'),
            LINE_BLOCK_SCRIPT: asset(base, 'shared/line-block.js'),
            ENDPOINT_ID: (endpoint && endpoint.id) || opts.itemId || 'NEW',
            HEADING_TEXT: endpoint ? 'Edit Endpoint:' : 'Create New Endpoint:',
            ENDPOINT_NAME: (endpoint && endpoint.name) || '',
            ENDPOINT_PATH: (endpoint && endpoint.path) || '',
            ENDPOINT_DESCRIPTION: (endpoint && endpoint.description) || '',
            ENDPOINT_FOLDER: (endpoint && endpoint.folder) || opts.defaultFolder || '',
            ENDPOINT_TAGS: ((endpoint && endpoint.tags) || []).join(','),
            GET_SELECTED: method === 'GET' ? 'selected' : '',
            POST_SELECTED: method === 'POST' ? 'selected' : '',
            PUT_SELECTED: method === 'PUT' ? 'selected' : '',
            PATCH_SELECTED: method === 'PATCH' ? 'selected' : '',
            DELETE_SELECTED: method === 'DELETE' ? 'selected' : ''
        });
    }

    /** environment-manager.ts → getHtmlContent(). */
    function buildEnvironment(template, base, environment, opts) {
        opts = opts || {};
        var css = sharedCss(base);
        var cssLinks = linkTags([
            css.atomic, css.core, css.modals, css.tables, css.tabs, css.toast
        ]);
        return substitute(template, {
            SHARED_STYLES: cssLinks,
            ENVIRONMENT_SCRIPT: asset(base, 'environment/environment.js'),
            DBMN_ACTIONS_SCRIPT: asset(base, 'shared/dbmn-actions.js'),
            DOCUMENTATION_HELPERS_URI: asset(base, 'shared/documentation-helpers.js'),
            HELP_MODE_SCRIPT: asset(base, 'shared/help-mode.js'),
            BUTTON_CONTRAST_SCRIPT: asset(base, 'shared/button-contrast.js'),
            SYSTEM_PICKER_SCRIPT: asset(base, 'shared/system-picker.js'),
            ICONS_SCRIPT: asset(base, 'shared/icons.js'),
            DBMN_FOOTER_SCRIPT: asset(base, 'shared/dbmn-footer.js'),
            DBMN_FOOTER_CSS: asset(base, 'shared/dbmn-footer.css'),
            EDITOR_WINDOW_CONTROLS_SCRIPT: asset(base, 'shared/editor-window-controls.js'),
            DBMN_MODAL_SCRIPT: asset(base, 'shared/dbmn-modal.js'),
            ROW_PASTE_SCRIPT: asset(base, 'shared/row-paste.js'),
            DBMN_TOAST_SCRIPT: asset(base, 'shared/dbmn-toast.js'),
            DBMN_CLIPBOARD_SCRIPT: asset(base, 'shared/dbmn-clipboard.js'),
            ENVIRONMENT_ID: opts.itemId || '',
            ENVIRONMENT_FOLDER: (environment && environment.folder) || opts.defaultFolder || ''
        });
    }

    /** Give a top-level page the styling context VS Code's workbench would
     *  provide: the `--vscode-*` token sheet on :root and the theme classes
     *  and attributes on <body>. Hub tab iframes copy these from the parent
     *  document via hub-tabs.js's theme bootstrap, so only top-level pages
     *  need this. */
    function applyThemeContext(html, themeHref, kind) {
        kind = kind || 'dark';
        var bodyClass = 'vscode-' + kind;
        var themeName = kind === 'dark' ? 'Dark Modern' : 'Light Modern';
        var link = '<link rel="stylesheet" href="' + themeHref + '">';
        var out = html;
        if (/<head[^>]*>/i.test(out)) {
            out = out.replace(/<head[^>]*>/i, function (m) { return m + link; });
        } else {
            out = link + out;
        }
        out = out.replace(/<body([^>]*)>/i, function (m, attrs) {
            var a = attrs || '';
            if (/class="/.test(a)) {
                a = a.replace(/class="([^"]*)"/, function (_m, cls) { return 'class="' + cls + ' ' + bodyClass + '"'; });
            } else {
                a += ' class="' + bodyClass + '"';
            }
            a += ' data-vscode-theme-kind="' + bodyClass + '" data-vscode-theme-name="' + themeName + '"';
            return '<body' + a + '>';
        });
        return out;
    }

    return {
        substitute: substitute,
        asset: asset,
        sharedCss: sharedCss,
        buildHub: buildHub,
        buildEndpoint: buildEndpoint,
        buildEnvironment: buildEnvironment,
        applyThemeContext: applyThemeContext
    };
}));
