// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Node's `path` (posix) for the browser, the part core uses. The web app's files live in its
 * in-browser filesystem (./fs.ts) under absolute posix paths.
 */
export const sep = '/';
export const delimiter = ':';

export function normalize(p: string): string {
    const absolute = p.startsWith('/');
    const out: string[] = [];
    for (const part of p.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (out.length && out[out.length - 1] !== '..') out.pop();
            else if (!absolute) out.push('..');
        } else {
            out.push(part);
        }
    }
    const joined = out.join('/');
    return (absolute ? '/' : '') + joined || (absolute ? '/' : '.');
}

export function join(...parts: string[]): string {
    return normalize(parts.filter(p => p !== '').join('/'));
}

export function resolve(...parts: string[]): string {
    let resolved = '';
    for (let i = parts.length - 1; i >= 0 && !resolved.startsWith('/'); i--) {
        if (parts[i]) resolved = parts[i] + (resolved ? '/' + resolved : '');
    }
    return normalize(resolved.startsWith('/') ? resolved : '/' + resolved);
}

export function isAbsolute(p: string): boolean {
    return p.startsWith('/');
}

export function dirname(p: string): string {
    const n = p.replace(/\/+$/, '');
    const i = n.lastIndexOf('/');
    if (i < 0) return '.';
    return i === 0 ? '/' : n.slice(0, i);
}

export function basename(p: string, ext?: string): string {
    const base = p.replace(/\/+$/, '').split('/').pop() || '';
    return ext && base.endsWith(ext) && base !== ext ? base.slice(0, -ext.length) : base;
}

export function extname(p: string): string {
    const base = basename(p);
    const i = base.lastIndexOf('.');
    return i <= 0 ? '' : base.slice(i);
}

export function relative(from: string, to: string): string {
    const a = resolve(from).split('/').filter(Boolean);
    const b = resolve(to).split('/').filter(Boolean);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

export function parse(p: string): { root: string; dir: string; base: string; ext: string; name: string } {
    const base = basename(p);
    const ext = extname(p);
    return { root: p.startsWith('/') ? '/' : '', dir: dirname(p), base, ext, name: ext ? base.slice(0, -ext.length) : base };
}

export const posix = { sep, delimiter, normalize, join, resolve, isAbsolute, dirname, basename, extname, relative, parse };
export default posix;
