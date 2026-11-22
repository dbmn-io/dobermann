// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Screen pages: a screen's HTML template (src/webviews/<screen>/<screen>.html) filled in with
 * its asset URLs. One builder per screen, used by every host: VS Code passes webview URIs, the
 * web app passes its own URLs. `asset` maps a path under src/webviews to a URL.
 */
import { versionLabel } from '../utils/version-label';

export type AssetUrl = (relativePath: string) => string;

/** The shared stylesheets every editor links (WebviewBase.getSharedCssUris). */
const SHARED_CSS = ['atomic', 'core', 'modals', 'tables', 'tabs', 'toast'];

export function sharedStyleLinks(asset: AssetUrl, names: string[] = SHARED_CSS): string {
    return names.map(name => `<link rel="stylesheet" href="${asset(`shared/${name}.css`)}">`).join('\n');
}

/** `{{KEY}}` → value, literally (split/join: a `$` in a value is never a regex backreference). */
export function fillTemplate(template: string, values: Record<string, string>): string {
    let html = template;
    for (const [key, value] of Object.entries(values)) {
        html = html.split(`{{${key}}}`).join(value);
    }
    return html;
}

/** `host` 'web': secrets of an environment that runs in DBMN for VS Code are entered there (#344). */
export function buildEnvironmentPage(template: string, asset: AssetUrl, environment: { id?: string; folder?: string }, host: 'vscode' | 'web' | 'desktop' = 'vscode'): string {
    return fillTemplate(template, {
        SHARED_STYLES: sharedStyleLinks(asset),
        ENVIRONMENT_SCRIPT: asset('environment/environment.js'),
        DBMN_ACTIONS_SCRIPT: asset('shared/dbmn-actions.js'),
        BUTTON_CONTRAST_SCRIPT: asset('shared/button-contrast.js'),
        DOCUMENTATION_HELPERS_URI: asset('shared/documentation-helpers.js'),
        HELP_MODE_SCRIPT: asset('shared/help-mode.js'),
        SYSTEM_PICKER_SCRIPT: asset('shared/system-picker.js'),
        ICONS_SCRIPT: asset('shared/icons.js'),
        DBMN_FOOTER_SCRIPT: asset('shared/dbmn-footer.js'),
        DBMN_FOOTER_CSS: asset('shared/dbmn-footer.css'),
        EDITOR_WINDOW_CONTROLS_SCRIPT: asset('shared/editor-window-controls.js'),
        DBMN_MODAL_SCRIPT: asset('shared/dbmn-modal.js'),
        ROW_PASTE_SCRIPT: asset('shared/row-paste.js'),
        DBMN_TOAST_SCRIPT: asset('shared/dbmn-toast.js'),
        DBMN_CLIPBOARD_SCRIPT: asset('shared/dbmn-clipboard.js'),
        TEMPLATE_AUTOCOMPLETE_SCRIPT: asset('shared/template-autocomplete.js'),
        ENVIRONMENT_ID: environment.id ?? '',
        ENVIRONMENT_FOLDER: environment.folder ?? '',
        HOST: host
    });
}

export function buildEndpointPage(
    template: string,
    asset: AssetUrl,
    endpoint: { id?: string; name?: string; path?: string; description?: string; folder?: string; tags?: string[]; method?: string } | undefined,
    opts: { itemId?: string; defaultFolder?: string }
): string {
    const method = endpoint?.method;
    return fillTemplate(template, {
        SHARED_STYLES: sharedStyleLinks(asset, ['atomic', 'core', 'modals', 'tables', 'toast', 'data-transformer']),
        ZOD_SCRIPT: '',
        ZOD_SCHEMAS_SCRIPT: '',
        BUTTON_CONTRAST_SCRIPT: asset('shared/button-contrast.js'),
        JSON_COMMENT_STRIPPER_SCRIPT: asset('shared/json-comment-stripper.js'),
        JSONC_PARSER_SCRIPT: asset('shared/jsonc-parser.js'),
        QUERY_PARAM_BUILDER_SCRIPT: asset('shared/query-param-builder.js'),
        SYSTEM_PICKER_SCRIPT: asset('shared/system-picker.js'),
        TAG_SUGGEST_SCRIPT: asset('shared/tag-suggest.js'),
        ICONS_SCRIPT: asset('shared/icons.js'),
        DBMN_FOOTER_SCRIPT: asset('shared/dbmn-footer.js'),
        DBMN_FOOTER_CSS: asset('shared/dbmn-footer.css'),
        EDITOR_WINDOW_CONTROLS_SCRIPT: asset('shared/editor-window-controls.js'),
        DBMN_MODAL_SCRIPT: asset('shared/dbmn-modal.js'),
        ROW_PASTE_SCRIPT: asset('shared/row-paste.js'),
        LINE_BLOCK_SCRIPT: asset('shared/line-block.js'),
        DBMN_TOAST_SCRIPT: asset('shared/dbmn-toast.js'),
        DBMN_CLIPBOARD_SCRIPT: asset('shared/dbmn-clipboard.js'),
        TEMPLATE_AUTOCOMPLETE_SCRIPT: asset('shared/template-autocomplete.js'),
        DOCUMENTATION_HELPERS_SCRIPT: asset('shared/documentation-helpers.js'),
        HELP_MODE_SCRIPT: asset('shared/help-mode.js'),
        DT_DATA_ENTRY_GRID_SCRIPT: asset('shared/dt-data-entry-grid.js'),
        DT_TYPE_COERCION_SCRIPT: asset('shared/dt-type-coercion.js'),
        DT_DATA_INGESTION_SCRIPT: asset('shared/dt-data-ingestion.js'),
        DT_DATA_PREVIEW_SCRIPT: asset('shared/dt-data-preview.js'),
        DT_MISMATCH_REPAIR_SCRIPT: asset('shared/dt-mismatch-repair.js'),
        DT_BATCH_CONFIG_SCRIPT: asset('shared/dt-batch-config.js'),
        CSV_HANDLER_SCRIPT: asset('shared/data-transformer.js'),
        FORM_MANAGER_SCRIPT: asset('endpoint/modules/form-manager.js'),
        TEMPLATE_COMPLETIONS_SCRIPT: asset('endpoint/modules/template-completions.js'),
        MONACO_THEME_SCRIPT: asset('shared/monaco-theme.js'),
        MONACO_LOADER_CONFIG_SCRIPT: asset('shared/monaco-loader-config.js'),
        DBMN_ACTIONS_SCRIPT: asset('shared/dbmn-actions.js'),
        MODULE_BRIDGE_SCRIPT: asset('endpoint/modules/module-bridge.js'),
        ENDPOINT_SCRIPT: asset('endpoint/endpoint.js'),
        ENDPOINT_ID: endpoint?.id || opts.itemId || 'NEW',
        HEADING_TEXT: endpoint ? 'Edit Endpoint:' : 'Create New Endpoint:',
        ENDPOINT_NAME: endpoint?.name || '',
        ENDPOINT_PATH: endpoint?.path || '',
        ENDPOINT_DESCRIPTION: endpoint?.description || '',
        ENDPOINT_FOLDER: endpoint?.folder || opts.defaultFolder || '',
        ENDPOINT_TAGS: (endpoint?.tags || []).join(','),
        GET_SELECTED: method === 'GET' ? 'selected' : '',
        POST_SELECTED: method === 'POST' ? 'selected' : '',
        PUT_SELECTED: method === 'PUT' ? 'selected' : '',
        PATCH_SELECTED: method === 'PATCH' ? 'selected' : '',
        DELETE_SELECTED: method === 'DELETE' ? 'selected' : ''
    });
}

/**
 * The Hub. `initialState` is embedded so the first paint is complete (no empty shell, no
 * ready → hubState flash); `<` is escaped so content can't close the script tag, and it goes
 * in by split/join so a `$` in it is never a backreference. `devBackend` is the pill and note
 * a dev build shows (CLAUDE.md "Always visible"); empty strings in a packaged build.
 */
export function buildHubPage(
    template: string,
    asset: AssetUrl,
    initialState: Record<string, unknown> | undefined,
    devBackend: { DEV_BACKEND_PILL: string; DEV_BACKEND_NOTE: string },
    /** Shown on Home (#348), e.g. "0.3.1"; nothing when unknown. */
    version?: string,
    /** The commit it was built from, beside the version (#447): "v0.4.0 · 64ca0bc". */
    commit?: string
): string {
    const html = fillTemplate(template, {
        HUB_HOME_JS_URI: asset('hub/hub-home.js'),
        BUTTON_CONTRAST_JS_URI: asset('shared/button-contrast.js'),
        HUB_VERSION: versionLabel(version, commit),
        ATOMIC_CSS_URI: asset('shared/atomic.css'),
        CORE_CSS_URI: asset('shared/core.css'),
        MODALS_CSS_URI: asset('shared/modals.css'),
        TABLES_CSS_URI: asset('shared/tables.css'),
        HUB_CSS_URI: asset('shared/hub.css'),
        IMPORT_EXPORT_CSS_URI: asset('import-export/import-export.css'),
        SYSTEM_PICKER_CSS_URI: asset('shared/core.css'),
        HUB_JS_URI: asset('hub/hub.js'),
        HUB_TABS_JS_URI: asset('hub/hub-tabs.js'),
        HELP_MODE_JS_URI: asset('shared/help-mode.js'),
        THEME_PICKER_JS_URI: asset('shared/theme-picker.js'),
        THEME_PICKER_CSS_URI: asset('shared/theme-picker.css'),
        HUB_HELP_JS_URI: asset('hub/hub-help.js'),
        HUB_LAYOUT_JS_URI: asset('hub/hub-layout.js'),
        HUB_LOGO_URI: asset('shared/dbmn-logo.svg'),
        HUB_ACTIVITY_JS_URI: asset('hub/hub-activity.js'),
        SEARCH_WORDS_JS_URI: asset('shared/search-words.js'), // #444: the Catalogue's and History's search
        SEARCH_MATCHER_JS_URI: asset('shared/search-matcher.js'), // the tables' search: the Hub's lists read and colour the same
        SEARCH_CSS_URI: asset('shared/search.css'),
        CATALOGUE_JS_URI: asset('hub/catalogue.js'),
        HUB_TAG_MANAGER_JS_URI: asset('hub/hub-tag-manager.js'),
        TRANSACTIONS_JS_URI: asset('hub/transactions.js'),
        COMPARE_LIST_JS_URI: asset('hub/compare-list.js'),   // #298
        IMPORT_EXPORT_JS_URI: asset('hub/import-export-frontend.js'),
        ACCOUNT_FRONTEND_JS_URI: asset('hub/account-frontend.js'),
        SYSTEM_PICKER_JS_URI: asset('shared/system-picker.js'),
        DBMN_ACTIONS_JS_URI: asset('shared/dbmn-actions.js'),
        ICONS_JS_URI: asset('shared/icons.js'),
        EXECUTION_ACTIONS_JS_URI: asset('shared/execution-actions.js'),
        DBMN_CONTEXT_MENU_JS_URI: asset('shared/dbmn-context-menu.js'),
        BADGES_JS_URI: asset('shared/badges.js'),
        DEV_BACKEND_PILL: devBackend.DEV_BACKEND_PILL,
        DEV_BACKEND_NOTE: devBackend.DEV_BACKEND_NOTE,
        DBMN_MODAL_JS_URI: asset('shared/dbmn-modal.js'),
        ROW_PASTE_JS_URI: asset('shared/row-paste.js'),
        DBMN_TOAST_JS_URI: asset('shared/dbmn-toast.js'),
        DBMN_CLIPBOARD_JS_URI: asset('shared/dbmn-clipboard.js'),
        TOAST_CSS_URI: asset('shared/toast.css')
    });
    const script = initialState
        ? `<script>window.__HUB_INITIAL_STATE__ = ${JSON.stringify(initialState).replace(/</g, '\\u003c')};</script>`
        : '';
    return html.split('{{INITIAL_STATE_SCRIPT}}').join(script);
}
