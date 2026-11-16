// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Readable buttons in every theme.
 *
 * DBMN's buttons take their fill and text colour from the theme (`--vscode-button-*`): the
 * main action uses the primary pair, every other button the secondary pair. A theme decides
 * those pairs, and not every theme pairs them well. Omarchy's VS Code theme gives the
 * secondary button the theme's text colour on its muted colour — 2.8:1 on some palettes,
 * which is hard to read — and makes its hover fill the page background. The result was the
 * same lavender button with dark text in one place and pale text in another.
 *
 * The rule, the same on every screen and in every host (VS Code, the web app, the desktop app):
 *   1. A theme's own text colour is kept when it reads on its fill (MIN_TEXT_CONTRAST).
 *   2. When it does not, the text becomes whichever of the page's text colour or the page's
 *      background colour reads best on that fill — and only if that is better.
 *   3. The hover fill is kept when the text still reads on it. When it does not, hover
 *      becomes a slightly lighter or darker shade of the button's own fill.
 * A theme whose pairs already read (VS Code's own themes) is left exactly as it is.
 *
 * How: the corrected values are set as the same `--vscode-button-*` properties on <body>.
 * The theme's originals stay on <html> (VS Code and the app's theme layer write them there),
 * so every existing rule picks the correction up by inheritance, with no rule to change, and
 * this script only ever reads the originals.
 *
 * Loads in a page (window.DbmnButtonContrast, and it starts itself) and in Node for tests.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.DbmnButtonContrast = factory();
        root.DbmnButtonContrast.start(root.document);
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /** WCAG AA for normal text. */
    const MIN_TEXT_CONTRAST = 4.5;
    /** Below this on the hover fill the label is effectively gone. */
    const MIN_HOVER_CONTRAST = 3;
    /** How far hover moves from the resting fill when it has to be made. */
    const HOVER_SHIFT = 0.14;

    const WHITE = { r: 255, g: 255, b: 255, a: 1 };
    const BLACK = { r: 0, g: 0, b: 0, a: 1 };

    /** The four the two button kinds are made of, and the properties they are read from. */
    const KINDS = [
        { fill: '--vscode-button-background', hoverFill: '--vscode-button-hoverBackground', text: '--vscode-button-foreground' },
        { fill: '--vscode-button-secondaryBackground', hoverFill: '--vscode-button-secondaryHoverBackground', text: '--vscode-button-secondaryForeground' }
    ];
    const PAGE_TEXT = '--vscode-foreground';
    const PAGE_BACKGROUND = '--vscode-editor-background';

    /** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`; null for anything else. */
    function parseColor(value) {
        const text = String(value == null ? '' : value).trim().toLowerCase();
        let match = /^#([0-9a-f]{3,8})$/.exec(text);
        if (match) {
            let hex = match[1];
            if (hex.length === 3 || hex.length === 4) hex = hex.split('').map(c => c + c).join('');
            if (hex.length !== 6 && hex.length !== 8) return null;
            const channel = at => parseInt(hex.slice(at, at + 2), 16);
            return { r: channel(0), g: channel(2), b: channel(4), a: hex.length === 8 ? channel(6) / 255 : 1 };
        }
        match = /^rgba?\(([^)]+)\)$/.exec(text);
        if (match) {
            const parts = match[1].split(/[\s,/]+/).filter(Boolean);
            if (parts.length < 3) return null;
            const number = part => (part.endsWith('%') ? parseFloat(part) * 2.55 : parseFloat(part));
            const alpha = parts[3] === undefined ? 1 : (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]));
            const color = { r: number(parts[0]), g: number(parts[1]), b: number(parts[2]), a: alpha };
            return [color.r, color.g, color.b, color.a].some(n => !isFinite(n)) ? null : color;
        }
        return null;
    }

    /** `top` painted over an opaque `bottom`. */
    function over(top, bottom) {
        const a = top.a;
        return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
    }

    function mix(from, to, amount) {
        return { r: from.r + (to.r - from.r) * amount, g: from.g + (to.g - from.g) * amount, b: from.b + (to.b - from.b) * amount, a: 1 };
    }

    function luminance(color) {
        const linear = channel => {
            const c = channel / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
    }

    /** WCAG contrast ratio of two opaque colours, 1 to 21. */
    function contrast(a, b) {
        const la = luminance(a);
        const lb = luminance(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    }

    function toHex(color) {
        const part = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
        return '#' + part(color.r) + part(color.g) + part(color.b);
    }

    /**
     * One button kind, corrected. Colours are CSS strings as the theme gives them. Returns the
     * text colour and hover fill to use instead, each null when the theme's own is kept.
     */
    function correctButton(theme) {
        const pageBackground = parseColor(theme.pageBackground);
        const pageText = parseColor(theme.pageText);
        const fillRaw = parseColor(theme.fill);
        const textRaw = parseColor(theme.text);
        if (!pageBackground || !pageText || !fillRaw || !textRaw) {
            return { text: null, hoverFill: null };      // a colour this cannot read: leave the theme alone
        }
        const page = over(pageBackground, WHITE);
        const fill = over(fillRaw, page);
        let text = over(textRaw, fill);
        let textChanged = false;

        if (contrast(text, fill) < MIN_TEXT_CONTRAST) {
            const best = [over(pageText, fill), page].sort((a, b) => contrast(b, fill) - contrast(a, fill))[0];
            if (contrast(best, fill) > contrast(text, fill)) {
                text = best;
                textChanged = true;
            }
        }

        let hoverFill = null;
        const hoverRaw = parseColor(theme.hoverFill);
        if (hoverRaw && contrast(text, over(hoverRaw, page)) < MIN_HOVER_CONTRAST) {
            // Away from the text, so the label reads at least as well as it does at rest
            hoverFill = toHex(mix(fill, luminance(text) < luminance(fill) ? WHITE : BLACK, HOVER_SHIFT));
        }
        return { text: textChanged ? toHex(text) : null, hoverFill };
    }

    function read(style, name) {
        return String(style.getPropertyValue(name) || '').trim();
    }

    /**
     * Read the theme from <html> and put what needs correcting on <body>. Safe to call again
     * whenever the theme changes: a property that no longer needs correcting is taken off.
     */
    function apply(doc) {
        if (!doc || !doc.documentElement || !doc.body) return;
        const view = doc.defaultView;
        const computed = view && view.getComputedStyle ? view.getComputedStyle(doc.documentElement) : null;
        const inline = doc.documentElement.style;
        const theme = name => (computed && read(computed, name)) || read(inline, name);
        const set = (name, value) => {
            const current = read(doc.body.style, name);
            if (value && current !== value) doc.body.style.setProperty(name, value);
            if (!value && current) doc.body.style.removeProperty(name);
        };
        for (const kind of KINDS) {
            const corrected = correctButton({
                pageBackground: theme(PAGE_BACKGROUND), pageText: theme(PAGE_TEXT),
                fill: theme(kind.fill), hoverFill: theme(kind.hoverFill), text: theme(kind.text)
            });
            set(kind.text, corrected.text);
            set(kind.hoverFill, corrected.hoverFill);
        }
    }

    /** Apply now (or when the page has a body), and again whenever the theme changes. */
    function start(doc) {
        if (!doc) return;
        const run = () => apply(doc);
        if (doc.body) run();
        else doc.addEventListener('DOMContentLoaded', run);
        const Observer = doc.defaultView && doc.defaultView.MutationObserver;
        if (!Observer) return;
        // VS Code rewrites <html style> and <body class> on a theme change; the app's theme
        // layer rewrites <html style>. <body style> is ours, so it is not watched.
        const observer = new Observer(run);
        observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
        const watchBody = () => observer.observe(doc.body, { attributes: true, attributeFilter: ['class'] });
        if (doc.body) watchBody();
        else doc.addEventListener('DOMContentLoaded', watchBody);
    }

    return { MIN_TEXT_CONTRAST, parseColor, contrast, correctButton, apply, start };
}));
