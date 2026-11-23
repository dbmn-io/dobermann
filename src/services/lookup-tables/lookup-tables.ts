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
 * (A host with no folder, and the tests, may give the store its state store instead.)
 *
 * A column has an id that never changes (a rename keeps it), so a saved query's
 * { table, from, to } keeps working when a column is renamed.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { IKeyValueStore } from '../../platform/interfaces/key-value-store.interface';
import { freeName as freeFileName, safeFileName } from '../query/query-folder';
import { cleanSearches, type SavedSearch } from '../query/query-store';
import * as lookupValueScript from '../../webviews/shared/lookup-value.js';
import type { LookupAnswer as SharedAnswer } from '../../webviews/shared/lookup-value.js';
import { sharedScript } from '../../utils/shared-script';

export const LOOKUP_TABLES_KEY = 'lookupTables';

/** The most columns a lookup table can have (James, 2026-11-23: up to five, all equal). */
export const LOOKUP_MAX_COLUMNS = 5;
/** The most rows a lookup table can have. */
export const LOOKUP_MAX_ROWS = 1000;
/** A lookup table's name: as long as a report's. */
export const LOOKUP_NAME_MAX = 30;
/** A column's name. */
export const LOOKUP_COLUMN_NAME_MAX = 20;

/**
 * A column. Every column is equal (James, 2026-11-23: "all equal. we can lookup any column and return any
 * other column"): Translate values looks a value up in any one and gives the same row's value in any other.
 * (A file from before, with `key: true` on a column, is read without it.)
 */
export interface LookupColumn {
    /** Never changes: what a query's function saves. */
    id: string;
    name: string;
}

export interface LookupTable {
    id: string;
    name: string;
    columns: LookupColumn[];
    /** A row: a value by column id. */
    rows: Array<Record<string, string>>;
    updatedAt: string;
    /** The ★'s saved searches on the table's page (James, 2026-11-23: "everywhere where we have a search box"), kept in
     *  its file so they travel with it; none when missing. */
    searches?: SavedSearch[];
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
    /** One row added (Translate values' "+ Add" in Query): LookupTablesStore.addRow. */
    addRow?(id: string, row: Record<string, string>, unique?: { column: string; value: string }): Promise<LookupTable>;
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

/**
 * Looking a value up: one rule, in the shared script the pages load too (shared/lookup-value.js): found (the first
 * matching row's To value, top to bottom as the table keeps them; `rows` when more than one matched) or missing.
 */
export type LookupAnswer = SharedAnswer;
const shared = sharedScript<{
    lookupColumn(table: Pick<LookupTable, 'columns'>, ref: string): LookupColumn | undefined;
    lookupValue(table: Pick<LookupTable, 'columns' | 'rows'>, from: string, value: string, to?: string): LookupAnswer;
}>(lookupValueScript, 'LookupValue');
/** A table's column by its id, or by its name (any case). */
export const lookupColumn = shared.lookupColumn;
/** One value looked up, by the rule Translate values, its dialog and Run Batch's lookups all follow. */
export const lookupValue = shared.lookupValue;

/** Why a table can't be kept as it is, or '' when it can. */
export function lookupTableProblem(table: Pick<LookupTable, 'name' | 'columns' | 'rows'>): string {
    const name = String(table.name || '').trim();
    if (!name) return 'A lookup table needs a name.';
    if (name.length > LOOKUP_NAME_MAX) return `A name is up to ${LOOKUP_NAME_MAX} characters.`;
    if (!table.columns.length) return 'A lookup table needs a column.';
    if (table.columns.length > LOOKUP_MAX_COLUMNS) return `A lookup table has up to ${LOOKUP_MAX_COLUMNS} columns.`;
    const tooLong = table.columns.find(c => String(c.name || '').trim().length > LOOKUP_COLUMN_NAME_MAX);
    if (tooLong) return `A column's name is up to ${LOOKUP_COLUMN_NAME_MAX} characters.`;
    if (table.rows.length > LOOKUP_MAX_ROWS) return `A lookup table has up to ${LOOKUP_MAX_ROWS.toLocaleString('en-AU')} rows.`;
    const names = new Set<string>();
    for (const column of table.columns) {
        const n = String(column.name || '').trim().toLowerCase();
        if (!n) return 'Every column needs a name.';
        if (names.has(n)) return `Two columns are called ${column.name}.`;
        names.add(n);
    }
    return '';
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

    /** A table by its name, any letter case (Run Batch's `lu` names its table). */
    async findByName(name: string): Promise<LookupTable | undefined> {
        const want = String(name ?? '').trim().toLowerCase();
        return (await this.readAll()).find(t => t.name.toLowerCase() === want);
    }

    /**
     * A new table, no rows yet, called `name` with the columns named (one to five, all equal). Refused in words when
     * it can't be: the dialog checks first, the store only refuses (another table of that name, two columns alike…).
     * Without names, the two of a first table: code and value.
     */
    async create(name: string, columnNames: string[] = ['code', 'value']): Promise<LookupTable> {
        const tables = await this.readAll();
        const trimmed = String(name ?? '').trim();
        if (tables.some(t => t.name.toLowerCase() === trimmed.toLowerCase())) throw new Error(`There's a lookup table called ${trimmed} already.`);
        const columns = columnNames.map((n, i) => ({ id: `c${i + 1}`, name: String(n ?? '').trim() }));
        const table: LookupTable = { id: newId(tables), name: trimmed, columns, rows: [], updatedAt: this.now() };
        const problem = lookupTableProblem(table);
        if (problem) throw new Error(problem);
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

    /**
     * One row added (James, 2026-11-23: Translate values' "+ Add" on a value not in the From column): `row` a value by
     * column id, the others blank. With `unique`, refused when that column already holds the value (another screen added
     * it first). Refused in words when the table is gone or full. Kept as save keeps a table (written whole, beside, then
     * put in place) and every screen on it hears (onChange).
     */
    async addRow(id: string, row: Record<string, string>, unique?: { column: string; value: string }): Promise<LookupTable> {
        const table = await this.get(id);
        if (!table) throw new Error('This lookup table has been deleted.');
        if (table.rows.length >= LOOKUP_MAX_ROWS) throw new Error(`A lookup table has up to ${LOOKUP_MAX_ROWS.toLocaleString('en-AU')} rows.`);
        if (unique) {
            const column = lookupColumn(table, unique.column);
            if (column && table.rows.some(r => (r[column.id] ?? '') === unique.value)) throw new Error(`${unique.value} is in ${column.name} already.`);
        }
        const added: Record<string, string> = {};
        table.columns.forEach(c => { const v = row[c.id]; added[c.id] = v === null || v === undefined ? '' : String(v); });
        return this.save({ ...table, rows: [...table.rows, added] });
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
            columns: from.columns.map(c => ({ ...c })), rows: from.rows.map(r => ({ ...r })), updatedAt: this.now(),
            // (its saved searches too: a copy is the same table)
            ...(from.searches && from.searches.length ? { searches: from.searches.map(x => ({ ...x })) } : {})
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
        .map(c => ({ id: String(c.id), name: String(c.name ?? c.id).trim() }));
    const ids = columns.map(c => c.id);
    const rows = (t.rows as unknown[])
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map(r => {
            const row: Record<string, string> = {};
            ids.forEach(id => { row[id] = r[id] === null || r[id] === undefined ? '' : String(r[id]); });
            return row;
        });
    const searches = t.searches === undefined ? undefined : cleanSearches(t.searches);
    return { id: t.id, name: String(t.name ?? '').trim(), columns, rows, updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : '', ...(searches && searches.length ? { searches } : {}) };
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
