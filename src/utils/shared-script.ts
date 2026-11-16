// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A screen script (src/webviews/shared/*.js) that core uses too. Each ends with
 * `module.exports = api` under Node and `window.Name = api` in a browser, where an ES module
 * import of it has no exports: take whichever it set.
 */
export function sharedScript<T extends object>(imported: unknown, globalName: string): T {
    const fromModule = imported as Record<string, unknown> | undefined;
    if (fromModule && Object.keys(fromModule).some(key => key !== 'default')) {
        return fromModule as T;
    }
    const fromDefault = fromModule?.default as T | undefined;
    if (fromDefault && Object.keys(fromDefault).length) {
        return fromDefault;
    }
    return (globalThis as Record<string, unknown>)[globalName] as T;
}
