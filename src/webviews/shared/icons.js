// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Icon registry for DBMN webviews.
 *
 * Icons are inlined SVG strings so they:
 *   - work under VS Code's strict webview CSP (no external CDNs)
 *   - inherit the active theme colour via `stroke="currentColor"`
 *   - cost no extra network round-trips
 *
 * Source: most icons are from https://lucide.dev (MIT licensed; copy of the
 * licence would sit at LICENSES/lucide-MIT.txt if added).
 * Custom icons designed in-house live alongside lucide ones in the same map —
 * just add a new entry to ICONS.
 *
 * Usage in HTML:
 *     <span data-icon="library"></span>
 *
 * Usage in JS:
 *     window.Icons.injectIcons();                  // hydrate all [data-icon]
 *     window.Icons.setIcon(el, 'chevrons-right');  // swap icon on an element
 *     el.innerHTML = window.Icons.icon('x');       // get raw SVG string
 *
 * ICON_ROLES — the *function* each icon performs in the UI ("paste-endpoint"
 * → 'clipboard'). Documentation and Puppy School lessons reference roles,
 * never icon names, via `{icon:paste-endpoint}` tokens; `npm run docs:icons`
 * exports ROLES + SVGs to the dbmn repo (`_data/dbmn_icons.json`) so the
 * website always shows the icon the product currently uses. A unit test
 * (icon-roles.test.ts) checks each role against the HTML/JS that renders the
 * control, so changing a control's icon without updating its role fails CI.
 *
 * Loads in the webview (window.Icons) and in Node (module.exports) — the
 * exporter and the tests require() this file directly.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root && typeof root === 'object') {
        root.Icons = api;
    }
}(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    // All icons use viewBox 24x24, no explicit width/height (CSS sizes them),
    // stroke="currentColor" so the theme colour is inherited.
    const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
    const SVG_CLOSE = '</svg>';
    const wrap = (paths) => SVG_OPEN + paths + SVG_CLOSE;

    const ICONS = {
        // ── Lucide ────────────────────────────────────────────────────────
        // Hub section nav
        'notebook-tabs':   wrap('<path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M15 2v20"/><path d="M15 7h5"/><path d="M15 12h5"/><path d="M15 17h5"/>'),
        'layers':          wrap('<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m6.08 9.5-3.5 1.6a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.49-1.59"/><path d="m6.08 14.5-3.5 1.6a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.49-1.59"/>'),
        'server':          wrap('<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>'),
        'ellipsis':        wrap('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
        // #298: Compare (lucide "scale")
        'scale':           wrap('<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>'),
        'blend':           wrap('<circle cx="9" cy="9" r="7"/><circle cx="15" cy="15" r="7"/>'),
        // A lookup table (the Hub's Reporting list, its tab) — lucide "sheet"
        'sheet':           wrap('<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><line x1="3" x2="21" y1="9" y2="9"/><line x1="3" x2="21" y1="15" y2="15"/><line x1="9" x2="9" y1="9" y2="21"/><line x1="15" x2="15" y1="9" y2="21"/>'),
        // A key column (dbmn-table: its values one per row) — lucide "key-round"
        'key-round':       wrap('<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>'),
        'lock':            wrap('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
        'database':        wrap('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>'),
        'git-merge':       wrap('<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>'),
        'settings':        wrap('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),

        // Nav-collapse toggle
        'chevrons-left':   wrap('<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>'),
        'chevrons-right':  wrap('<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>'),
        'chevron-down':    wrap('<path d="m6 9 6 6 6-6"/>'),
        'chevron-up':      wrap('<path d="m18 15-6-6-6 6"/>'),
        'circle-chevron-left':  wrap('<circle cx="12" cy="12" r="10"/><path d="m14 16-4-4 4-4"/>'),
        'circle-chevron-right': wrap('<circle cx="12" cy="12" r="10"/><path d="m10 8 4 4-4 4"/>'),
        'circle-chevron-up':    wrap('<circle cx="12" cy="12" r="10"/><path d="m8 14 4-4 4 4"/>'),
        'circle-chevron-down':  wrap('<circle cx="12" cy="12" r="10"/><path d="m16 10-4 4-4-4"/>'),
        'panel-left-open':      wrap('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/>'),
        'panel-left-close':     wrap('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>'),

        // Misc actions
        'x':               wrap('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
        'tab-x':           wrap('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>'),
        'plus':            wrap('<path d="M5 12h14"/><path d="M12 5v14"/>'),
        'pencil':          wrap('<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>'),
        'check':           wrap('<path d="M20 6 9 17l-5-5"/>'),
        'search':          wrap('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
        'satellite-dish':  wrap('<path d="M4 10a7.31 7.31 0 0 0 10 10Z"/><path d="m9 15 3-3"/><path d="M17 13a6 6 0 0 0-6-6"/><path d="M21 13A10 10 0 0 0 11 3"/>'),
        'user':            wrap('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
        'paw-print':       wrap('<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.4 2.5 15.5 2.5 13a2.5 2.5 0 0 1 5 0"/>'),
        'history':         wrap('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>'),
        'minus':           wrap('<path d="M5 12h14"/>'),
        'maximize-2':      wrap('<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>'),
        'minimize-2':      wrap('<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" x2="21" y1="10" y2="3"/><line x1="3" x2="10" y1="21" y2="14"/>'),
        'upload':          wrap('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>'),
        'download':        wrap('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'),
        'circle-check':    wrap('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),
        'circle-check-big':wrap('<path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/>'),
        'circle-x':        wrap('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>'),
        'circle-play':     wrap('<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>'),
        'circle-pause':    wrap('<circle cx="12" cy="12" r="10"/><line x1="10" x2="10" y1="15" y2="9"/><line x1="14" x2="14" y1="15" y2="9"/>'),
        'octagon-x':       wrap('<path d="M2.586 16.726A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2h6.624a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688A2 2 0 0 1 15.312 22H8.688a2 2 0 0 1-1.414-.586z"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>'),
        'clock':           wrap('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
        'loader':          wrap('<path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/>'),
        'play':            wrap('<polygon points="6 3 20 12 6 21 6 3"/>'),
        // Console (Issue #312: the Console's emoji → Lucide)
        'pause':           wrap('<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>'),
        'square':          wrap('<rect width="18" height="18" x="3" y="3" rx="2"/>'),
        'refresh-cw':      wrap('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'),
        'arrow-right':     wrap('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
        'external-link':   wrap('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
        'chevron-right':   wrap('<path d="m9 18 6-6-6-6"/>'),
        'chevron-left':    wrap('<path d="m15 18-6-6 6-6"/>'),
        'eye':             wrap('<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>'),
        'eye-off':         wrap('<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>'),
        'timer':           wrap('<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>'),
        'hourglass':       wrap('<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>'),
        'info':            wrap('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
        'circle-dot-dashed': wrap('<path d="M10.1 2.18a9.93 9.93 0 0 1 3.8 0"/><path d="M17.6 3.71a9.95 9.95 0 0 1 2.69 2.7"/><path d="M21.82 10.1a9.93 9.93 0 0 1 0 3.8"/><path d="M20.29 17.6a9.95 9.95 0 0 1-2.7 2.69"/><path d="M13.9 21.82a9.94 9.94 0 0 1-3.8 0"/><path d="M6.4 20.29a9.95 9.95 0 0 1-2.69-2.7"/><path d="M2.18 13.9a9.93 9.93 0 0 1 0-3.8"/><path d="M3.71 6.4a9.95 9.95 0 0 1 2.7-2.69"/><circle cx="12" cy="12" r="1"/>'),
        // Results' toggles: Totals (Lucide square-sigma); hidden characters, Word's show/hide mark (pilcrow)
        'square-sigma':    wrap('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M16 8.9V7H8l4 5-4 5h8v-1.9"/>'),
        'pilcrow':         wrap('<path d="M13 4v16"/><path d="M17 4v16"/><path d="M19 4H9.5a4.5 4.5 0 0 0 0 9H13"/>'),
        'clock-arrow-up':  wrap('<path d="M13.228 21.925A10 10 0 1 1 21.994 12.338"/><path d="M12 6v6l1.562.781"/><path d="m14 18 4-4 4 4"/><path d="M18 22v-8"/>'),
        'clock-arrow-down': wrap('<path d="M12.338 21.994A10 10 0 1 1 21.925 13.227"/><path d="M12 6v6l2 1"/><path d="m14 18 4 4 4-4"/><path d="M18 14v8"/>'),
        'arrow-down-a-z':  wrap('<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M20 8h-5"/><path d="M15 10V6.5a2.5 2.5 0 0 1 5 0V10"/><path d="M15 14h5l-5 6h5"/>'),
        'arrow-down-z-a':  wrap('<path d="m3 16 4 4 4-4"/><path d="M7 4v16"/><path d="M15 4h5l-5 6h5"/><path d="M15 20v-3.5a2.5 2.5 0 0 1 5 0V20"/><path d="M20 18h-5"/>'),
        'arrow-down-0-1':  wrap('<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><rect x="15" y="4" width="4" height="6" ry="2"/><path d="M17 20v-6h-2"/><path d="M15 20h4"/>'),
        'arrow-down-1-0':  wrap('<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M17 10V4h-2"/><path d="M15 10h4"/><rect x="15" y="14" width="4" height="6" ry="2"/>'),
        // A list of records opened full width, under its row, or back into its cell (dbmn-table)
        'unfold-horizontal': wrap('<path d="M16 12h6"/><path d="M8 12H2"/><path d="M12 2v2"/><path d="M12 8v2"/><path d="M12 14v2"/><path d="M12 20v2"/><path d="m19 15 3-3-3-3"/><path d="m5 9-3 3 3 3"/>'),
        'fold-horizontal': wrap('<path d="M2 12h6"/><path d="M22 12h-6"/><path d="M12 2v2"/><path d="M12 8v2"/><path d="M12 14v2"/><path d="M12 20v2"/><path d="m19 9-3 3 3 3"/><path d="m5 15 3-3-3-3"/>'),
        'move-horizontal': wrap('<path d="m18 8 4 4-4 4"/><path d="M2 12h20"/><path d="m6 8-4 4 4 4"/>'),
        'triangle-dashed': wrap('<path d="M10.17 4.193a2 2 0 0 1 3.666.013"/><path d="M14 21h2"/><path d="m15.874 7.743 1 1.732"/><path d="m18.849 12.952 1 1.732"/><path d="M21.824 18.18a2 2 0 0 1-1.835 2.824"/><path d="M4.024 21a2 2 0 0 1-1.839-2.839"/><path d="m5.136 12.952-1 1.732"/><path d="M8 21h2"/><path d="m8.102 7.743-1 1.732"/>'),
        'triangle-alert':  wrap('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
        'star':            wrap('<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>'),
        'folder':          wrap('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
        'scroll-text':     wrap('<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>'),
        'file-text':       wrap('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>'),
        'lightbulb':       wrap('<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>'),
        'folder-tree-play':wrap('<polygon points="11 3.5 18 7 11 10.5"/><polygon points="11 14.5 18 18 11 21.5"/><path d="M3 5a2 2 0 0 0 2 2h3"/><path d="M3 3v13a2 2 0 0 0 2 2h3"/>'),
        'clipboard':       wrap('<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>'),
        'copy':            wrap('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
        'globe':           wrap('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>'),
        // The help mode button (Hub header) — Lucide shield-question-mark.
        'shield-question-mark': wrap('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
        // The theme picker (Hub header, and dbmn.io) — Lucide palette.
        'palette':         wrap('<path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"/><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/>'),
        // An environment that runs in DBMN for VS Code (#344), beside its name in the Hub header,
        // the environment list and the Console title: the VS Code mark drawn in Lucide's line
        // style (Tabler's brand-vscode, MIT).
        'vscode':          wrap('<path d="M16 3v18l4 -2.5v-13z"/><path d="M9.165 13.903l-4.165 3.597l-2 -1l4.333 -4.5m1.735 -1.802l6.932 -7.198v5l-4.795 4.141"/><path d="M16 16.5l-11 -10l-2 1.5l13 13.5"/>'),
        'file-question':   wrap('<path d="M12 17h.01"/><path d="M15.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h2.5"/><path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"/>'),

        // Endpoint "Add" menu
        'braces':          wrap('<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>'),
        'tag':             wrap('<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>'),
        'list-filter':     wrap('<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>'),
        // #444: the search query builder (Lucide text-search)
        'text-search':     wrap('<path d="M21 6H3"/><path d="M10 12H3"/><path d="M10 18H3"/><circle cx="17" cy="15" r="3"/><path d="m21 19-1.9-1.9"/>'),
        'funnel':          wrap('<path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"/>'),
        'funnel-filled':   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"/></svg>',
        'corner-down-left':wrap('<path d="m9 10-5 5 5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>'),
        'ampersand':       wrap('<path d="M17.5 12c0 4.4-3.6 8-8 8A4.5 4.5 0 0 1 5 15.5c0-6 8-4 8-8.5a3 3 0 1 0-6 0c0 3 2.5 8.5 12 13"/><path d="M16 12h3"/>'),

        // Request Body editor toolbar
        'variable':        wrap('<path d="M8 21s-4-3-4-9 4-9 4-9"/><path d="M16 3s4 3 4 9-4 9-4 9"/><line x1="15" x2="9" y1="9" y2="15"/><line x1="9" x2="15" y1="9" y2="15"/>'),
        'sliders-horizontal':wrap('<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>'),
        'binary':          wrap('<rect x="14" y="14" width="4" height="6" rx="2"/><rect x="6" y="4" width="4" height="6" rx="2"/><path d="M6 20h4"/><path d="M14 10h4"/><path d="M6 14h2v6"/><path d="M14 4h2v6"/>'),
        'message-square':  wrap('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
        'trash-2':         wrap('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>'),
        'undo-2':          wrap('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/>'),
        'redo-2':          wrap('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13"/>'),
        'wand-sparkles':   wrap('<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/>'),
        'flask-conical':   wrap('<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/>')

        // ── Custom (add your own here) ────────────────────────────────────
        // Example: copy a lucide SVG's <path>/etc children below as a string.
        //
        // 'my-custom-icon': wrap('<path d="..."/>')
    };

    // ── Roles: what each icon DOES in the product ─────────────────────
    // Key = the function, value = the ICONS entry currently drawn for it.
    // When you change a control's icon, change its role here too — the
    // icon-roles unit test pins each role to the markup that renders it.
    // Docs and Puppy School use `{icon:<role>}`; see the header comment.
    const ICON_ROLES = {
        // Hub navigation (hub.html)
        'nav-environments':   'server',
        'nav-api-catalogue':  'notebook-tabs',
        'nav-history':        'history',
        'nav-reporting':      'database',
        'nav-import':         'download',
        'nav-export':         'upload',
        'nav-logs':           'scroll-text',
        'nav-account':        'user',
        'nav-settings':       'settings',
        'env-switcher':       'chevron-down',
        'filters':            'funnel',
        'build-search':       'text-search',   // #444: the Hub search's query builder
        // Compare's Results toolbar (compare-page.ts)
        'compare-columns':    'settings',
        'compare-open-result':'external-link',
        'compare-export':     'download',

        // Help mode: the one help button, in the Hub header (shared/help-mode.js)
        'help':               'shield-question-mark',
        // The theme picker, beside it (shared/theme-picker.js); hidden in VS Code
        'theme-picker':       'palette',
        'paste-row':          'clipboard',

        // Endpoints, the API Catalogue until 0.4.0 (catalogue.js)
        'add-endpoint':       'plus',
        'paste-endpoint':     'clipboard',
        'run-api':            'play',
        'run-batch':          'folder-tree-play',

        // Endpoint editor (endpoint.html)
        'editor-line-variable':  'variable',
        'editor-insert-var':     'braces',
        'editor-modifier':       'sliders-horizontal',
        'editor-encode':         'binary',
        'editor-comment':        'message-square',
        'editor-delete-line':    'trash-2',
        'editor-undo':           'undo-2',
        'editor-redo':           'redo-2',
        'editor-format':         'wand-sparkles',
        'add-header':            'corner-down-left',
        'add-query-param':       'ampersand',
        'add-request-body':      'braces',
        'window-maximise':       'maximize-2',
        'window-close':          'x',

        // Execution status (statusIcon() below)
        'status-completed':   'circle-check-big',
        'status-error':       'circle-x',
        'status-running':     'circle-play',
        'status-paused':      'circle-pause',
        'status-stopped':     'octagon-x',
        'status-queued':      'clock',

        // Console footer (console.html / batch-actions.js)
        'console-rerun':      'refresh-cw',
        'console-reprocess':  'refresh-cw',
        'console-next-page':  'arrow-right',
        'console-cancel':     'square',
        'console-pause':      'pause',
        'console-resume':     'play'
    };

    function icon(name) {
        return ICONS[name] || '';
    }

    /** SVG for a role (e.g. 'paste-endpoint'), or '' when unknown. */
    function roleIcon(role) {
        return icon(ICON_ROLES[role]);
    }

    /**
     * Issue #312: an icon beside a text label — "⏹️ Cancel" without the emoji.
     * `cls` is 'btn-icon' inside a .btn (core.css sizes it to the label) or
     * 'inline-icon' in running text. Markup only; the caller sets innerHTML.
     */
    function label(name, text, cls) {
        const c = cls || 'inline-icon';
        return '<span class="' + c + '" data-icon="' + name + '">' + icon(name) + '</span>' + (text ? '<span>' + text + '</span>' : '');
    }

    function setIcon(el, name) {
        if (!el) return;
        el.setAttribute('data-icon', name);
        el.innerHTML = icon(name);
    }

    function injectIcons(root) {
        const scope = root || document;
        scope.querySelectorAll('[data-icon]').forEach(el => {
            const name = el.getAttribute('data-icon');
            // Only inject if the element is empty — preserves already-hydrated
            // icons across re-renders.
            if (!el.firstChild) el.innerHTML = icon(name);
        });
    }

    /** Canonical execution-status → icon mapping. Single source of truth for
     *  the tab strip, activity drawer, transactions list — anything that
     *  renders an execution status. Returns { icon, bucket, title } where
     *  bucket drives colour via `data-bucket` and title is the raw status
     *  word (UPPERCASE) for the tooltip / a11y label. */
    function statusIcon(raw) {
        const r = String(raw || '').toLowerCase();
        const title = (raw || 'unknown').toString().toUpperCase();
        if (r === 'completed' || r === 'success' || r === 'done')
            return { icon: 'circle-check-big', bucket: 'success', title };
        if (r === 'failed' || r === 'error')
            return { icon: 'circle-x',         bucket: 'error',   title };
        if (r === 'running' || r === 'in_progress' || r === 'processing')
            return { icon: 'circle-play',      bucket: 'running', title };
        if (r === 'paused')
            return { icon: 'circle-pause',     bucket: 'pending', title };
        if (r === 'stopped' || r === 'cancelled')
            return { icon: 'octagon-x',        bucket: 'error',   title };
        if (r === 'queued' || r === 'pending')
            return { icon: 'clock',            bucket: 'pending', title };
        if (r === 'partial')
            return { icon: 'circle-pause',     bucket: 'error',   title };
        if (r === 'preparing')
            return { icon: 'clock',            bucket: 'running', title };
        return { icon: 'clock', bucket: 'pending', title };
    }

    return { ICONS, ICON_ROLES, icon, roleIcon, label, setIcon, injectIcons, statusIcon };
}));
