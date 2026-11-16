// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #318: the `test:core` lane's require guard.
 *
 * Loaded with `mocha --require` in place of `vscode-mock`. Any attempt to load `vscode` is
 * recorded and then thrown, with the chain of modules that led to it, so a core module that
 * still needs VS Code fails loudly instead of being handed a fake. Attempts are recorded as
 * well as thrown because some modules swallow the error (`try { require('vscode') } catch {}`).
 *
 * `DBMN_CORE_GUARD=survey` records without throwing (`vscode` resolves to an empty object), so
 * one load lists every chain into `vscode` rather than only the first: a map for cutting a
 * module free, not a test mode.
 */
import Module = require('module');

interface ModuleWithLoad {
    _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
    _resolveFilename(request: string, parent: NodeModule | undefined, isMain: boolean): string;
}

export interface VscodeLoadAttempt {
    /** Importing modules, outermost first, ending with the module that asked for `vscode`. */
    chain: string[];
}

const loader = Module as unknown as ModuleWithLoad;
const originalLoad = loader._load;
const firstParent = new Map<string, string>();
const attempts: VscodeLoadAttempt[] = [];
const surveyOnly = process.env.DBMN_CORE_GUARD === 'survey';

const outRoot = require('path').resolve(__dirname, '..', '..', '..');

function shortName(filename: string): string {
    return filename.startsWith(outRoot) ? filename.slice(outRoot.length + 1) : filename;
}

function chainFor(filename: string | undefined): string[] {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current = filename;
    while (current && !seen.has(current)) {
        seen.add(current);
        chain.unshift(shortName(current));
        current = firstParent.get(current);
    }
    return chain;
}

loader._load = function (request: string, parent: NodeModule | undefined, isMain: boolean): unknown {
    if (request === 'vscode') {
        const attempt: VscodeLoadAttempt = { chain: chainFor(parent?.filename) };
        attempts.push(attempt);
        if (surveyOnly) {
            return {};
        }
        throw new Error(`core must not load 'vscode': ${[...attempt.chain, 'vscode'].join(' → ')}`);
    }
    if (parent?.filename) {
        try {
            const resolved = loader._resolveFilename(request, parent, isMain);
            if (!firstParent.has(resolved)) {
                firstParent.set(resolved, parent.filename);
            }
        } catch {
            // Unresolvable requests fail in the original loader with Node's own message.
        }
    }
    return originalLoad.call(this, request, parent, isMain);
};

/** Every `vscode` load attempted since the lane started (or since the last reset). */
export function vscodeLoadAttempts(): readonly VscodeLoadAttempt[] {
    return attempts;
}

export function resetVscodeLoadAttempts(): void {
    attempts.length = 0;
}

// #420: the core lane never reaches the network. Anything but the loopback address throws,
// naming the URL, so a test that forgot its stub is a red test rather than a line in the log.
// A test that replaces global.fetch with its own stub is unaffected.
const guardedFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let host = '';
    try { host = new URL(url).hostname; } catch { /* a relative or invalid URL: let fetch say so */ }
    if (host && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') {
        return Promise.reject(new Error(`core must not reach the network: ${url} (stub fetch in this test, #420)`));
    }
    return guardedFetch(input, init);
}) as typeof fetch;
