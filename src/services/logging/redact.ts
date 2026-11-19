// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Dobermann issue 7: secrets never reach a log line. They are removed where the line is written
 * (AppLog.write), not where it is shown, so a line copied, saved or pasted into an issue is
 * always safe.
 *
 * Three nets, each catching what the others miss:
 *   - by name: a header or field called Authorization, Cookie, password, client_secret, any
 *     `…token` or `…secret`, and the like (`redactValue`, and `name: value` / `name=value` in text)
 *   - by shape: `Bearer …`, `Basic …`, a JWT, `code=` / `access_token=` in a URL
 *   - by value: a secret the app knows it is using (a token it got, a client secret it sent),
 *     registered with `addSecret`, is removed wherever it appears, in any form of text
 *
 * The word that replaces a secret is `[removed]`.
 */

export const REMOVED = '[removed]';

/** Field and header names whose value is a secret, compared without case, `-` or `_`. */
const SECRET_NAMES = new Set([
    'authorization', 'proxyauthorization', 'cookie', 'setcookie',
    'xapikey', 'apikey', 'xauthtoken', 'password', 'passwd', 'passphrase',
    'secret', 'clientsecret', 'codeverifier', 'privatekey', 'privatekeyid',
    'otp', 'onetimecode', 'assertion', 'clientassertion', 'sessionid'
]);
/** Names that end like a secret but are not one. */
const NOT_SECRET = new Set(['tokenurl', 'tokentype', 'tokenendpoint', 'secretname']);

function normaliseName(name: string): string {
    return name.toLowerCase().replace(/[-_\s]/g, '');
}

/** Is a field or header of this name a secret? */
export function isSecretName(name: string): boolean {
    const n = normaliseName(name);
    if (NOT_SECRET.has(n)) return false;
    return SECRET_NAMES.has(n) || n.endsWith('token') || n.endsWith('secret') || n.endsWith('password');
}

/** The names, as a regular expression alternative, for `name: value` and `name=value` in text. */
const NAME_IN_TEXT = '(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|x-auth-token|password|passwd|client[-_]?secret|code[-_]verifier|private[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?id|token|secret|assertion|client[-_]?assertion)';

const keep = (all: string, value: string) => value === '' || value === REMOVED;

const PATTERNS: Array<[RegExp, string | ((...m: string[]) => string)]> = [
    // a quoted value: `"access_token": "…"`, `'client_secret'='…'`
    [new RegExp(`(["']?)\\b(${NAME_IN_TEXT})\\1(\\s*[:=]\\s*)(["'])((?:\\\\.|(?!\\4)[^\\\\])*)\\4`, 'gi'),
        (all, q, name, sep, vq, value) => keep(all, value) ? all : `${q}${name}${q}${sep}${vq}${REMOVED}${vq}`],
    // a header written out: `Authorization: Basic …` is secret to the end of its line
    [/\b(authorization|proxy-authorization|cookie|set-cookie)(\s*:\s*)(?!["'])([^\r\n]+)/gi,
        (all, name, sep, value) => keep(all, value.trim()) ? all : `${name}${sep}${REMOVED}`],
    // an unquoted value: `client_secret=…`, `password: …`, up to the next separator
    [new RegExp(`\\b(${NAME_IN_TEXT})(\\s*=\\s*|:\\s*)(?!["'\\s]|\\[removed\\])([^\\s"'&,;}\\]]+)`, 'gi'),
        (all, name, sep, value) => keep(all, value) ? all : `${name}${sep}${REMOVED}`],
    // a URL's code (the sign-in's one-time code) and tokens in a query string
    [/([?&#](?:code|access_token|refresh_token|id_token|token|client_secret|code_verifier)=)[^&#\s"']+/gi, `$1${REMOVED}`],
    // a scheme and its credential, wherever they appear
    // (12 characters or more, so `Basic header` in a sentence stays)
    [/\b(Bearer|Basic|Digest|Token)\s+(?!\[removed\])[A-Za-z0-9\-._~+/=]{12,}/g, `$1 ${REMOVED}`],
    // a private key (a Google service account's), whole
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REMOVED],
    // a JWT on its own
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REMOVED]
];

/** Values shorter than this are not taken as known secrets: they would match ordinary text. */
const SHORTEST_KNOWN = 6;

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class Redactor {
    private readonly known = new Set<string>();
    private knownPattern: RegExp | undefined;

    /** A secret the app is using: removed wherever it appears from now on. */
    addSecret(value: string | undefined | null): void {
        if (typeof value !== 'string') return;
        const v = value.trim();
        if (v.length < SHORTEST_KNOWN || this.known.has(v)) return;
        this.known.add(v);
        // longest first, so a secret that contains another is removed whole
        const all = [...this.known].sort((a, b) => b.length - a.length).map(escapeRegExp);
        this.knownPattern = new RegExp(all.join('|'), 'g');
    }

    /** Text with every secret it holds removed. */
    text(input: string): string {
        if (!input) return input;
        let out = this.knownPattern ? input.replace(this.knownPattern, REMOVED) : input;
        for (const [pattern, replacement] of PATTERNS) {
            out = out.replace(pattern, replacement as string);
        }
        return out;
    }

    /** A copy of a value with every secret removed: secret-named fields, and secrets in strings. */
    value<T>(input: T): T {
        return this.walk(input, new WeakSet()) as T;
    }

    private walk(input: unknown, seen: WeakSet<object>): unknown {
        if (typeof input === 'string') return this.text(input);
        if (input === null || typeof input !== 'object') return input;
        if (seen.has(input)) return '[circular]';
        seen.add(input);
        if (Array.isArray(input)) return input.map(v => this.walk(v, seen));
        if (input instanceof Error) return this.text(input.stack || `${input.name}: ${input.message}`);
        const out: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(input as Record<string, unknown>)) {
            out[key] = isSecretName(key) && v !== undefined && v !== null && v !== '' ? REMOVED : this.walk(v, seen);
        }
        return out;
    }
}
