// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Node's `fs` for the browser, the part core uses (execution files, the run history's sql.js
 * database, exports). Files live in memory and are written behind to IndexedDB, so a run's
 * history survives a reload; `mountBrowserFs` loads them before anything reads.
 *
 * Synchronous calls work on the memory copy, as core's sync calls expect.
 *
 * Folder mode (#344): with the user's workspace folder picked, paths under its root (the same
 * absolute path VS Code uses) are that folder. Nothing is read until asked for: the history
 * database at start, a run's files before its Console opens (loadFromFolder). What changes is
 * written behind to the folder. A file another writer (VS Code) changed since we read or wrote
 * it is never written over: we load theirs and tell the host (onFolderChange), which merges and
 * saves again. A file that's in the folder but was never loaded here is only appended to.
 */
import type { FolderFile, FolderSource } from './folder-source';
import { isUnderRoot, rootsByFolderName } from '../../../../src/services/workspace/folder-check';
import { writesNow } from '../../../../src/services/workspace/write-now';

type Data = Uint8Array;

const files = new Map<string, Data>();
const dirs = new Set<string>(['/']);
const times = new Map<string, number>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let database: IDBDatabase | undefined;
const dirty = new Set<string>();
/**
 * What IndexedDB holds for each file: its length and how many appended chunks follow the base
 * record. A file that has only grown since the last save is saved as one more chunk (its new
 * bytes), so a run's archive taking a record per transaction never rewrites the whole file.
 * Anything else (a write, a rename, a delete) saves the file whole and drops its chunks.
 */
const persisted = new Map<string, { length: number; chunks: number }>();
const rewritten = new Set<string>();
const CHUNK = '\u0000';
const chunkKey = (p: string, i: number) => `${p}${CHUNK}${String(i).padStart(8, '0')}`;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Small JSON files written whole (a saved query, a lookup table, a setting): written out on the next tick, on their own,
 * not 300 ms on with the rest (write-now.ts). A change saved just before a reload was lost while every write waited
 * (2026-11-23: a saved search deleted, the page reloaded at once, and it came back). The rest stays batched.
 */
const soon = new Set<string>();
let soonTimer: ReturnType<typeof setTimeout> | undefined;

function norm(p: string | URL): string {
    const s = String(p).replace(/\\/g, '/');
    const parts: string[] = [];
    for (const part of s.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') parts.pop(); else parts.push(part);
    }
    return '/' + parts.join('/');
}

function parent(p: string): string {
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
}

function error(code: string, syscall: string, p: string): Error {
    return Object.assign(new Error(`${code}: no such file or directory, ${syscall} '${p}'`), { code, syscall, path: p });
}

function toData(content: string | Data | ArrayBuffer | ArrayBufferView): Data {
    if (typeof content === 'string') return encoder.encode(content);
    if (content instanceof Uint8Array) return new Uint8Array(content);
    if (content instanceof ArrayBuffer) return new Uint8Array(content.slice(0));
    return new Uint8Array(content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength));
}

function encodingOf(options: unknown): string | undefined {
    if (typeof options === 'string') return options;
    return (options as { encoding?: string } | undefined)?.encoding ?? undefined;
}

function touch(p: string, appended = false): void {
    times.set(p, Date.now());
    dirty.add(p);
    if (!appended) rewritten.add(p);
    if (writesNow(p, files.get(p)?.length ?? 0, appended)) {
        soon.add(p);
        if (!soonTimer) soonTimer = setTimeout(flushSoon, 0);
        return;
    }
    if (!flushTimer) flushTimer = setTimeout(() => { void flush(); }, 300);
}

/** The small files changed since the last tick, written on their own (one flush at a time, as flush). */
function flushSoon(): void {
    soonTimer = undefined;
    const only = [...soon];
    soon.clear();
    flushing = flushing.then(() => flushNow(only), () => flushNow(only));
}

function ensureDirs(p: string): void {
    let d = parent(p);
    const chain: string[] = [];
    while (!dirs.has(d)) {
        chain.push(d);
        d = parent(d);
    }
    chain.forEach(c => dirs.add(c));
}

/** Write what changed to IndexedDB. */
export function flush(): Promise<void> {
    flushTimer = undefined;
    // One flush at a time: the folder's writes are async, and two at once could interleave
    flushing = flushing.then(() => flushNow(), () => flushNow());
    return flushing;
}

let flushing: Promise<void> = Promise.resolve();

/** `only`: these paths (still changed), the rest left for the next flush; else every changed file. */
async function flushNow(only?: string[]): Promise<void> {
    if (dirty.size === 0) return;
    const all = only ? only.filter(p => dirty.has(p)) : [...dirty];
    if (!all.length) return;
    all.forEach(p => dirty.delete(p));
    const toFolder = all.filter(inFolder);
    if (toFolder.length) await flushToFolder(toFolder);
    const paths = all.filter(p => !inFolder(p));
    if (!database || paths.length === 0) return;
    await new Promise<void>((resolve, reject) => {
        const tx = database!.transaction('files', 'readwrite');
        const store = tx.objectStore('files');
        for (const p of paths) {
            const data = files.get(p);
            const mtime = times.get(p) ?? Date.now();
            const known = persisted.get(p);
            const wasRewritten = rewritten.delete(p);
            if (!data) {
                store.delete(p);
                for (let i = 0; i < (known?.chunks ?? 0); i++) store.delete(chunkKey(p, i));
                persisted.delete(p);
            } else if (!wasRewritten && known && data.length > known.length) {
                store.put({ data: data.slice(known.length), mtime }, chunkKey(p, known.chunks));
                persisted.set(p, { length: data.length, chunks: known.chunks + 1 });
            } else if (wasRewritten || !known || data.length !== known.length) {
                for (let i = 0; i < (known?.chunks ?? 0); i++) store.delete(chunkKey(p, i));
                // A file grown by appends is a view on a bigger buffer: store just its bytes
                store.put({ data: data.byteLength === data.buffer.byteLength ? data : data.slice(), mtime }, p);
                persisted.set(p, { length: data.length, chunks: 0 });
            }
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** Load this browser's files (one store per `scope`: backend and user). */
export async function mountBrowserFs(scope: string): Promise<void> {
    database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(`dbmn-files:${scope}`, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('files');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const bases = new Map<string, { data: Data; mtime: number }>();
    const chunks = new Map<string, Data[]>();
    await new Promise<void>((resolve, reject) => {
        const tx = database!.transaction('files', 'readonly');
        const cursorRequest = tx.objectStore('files').openCursor();
        cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const key = String(cursor.key);
            const value = cursor.value as { data: Data; mtime: number };
            const split = key.indexOf(CHUNK);
            if (split < 0) bases.set(key, value);
            else chunks.set(key.slice(0, split), [...(chunks.get(key.slice(0, split)) ?? []), value.data]);   // keys arrive in order
            cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    for (const [p, base] of bases) {
        const parts = chunks.get(p) ?? [];
        const length = base.data.length + parts.reduce((n, c) => n + c.length, 0);
        const whole = new Uint8Array(length);
        whole.set(base.data);
        let at = base.data.length;
        for (const c of parts) { whole.set(c, at); at += c.length; }
        files.set(p, whole);
        times.set(p, base.mtime);
        ensureDirs(p);
        persisted.set(p, { length, chunks: parts.length });
        // Many chunks: save it whole once, so loading stays quick
        if (parts.length > 64) touch(p);
    }
    addEventListener('pagehide', () => { void flush(); });
    // (hidden first: a closed or switched-away tab is hidden before pagehide, so the writes start sooner)
    addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flush(); });
}

export function existsSync(p: string): boolean {
    const n = norm(p);
    return files.has(n) || dirs.has(n);
}

export function mkdirSync(p: string): void {
    const n = norm(p);
    ensureDirs(n + '/x');
}

export function writeFileSync(p: string, content: string | Data | ArrayBuffer | ArrayBufferView): void {
    const n = norm(p);
    ensureDirs(n);
    files.set(n, toData(content));
    touch(n);
}

/**
 * Appends grow the file in place: the bytes sit in a buffer with room to spare (doubling), so
 * a run's archive taking a block per transaction costs the block, not a copy of the whole file.
 */
export function appendFileSync(p: string, content: string | Data): void {
    const n = norm(p);
    const existing = files.get(n);
    const add = toData(content);
    const length = (existing?.length ?? 0) + add.length;
    if (existing && existing.byteOffset === 0 && existing.buffer.byteLength >= length) {
        const grown = new Uint8Array(existing.buffer, 0, length);
        grown.set(add, existing.length);
        files.set(n, grown);
    } else {
        const room = new Uint8Array(Math.max(length, (existing?.length ?? 0) * 2, 4096));
        if (existing) room.set(existing);
        room.set(add, existing?.length ?? 0);
        ensureDirs(n);
        files.set(n, room.subarray(0, length));
    }
    touch(n, true);
}

/** Node's positional reads, for core code that reads part of a large file (a run archive). */
const descriptors = new Map<number, string>();
let nextDescriptor = 100;

export function openSync(p: string, _flags?: string): number {
    const n = norm(p);
    if (!files.has(n)) throw error('ENOENT', 'open', n);
    const fd = nextDescriptor++;
    descriptors.set(fd, n);
    return fd;
}

export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
    const n = descriptors.get(fd);
    const data = n ? files.get(n) : undefined;
    if (!data) throw error('EBADF', 'read', String(fd));
    const count = Math.max(0, Math.min(length, data.length - position));
    buffer.set(data.subarray(position, position + count), offset);
    return count;
}

export function fstatSync(fd: number): Stats {
    const n = descriptors.get(fd);
    if (!n) throw error('EBADF', 'fstat', String(fd));
    return statSync(n);
}

export function closeSync(fd: number): void {
    descriptors.delete(fd);
}

export function readFileSync(p: string, options?: unknown): string | Data {
    const n = norm(p);
    const data = files.get(n);
    if (!data) throw error('ENOENT', 'open', n);
    return encodingOf(options) ? decoder.decode(data) : new Uint8Array(data);
}

export function renameSync(from: string, to: string): void {
    const a = norm(from), b = norm(to);
    const data = files.get(a);
    if (data) {
        files.delete(a);
        touch(a);
        ensureDirs(b);
        files.set(b, data);
        touch(b);
        return;
    }
    if (!dirs.has(a)) throw error('ENOENT', 'rename', a);
    // A folder: everything under it moves
    for (const f of [...files.keys()]) {
        if (f.startsWith(a + '/')) {
            const moved = b + f.slice(a.length);
            files.set(moved, files.get(f)!);
            times.set(moved, times.get(f) ?? Date.now());
            files.delete(f);
            touch(f);
            touch(moved);
        }
    }
    for (const d of [...dirs]) {
        if (d === a || d.startsWith(a + '/')) {
            dirs.delete(d);
            dirs.add(b + d.slice(a.length));
        }
    }
    ensureDirs(b);
}

export function unlinkSync(p: string): void {
    const n = norm(p);
    if (!files.delete(n)) throw error('ENOENT', 'unlink', n);
    touch(n);
}

export function rmSync(p: string, options?: { recursive?: boolean; force?: boolean }): void {
    const n = norm(p);
    if (files.has(n)) {
        unlinkSync(n);
        return;
    }
    if (!dirs.has(n)) {
        if (options?.force) return;
        throw error('ENOENT', 'rm', n);
    }
    for (const f of [...files.keys()]) {
        if (f.startsWith(n + '/')) {
            files.delete(f);
            touch(f);
        }
    }
    for (const d of [...dirs]) {
        if (d === n || d.startsWith(n + '/')) dirs.delete(d);
    }
}

export function readdirSync(p: string): string[] {
    const n = norm(p);
    if (!dirs.has(n)) throw error('ENOENT', 'scandir', n);
    const prefix = n === '/' ? '/' : n + '/';
    const names = new Set<string>();
    for (const key of [...files.keys(), ...dirs]) {
        if (key !== n && key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0]);
    }
    return [...names];
}

export interface Stats {
    size: number;
    mtimeMs: number;
    mtime: Date;
    isFile(): boolean;
    isDirectory(): boolean;
}

export function statSync(p: string): Stats {
    const n = norm(p);
    const data = files.get(n);
    if (!data && !dirs.has(n)) throw error('ENOENT', 'stat', n);
    const mtimeMs = times.get(n) ?? 0;
    return { size: data?.length ?? 0, mtimeMs, mtime: new Date(mtimeMs), isFile: () => !!data, isDirectory: () => !data };
}

const later = <T>(f: () => T): Promise<T> => new Promise((resolve, reject) => {
    try { resolve(f()); } catch (e) { reject(e); }
});

export const promises = {
    access: (p: string) => later(() => { if (!existsSync(p)) throw error('ENOENT', 'access', norm(p)); }),
    mkdir: (p: string) => later(() => mkdirSync(p)),
    readFile: (p: string, options?: unknown) => later(() => readFileSync(p, options)),
    writeFile: (p: string, content: string | Data, _options?: unknown) => later(() => writeFileSync(p, content)),
    appendFile: (p: string, content: string | Data) => later(() => appendFileSync(p, content)),
    rm: (p: string, options?: { recursive?: boolean; force?: boolean }) => later(() => rmSync(p, options)),
    unlink: (p: string) => later(() => unlinkSync(p)),
    rename: (a: string, b: string) => later(() => renameSync(a, b)),
    stat: (p: string) => later(() => statSync(p)),
    readdir: (p: string) => later(() => readdirSync(p))
};

/** A file as the browser gets it: for exports handed over as downloads. */
export function takeFile(p: string): Data | undefined {
    return files.get(norm(p));
}

export default {
    existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, renameSync, unlinkSync, rmSync,
    readdirSync, statSync, openSync, readSync, fstatSync, closeSync, promises
};

// ─── Folder mode (#344) ──────────────────────────────────────────────────────

/** `aliases`: the workspace's other paths (VS Code's, another computer's): their files are the folder's too. */
let folder: { source: FolderSource; root: string; aliases: string[] } | undefined;
/** The folder's copy as we last read or wrote it: another writer changed it when these differ. */
const onDisk = new Map<string, FolderFile>();
const watched = new Set<string>();
const folderListeners = new Set<(path: string, reason: 'changed' | 'conflict') => void>();

function rootOf(p: string): string | undefined {
    if (!folder) return undefined;
    return [folder.root, ...folder.aliases].find(root => isUnderRoot(p, root));
}

/**
 * #443: a path recorded under another location of this folder that the account doesn't know (DBMN
 * for VS Code 0.3.1 never records one): found by the folder's name in it, and kept as an alias
 * once the rest of the path is in the folder. Before anything reads it: callers load first.
 */
async function learnAlias(p: string): Promise<void> {
    if (!folder || inFolder(p)) return;
    const name = folder.root.split('/').filter(Boolean).pop();
    if (!name) return;
    for (const root of rootsByFolderName(p, name)) {
        const rest = p.slice(root.length).split('/').filter(Boolean);
        const there = (await folder.source.stat(rest).catch(() => undefined)) ?? (await folder.source.list(rest).catch(() => undefined));
        if (!there) continue;
        folder.aliases.push(root);
        console.info(`[Workspace] ${root} is this folder (found by its name): its runs open from here`);
        return;
    }
}

function inFolder(p: string): boolean {
    return rootOf(p) !== undefined;
}

function folderParts(p: string): string[] {
    return p.slice(rootOf(p)!.length).split('/').filter(Boolean);
}

/** Read one file from the folder into memory (not marked changed). False when it isn't there. */
async function readFromFolder(p: string): Promise<boolean> {
    const file = await folder!.source.read(folderParts(p));
    if (!file) return false;
    files.set(p, file.bytes);
    times.set(p, file.lastModified);
    onDisk.set(p, { size: file.size, lastModified: file.lastModified });
    ensureDirs(p);
    return true;
}

/**
 * Use the workspace folder for everything under `root` (the account's path for it), and under
 * each of `aliases` (#441: its other paths, so runs recorded at them open too). Reads `preload`
 * now; watches `watch` for another writer every couple of seconds.
 */
export async function mountFolder(source: FolderSource, root: string, preload: string[], watch: string[], aliases: string[] = []): Promise<void> {
    const main = norm(root);
    folder = { source, root: main, aliases: [...new Set(aliases.map(norm))].filter(alias => alias !== main && alias !== '/') };
    ensureDirs(folder.root + '/x');
    for (const p of preload) await readFromFolder(norm(p));
    for (const p of watch) watched.add(norm(p));
    setInterval(() => { checkWatched().catch(error => console.warn('[Workspace] could not check the folder for changes', error)); }, 2000);
}

export function folderRoot(): string | undefined {
    return folder?.root;
}

/** Another writer changed a folder file (`changed`), or a save of ours found it changed (`conflict`). */
export function onFolderChange(listener: (path: string, reason: 'changed' | 'conflict') => void): () => void {
    folderListeners.add(listener);
    return () => folderListeners.delete(listener);
}

/**
 * Before code reads synchronously: the files (`paths`) and the files directly in folders
 * (`folders`, not below) that aren't in memory yet. Nothing outside folder mode.
 */
export async function loadFromFolder(paths: string[], folders: string[] = []): Promise<void> {
    if (!folder) return;
    for (const raw of paths) {
        const p = norm(raw);
        await learnAlias(p);
        if (inFolder(p) && !files.has(p)) await readFromFolder(p);
    }
    for (const raw of folders) {
        const d = norm(raw);
        await learnAlias(d);
        if (!inFolder(d)) continue;
        const entries = await folder.source.list(folderParts(d));
        if (!entries) continue;
        dirs.add(d);
        for (const { name, kind } of entries) {
            const p = `${d}/${name}`;
            if (kind === 'file' && !files.has(p)) await readFromFolder(p);
            else if (kind === 'directory') dirs.add(p);
        }
    }
}

async function checkWatched(): Promise<void> {
    for (const p of watched) {
        if (dirty.has(p)) continue;   // ours to save first; the save checks
        const file = await folder!.source.stat(folderParts(p));
        if (!file) continue;
        const known = onDisk.get(p);
        if (known && file.size === known.size && file.lastModified === known.lastModified) continue;
        if (dirty.has(p)) continue;   // changed here while we looked
        await readFromFolder(p);
        console.info(`[Workspace] ${p} changed in the folder (another writer saved): picking it up`);
        folderListeners.forEach(listener => listener(p, 'changed'));
    }
}

async function flushToFolder(paths: string[]): Promise<void> {
    const source = folder!.source;
    for (const p of paths) {
        const data = files.get(p);
        const wasRewritten = rewritten.delete(p);
        const parts = folderParts(p);
        if (!data) {
            await source.remove(parts);
            onDisk.delete(p);
            continue;
        }
        const before = await source.stat(parts);
        // Gone from the folder (or never there): nothing of another writer's to keep
        if (!before) onDisk.delete(p);
        const known = onDisk.get(p);
        const changedThere = !!before && !!known && (before.size !== known.size || before.lastModified !== known.lastModified);
        if (changedThere && wasRewritten) {
            // Another writer saved it since we read it: never write over them. Take theirs; the
            // host merges ours in and saves again.
            await readFromFolder(p);
            console.info(`[Workspace] ${p} changed in the folder before our save: merging, then saving again`);
            folderListeners.forEach(listener => listener(p, 'conflict'));
            continue;
        }
        let after: FolderFile | undefined;
        if (!wasRewritten && known && data.length > known.size && !changedThere) {
            after = await source.write(parts, data.slice(known.size), known.size);          // grown: just the new bytes
        } else if (before && !wasRewritten && (changedThere || (!known && before.size > 0))) {
            // Appended to a file someone else also grew, or one this browser never loaded: add
            // our bytes after what's there (a run archive's records stand on their own)
            await source.write(parts, known ? data.slice(known.size) : data, before.size);
            await readFromFolder(p);
            continue;
        } else {
            after = await source.write(parts, data.byteLength === data.buffer.byteLength ? data : data.slice());
        }
        if (after) onDisk.set(p, after);
    }
}
