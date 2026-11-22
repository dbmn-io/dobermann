// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Lookup tables: small tables the user keeps (a code and what it stands for, or several columns
 * of it), on the Hub's Reporting list. A query's Translate values function reads one: a value
 * found in its `from` column becomes the same row's `to` column. Edits are shared live: every
 * query that uses a table reads it as it is now, and a table that has been deleted is missing
 * (the query says so and does not run).
 *
 * A lookup table is a saved table of its own (a query only names it), kept as one JSON file per
 * table (James, 2026-11-21: "Each lookup table becomes one JSON") in the workspace folder itself,
 * where every app on that folder sees it and a person can copy it: `Lookup Tables/<name>.json`
 * (James, 2026-11-23: "Move the lookup tables to the root, not within .dbmn"). A table is known by
 * the id inside its file, so the file's name is only for people; renaming the table renames it.
 * An edit rewrites that table's file only. Small: up to 1,000 rows ("it's just a translation table").
 *
 * (Tables made before that were kept in the app's small state store, key `lookupTables`:
 * migrateFrom(state) moves them into files once. Tests may still give the store a state.)
 *
 * A column has an id that never changes (a rename keeps it), so a saved query's
 * { table, from, to } keeps working when a column is renamed.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { IKeyValueStore } from '../../platform/interfaces/key-value-store.interface';
import { freeName as freeFileName, safeFileName } from '../query/query-folder';

export const LOOKUP_TABLES_KEY = 'lookupTables';

/** The most columns a lookup table can have. */
export const LOOKUP_MAX_COLUMNS = 50;
/** The most rows a lookup table can have. */
export const LOOKUP_MAX_ROWS = 1000;
/** A lookup table's name: as long as a report's. */
export const LOOKUP_NAME_MAX = 30;

export interface LookupColumn {
    /** Never changes: what a query's function saves. */
    id: string;
    name: string;
    /** The key: its values one per row. */
    key?: boolean;
}

export interface LookupTable {
    id: string;
    name: string;
    columns: LookupColumn[];
    /** A row: a value by column id. */
    rows: Array<Record<string, string>>;
    updatedAt: string;
}

/** A table as the list shows it: its columns, and how many rows. */
export interface LookupTableSummary {
    id: string;
    name: string;
    columns: LookupColumn[];
    rows: number;
    updatedAt: string;
}

export type LookupChange = { kind: 'saved' | 'deleted'; id: string };

/** What a screen (Query's Translate values) is handed: read, and hear of changes. */
export interface LookupTablesReader {
    list(): Promise<LookupTableSummary[]>;
    /** The table, or undefined when it has been deleted. */
    get(id: string): Promise<LookupTable | undefined>;
    /** Called after a table is saved or deleted; returns a function that stops it. */
    onChange(listener: (change: LookupChange) => void): () => void;
}

export interface LookupTablesStoreOptions {
    /** Now, as ISO 8601 (tests pass their own). */
    now?(): string;
}

const ID_PREFIX = 'lkp-';
/** In the workspace folder, beside the Queries folder. */
export const LOOKUP_FOLDER = 'Lookup Tables';

/** Where lookup tables are kept: the host's workspace folder (or, in the web app without one, this browser's). */
export interface LookupFolder {
    workspaceRoot(): Promise<string>;
    /** Make a folder's files readable first (the web app on a workspace folder reads them when asked). */
    preload?(folder: string): Promise<void>;
}
type Backing = Pick<IKeyValueStore, 'get' | 'update'> | LookupFolder;
const isFolder = (b: Backing): b is LookupFolder => typeof (b as LookupFolder).workspaceRoot === 'function';
/** Ids are DBMN's own (lkp-...); anything else never becomes a path. */
const safe = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_');

/** Whether an id is a lookup table's (the Hub's Reporting list holds reports and lookup tables). */
export function isLookupId(id: string): boolean {
    return typeof id === 'string' && id.startsWith(ID_PREFIX);
}

/**
 * Who hears of a change: every store on this state, in this process (the Hub saves a table, an
 * open Query tab reruns), so not one store's own list.
 */
const LISTENERS = new WeakMap<object, Set<(change: LookupChange) => void>>();
function listenersOf(state: object): Set<(change: LookupChange) => void> {
    let set = LISTENERS.get(state);
    if (!set) { set = new Set(); LISTENERS.set(state, set); }
    return set;
}

/** Why a table can't be kept as it is, or '' when it can. */
export function lookupTableProblem(table: Pick<LookupTable, 'name' | 'columns' | 'rows'>): string {
    const name = String(table.name || '').trim();
    if (!name) return 'A lookup table needs a name.';
    if (name.length > LOOKUP_NAME_MAX) return `A name is up to ${LOOKUP_NAME_MAX} characters.`;
    if (!table.columns.length) return 'A lookup table needs a column.';
    if (table.columns.length > LOOKUP_MAX_COLUMNS) return `A lookup table has up to ${LOOKUP_MAX_COLUMNS} columns.`;
    if (table.rows.length > LOOKUP_MAX_ROWS) return `A lookup table has up to ${LOOKUP_MAX_ROWS.toLocaleString('en-AU')} rows.`;
    const names = new Set<string>();
    for (const column of table.columns) {
        const n = String(column.name || '').trim().toLowerCase();
        if (!n) return 'Every column needs a name.';
        if (names.has(n)) return `Two columns are called ${column.name}.`;
        names.add(n);
    }
    for (const column of table.columns.filter(c => c.key)) {
        const seen = new Set<string>();
        for (const row of table.rows) {
            const value = String(row[column.id] ?? '').trim();
            if (!value) return `Every row needs a ${column.name}: it is the key.`;
            if (seen.has(value)) return `${column.name} ${value} is in two rows: a key is in one row only.`;
            seen.add(value);
        }
    }
    return '';
}

/** A new table's columns: a key and a value, as most lookups are. */
export function starterColumns(): LookupColumn[] {
    return [{ id: 'c1', name: 'code', key: true }, { id: 'c2', name: 'value' }];
}

export class LookupTablesStore implements LookupTablesReader {
    /**
     * `backing`: the host's data folder (one file per table), the one object for the whole host so
     * every store on it hears the others' changes. A state store also works (tests; the old keeping).
     */
    constructor(private readonly backing: Backing, private readonly options: LookupTablesStoreOptions = {}) {}

    private get state(): object { return this.backing; }

    private now(): string {
        return this.options.now ? this.options.now() : new Date().toISOString();
    }

    private async folder(): Promise<string> {
        const backing = this.backing as LookupFolder;
        const folder = path.join(await backing.workspaceRoot(), LOOKUP_FOLDER);
        await backing.preload?.(folder);
        return folder;
    }

    /** Each table in the folder, with its file's name. */
    private entries(folder: string): Array<{ file: string; table: LookupTable }> {
        if (!fs.existsSync(folder)) return [];
        const found: Array<{ file: string; table: LookupTable }> = [];
        for (const name of fs.readdirSync(folder).sort()) {
            if (!name.endsWith('.json')) continue;
            try {
                const table = clean(JSON.parse(String(fs.readFileSync(path.join(folder, name), 'utf8'))));
                if (table) found.push({ file: name, table });
            } catch { /* a file that can't be read is left alone, not shown */ }
        }
        return found;
    }

    private async readAll(): Promise<LookupTable[]> {
        if (!isFolder(this.backing)) {
            const kept = this.backing.get<unknown>(LOOKUP_TABLES_KEY);
            return Array.isArray(kept) ? kept.map(clean).filter((t): t is LookupTable => !!t) : [];
        }
        // The same table twice (a file copied in under another name): the newer edit counts
        const byId = new Map<string, LookupTable>();
        for (const { table } of this.entries(await this.folder())) {
            const had = byId.get(table.id);
            if (!had || had.updatedAt < table.updatedAt) byId.set(table.id, table);
        }
        return [...byId.values()];
    }

    /**
     * One table's file, named after it (written beside, then put in place, so a failed write
     * leaves the old one). A renamed table's old file goes.
     */
    private writeFile(folder: string, table: LookupTable): void {
        fs.mkdirSync(folder, { recursive: true });
        const all = this.entries(folder);
        const mine = all.filter(e => e.table.id === table.id).map(e => e.file);
        const others = all.filter(e => e.table.id !== table.id).map(e => e.file.replace(/\.json$/, ''));
        const name = `${freeFileName(others, safeFileName(table.name, safe(table.id)))}.json`;
        const file = path.join(folder, mine.find(f => f.toLowerCase() === name.toLowerCase()) ?? name);
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(table, null, 2));
        fs.renameSync(`${file}.tmp`, file);
        for (const old of mine) if (path.join(folder, old) !== file) fs.rmSync(path.join(folder, old), { force: true });
    }

    /** Keep one table: its own file. */
    private async writeOne(table: LookupTable): Promise<void> {
        if (!isFolder(this.backing)) {
            const all = (await this.readAll()).filter(t => t.id !== table.id);
            await this.backing.update(LOOKUP_TABLES_KEY, [...all, table]);
            return;
        }
        this.writeFile(await this.folder(), table);
    }

    private async removeOne(id: string): Promise<void> {
        if (!isFolder(this.backing)) {
            await this.backing.update(LOOKUP_TABLES_KEY, (await this.readAll()).filter(t => t.id !== id));
            return;
        }
        const folder = await this.folder();
        for (const { file, table } of this.entries(folder)) if (table.id === id) fs.rmSync(path.join(folder, file), { force: true });
    }

    /**
     * Tables kept in the state store before they had files of their own: written to files (one
     * not already there), then gone from the state. Returns how many were moved.
     */
    async migrateFrom(state: Pick<IKeyValueStore, 'get' | 'update'>): Promise<number> {
        if (!isFolder(this.backing)) return 0;
        const kept = state.get<unknown>(LOOKUP_TABLES_KEY);
        if (!Array.isArray(kept) || !kept.length) return 0;
        const have = new Set((await this.readAll()).map(t => t.id));
        let moved = 0;
        for (const raw of kept) {
            const table = clean(raw);
            if (!table || have.has(table.id)) continue;
            await this.writeOne(table);
            moved++;
        }
        await state.update(LOOKUP_TABLES_KEY, undefined);
        return moved;
    }

    private tell(change: LookupChange): void {
        listenersOf(this.state).forEach(listener => {
            try { listener(change); } catch { /* a listener's trouble is its own */ }
        });
    }

    async list(): Promise<LookupTableSummary[]> {
        const tables = await this.readAll();
        return tables
            .map(t => ({ id: t.id, name: t.name, columns: t.columns.map(c => ({ ...c })), rows: t.rows.length, updatedAt: t.updatedAt }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    async get(id: string): Promise<LookupTable | undefined> {
        return (await this.readAll()).find(t => t.id === id);
    }

    /** A new table, empty but for a key and a value column, called `name` (made unique). */
    async create(name: string): Promise<LookupTable> {
        const tables = await this.readAll();
        const table: LookupTable = { id: newId(tables), name: freeName(tables, name || 'Lookup'), columns: starterColumns(), rows: [], updatedAt: this.now() };
        await this.writeOne(table);
        this.tell({ kind: 'saved', id: table.id });
        return table;
    }

    /** Keep a table as given (its name, columns and rows). Throws with the reason when it can't be kept. */
    async save(table: Omit<LookupTable, 'updatedAt'>): Promise<LookupTable> {
        const tables = await this.readAll();
        const at = tables.findIndex(t => t.id === table.id);
        if (at < 0) throw new Error('This lookup table has been deleted.');
        const kept = clean({ ...table, updatedAt: this.now() });
        if (!kept) throw new Error('This lookup table could not be read.');
        const problem = lookupTableProblem(kept);
        if (problem) throw new Error(problem);
        if (tables.some(t => t.id !== kept.id && t.name.toLowerCase() === kept.name.toLowerCase())) {
            throw new Error(`Another lookup table is already called ${kept.name}.`);
        }
        await this.writeOne(kept);
        this.tell({ kind: 'saved', id: kept.id });
        return kept;
    }

    async rename(id: string, name: string): Promise<LookupTable> {
        const table = await this.get(id);
        if (!table) throw new Error('This lookup table has been deleted.');
        return this.save({ ...table, name: name.trim() });
    }

    /** A copy, called "<name> copy" (made unique). */
    async duplicate(id: string): Promise<LookupTable> {
        const tables = await this.readAll();
        const from = tables.find(t => t.id === id);
        if (!from) throw new Error('This lookup table has been deleted.');
        const copy: LookupTable = {
            id: newId(tables), name: freeName(tables, `${from.name} copy`),
            columns: from.columns.map(c => ({ ...c })), rows: from.rows.map(r => ({ ...r })), updatedAt: this.now()
        };
        await this.writeOne(copy);
        this.tell({ kind: 'saved', id: copy.id });
        return copy;
    }

    async remove(id: string): Promise<void> {
        if (!(await this.readAll()).some(t => t.id === id)) return;
        await this.removeOne(id);
        this.tell({ kind: 'deleted', id });
    }

    onChange(listener: (change: LookupChange) => void): () => void {
        const set = listenersOf(this.state);
        set.add(listener);
        return () => { set.delete(listener); };
    }
}

/** A table as read (from the file or a screen): only what a table has, every value text. */
function clean(raw: unknown): LookupTable | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const t = raw as Record<string, unknown>;
    if (typeof t.id !== 'string' || !Array.isArray(t.columns) || !Array.isArray(t.rows)) return undefined;
    const columns: LookupColumn[] = (t.columns as unknown[])
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof (c as Record<string, unknown>).id === 'string')
        .map(c => ({ id: String(c.id), name: String(c.name ?? c.id).trim(), ...(c.key === true ? { key: true } : {}) }));
    const ids = columns.map(c => c.id);
    const rows = (t.rows as unknown[])
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map(r => {
            const row: Record<string, string> = {};
            ids.forEach(id => { row[id] = r[id] === null || r[id] === undefined ? '' : String(r[id]); });
            return row;
        });
    return { id: t.id, name: String(t.name ?? '').trim(), columns, rows, updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : '' };
}

function newId(tables: LookupTable[]): string {
    let id = '';
    do { id = `${ID_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`; } while (tables.some(t => t.id === id));
    return id;
}

/** `base`, cut to length, with a number after it when another table has the name. */
function freeName(tables: LookupTable[], base: string): string {
    const taken = new Set(tables.map(t => t.name.toLowerCase()));
    const clean = base.trim().slice(0, LOOKUP_NAME_MAX).trim() || 'Lookup';
    let name = clean;
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
        const tail = ` ${n}`;
        name = clean.slice(0, LOOKUP_NAME_MAX - tail.length).trim() + tail;
    }
    return name;
}
