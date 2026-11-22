// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Where a query's file views (CSV or Excel) keep their rows: beside the query itself, in its
 * folder in the workspace (`Queries/<query name>/<view>.json`, query-folder), so a query's folder
 * holds everything it needs. A file is read once, when it is picked; the query then opens and
 * runs from this copy, so it never asks for the file again.
 *
 * A query with no folder (no workspace folder: the core tests) keeps them in DBMN's data folder,
 * `.dbmn/query-files/<query>/<view>.json`, as before.
 *
 * Not in the saved query itself: that is small state which can be kept on the account, and a
 * file's rows stay on the computer they were picked on. Not in the history database either:
 * it is written whole on every save, and a file can be a hundred thousand rows.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { QueryRowData } from './query-engine';
import type { QueryFileRows } from './query-file';
import { QUERY_FILE, queryFolderOf } from './query-folder';

export interface QueryFileStoreOptions {
    /** DBMN's data folder (where the history database is). */
    dataDir(): Promise<string>;
    /** Make a folder's files readable first (the web app on a workspace folder reads them when asked). */
    preload?(folder: string): Promise<void>;
}

const FOLDER = 'query-files';
/** Ids are DBMN's own (qry-..., v-...); anything else never becomes a path. */
const safe = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_');

export class QueryFileStore {
    constructor(private readonly options: QueryFileStoreOptions) {}

    /** The query's own folder in the workspace, or (no workspace folder) DBMN's data folder. */
    private async folder(queryId: string): Promise<string> {
        return queryFolderOf(queryId) ?? this.inDataFolder(queryId);
    }

    private async inDataFolder(queryId: string): Promise<string> {
        return path.join(await this.options.dataDir(), FOLDER, safe(queryId));
    }

    /** Keep a file view's rows (over what was kept for it before). */
    async save(queryId: string, viewId: string, file: QueryFileRows): Promise<void> {
        const folder = await this.folder(queryId);
        fs.mkdirSync(folder, { recursive: true });
        // A row as its values in column order: the names are written once
        const rows = file.rows.map(row => file.columns.map(column => row[column] ?? null));
        fs.writeFileSync(path.join(folder, `${safe(viewId)}.json`), JSON.stringify({ columns: file.columns, rows }));
    }

    /** A file view's rows as kept, or undefined when this computer has none for it. */
    async read(queryId: string, viewId: string): Promise<QueryFileRows | undefined> {
        const folder = await this.folder(queryId);
        try {
            await this.options.preload?.(folder);
            const file = path.join(folder, `${safe(viewId)}.json`);
            if (!fs.existsSync(file)) return undefined;
            const kept = JSON.parse(String(fs.readFileSync(file, 'utf8'))) as { columns?: unknown; rows?: unknown };
            if (!Array.isArray(kept.columns) || !Array.isArray(kept.rows)) return undefined;
            const columns = kept.columns.map(String);
            const rows = (kept.rows as unknown[][]).map(values => {
                const row: QueryRowData = {};
                columns.forEach((column, i) => { row[column] = (values[i] ?? null) as QueryRowData[string]; });
                return row;
            });
            return { columns, rows };
        } catch {
            return undefined;
        }
    }

    /** Drop one view's rows, or (no view) all the query kept. */
    async remove(queryId: string, viewId?: string): Promise<void> {
        const folder = await this.folder(queryId);
        try {
            await this.options.preload?.(folder);
            if (viewId) fs.rmSync(path.join(folder, `${safe(viewId)}.json`), { force: true });
            else if (fs.existsSync(path.join(folder, QUERY_FILE))) {
                // The query's own folder: its rows go, the query stays (query-store removes the folder)
                for (const name of fs.readdirSync(folder)) if (name !== QUERY_FILE) fs.rmSync(path.join(folder, name), { force: true });
            } else fs.rmSync(folder, { recursive: true, force: true });
        } catch {
            // nothing kept, or the folder is not reachable now: nothing to drop
        }
    }

    /** A duplicated query keeps its own copy of each file's rows (not the original's query.json). */
    async copy(fromQueryId: string, toQueryId: string): Promise<void> {
        const from = await this.folder(fromQueryId);
        const to = await this.folder(toQueryId);
        try {
            await this.options.preload?.(from);
            if (!fs.existsSync(from)) return;
            fs.mkdirSync(to, { recursive: true });
            for (const name of fs.readdirSync(from)) {
                if (name.endsWith('.json') && name !== QUERY_FILE) fs.writeFileSync(path.join(to, name), fs.readFileSync(path.join(from, name)));
            }
        } catch {
            // the copy asks for its files again
        }
    }
}
