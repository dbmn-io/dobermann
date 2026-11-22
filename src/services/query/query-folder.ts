// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Saved queries in the workspace folder (James, 2026-11-23: "Create a query folder also and have
 * the query and files saved alongside one another… ensure every app that's accessing that
 * workspace can view them"). Each query is a folder of its own, named after the query:
 *
 *     <workspace>/Queries/<query name>/query.json     the query (its id is inside)
 *     <workspace>/Queries/<query name>/<view id>.json a CSV or Excel view's rows (query-file-store)
 *
 * So VS Code, the desktop app and the web app on that folder all list the same queries, and a
 * query can be handed on by copying its folder. The folder's name is only for people: a query is
 * found by the id inside its query.json, so a folder copied in under any name still opens.
 * Renaming the query moves its folder.
 *
 * Each host says once where its workspace folder is (useQueryFolder). Without one (the core
 * tests, or before VS Code has a workspace), query-store keeps queries in the state store as
 * before. Later, the account's catalogue may sync these files.
 */
import * as fs from 'fs';
import * as path from 'path';

export const QUERIES_FOLDER = 'Queries';
export const QUERY_FILE = 'query.json';

/** Where this host's workspace folder is. */
export interface QueryFolderHost {
    /** The workspace folder, or undefined while there is none. */
    root(): string | undefined;
    /** The web app on a folder: bring these files, and the files directly in these folders, into memory before reading. */
    preload?(paths: string[], folders: string[]): Promise<void>;
}

/** What query-folder keeps: a saved query as JSON, its id and name read from it. */
export interface FolderRecord {
    id: string;
    name?: string;
    updatedAt?: string;
}

let host: QueryFolderHost | undefined;
/** The last read of the folder: reads within a second of it (a Hub list asks many times) use it. */
let cache: { dir: string; at: number; entries: Map<string, { folder: string; record: FolderRecord }> } | undefined;
const FRESH_MS = 1000;

/** Say where the workspace folder is (undefined: none, queries stay in the state store). */
export function useQueryFolder(next: QueryFolderHost | undefined): void {
    host = next;
    cache = undefined;
}

/** `<workspace>/Queries`, or undefined when this host has no workspace folder. */
export function queriesDir(): string | undefined {
    const root = host?.root();
    return root ? path.join(root, QUERIES_FOLDER) : undefined;
}

/** Bring the folder's queries into memory (the web app on a folder; nothing elsewhere). */
export async function loadQueryFolder(): Promise<void> {
    const dir = queriesDir();
    if (!dir || !host?.preload) return;
    await host.preload([], [dir]);
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    await host.preload(names.map(name => path.join(dir, name, QUERY_FILE)), []);
    cache = undefined;
}

/** Bring one query's folder into memory (its rows files). */
export async function loadQueryFolderOf(id: string): Promise<void> {
    const folder = queryFolderOf(id);
    if (folder && host?.preload) await host.preload([], [folder]);
}

function scan(dir: string): Map<string, { folder: string; record: FolderRecord }> {
    if (cache && cache.dir === dir && Date.now() - cache.at < FRESH_MS) return cache.entries;
    const entries = new Map<string, { folder: string; record: FolderRecord }>();
    let names: string[] = [];
    try { names = fs.existsSync(dir) ? fs.readdirSync(dir) : []; } catch { names = []; }
    for (const name of names.sort()) {
        const file = path.join(dir, name, QUERY_FILE);
        try {
            if (!fs.existsSync(file)) continue;
            const record = JSON.parse(String(fs.readFileSync(file, 'utf8'))) as FolderRecord;
            if (!record || typeof record.id !== 'string' || !record.id) continue;
            const had = entries.get(record.id);
            // The same query in two folders (one copied in): the newer edit counts
            if (had && String(had.record.updatedAt ?? '') >= String(record.updatedAt ?? '')) continue;
            entries.set(record.id, { folder: path.join(dir, name), record });
        } catch {
            // a query.json that can't be read is left alone, not listed
        }
    }
    cache = { dir, at: Date.now(), entries };
    return entries;
}

/** Every query in the folder, or undefined when this host has no workspace folder. */
export function readFolderQueries(): FolderRecord[] | undefined {
    const dir = queriesDir();
    if (!dir) return undefined;
    return [...scan(dir).values()].map(e => e.record);
}

/** The folder a saved query is in, or undefined. */
export function queryFolderOf(id: string): string | undefined {
    const dir = queriesDir();
    return dir ? scan(dir).get(id)?.folder : undefined;
}

/**
 * A name a folder or file can have on Windows, macOS and Linux: the characters they refuse become
 * "-", and a name with nothing left (or one Windows keeps for itself) is the fallback.
 */
export function safeFileName(name: string, fallback: string): string {
    // eslint-disable-next-line no-control-regex
    let clean = String(name ?? '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-').trim().replace(/[. ]+$/, '');
    if (!clean || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean)) clean = fallback;
    return clean.slice(0, 80);
}

/** `wanted`, or `wanted (2)`… when one of `others` has it (letter case aside: Windows and macOS ignore it). */
export function freeName(others: string[], wanted: string, suffix = ''): string {
    const taken = new Set(others.map(name => name.toLowerCase()));
    let name = wanted;
    for (let n = 2; taken.has(`${name}${suffix}`.toLowerCase()); n++) name = `${wanted} (${n})`;
    return name;
}

/** Written beside, then put in place: a failed write leaves the old file. */
function writeWhole(file: string, text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
}

/**
 * Keep a query in its folder. A renamed query's folder moves, with its rows files. False when this
 * host has no workspace folder (the caller keeps it in the state store).
 */
export function writeFolderQuery(record: FolderRecord): boolean {
    const dir = queriesDir();
    if (!dir) return false;
    const had = scan(dir).get(record.id)?.folder;
    // Only another query's folder is in the way (an empty one left behind is used again)
    const others = [...scan(dir).values()].map(e => e.folder).filter(f => f !== had).map(f => path.basename(f));
    const name = freeName(others, safeFileName(record.name ?? '', record.id));
    // A change of letter case only stays in the old folder: on Windows and macOS it is the same folder
    const folder = had && had.toLowerCase() === path.join(dir, name).toLowerCase() ? had : path.join(dir, name);
    writeWhole(path.join(folder, QUERY_FILE), JSON.stringify(record, null, 2));
    if (had && had !== folder) {
        // Renamed: the rest of the old folder (its CSV and Excel views' rows) comes along
        try {
            for (const file of fs.readdirSync(had)) {
                if (file === QUERY_FILE) continue;
                fs.writeFileSync(path.join(folder, file), fs.readFileSync(path.join(had, file)));
            }
            fs.rmSync(had, { recursive: true, force: true });
        } catch {
            // left where it was: the query still opens; a view asks for its file again
        }
    }
    cache = undefined;
    return true;
}

/** Remove a query's folder, rows and all. False when this host has no workspace folder. */
export function removeFolderQuery(id: string): boolean {
    const dir = queriesDir();
    if (!dir) return false;
    const folder = scan(dir).get(id)?.folder;
    if (folder) {
        try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* not reachable now */ }
    }
    cache = undefined;
    return true;
}
