// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Parser for the "shared endpoint" clipboard format (GitHub Issues #188, #278, #291).
 *
 * Pure string → object logic, extracted from EndpointManager so it can be unit
 * tested against every real clipboard variant. Two variants exist, and BOTH
 * must round-trip:
 *
 *   1. Plain-text (from copyToClipboard) — JSONC metadata comments + body:
 *        // Name: …
 *        // Method: …
 *        // Path: …
 *        <body>
 *
 *   2. Rendered card (from buildEndpointHtml, i.e. what you get when you copy
 *      the *visible* share card out of Teams/Outlook/a browser) — the same,
 *      but wrapped with a "DBMN Endpoint" title line ABOVE the metadata and a
 *      "⚡ Dobermann | …" footer BELOW the body.
 *
 * Issue #278 bug: the title line sat before the `//` metadata and was mistaken
 * for the first body line, so `inBody` flipped on immediately and the metadata
 * never parsed → the paste was rejected. Fix: don't let any preamble line
 * (before the first metadata comment) start the body.
 *
 * Issue #291 bug: chat/email clients frequently collapse the card's whitespace
 * so the whole thing arrives on ONE line ("DBMN Endpoint // Name: X // Method:
 * POST // Path: /p { … } ⚡ Dobermann …"). A purely line-based parser saw no
 * `// Name:` at the start of any line and rejected it as invalid content.
 * Fix: {@link normaliseSharedEndpointText} re-introduces line breaks around the
 * metadata tokens (and after single-token Method/Path values and the
 * `[enabled]`/`[disabled]` flags) before the line parser runs, so flattened,
 * CRLF and non-breaking-space variants all parse identically to the pristine
 * multi-line text. The same issue asked that a paste "always resolve, even if
 * we can only find a few bits of information" — so the JSONC format now
 * accepts a name OR a path rather than requiring both.
 *
 * A legacy `Name:/Method:/Path:/Body:` (no `//`) format is still accepted; it
 * keeps the stricter name AND path rule because its bare keywords are far
 * more likely to appear in ordinary prose.
 */

export interface ParsedSharedEndpoint {
    name?: string;
    method?: string;
    path?: string;
    description?: string;
    body?: string;
    headers?: Array<{ key: string; value: string; enabled: boolean }>;
    queryParams?: Array<{ key: string; value: string; enabled: boolean }>;
    /** Normalised (trimmed, lower-cased, de-duplicated) — the same rules as the tag editor. */
    tags?: string[];
    /** Said to the user when the paste came through without its line breaks and its body couldn't be read back for certain. */
    warning?: string;
}

/** What the paste says when a flattened body couldn't be put back for certain. */
export const FLATTENED_BODY_WARNING = 'This endpoint lost its line breaks on the way (some chats do that), and its body could not be read back for certain. Check the body before you save, or share the endpoint as a file.';

type MetaKey = 'Name' | 'Method' | 'Path' | 'Description' | 'Tags' | 'Header' | 'QueryParam';

const META_KEYS = 'Name|Method|Path|Description|Tags|Header|QueryParam';

/**
 * Any `// Key:` token, known or not. A card from a newer version may carry keys this
 * version has never heard of; they get their own line (so they never bleed into the
 * value before them when the text was flattened) and the line parser then ignores them.
 */
const ANY_KEY = '[A-Za-z][A-Za-z0-9_-]*';

/**
 * A metadata line: `// Key: value`. At least one space after `//` is required
 * so `https://host//Name:` inside a URL is never mistaken for metadata.
 */
const META_LINE = new RegExp(`^\\s*\\/\\/\\s+(${META_KEYS}):\\s*(.*)$`);

/** Every metadata token — known or unknown — wherever it sits in the text. */
const META_TOKEN_ANYWHERE = new RegExp(`[ \\t]*(\\/\\/[ \\t]+${ANY_KEY}:)`, 'g');

/** Method/Path values are single tokens; anything after them on the line is body. */
const SINGLE_TOKEN_VALUE = /^(\/\/[ \t]+(?:Method|Path):[ \t]*\S+)[ \t]+(?=\S)/gm;

/** Header/QueryParam values end at their [enabled]/[disabled] flag. */
const FLAGGED_VALUE = /^(\/\/[ \t]+(?:Header|QueryParam):.*?\[(?:enabled|disabled)\])[ \t]+(?=\S)/gm;

/**
 * A Header/QueryParam line with no flag (the flag is optional — absent means enabled)
 * that has a JSON body glued onto it: the body starts at the first ` {` that is not a
 * `{{template}}`. Only lines without a flag; FLAGGED_VALUE already handled the rest.
 */
const UNFLAGGED_VALUE_THEN_BODY = /^(\/\/[ \t]+(?:Header|QueryParam):(?:(?!\[(?:enabled|disabled)\]).)*?)[ \t]+(?=\{(?!\{))/gm;

/**
 * A Name/Description/Tags line with a JSON body glued onto it (a flattened card: "// Description: Create PO{  "Actions"…").
 * The body starts at the first `{` (never `{{`) that opens real JSON (a key, an empty object or a comment), or a `[`
 * opening a list of them.
 */
const TEXT_VALUE_THEN_BODY = /^(\/\/[ \t]+(?:Name|Description|Tags):.*?)[ \t]*(?=\{(?!\{)\s*(?:"|\}|\/\/)|\[\s*[{"[\]])/gm;

/** `key: value [enabled|disabled]` payload of a Header/QueryParam line; the flag is optional. */
const KEY_VALUE_FLAG = /^(.+?):\s*(.*?)\s*(?:\[(enabled|disabled)\])?\s*$/;

/**
 * Quick, cheap "does this look like a shared DBMN endpoint?" check. Used by
 * the webview's Ctrl+V interception so ordinary pastes are never hijacked —
 * only text carrying at least one metadata token (or the card title) is
 * routed through the endpoint parser.
 */
export function looksLikeSharedEndpointText(text: string): boolean {
    if (!text) {
        return false;
    }
    const t = text.replace(/ /g, ' ');
    return new RegExp(`\\/\\/[ \\t]+(?:Name|Method|Path):`).test(t) || /^\s*DBMN Endpoint\b/.test(t);
}

/**
 * Re-introduce the line structure that rich-text round-trips destroy.
 * Idempotent on already well-formed text (it only ever adds blank lines,
 * which the line parser skips), so it runs unconditionally.
 */
export function normaliseSharedEndpointText(text: string): string {
    let t = text.replace(/\r\n?/g, '\n').replace(/ /g, ' ');
    // 1. Every metadata token starts its own line.
    t = t.replace(META_TOKEN_ANYWHERE, '\n$1');
    // 2. Method / Path values are single tokens — a body glued onto the same
    //    line ("// Path: /p { … }") moves to the next line.
    t = t.replace(SINGLE_TOKEN_VALUE, '$1\n');
    // 3. Header / QueryParam values end at their flag; the body may follow.
    t = t.replace(FLAGGED_VALUE, '$1\n');
    //    Without a flag, a body glued on is recognisable by its opening brace.
    t = t.replace(UNFLAGGED_VALUE_THEN_BODY, '$1\n');
    //    A name or description (free text) with the body glued on: the body starts at its JSON.
    t = t.replace(TEXT_VALUE_THEN_BODY, '$1\n');
    // 4. The footer always gets its own line so the line parser can drop it.
    t = t.replace(/[ \t]*(⚡)/g, '\n$1');
    return t;
}

/** Each `// …` comment taken out (to the end of its line), outside strings. */
function stripLineComments(text: string): string {
    let out = '';
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            out += c;
            if (c === '\\') { out += text[i + 1] ?? ''; i++; } else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') { inString = true; out += c; continue; }
        if (c === '/' && text[i + 1] === '/') {
            const end = text.indexOf('\n', i);
            if (end < 0) break;
            i = end - 1;
            continue;
        }
        out += c;
    }
    return out;
}

/** Reads as JSON once its comments are out and its {{placeholders}} stand for values. */
function readsAsJson(text: string): boolean {
    try {
        JSON.parse(stripLineComments(text).replace(/\{\{[^{}]*\}\}/g, '0'));
        return true;
    } catch {
        return false;
    }
}

/**
 * A body flattened onto one line: a `//` comment there runs to the end of the line, taking the rest of the body with
 * it. What is left of the lost line breaks is the indentation: each comment ends at the first run of two or more spaces.
 */
function endFlattenedComments(text: string): string {
    let out = '';
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            out += c;
            if (c === '\\') { out += text[i + 1] ?? ''; i++; } else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') { inString = true; out += c; continue; }
        if (c === '/' && text[i + 1] === '/') {
            const rest = text.slice(i);
            const gap = rest.search(/[ \t]{2,}/);
            if (gap < 0) { out += rest; break; }
            out += rest.slice(0, gap) + '\n';
            i += gap - 1;
            continue;
        }
        out += c;
    }
    return out;
}

/** Strip the "⚡ Dobermann | …" footer that the rendered card appends. */
function stripFooter(body: string): string {
    return body.replace(/\n*⚡\s*Dobermann\s*\|.*$/s, '').trim();
}

function parseKeyValueFlag(payload: string): { key: string; value: string; enabled: boolean } | null {
    const m = payload.match(KEY_VALUE_FLAG);
    if (!m) {
        return null;
    }
    return { key: m[1].trim(), value: m[2].trim(), enabled: m[3] !== 'disabled' };
}

/** `// Tags: a, B, a` → ['a', 'b']. Mirrors src/utils/tag-normalizer (this file cannot import it). */
function parseTags(payload: string): string[] {
    const seen = new Set<string>();
    for (const raw of payload.split(',')) {
        const tag = raw.trim().toLowerCase();
        if (tag && !seen.has(tag)) {
            seen.add(tag);
        }
    }
    return Array.from(seen);
}

/**
 * Parse shared-endpoint clipboard text. Returns the endpoint on success, or
 * `null` when the text isn't recognisable endpoint data.
 */
export function parseSharedEndpointText(text: string): ParsedSharedEndpoint | null {
    try {
        if (!text || text.trim() === '') {
            return null;
        }

        const lines = normaliseSharedEndpointText(text).split('\n');
        const endpoint: ParsedSharedEndpoint = {};
        let inBody = false;
        const bodyLines: string[] = [];
        const headers: Array<{ key: string; value: string; enabled: boolean }> = [];
        const queryParams: Array<{ key: string; value: string; enabled: boolean }> = [];

        // Detect format: JSONC comments (// Name: / // Path: …) vs legacy (Name: / Body:).
        const isJsoncFormat = lines.some(l => META_LINE.test(l));

        // Issue #278: in the JSONC format the body must not start until we've
        // seen at least one metadata comment. That keeps the "DBMN Endpoint"
        // card title (and any other preamble above the metadata) from being
        // swallowed as the first body line.
        let seenMeta = false;

        for (const line of lines) {
            // The "⚡ Dobermann | …" footer must never end up in the body,
            // even once we're in body mode (Issue #278). Skip it wherever it
            // appears; stripFooter() is a secondary net for trailing variants.
            if (line.trim().startsWith('⚡')) {
                continue;
            }

            if (isJsoncFormat) {
                if (inBody) {
                    bodyLines.push(line);
                    continue;
                }

                const meta = line.match(META_LINE);
                if (meta) {
                    seenMeta = true;
                    const key = meta[1] as MetaKey;
                    const value = meta[2].trim();
                    switch (key) {
                        case 'Name':
                            endpoint.name = value;
                            break;
                        case 'Method':
                            endpoint.method = value.toUpperCase();
                            break;
                        case 'Path':
                            endpoint.path = value;
                            break;
                        case 'Description':
                            endpoint.description = value;
                            break;
                        case 'Tags': {
                            const tags = parseTags(value);
                            if (tags.length > 0) {
                                endpoint.tags = tags;
                            }
                            break;
                        }
                        case 'Header': {
                            const h = parseKeyValueFlag(value);
                            if (h) {
                                headers.push(h);
                            }
                            break;
                        }
                        case 'QueryParam': {
                            const q = parseKeyValueFlag(value);
                            if (q) {
                                queryParams.push(q);
                            }
                            break;
                        }
                    }
                } else if (line.trim().startsWith('//')) {
                    // Skip other comment lines
                } else if (line.trim() === '') {
                    // Skip blank lines (both preamble and inter-section spacing)
                } else if (!seenMeta) {
                    // Preamble before the metadata — e.g. the "DBMN Endpoint"
                    // card title from the rendered share card. Ignore it so it
                    // doesn't get treated as the body (Issue #278).
                } else {
                    // First real content line AFTER the metadata starts the body.
                    inBody = true;
                    bodyLines.push(line);
                }
            } else {
                // Legacy format (backward compat)
                if (inBody) {
                    bodyLines.push(line);
                } else if (line.startsWith('Name:')) {
                    endpoint.name = line.substring(5).trim();
                } else if (line.startsWith('Method:')) {
                    endpoint.method = line.substring(7).trim().toUpperCase();
                } else if (line.startsWith('Path:')) {
                    endpoint.path = line.substring(5).trim();
                } else if (line.startsWith('Description:')) {
                    endpoint.description = line.substring(12).trim();
                } else if (line.startsWith('Body:')) {
                    inBody = true;
                }
            }
        }

        if (bodyLines.length > 0) {
            let body = stripFooter(bodyLines.join('\n').trim());
            // A body that came through on one line (line breaks lost on the way): its comments ended where its
            // lines did, kept only when that reads back as JSON; else kept as it came, and said (#473)
            if (body && !body.includes('\n') && !readsAsJson(body)) {
                const repaired = endFlattenedComments(body);
                if (readsAsJson(repaired)) body = repaired;
                else endpoint.warning = FLATTENED_BODY_WARNING;
            }
            if (body) {
                endpoint.body = body;
            }
        }

        if (headers.length > 0) {
            endpoint.headers = headers;
        }

        if (queryParams.length > 0) {
            endpoint.queryParams = queryParams;
        }

        // Issue #291: resolve with whatever we found. The JSONC format is
        // unambiguous, so a name OR a path is enough; legacy keeps both.
        const recognised = isJsoncFormat
            ? Boolean(endpoint.name || endpoint.path)
            : Boolean(endpoint.name && endpoint.path);

        if (recognised) {
            endpoint.method = endpoint.method || 'GET';
            return endpoint;
        }

        return null;
    } catch {
        return null;
    }
}
