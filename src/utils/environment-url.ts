// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Environment base-URL normalisation.
 *
 * A single canonical form for the string we use as the identity of an
 * environment: its host. Standard Systems match an environment by it.
 *
 * One function, so every comparison agrees on what "the same environment" is.
 * (It was written when three copies disagreed; the environment licence checks
 * that used it are gone in 0.4.0, and no address is sent to DBMN any more.)
 *
 * Deliberately dependency-free (no `vscode` import) so it stays usable off the
 * extension host — see docs/portability/spa-migration.md.
 */

/**
 * Reduce an environment URL to `protocol//hostname`, lowercased.
 *
 * Port, path, query, hash and trailing slash are all dropped: an environment is
 * its host, and users type the same environment a dozen different ways.
 *
 * Returns `''` for anything unparseable, which callers treat as "no identity" —
 * never as a wildcard match.
 */
export function normaliseEnvironmentUrl(url: string | undefined | null): string {
    if (!url) {
        return '';
    }

    try {
        const parsed = new URL(url.trim());
        // `URL` already lowercases protocol and hostname, but an IDN or an
        // odd input can still surprise us — normalise explicitly.
        return `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}`;
    } catch {
        return '';
    }
}

/**
 * True when two environment URLs refer to the same environment.
 * Two unparseable URLs are NOT considered equal — `''` must never match `''`,
 * or every malformed environment would share one identity.
 */
export function isSameEnvironmentUrl(a: string | undefined | null, b: string | undefined | null): boolean {
    const left = normaliseEnvironmentUrl(a);
    if (!left) {
        return false;
    }
    return left === normaliseEnvironmentUrl(b);
}

/**
 * #415: true when two base URLs are the same address, as a user would mean it: protocol, host
 * and port, path and query, ignoring case and a trailing slash (it only warns). Stricter than
 * isSameEnvironmentUrl (host only), which would make the Training Ground and its sign-in server one:
 * they share a host and differ by path.
 */
export function isSameBaseUrl(a: string | undefined | null, b: string | undefined | null): boolean {
    const address = (url: string | undefined | null): string => {
        if (!url) return '';
        try {
            const parsed = new URL(url.trim());
            return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`.toLowerCase();
        } catch {
            return '';
        }
    };
    const left = address(a);
    return !!left && left === address(b);
}

/**
 * A base URL's variables: `{{name}}` or `{{ENV:name}}` in its path, filled from the environment's
 * variables when a request goes (`https://api.example.com/v2.0/{{tenant}}/{{company}}`). Only the
 * path: the host is the environment's identity (and its System), so a variable
 * there would let one environment become another. A name with no value stays as typed.
 */
const BASE_URL_VARIABLE = /\{\{\s*(?:ENV:)?([^{}:|\s]+)\s*\}\}/gi;

export function fillBaseUrl(baseUrl: string, variables: Record<string, string> | undefined): string {
    if (!baseUrl.includes('{{')) return baseUrl;
    return baseUrl.replace(BASE_URL_VARIABLE, (match, name: string) => {
        const value = variables?.[name];
        return value ? value : match;
    });
}

/** The variables a base URL names, each once, in order. */
export function baseUrlVariableNames(baseUrl: string | undefined | null): string[] {
    const names: string[] = [];
    for (const match of (baseUrl ?? '').matchAll(BASE_URL_VARIABLE)) {
        if (!names.includes(match[1])) names.push(match[1]);
    }
    return names;
}

/** `protocol//host[:port]`, lowercased, of a base URL that may hold variables in its path; '' when unparseable. */
export function baseUrlOrigin(baseUrl: string | undefined | null): string {
    if (!baseUrl) return '';
    try {
        return new URL(baseUrl.trim()).origin.toLowerCase();
    } catch {
        return '';
    }
}

/**
 * Why a base URL can't be saved, or undefined when it can. A variable may stand in the path but
 * never in the host; an existing environment's host never changes (its path may, to make part of
 * it a variable).
 */
export function baseUrlProblem(baseUrl: string, previous?: string): string | undefined {
    const host = baseUrl.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];
    if (host.includes('{{')) {
        return 'A variable can only be part of the path, not the host. Make one environment per host.';
    }
    const origin = baseUrlOrigin(baseUrl);
    if (!origin || origin === 'null') return 'The Base URL is not a valid URL';
    if (previous && baseUrlOrigin(previous) && origin !== baseUrlOrigin(previous)) {
        return `The host can't change: this environment is ${baseUrlOrigin(previous)}. Make a new environment for ${origin}.`;
    }
    return undefined;
}
