// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * JSONC Parser for Webviews
 *
 * Comment-preserving JSON pretty-printer. Unlike the previous version — which
 * only re-indented existing lines and therefore left constructs like `[ {` or
 * `{ "gtin": "x" }` collapsed onto a single line — this reflows the document so
 * every structural token gets its own line. That matters because our line-based
 * editor features (Ctrl+M add-variable, Ctrl+/ comment toggle) operate per line:
 * a value sharing a line with `{`/`[`/`}` can't be templated or commented.
 * (Issue #260.)
 *
 * It is a lexer + printer (not a full JSON parser), so it tolerates our template
 * variables (`{{gtin}}`, `{{qty:number}}`) and JSONC comments. Strings are
 * consumed whole, so braces/slashes inside string values (templates, URLs) are
 * never mistaken for structure or comments.
 */
(function () {
    'use strict';

    /**
     * Lex the text into structural tokens, strings, comments and literals.
     * `nl` records whether a newline appeared in the whitespace before the
     * token — used to decide whether a `//` comment is trailing (same line as
     * the previous token) or stands on its own line.
     */
    function tokenize(text) {
        const toks = [];
        let i = 0;
        const n = text.length;
        let nl = false;

        const isStruct = (c) => c === '{' || c === '}' || c === '[' || c === ']' || c === ',' || c === ':';

        while (i < n) {
            const c = text[i];

            if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
            if (c === '\n') { nl = true; i++; continue; }

            // Line comment — to end of line
            if (c === '/' && text[i + 1] === '/') {
                let j = i;
                while (j < n && text[j] !== '\n') j++;
                toks.push({ t: 'LC', v: text.slice(i, j).trimEnd(), nl });
                nl = false; i = j; continue;
            }

            // Block comment — to closing */
            if (c === '/' && text[i + 1] === '*') {
                let j = i + 2;
                while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++;
                j = Math.min(n, j + 2);
                toks.push({ t: 'BC', v: text.slice(i, j), nl });
                nl = false; i = j; continue;
            }

            // String literal — consumed whole (handles escapes)
            if (c === '"') {
                let j = i + 1;
                let esc = false;
                while (j < n) {
                    const d = text[j];
                    if (esc) { esc = false; j++; continue; }
                    if (d === '\\') { esc = true; j++; continue; }
                    if (d === '"') { j++; break; }
                    j++;
                }
                toks.push({ t: 'STR', v: text.slice(i, j), nl });
                nl = false; i = j; continue;
            }

            // Structural punctuation
            if (isStruct(c)) {
                toks.push({ t: 'ST', v: c, nl });
                nl = false; i++; continue;
            }

            // Literal run — numbers, true/false/null, or anything else
            let j = i;
            while (j < n) {
                const d = text[j];
                if (d === ' ' || d === '\t' || d === '\r' || d === '\n') break;
                if (isStruct(d) || d === '"') break;
                if (d === '/' && (text[j + 1] === '/' || text[j + 1] === '*')) break;
                j++;
            }
            if (j === i) { i++; continue; } // safety: never stall
            toks.push({ t: 'LIT', v: text.slice(i, j), nl });
            nl = false; i = j;
        }

        return toks;
    }

    /**
     * Print tokens back out, one structural token per line with 2-space indent.
     * Empty objects/arrays (`{}`, `[]`) stay collapsed. Trailing `//` comments
     * remain on the line they annotate; full-line comments keep their own line.
     */
    function prettyPrint(text) {
        const toks = tokenize(text);
        let out = '';
        let indent = 0;
        let lineHasContent = false;

        const pad = () => '  '.repeat(indent);
        const newLine = () => { if (!lineHasContent) return; out += '\n'; lineHasContent = false; };
        const startContent = () => { if (!lineHasContent) { out += pad(); lineHasContent = true; } };
        // Issue #305: a `//` comment written on the same line as a `,`, `{` or
        // `[` annotates that line — keep it there instead of breaking first.
        const takeTrailingComment = (k) => {
            const next = toks[k + 1];
            if (!next || next.t !== 'LC' || next.nl) return false;
            out += ' ' + next.v;
            return true;
        };

        for (let k = 0; k < toks.length; k++) {
            const tk = toks[k];
            const next = toks[k + 1];

            if (tk.t === 'ST' && (tk.v === '{' || tk.v === '[')) {
                startContent();
                out += tk.v;
                const close = tk.v === '{' ? '}' : ']';
                // Collapse empty container: `{}` / `[]`
                if (next && next.t === 'ST' && next.v === close) {
                    out += close;
                    k++;
                    continue;
                }
                indent++;
                if (takeTrailingComment(k)) k++;
                newLine();
                continue;
            }

            if (tk.t === 'ST' && (tk.v === '}' || tk.v === ']')) {
                indent = Math.max(0, indent - 1);
                newLine();
                startContent();
                out += tk.v;
                continue;
            }

            if (tk.t === 'ST' && tk.v === ',') {
                out += ',';
                if (takeTrailingComment(k)) k++;
                newLine();
                continue;
            }

            if (tk.t === 'ST' && tk.v === ':') {
                out += ': ';
                continue;
            }

            if (tk.t === 'LC') {
                if (lineHasContent && !tk.nl) {
                    // Trailing comment on the current line
                    out += ' ' + tk.v;
                    newLine();
                } else {
                    newLine();
                    startContent();
                    out += tk.v;
                    newLine();
                }
                continue;
            }

            if (tk.t === 'BC') {
                startContent();
                out += tk.v + ' ';
                continue;
            }

            // STR / LIT — key or value content
            startContent();
            out += tk.v;
        }

        // Tidy: drop trailing spaces, collapse blank lines, trim ends
        return out.replace(/[ \t]+$/gm, '').replace(/\n{2,}/g, '\n').trimEnd();
    }

    const api = {
        prettyPrint,

        format: function (text /*, range, options */) {
            try {
                if (!text || text.trim() === '') {
                    return [];
                }
                return [{
                    offset: 0,
                    length: text.length,
                    content: prettyPrint(text)
                }];
            } catch (error) {
                console.error('JSONC format error:', error);
                return [];
            }
        },

        applyEdits: function (text, edits) {
            if (!edits || edits.length === 0) return text;

            // Sort edits by offset in descending order to avoid position shifts
            edits.sort((a, b) => b.offset - a.offset);

            let result = text;
            for (const edit of edits) {
                const before = result.substring(0, edit.offset);
                const after = result.substring(edit.offset + edit.length);
                result = before + edit.content + after;
            }

            return result;
        }
    };

    if (typeof window !== 'undefined') window.jsoncParser = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
