// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Shared Value Formatter (GitHub Issue #271)
 *
 * Long string cells in the console Report view often carry structured payloads:
 * escaped JSON, BASE64-encoded blobs, or ZPL label markup. This module detects
 * the likely content type and pretty-prints it for the cell-detail modal.
 *
 * Pure functions only — NO DOM, NO VS Code API — so it is unit-testable and can
 * run in both the webview (window global) and Node (module.exports).
 *
 * Used by:
 * - Frontend (console.html) — cell-detail modal formatting + format picker
 */

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof window !== 'undefined') {
        window.ValueFormatter = api;
    }
})(this, function () {
    'use strict';

    const TYPES = ['auto', 'deep', 'json', 'escaped-json', 'base64', 'zpl', 'text'];
    const MAX_DEEP_DEPTH = 8;

    function tryParseJson(s) {
        try {
            return { ok: true, value: JSON.parse(s) };
        } catch (e) {
            return { ok: false };
        }
    }

    // Interpret backslash escapes in a JSON-ish string (\" \\ \n …) by treating
    // it as the CONTENTS of a JSON string literal and parsing. Escaped-JSON
    // payloads already have their inner quotes backslash-escaped, so wrapping in
    // quotes and parsing collapses `\"` → `"`. Returns null on failure (e.g. a
    // bare unescaped quote or control char that breaks the wrapper).
    function unescapeJsonish(s) {
        try {
            return JSON.parse('"' + s + '"');
        } catch (e) {
            return null;
        }
    }

    function looksLikeZpl(s) {
        // ZPL programs open with ^XA and use ^-prefixed commands (^FO, ^FD, …).
        return s.startsWith('^XA') || /\^(XA|XZ|FO|FD|FS|BY|GB|A0|CF)/.test(s);
    }

    function looksLikeJson(s) {
        const c = s.charAt(0);
        return (c === '{' || c === '[') && tryParseJson(s).ok;
    }

    function looksLikeEscapedJson(s) {
        // Must contain literal backslash-escaped quotes AND unescape to real JSON.
        if (s.indexOf('\\"') === -1) return false;
        const un = unescapeJsonish(s);
        if (un === null) return false;
        const t = un.trim();
        return (t.charAt(0) === '{' || t.charAt(0) === '[') && tryParseJson(t).ok;
    }

    function decodeBase64(s) {
        if (typeof Buffer !== 'undefined') return Buffer.from(s, 'base64').toString('utf8');
        if (typeof atob === 'function') return atob(s);
        throw new Error('No base64 decoder available');
    }

    function looksLikeBase64(s) {
        // Conservative: even-quartet length, base64 charset, and a printable
        // decode. The length floor avoids flagging short IDs/tokens.
        if (s.length < 16 || s.length % 4 !== 0) return false;
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
        let decoded;
        try {
            decoded = decodeBase64(s);
        } catch (e) {
            return false;
        }
        if (!decoded) return false;
        // Require the decode to be mostly printable, else it's likely just an
        // opaque token that happens to fit the charset.
        let printable = 0;
        for (let i = 0; i < decoded.length; i++) {
            const code = decoded.charCodeAt(i);
            if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)) printable++;
        }
        return decoded.length > 0 && printable / decoded.length >= 0.85;
    }

    /**
     * Best-effort detect the content type of a string cell value.
     *
     * @param {*} value
     * @returns {'json'|'escaped-json'|'base64'|'zpl'|'text'}
     */
    function detectValueType(value) {
        if (typeof value !== 'string') return 'text';
        const s = value.trim();
        if (!s) return 'text';
        if (looksLikeZpl(s)) return 'zpl';
        if (looksLikeJson(s)) return 'json';
        if (looksLikeEscapedJson(s)) return 'escaped-json';
        if (looksLikeBase64(s)) return 'base64';
        return 'text';
    }

    function prettyJson(value) {
        return JSON.stringify(value, null, 2);
    }

    /**
     * If a string is itself a structured payload — JSON, escaped JSON, or a
     * BASE64 blob that decodes to JSON — return the parsed value. Otherwise
     * return undefined (plain text, numbers-as-strings, dates, encrypted tokens
     * etc. are left untouched). BASE64 is only accepted when it decodes to JSON,
     * so encrypted/opaque tokens are never mangled.
     *
     * @param {string} str
     * @returns {* | undefined}
     */
    function tryStructured(str) {
        if (typeof str !== 'string') return undefined;
        const s = str.trim();
        if (!s) return undefined;
        if (s.charAt(0) === '{' || s.charAt(0) === '[') {
            const p = tryParseJson(s);
            if (p.ok) return p.value;
        }
        if (s.indexOf('\\"') !== -1) {
            const un = unescapeJsonish(s);
            if (un !== null) {
                const t = un.trim();
                if (t.charAt(0) === '{' || t.charAt(0) === '[') {
                    const p = tryParseJson(t);
                    if (p.ok) return p.value;
                }
            }
        }
        if (looksLikeBase64(s)) {
            try {
                const p = tryParseJson(decodeBase64(s).trim());
                if (p.ok) return p.value;
            } catch (e) { /* not base64-of-json */ }
        }
        return undefined;
    }

    /**
     * Recursively expand nested structured strings inside a parsed value so a
     * deeply-wrapped payload (a JSON field that is itself escaped JSON or a
     * BASE64-of-JSON blob) becomes fully readable rather than an escaped
     * one-liner. Depth-capped to avoid pathological nesting.
     *
     * @param {*} value - already-parsed value
     * @param {number} depth
     * @returns {*}
     */
    function deepExpand(value, depth) {
        if (depth <= 0 || value === null || value === undefined) return value;
        if (typeof value === 'string') {
            const inner = tryStructured(value);
            return inner === undefined ? value : deepExpand(inner, depth - 1);
        }
        if (Array.isArray(value)) {
            return value.map((v) => deepExpand(v, depth - 1));
        }
        if (typeof value === 'object') {
            const out = {};
            for (const k of Object.keys(value)) out[k] = deepExpand(value[k], depth - 1);
            return out;
        }
        return value;
    }

    /**
     * Format a string value for display using the given type. Pass 'auto' (or
     * omit) to detect first. Never throws — on failure returns the raw string
     * with an `error` message so the modal can fall back gracefully.
     *
     * @param {*} value - Raw cell value (coerced to string)
     * @param {string} [type] - one of TYPES; defaults to 'auto'
     * @returns {{ text: string, type: string, error?: string }}
     */
    function formatValue(value, type) {
        const raw = value == null ? '' : String(value);
        let effective = type && TYPES.indexOf(type) !== -1 ? type : 'auto';

        // 'deep' — detect the base type, parse it, then recursively expand any
        // nested structured strings so multi-level payloads become readable.
        if (effective === 'deep') {
            const base = detectValueType(raw);
            let parsed = { ok: false };
            if (base === 'json') {
                parsed = tryParseJson(raw.trim());
            } else if (base === 'escaped-json') {
                const un = unescapeJsonish(raw.trim());
                parsed = un !== null ? tryParseJson(un.trim()) : { ok: false };
            } else if (base === 'base64') {
                try { parsed = tryParseJson(decodeBase64(raw.trim()).trim()); } catch (e) { parsed = { ok: false }; }
            }
            if (parsed.ok) {
                return { text: prettyJson(deepExpand(parsed.value, MAX_DEEP_DEPTH)), type: 'deep' };
            }
            // Not a structured payload (plain text, ZPL, opaque token) — fall
            // back to the ordinary single-level formatting of the detected type.
            return formatValue(raw, base);
        }

        if (effective === 'auto') effective = detectValueType(raw);

        switch (effective) {
            case 'json': {
                const parsed = tryParseJson(raw.trim());
                if (parsed.ok) return { text: prettyJson(parsed.value), type: 'json' };
                return { text: raw, type: 'json', error: 'Not valid JSON' };
            }
            case 'escaped-json': {
                const un = unescapeJsonish(raw.trim());
                const parsed = un !== null ? tryParseJson(un.trim()) : { ok: false };
                if (parsed.ok) return { text: prettyJson(parsed.value), type: 'escaped-json' };
                return { text: raw, type: 'escaped-json', error: 'Could not unescape JSON' };
            }
            case 'base64': {
                try {
                    const decoded = decodeBase64(raw.trim());
                    // A base64 blob often wraps JSON — pretty-print it if so.
                    const inner = tryParseJson(decoded.trim());
                    if (inner.ok) return { text: prettyJson(inner.value), type: 'base64' };
                    return { text: decoded, type: 'base64' };
                } catch (e) {
                    return { text: raw, type: 'base64', error: 'Could not decode BASE64' };
                }
            }
            case 'zpl':
                // Keep ZPL byte-accurate; only normalise line endings.
                return { text: raw.replace(/\r\n/g, '\n'), type: 'zpl' };
            case 'text':
            default:
                return { text: raw, type: 'text' };
        }
    }

    return { TYPES, detectValueType, formatValue };
});
