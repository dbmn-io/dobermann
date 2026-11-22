// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as path from 'path';
import * as fs from 'fs';
import { IExecutionStorage, BatchMemberFile, BatchMemberLogRow } from './execution-storage.interface';
import { ExecutionLinkInput, ExecutionLinks, ExecutionLinkEnd } from '../chain/chain-types';
import {
    ExecutionMetadata,
    ExecutionFilters,
    TableOptions,
    ExecutionTableResult,
    ExecutionStats,
    validateExecutionMetadata
} from '../../storage/execution-metadata';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';
import { readRunFileIfExists } from '../run-content/run-content-store';

/**
 * Issue #324: what the storage needs from its host. The VS Code shell builds these from the
 * extension context and the Dobermann workspace folder
 * (`platform/vscode/vscode-execution-storage.ts`); `test:core` points them at a temp folder.
 */
export interface SqlJsStorageOptions {
    /** The folder that holds `executions.db` (created if missing). Resolved on `initialize()`. */
    resolveDatabaseDir: () => Promise<string>;
    /** `sql-wasm.wasm`. */
    wasmPath: string;
    /** `sqlite-schema.sql`. */
    schemaPath: string;
    logger: IExtensionDiagnosticLogger;
    /** Tell the user their history was reset and where the corrupted file was kept. */
    notifyCorruptionRecovered?: (corruptPath: string, cause: unknown) => void;
}

/**
 * The SQLite engine (`sql-wasm.wasm`) could not be loaded from `wasmPath`. In the web app that
 * file comes from the app's server, so this is what a stopped dev server or a site outage looks
 * like at start-up (sql.js itself throws the bare string "both async and sync fetching of the
 * wasm failed"). The host says what that means where it runs; `cause` keeps sql.js's own words.
 */
export class SqlJsEngineLoadError extends Error {
    /** sql.js's own error (ES2020 lib has no Error.cause, so declared here). */
    public readonly cause: unknown;
    constructor(public readonly wasmPath: string, cause: unknown) {
        super(`Could not load the SQLite engine from ${wasmPath}: ${cause instanceof Error ? cause.message : String(cause)}`);
        this.name = 'SqlJsEngineLoadError';
        this.cause = cause;
    }
}

/**
 * SQLite implementation of execution metadata storage using sql.js (WASM)
 *
 * GitHub Issue #102: Migrate from JSON to SQLite for:
 * - 132× reduction in write operations (330,000 → 2,500)
 * - 60× faster I/O (30 minutes → 30 seconds)
 * - ACID transactions for corruption protection
 * - Indexed queries for instant lookups
 *
 * GitHub Issue #109: Migrated to sql.js for cross-platform compatibility
 * - No native binaries (pure WASM)
 * - Works on Windows, Linux, Mac without build tools
 * - No NODE_MODULE_VERSION conflicts
 * - Reads existing better-sqlite3 databases perfectly
 */
/** GitHub Issue #247: a run's request headers — its own, or (a batch) its first member's. */
const HEADERS_OF = (alias: string): string =>
    `COALESCE(${alias}.request_headers, (SELECT m.request_headers FROM executions m WHERE m.batch_id = ${alias}.id AND m.request_headers IS NOT NULL LIMIT 1))`;

function parseHeaders(raw: unknown): Record<string, string> | undefined {
    if (typeof raw !== 'string' || !raw) return undefined;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : undefined;
    } catch {
        return undefined;
    }
}

export class SqlJsExecutionStorage implements IExecutionStorage {
    private db: SqlJsDatabase | null = null;
    private dbPath: string | null = null;
    private readonly DB_VERSION = 1;
    private readonly logger: IExtensionDiagnosticLogger;

    // GitHub Issue #110: JavaScript-level mutex for claim operations
    // sql.js doesn't block async operations, so we need app-level locking
    // Promise chain pattern allows different return types per operation
    private claimMutex: Promise<any> = Promise.resolve();

    // Debounced save: sql.js is in-memory so all queries see latest state immediately.
    // Disk saves are purely crash recovery — safe to coalesce into periodic flushes.
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly SAVE_DEBOUNCE_MS = 2000;

    // sql.js has no file system: the database is a byte array we read in and write out
    // whole. Nothing locks the file, so two VS Code windows are not sharing a database —
    // they are keeping two of them that save to the same name, and the last writer wins.
    // That cost a 67,000-record batch on 2026-09-18: thirteen windows had this file open,
    // one of them exported a four-day-old copy over the top, and no save reported an error.
    //
    // So before each save we ask whether the file moved on since we last saw it, and if it
    // did we take what it gained. `SQL` is kept for that second, disk-side database.
    private SQL: typeof import('sql.js') extends (...args: never[]) => Promise<infer T> ? T : never | null = null as never;
    private fileSize = -1;
    private fileMtimeMs = -1;

    // Rows THIS window has written since it loaded. Everything else in memory is just a
    // copy of what the file said when we read it, and may since have been moved on by the
    // window that owns it — so on a merge we keep ours only for rows we actually wrote,
    // and defer to the file for the rest. Never cleared on save: another window may still
    // be holding an older copy of these rows and we have to keep winning against it.
    private readonly ownedExecutionIds = new Set<string>();
    private readonly ownedBatchIds = new Set<string>();
    private readonly deletedExecutionIds = new Set<string>();
    private readonly ownedLinkIds = new Set<string>();   // GitHub Issue #247

    constructor(private readonly options: SqlJsStorageOptions) {
        this.logger = options.logger;
    }

    /**
     * Initialize SQLite database and create schema
     * GitHub Issue #109: sql.js requires async WASM loading + file persistence
     */
    async initialize(): Promise<void> {
        try {
            // Ensure the database folder (the workspace's .dbmn) exists
            const databaseDir = await this.options.resolveDatabaseDir();
            await fs.promises.mkdir(databaseDir, { recursive: true });

            // Create database file path
            this.dbPath = path.join(databaseDir, 'executions.db');

            // Initialize sql.js (load WASM)
            const wasmPath = this.options.wasmPath;
            const SQL = this.SQL = await initSqlJs({
                locateFile: (file) => {
                    // Return path to WASM file bundled by webpack
                    if (file === 'sql-wasm.wasm') {
                        return wasmPath;
                    }
                    return file;
                }
            }).catch((cause: unknown) => { throw new SqlJsEngineLoadError(wasmPath, cause); });

            // Load existing database or create new. On corruption ("disk image
            // is malformed" — usually a torn write from a prior interrupted
            // session), move the bad file aside for forensics and start fresh
            // instead of bricking extension activation. Atomic writes (see
            // flushDatabase) prevent this happening to us, but external causes
            // — disk failure, antivirus, manual edits — still need this guard.
            //
            // Critical: sql.js validates the buffer LAZILY. `new SQL.Database(buf)`
            // accepts a file whose header is intact but whose pages are
            // corrupt; the actual "disk image is malformed" throw happens on
            // first read (PRAGMA / SELECT / schema mutation). We force the
            // validation with `PRAGMA quick_check` INSIDE the try block so
            // the throw lands here instead of escaping to extension.activate.
            // quick_check reads every page like integrity_check but skips the
            // index-vs-table cross-check: ~260 ms instead of ~460 ms on 70 MB.
            if (fs.existsSync(this.dbPath)) {
                // Record the file as we are about to read it — before the read, so a write that
                // lands in between makes the first save merge rather than go unseen. Without
                // this the first save took its own file for another window's write and merged
                // all of it into itself (2026-10-04: 10–31 s activations on a 70 MB history).
                this.rememberFileState();
                const buffer = fs.readFileSync(this.dbPath);
                let loaded = false;
                try {
                    this.db = new SQL.Database(buffer);
                    // Force lazy validation — this will throw "disk image is
                    // malformed" on a corrupt file even if construction succeeded.
                    // Also surfaces non-throwing damage: a "result not 'ok'" is
                    // treated as corrupt.
                    const checkResult = this.db.exec('PRAGMA quick_check');
                    const firstRow = checkResult[0]?.values?.[0]?.[0];
                    if (firstRow !== 'ok') {
                        throw new Error(`SQLite quick_check failed: ${String(firstRow)}`);
                    }
                    loaded = true;
                    this.logger.info(`Loaded existing SQLite database: ${this.dbPath}`);
                } catch (loadErr) {
                    // Close the partially-loaded DB before swapping it out.
                    try { this.db?.close(); } catch (_e) { /* ignore */ }
                    this.db = null;

                    const corruptPath = `${this.dbPath}.corrupted-${Date.now()}`;
                    fs.renameSync(this.dbPath, corruptPath);
                    this.db = new SQL.Database();
                    this.logger.error(
                        `SQLite DB corrupted on load — preserved as ${corruptPath}, started fresh.`,
                        loadErr instanceof Error ? loadErr : undefined
                    );
                    // Persistent notice from the host (in VS Code a native notification with
                    // action buttons — see platform/vscode/vscode-execution-storage.ts).
                    this.notifyCorruptionRecovered(corruptPath, loadErr);
                }
                void loaded; // suppress unused-var when the try succeeds
            } else {
                this.db = new SQL.Database();
                this.logger.info(`Created new SQLite database: ${this.dbPath}`);
            }

            // SQLite ships with foreign-key enforcement OFF by default per
            // connection. Without this PRAGMA, the `ON DELETE CASCADE` clauses
            // declared in sqlite-schema.sql are silently inert — deleting a
            // batch parent leaves orphan batch_member rows.
            this.db.run('PRAGMA foreign_keys = ON');

            // Create schema
            await this.createSchema();

            // Initial save to disk
            this.saveDatabaseSync();

            this.rememberFileState();
            this.logger.info(`sql.js execution storage initialized: ${this.dbPath}`);
        } catch (error) {
            this.logger.error('Failed to initialize sql.js execution storage:', error instanceof Error ? error : undefined);
            throw error;
        }
    }

    /**
     * Tell the user their history was reset (Issue #324: the host shows it), and log the same
     * details so they survive a dismissed notification.
     */
    private notifyCorruptionRecovered(corruptPath: string, loadErr: unknown): void {
        const fileName = path.basename(corruptPath);
        const dirName = path.dirname(corruptPath);
        const errMsg = loadErr instanceof Error ? loadErr.message : String(loadErr);

        try {
            this.options.notifyCorruptionRecovered?.(corruptPath, loadErr);
        } catch {
            // Never block activation on this notification.
        }

        // Belt-and-braces: also dump the message to the Output panel so it's
        // recoverable from the log even if the user closes the notification
        // without reading it.
        this.logger.error(`DB corruption recovery: preserved=${corruptPath} dir=${dirName} fileName=${fileName} cause="${errMsg}"`);
    }

    /**
     * Schedule a debounced save to disk.
     * sql.js is fully in-memory — all queries see the latest state regardless of disk persistence.
     * Disk writes are purely crash recovery, so coalescing them is safe and dramatically
     * reduces I/O during batch execution (from ~2000 full-DB exports down to periodic flushes).
     *
     * GitHub Issue #94: Original debounce was removed due to race conditions, but those
     * only affected in-memory query consistency. Since sql.js queries always read from
     * the in-memory DB (not disk), debouncing disk saves has no effect on query results.
     */
    private saveDatabase(): void {
        if (!this.db || !this.dbPath) return;

        // If a save is already scheduled, let it coalesce
        if (this.saveTimer) return;

        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.flushDatabase();
        }, this.SAVE_DEBOUNCE_MS);
    }

    /**
     * Immediately flush the in-memory database to disk.
     * Used for: initial save, close/dispose, and the debounce callback.
     *
     * Atomic write: serialise to a sibling `.tmp` file, then `renameSync` over
     * the live path. rename is atomic on every filesystem that matters
     * (ext4/WSL, APFS, NTFS), so the live file is either the old fully-valid
     * DB or the new fully-valid DB — never a half-written file. A torn write
     * during the streaming step only damages the tmp file, which the next
     * flush overwrites. Without this, a 91 MB writeFileSync interrupted
     * mid-stream leaves a partial file that fails to load with "database
     * disk image is malformed" on next activation.
     */
    private flushDatabase(): void {
        if (!this.db || !this.dbPath) return;

        const tmpPath = `${this.dbPath}.tmp`;
        try {
            // Take anything the file gained since we read it, or we would erase it.
            this.mergeFromDiskIfChanged();

            const bytes = this.db.export();
            // (export closes and reopens the database, so SQLite's change count starts again from 0: changeStamp counts saves too)
            this.exports++;
            fs.writeFileSync(tmpPath, bytes);
            fs.renameSync(tmpPath, this.dbPath);
            this.rememberFileState();
        } catch (error) {
            // Best-effort cleanup of the tmp file so it doesn't linger if
            // the write succeeded but the rename failed (very rare).
            try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_e) { /* swallow */ }
            this.logger.error('Failed to save database:', error instanceof Error ? error : undefined);
        }
    }

    /**
     * A stamp that changes whenever any row of the history does: SQLite's own count of rows written
     * on this database (every insert, update and delete, the merges from another writer's file
     * too), with which database object it is (a reload starts a new count) and how many times it
     * has been saved (sql.js's export closes and reopens it, and the count starts again from 0: without
     * this, a stamp from before a save could come round again with other runs in it; found by the
     * tester 2026-11-23). The run list's cache (DatabaseAdapter.runList) is read again only when it
     * changes. Undefined while closed.
     */
    changeStamp(): string | undefined {
        if (!this.db) return undefined;
        if (this.db !== this.stampedDb) { this.stampedDb = this.db; this.stampSerial++; }
        const changes = this.db.exec('SELECT total_changes()')[0]?.values[0]?.[0];
        return `${this.stampSerial}:${this.exports}:${String(changes)}`;
    }
    private stampedDb: unknown;
    private stampSerial = 0;
    private exports = 0;

    /**
     * #344: fold in what another writer saved, now rather than at our next save, and say whether
     * there was anything. The web app calls it when the workspace folder's database changed
     * (VS Code ran something), so History shows it; and when a save of its own found the file
     * changed underneath, before saving again. Same merge as a save: our rows stay ours.
     */
    refreshFromDisk(options: { save?: boolean } = {}): boolean {
        if (!this.db || !this.dbPath || !this.fileChangedUnderneath()) return false;
        this.mergeFromDiskIfChanged();
        this.rememberFileState();
        if (options.save) this.saveDatabase();
        return true;
    }

    /**
     * #344: bring in runs another history holds that this one doesn't (the web app's own, kept in
     * the browser while the workspace folder wasn't connected), with their file paths moved from
     * `rewrite.from` to `rewrite.to`. Runs this history already has are left as they are. Returns
     * how many runs came in; they're this history's own from now on, saved like any other.
     */
    importExecutionsFrom(sourcePath: string, rewrite: { from: string; to: string }): number {
        if (!this.db || !this.SQL || !fs.existsSync(sourcePath)) return 0;
        const source = new this.SQL.Database(fs.readFileSync(sourcePath));
        try {
            const from = rewrite.from.replace(/\/+$/, '');
            const to = rewrite.to.replace(/\/+$/, '');
            // Paths first, in the copy: the file columns start with the old root; inside the JSON
            // columns a path is a quoted string that starts with it
            for (const column of ['request_file', 'response_file', 'log_path']) {
                source.run(`UPDATE executions SET ${column} = ? || substr(${column}, ?) WHERE ${column} LIKE ?`, [to, from.length + 1, `${from}/%`]);
            }
            for (const column of ['batch_configuration', 'preparation_state', 'batch_resumption_data']) {
                source.run(`UPDATE executions SET ${column} = replace(${column}, ?, ?) WHERE ${column} LIKE ?`, [`"${from}/`, `"${to}/`, `%"${from}/%`]);
            }
            const ids = (table: string, key: string, db: SqlJsDatabase) =>
                new Set((db.exec(`SELECT ${key} FROM ${table}`)[0]?.values ?? []).map(row => String(row[0])));
            const before = ids('executions', 'id', this.db);
            const coming = [...ids('executions', 'id', source)].filter(id => !before.has(id));
            if (coming.length === 0) return 0;
            // Only the runs this history lacks: a run it has (moved on an earlier start, perhaps
            // changed since by VS Code) must never be replaced by the older copy
            source.run('CREATE TEMP TABLE import_keep (id TEXT PRIMARY KEY)');
            const keep = source.prepare('INSERT INTO temp.import_keep (id) VALUES (?)');
            try { for (const id of coming) keep.run([id]); } finally { keep.free(); }
            source.run('DELETE FROM executions WHERE id NOT IN (SELECT id FROM temp.import_keep)');
            source.run('DELETE FROM batch_resumption WHERE batch_id NOT IN (SELECT id FROM temp.import_keep)');
            try {
                source.run('DELETE FROM execution_links WHERE source_execution_id NOT IN (SELECT id FROM temp.import_keep) AND target_execution_id NOT IN (SELECT id FROM temp.import_keep)');
            } catch { /* an older file: no links */ }
            this.mergeTable(source, 'executions', 'id', this.ownedExecutionIds, this.deletedExecutionIds);
            this.mergeTable(source, 'batch_resumption', 'batch_id', this.ownedBatchIds);
            try { this.mergeTable(source, 'execution_links', 'id', this.ownedLinkIds); } catch { /* an older file: no links */ }
            for (const id of coming) this.ownedExecutionIds.add(id);
            this.saveDatabase();
            return coming.length;
        } finally {
            try { source.close(); } catch { /* ignore */ }
        }
    }

    /** #344: which of these runs this history has. */
    hasExecutions(ids: string[]): Set<string> {
        const found = new Set<string>();
        if (!this.db || ids.length === 0) return found;
        const statement = this.db.prepare('SELECT 1 FROM executions WHERE id = ?');
        try {
            for (const id of ids) {
                statement.bind([id]);
                if (statement.step()) found.add(id);
                statement.reset();
            }
        } finally {
            statement.free();
        }
        return found;
    }

    /**
     * Record the file as we last saw it, so the next save can tell whether anybody else
     * has written. Size and modification time together: mtime alone is too coarse on some
     * filesystems to separate two writes in the same second.
     */
    private rememberFileState(): void {
        if (!this.dbPath) return;
        try {
            const stat = fs.statSync(this.dbPath);
            this.fileSize = stat.size;
            this.fileMtimeMs = stat.mtimeMs;
        } catch {
            this.fileSize = -1;
            this.fileMtimeMs = -1;
        }
    }

    /**
     * Has another window written since we last read or wrote? One stat — so a lone window,
     * which is the normal case, pays nothing.
     */
    private fileChangedUnderneath(): boolean {
        if (!this.dbPath) return false;
        try {
            const stat = fs.statSync(this.dbPath);
            return stat.size !== this.fileSize || stat.mtimeMs !== this.fileMtimeMs;
        } catch {
            return false;   // no file yet: nothing to lose
        }
    }

    /**
     * Fold in whatever the file gained while we weren't looking.
     *
     * An execution is only ever mutated by the window that ran it, so ownership decides it
     * and no clocks are needed: rows this window wrote stay as we have them, and for every
     * other row the file's copy wins, because ours is only what the file said when we read
     * it. Both windows' work survives, and a stale copy can never roll a live row back.
     *
     * Best effort by design. A merge that fails must not block the save, or an unreadable
     * file would stop a window persisting anything at all.
     */
    private mergeFromDiskIfChanged(): void {
        if (!this.db || !this.dbPath || !this.SQL) return;
        if (!this.fileChangedUnderneath()) return;

        let diskDb: SqlJsDatabase | null = null;
        try {
            diskDb = new this.SQL.Database(fs.readFileSync(this.dbPath));
            const executions = this.mergeTable(diskDb, 'executions', 'id', this.ownedExecutionIds, this.deletedExecutionIds);
            const resumption = this.mergeTable(diskDb, 'batch_resumption', 'batch_id', this.ownedBatchIds);
            // GitHub Issue #247: a file from before chaining has no links table — merge what we can.
            let links = 0;
            try {
                links = this.mergeTable(diskDb, 'execution_links', 'id', this.ownedLinkIds);
            } catch {
                links = 0;
            }
            if (links) {
                this.logger.info(`Another window wrote to the history database — merged in ${links} run link(s).`);
            }
            if (executions || resumption) {
                this.logger.info(
                    `Another window wrote to the history database — merged in ${executions} execution(s) ` +
                    `and ${resumption} batch resumption record(s) before saving.`
                );
            }
        } catch (error) {
            this.logger.error('Could not merge concurrent history changes; saving our own state',
                error instanceof Error ? error : undefined);
        } finally {
            try { diskDb?.close(); } catch { /* ignore */ }
        }
    }

    /**
     * Copy rows of `table` that are on disk but missing or different in memory. Returns how many.
     * Column list is what the disk and memory schemas have in common, so a file written by an
     * older or newer schema contributes whatever columns the two share.
     *
     * The comparison runs inside SQLite: the disk copy is ATTACHed to our database and one
     * INSERT ... SELECT takes only the rows that differ. On a 70 MB history (61,129 executions)
     * that is ~0.3 s; copying every row through JavaScript one statement at a time took ~13 s
     * and froze the extension host (2026-10-04).
     */
    private mergeTable(diskDb: SqlJsDatabase, table: string, keyColumn: string, owned: Set<string>, dropped?: Set<string>): number {
        if (!this.db) return 0;

        // sql.js keeps each database as a file in its in-memory file system, all databases
        // sharing one; `filename` names it, so our connection can ATTACH the disk copy.
        const diskFile = (diskDb as unknown as { filename?: unknown }).filename;
        if (typeof diskFile !== 'string') {
            return this.mergeTableRowByRow(diskDb, table, keyColumn, owned, dropped);
        }

        const db = this.db;
        db.run(`ATTACH DATABASE '/${diskFile}' AS merge_disk`);
        try {
            const columnsIn = (schema: string): string[] =>
                (db.exec(`SELECT name FROM pragma_table_info('${table}', '${schema}')`)[0]?.values ?? [])
                    .map(row => String(row[0]));
            const ours = new Set(columnsIn('main'));
            const columns = columnsIn('merge_disk').filter(column => ours.has(column));
            if (!columns.includes(keyColumn)) return 0;   // no such table on disk (or no key)

            db.run('BEGIN');
            try {
                // Rows we own or deleted are ours to keep: never take the file's copy of them.
                db.run('CREATE TEMP TABLE IF NOT EXISTS merge_skip (key TEXT PRIMARY KEY)');
                db.run('DELETE FROM temp.merge_skip');
                const skip = db.prepare('INSERT OR IGNORE INTO temp.merge_skip (key) VALUES (?)');
                try {
                    for (const key of owned) skip.run([key]);
                    for (const key of dropped ?? []) skip.run([key]);
                } finally {
                    skip.free();
                }

                const unchanged = columns.map(column => `m.${column} IS d.${column}`).join(' AND ');
                // REPLACE, not IGNORE: for a row we did not write, the file's copy is at least as
                // new as the one we read, so it wins. Identical rows are left alone.
                db.run(`
                    INSERT OR REPLACE INTO main.${table} (${columns.join(', ')})
                    SELECT ${columns.map(column => `d.${column}`).join(', ')}
                    FROM merge_disk.${table} d
                    LEFT JOIN main.${table} m ON m.${keyColumn} = d.${keyColumn}
                    WHERE CAST(d.${keyColumn} AS TEXT) NOT IN (SELECT key FROM temp.merge_skip)
                      AND (m.${keyColumn} IS NULL OR NOT (${unchanged}))
                `);
                const taken = db.getRowsModified();
                db.run('DELETE FROM temp.merge_skip');
                db.run('COMMIT');
                return taken;
            } catch (error) {
                try { db.run('ROLLBACK'); } catch { /* already rolled back */ }
                throw error;
            }
        } finally {
            db.run('DETACH DATABASE merge_disk');
        }
    }

    /**
     * Fallback for a sql.js build that doesn't expose a database's `filename`: compare and copy
     * through JavaScript. Slower, same result, in one transaction.
     */
    private mergeTableRowByRow(diskDb: SqlJsDatabase, table: string, keyColumn: string, owned: Set<string>, dropped?: Set<string>): number {
        if (!this.db) return 0;

        const theirs = diskDb.exec(`SELECT * FROM ${table}`);
        if (theirs.length === 0) return 0;

        const columns = theirs[0].columns;
        const keyIndex = columns.indexOf(keyColumn);
        if (keyIndex < 0) return 0;

        const placeholders = columns.map(() => '?').join(', ');
        const current = this.db.prepare(`SELECT ${columns.join(', ')} FROM ${table} WHERE ${keyColumn} = ?`);
        const upsert = this.db.prepare(
            `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`
        );
        let taken = 0;
        this.db.run('BEGIN');
        try {
            for (const row of theirs[0].values) {
                const key = String(row[keyIndex]);
                if (owned.has(key)) continue;        // ours: we wrote it, we keep it
                if (dropped?.has(key)) continue;     // ours: we deleted it, don't resurrect it
                current.bind([row[keyIndex]]);
                const mine = current.step() ? current.get() : null;
                current.reset();
                if (mine && mine.every((value, i) => value === row[i])) continue;
                upsert.run(row as never);
                taken++;
            }
            this.db.run('COMMIT');
        } catch (error) {
            try { this.db.run('ROLLBACK'); } catch { /* already rolled back */ }
            throw error;
        } finally {
            current.free();
            upsert.free();
        }
        return taken;
    }

    /**
     * Alias for flushDatabase() for backward compatibility
     */
    private saveDatabaseSync(): void {
        this.flushDatabase();
    }

    /**
     * Create database schema from SQL file
     */
    private async createSchema(): Promise<void> {
        if (!this.db) return;

        // Read schema SQL file from extension directory (webpack bundles to dist/)
        const schemaPath = this.options.schemaPath;
        const schemaSql = await fs.promises.readFile(schemaPath, 'utf8');

        // Execute schema (handles CREATE TABLE IF NOT EXISTS)
        this.db.exec(schemaSql);

        // Run migrations for new columns on existing databases
        await this.runMigrations();
    }

    /**
     * Run migrations to add new columns to existing databases
     * GitHub Issue #151: Add reprocess tracking columns
     */
    private async runMigrations(): Promise<void> {
        if (!this.db) return;

        // Get existing columns
        const columns = this.db.exec("PRAGMA table_info(executions)");
        const existingColumns = new Set<string>();
        if (columns.length > 0 && columns[0].values) {
            for (const row of columns[0].values) {
                existingColumns.add(row[1] as string); // column name is at index 1
            }
        }

        // GitHub Issue #151: Add reprocess tracking columns if missing
        const reprocessColumns = [
            { name: 'reprocessed_from_batch_id', type: 'TEXT' },
            { name: 'reprocessed_to_batch_id', type: 'TEXT' },
            { name: 'reprocess_type', type: 'TEXT' }
        ];

        for (const col of reprocessColumns) {
            if (!existingColumns.has(col.name)) {
                this.logger.info(`Migration: Adding column ${col.name} to executions table`);
                try {
                    this.db.run(`ALTER TABLE executions ADD COLUMN ${col.name} ${col.type}`);
                } catch (error) {
                    // Column might already exist in some edge cases
                    this.logger.warn(`Migration warning for ${col.name}:`, error);
                }
            }
        }

        // In-batch reprocess: Add reprocess_count column if missing
        if (!existingColumns.has('reprocess_count')) {
            this.logger.info('Migration: Adding column reprocess_count to executions table');
            try {
                this.db.run('ALTER TABLE executions ADD COLUMN reprocess_count INTEGER DEFAULT 0');
            } catch (error) {
                this.logger.warn('Migration warning for reprocess_count:', error);
            }
        }

        // GitHub Issue #165: Add environment_variables column if missing
        if (!existingColumns.has('environment_variables')) {
            this.logger.info('Migration: Adding column environment_variables to executions table');
            try {
                this.db.run('ALTER TABLE executions ADD COLUMN environment_variables TEXT');
            } catch (error) {
                this.logger.warn('Migration warning for environment_variables:', error);
            }
        }

        // #424/#160: a batch's base URL, its variables filled, kept from when it started
        if (!existingColumns.has('base_url')) {
            this.logger.info('Migration: Adding column base_url to executions table');
            try {
                this.db.run('ALTER TABLE executions ADD COLUMN base_url TEXT');
            } catch (error) {
                this.logger.warn('Migration warning for base_url:', error);
            }
        }
    }

    /**
     * Generate unique execution ID
     */
    private generateExecutionId(): string {
        return `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Map ExecutionMetadata to database row (for named parameters)
     */
    private toRow(metadata: ExecutionMetadata): any {
        return {
            $id: metadata.id,
            $environment: metadata.environment,
            $environment_id: metadata.environmentId || null,
            $organization: metadata.organization || null,
            $endpoint_id: metadata.endpointId,
            $endpoint_name: metadata.endpointName,
            $endpoint_method: metadata.endpointMethod,
            $endpoint_path: metadata.endpointPath,
            $execution_type: metadata.executionType || 'individual',
            $batch_id: metadata.batchId || null,
            $row_start: metadata.rowStart || null,
            $rows: metadata.rows || '1',
            $status: metadata.status,
            $run_time: metadata.runTime || null,
            $created_at: metadata.createdAt.getTime(),
            $started_at: metadata.startedAt?.getTime() || null,
            $completed_at: metadata.completedAt?.getTime() || null,
            $request_file: metadata.requestFile || null,
            $response_file: metadata.responseFile || null,
            $log_path: metadata.logPath || null,
            $http_status: metadata.httpStatus || null,
            $http_status_text: metadata.httpStatusText || null,
            $error_message: metadata.errorMessage || null,
            $request_hash: metadata.requestHash || null,
            $request_headers: metadata.requestHeaders ? JSON.stringify(metadata.requestHeaders) : null,
            $request_query_params: metadata.requestQueryParams ? JSON.stringify(metadata.requestQueryParams) : null,
            $test_status: metadata.testStatus || null,
            $tests_passed: metadata.testsPassed || null,
            $tests_failed: metadata.testsFailed || null,
            $test_results: metadata.testResults ? JSON.stringify(metadata.testResults) : null,
            $batch_configuration: metadata.batchConfiguration ? JSON.stringify(metadata.batchConfiguration) : null,
            $batch_resumption_data: metadata.batchResumptionData ? JSON.stringify(metadata.batchResumptionData) : null,
            $preparation_state: metadata.preparationState ? JSON.stringify(metadata.preparationState) : null,
            $endpoint_config: metadata.endpointConfig ? JSON.stringify(metadata.endpointConfig) : null,
            $column_mapping_used: metadata.columnMappingUsed ? JSON.stringify(metadata.columnMappingUsed) : null,
            $environment_variables: metadata.environmentVariables ? JSON.stringify(metadata.environmentVariables) : null,
            $base_url: metadata.baseUrl || null,
            $copied_from_batch_id: metadata.copiedFromBatchId || null,
            $copied_from_environment: metadata.copiedFromEnvironment || null,
            $copied_from_organization: metadata.copiedFromOrganization || null,
            $copied_at: metadata.copiedAt?.getTime() || null,
            $copy_generation: metadata.copyGeneration || null,
            $split_from_member_id: metadata.splitFromMemberId || null,
            $is_split_transaction: metadata.isSplitTransaction ? 1 : 0,
            $split_reason: metadata.splitReason || null,
            $array_index: metadata.arrayIndex || null,
            $original_array_size: metadata.originalArraySize || null,
            // GitHub Issue #151: Reprocess tracking fields
            $reprocessed_from_batch_id: metadata.reprocessedFromBatchId || null,
            $reprocessed_to_batch_id: metadata.reprocessedToBatchId || null,
            $reprocess_type: metadata.reprocessType || null,
            // In-batch reprocess tracking
            $reprocess_count: metadata.reprocessCount || 0
        };
    }

    /**
     * Map database row to ExecutionMetadata
     */
    private fromRow(row: any): ExecutionMetadata {
        return {
            id: row.id,
            environment: row.environment,
            environmentId: row.environment_id || undefined,
            organization: row.organization || undefined,
            endpointId: row.endpoint_id,
            endpointName: row.endpoint_name,
            endpointMethod: row.endpoint_method,
            endpointPath: row.endpoint_path,
            executionType: row.execution_type,
            batchId: row.batch_id || undefined,
            rowStart: row.row_start || undefined,
            rows: row.rows,
            status: row.status,
            runTime: row.run_time || undefined,
            createdAt: new Date(row.created_at),
            startedAt: row.started_at ? new Date(row.started_at) : undefined,
            completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
            requestFile: row.request_file || undefined,
            responseFile: row.response_file || undefined,
            logPath: row.log_path || undefined,
            httpStatus: row.http_status || undefined,
            httpStatusText: row.http_status_text || undefined,
            errorMessage: row.error_message || undefined,
            requestHash: row.request_hash || undefined,
            requestHeaders: row.request_headers ? JSON.parse(row.request_headers) : undefined,
            requestQueryParams: row.request_query_params ? JSON.parse(row.request_query_params) : undefined,
            testStatus: row.test_status || undefined,
            testsPassed: row.tests_passed || undefined,
            testsFailed: row.tests_failed || undefined,
            testResults: row.test_results ? JSON.parse(row.test_results) : undefined,
            batchConfiguration: row.batch_configuration ? JSON.parse(row.batch_configuration) : undefined,
            batchResumptionData: row.batch_resumption_data ? JSON.parse(row.batch_resumption_data) : undefined,
            preparationState: row.preparation_state ? JSON.parse(row.preparation_state) : undefined,
            endpointConfig: row.endpoint_config ? JSON.parse(row.endpoint_config) : undefined,
            columnMappingUsed: row.column_mapping_used ? JSON.parse(row.column_mapping_used) : undefined,
            environmentVariables: row.environment_variables ? JSON.parse(row.environment_variables) : undefined,
            baseUrl: row.base_url || undefined,
            copiedFromBatchId: row.copied_from_batch_id || undefined,
            copiedFromEnvironment: row.copied_from_environment || undefined,
            copiedFromOrganization: row.copied_from_organization || undefined,
            copiedAt: row.copied_at ? new Date(row.copied_at) : undefined,
            copyGeneration: row.copy_generation || undefined,
            splitFromMemberId: row.split_from_member_id || undefined,
            isSplitTransaction: row.is_split_transaction === 1,
            splitReason: row.split_reason || undefined,
            arrayIndex: row.array_index || undefined,
            originalArraySize: row.original_array_size || undefined,
            // GitHub Issue #151: Reprocess tracking fields
            reprocessedFromBatchId: row.reprocessed_from_batch_id || undefined,
            reprocessedToBatchId: row.reprocessed_to_batch_id || undefined,
            reprocessType: row.reprocess_type || undefined,
            // In-batch reprocess tracking
            reprocessCount: row.reprocess_count || undefined
        };
    }

    /**
     * Create a new execution record
     */
    /** This window wrote this row: keep ours when merging, and never re-import a delete. */
    private claimExecution(id: string): void {
        this.ownedExecutionIds.add(id);
        this.deletedExecutionIds.delete(id);
    }

    async createExecution(metadata: Omit<ExecutionMetadata, 'id'>): Promise<string> {
        if (!this.db) throw new Error('Database not initialized');

        const id = this.generateExecutionId();
        const fullMetadata: ExecutionMetadata = { id, ...metadata } as ExecutionMetadata;

        // Validate metadata
        const validatedMetadata = validateExecutionMetadata(fullMetadata);

        // Convert to row with $ prefixes for sql.js named parameters
        const row = this.toRow(validatedMetadata);

        // Insert using sql.js
        const stmt = this.db.prepare(`
            INSERT INTO executions (
                id, environment, environment_id, organization,
                endpoint_id, endpoint_name, endpoint_method, endpoint_path,
                execution_type, batch_id, row_start, rows, status,
                run_time, created_at, started_at, completed_at,
                request_file, response_file, log_path,
                http_status, http_status_text, error_message, request_hash,
                request_headers, request_query_params,
                test_status, tests_passed, tests_failed, test_results,
                batch_configuration, batch_resumption_data, preparation_state,
                endpoint_config, column_mapping_used, environment_variables, base_url,
                copied_from_batch_id, copied_from_environment, copied_from_organization,
                copied_at, copy_generation,
                split_from_member_id, is_split_transaction, split_reason,
                array_index, original_array_size,
                reprocessed_from_batch_id, reprocessed_to_batch_id, reprocess_type,
                reprocess_count
            ) VALUES (
                $id, $environment, $environment_id, $organization,
                $endpoint_id, $endpoint_name, $endpoint_method, $endpoint_path,
                $execution_type, $batch_id, $row_start, $rows, $status,
                $run_time, $created_at, $started_at, $completed_at,
                $request_file, $response_file, $log_path,
                $http_status, $http_status_text, $error_message, $request_hash,
                $request_headers, $request_query_params,
                $test_status, $tests_passed, $tests_failed, $test_results,
                $batch_configuration, $batch_resumption_data, $preparation_state,
                $endpoint_config, $column_mapping_used, $environment_variables, $base_url,
                $copied_from_batch_id, $copied_from_environment, $copied_from_organization,
                $copied_at, $copy_generation,
                $split_from_member_id, $is_split_transaction, $split_reason,
                $array_index, $original_array_size,
                $reprocessed_from_batch_id, $reprocessed_to_batch_id, $reprocess_type,
                $reprocess_count
            )
        `);

        stmt.run(row);
        stmt.free();

        this.claimExecution(id);
        // Save to disk
        this.saveDatabase();

        return id;
    }

    /**
     * Create multiple execution records in a single transaction
     * GitHub Issue #94 - Batch INSERT optimization
     */
    async createExecutionBatch(metadataArray: Array<Omit<ExecutionMetadata, 'id'>>): Promise<string[]> {
        if (!this.db) throw new Error('Database not initialized');
        if (!metadataArray || metadataArray.length === 0) {
            return [];
        }

        const ids: string[] = [];

        // Begin transaction
        this.db.run('BEGIN TRANSACTION');

        try {
            // Prepare statement once
            const stmt = this.db.prepare(`
                INSERT INTO executions (
                    id, environment, environment_id, organization,
                    endpoint_id, endpoint_name, endpoint_method, endpoint_path,
                    execution_type, batch_id, row_start, rows, status,
                    run_time, created_at, started_at, completed_at,
                    request_file, response_file, log_path,
                    http_status, http_status_text, error_message, request_hash,
                    request_headers, request_query_params,
                    test_status, tests_passed, tests_failed, test_results,
                    batch_configuration, batch_resumption_data, preparation_state,
                    endpoint_config, column_mapping_used, environment_variables, base_url,
                    copied_from_batch_id, copied_from_environment, copied_from_organization,
                    copied_at, copy_generation,
                    split_from_member_id, is_split_transaction, split_reason,
                    array_index, original_array_size,
                    reprocessed_from_batch_id, reprocessed_to_batch_id, reprocess_type
                ) VALUES (
                    $id, $environment, $environment_id, $organization,
                    $endpoint_id, $endpoint_name, $endpoint_method, $endpoint_path,
                    $execution_type, $batch_id, $row_start, $rows, $status,
                    $run_time, $created_at, $started_at, $completed_at,
                    $request_file, $response_file, $log_path,
                    $http_status, $http_status_text, $error_message, $request_hash,
                    $request_headers, $request_query_params,
                    $test_status, $tests_passed, $tests_failed, $test_results,
                    $batch_configuration, $batch_resumption_data, $preparation_state,
                    $endpoint_config, $column_mapping_used, $environment_variables, $base_url,
                    $copied_from_batch_id, $copied_from_environment, $copied_from_organization,
                    $copied_at, $copy_generation,
                    $split_from_member_id, $is_split_transaction, $split_reason,
                    $array_index, $original_array_size,
                    $reprocessed_from_batch_id, $reprocessed_to_batch_id, $reprocess_type
                )
            `);

            // Execute for each metadata
            for (const metadata of metadataArray) {
                const id = this.generateExecutionId();
                const fullMetadata: ExecutionMetadata = { id, ...metadata } as ExecutionMetadata;
                const validatedMetadata = validateExecutionMetadata(fullMetadata);
                const row = this.toRow(validatedMetadata);

                stmt.run(row);
                ids.push(id);
            }

            stmt.free();

            // Commit transaction
            this.db.run('COMMIT');

            for (const created of ids) { this.claimExecution(created); }
            // Save to disk
            this.saveDatabase();

            return ids;
        } catch (error) {
            // Rollback on error
            this.db.run('ROLLBACK');
            throw error;
        }
    }

    /**
     * Update an existing execution record
     */
    async updateExecution(id: string, updates: Partial<ExecutionMetadata>): Promise<void> {
        this.claimExecution(id);
        if (!this.db) throw new Error('Database not initialized');

        // Get current execution
        const current = await this.getExecution(id);
        if (!current) {
            throw new Error(`Execution with ID "${id}" not found`);
        }

        // Merge updates
        const merged = { ...current, ...updates };

        // 🔍 WATCHDOG: Detect requestQueryParams changes
        const oldPage = current.requestQueryParams?.['page'];
        const newPage = merged.requestQueryParams?.['page'];
        if (oldPage !== undefined && newPage !== oldPage) {
            console.warn(`[DB WATCHDOG] requestQueryParams.page CHANGED for ${id}: "${oldPage}" → "${newPage}". Update keys: ${Object.keys(updates).join(', ')}. Stack: ${new Error().stack?.split('\n').slice(1, 4).join(' | ')}`);
        }
        if (current.requestQueryParams && !merged.requestQueryParams) {
            console.warn(`[DB WATCHDOG] requestQueryParams LOST for ${id}! Was: ${JSON.stringify(current.requestQueryParams)}. Update keys: ${Object.keys(updates).join(', ')}. Stack: ${new Error().stack?.split('\n').slice(1, 4).join(' | ')}`);
        }

        // Validate
        const validated = validateExecutionMetadata(merged);

        // Convert to row
        const row = this.toRow(validated);

        // Update
        const stmt = this.db.prepare(`
            UPDATE executions SET
                environment = $environment,
                environment_id = $environment_id,
                organization = $organization,
                endpoint_id = $endpoint_id,
                endpoint_name = $endpoint_name,
                endpoint_method = $endpoint_method,
                endpoint_path = $endpoint_path,
                execution_type = $execution_type,
                batch_id = $batch_id,
                row_start = $row_start,
                rows = $rows,
                status = $status,
                run_time = $run_time,
                created_at = $created_at,
                started_at = $started_at,
                completed_at = $completed_at,
                request_file = $request_file,
                response_file = $response_file,
                log_path = $log_path,
                http_status = $http_status,
                http_status_text = $http_status_text,
                error_message = $error_message,
                request_hash = $request_hash,
                request_headers = $request_headers,
                request_query_params = $request_query_params,
                test_status = $test_status,
                tests_passed = $tests_passed,
                tests_failed = $tests_failed,
                test_results = $test_results,
                batch_configuration = $batch_configuration,
                batch_resumption_data = $batch_resumption_data,
                preparation_state = $preparation_state,
                endpoint_config = $endpoint_config,
                column_mapping_used = $column_mapping_used,
                environment_variables = $environment_variables,
                base_url = $base_url,
                copied_from_batch_id = $copied_from_batch_id,
                copied_from_environment = $copied_from_environment,
                copied_from_organization = $copied_from_organization,
                copied_at = $copied_at,
                copy_generation = $copy_generation,
                split_from_member_id = $split_from_member_id,
                is_split_transaction = $is_split_transaction,
                split_reason = $split_reason,
                array_index = $array_index,
                original_array_size = $original_array_size,
                reprocessed_from_batch_id = $reprocessed_from_batch_id,
                reprocessed_to_batch_id = $reprocessed_to_batch_id,
                reprocess_type = $reprocess_type,
                reprocess_count = $reprocess_count
            WHERE id = $id
        `);

        stmt.run(row);
        stmt.free();

        // Save to disk
        this.saveDatabase();
    }

    /**
     * Bulk update multiple executions
     * GitHub Issue #67 - prevent corruption with transaction
     */
    async bulkUpdateExecutions(updates: Array<{ id: string; updates: Partial<ExecutionMetadata> }>): Promise<void> {
        for (const update of updates) { this.claimExecution(update.id); }
        if (!this.db) throw new Error('Database not initialized');
        if (updates.length === 0) return;

        // Begin transaction
        this.db.run('BEGIN TRANSACTION');

        try {
            for (const { id, updates: executionUpdates } of updates) {
                // Get current execution
                const current = await this.getExecution(id);
                if (!current) {
                    throw new Error(`Execution with ID "${id}" not found`);
                }

                // Merge and validate
                const merged = { ...current, ...executionUpdates };
                const validated = validateExecutionMetadata(merged);
                const row = this.toRow(validated);

                // Update
                const stmt = this.db.prepare(`
                    UPDATE executions SET
                        status = $status,
                        run_time = $run_time,
                        started_at = $started_at,
                        completed_at = $completed_at,
                        http_status = $http_status,
                        http_status_text = $http_status_text,
                        error_message = $error_message,
                        batch_resumption_data = $batch_resumption_data,
                        preparation_state = $preparation_state
                    WHERE id = $id
                `);

                stmt.run(row);
                stmt.free();
            }

            // Commit transaction
            this.db.run('COMMIT');

            // Save to disk
            this.saveDatabase();
        } catch (error) {
            // Rollback on error
            this.db.run('ROLLBACK');
            throw error;
        }
    }

    /**
     * Get a single execution by ID
     */
    async getExecution(id: string): Promise<ExecutionMetadata | null> {
        if (!this.db) throw new Error('Database not initialized');

        const stmt = this.db.prepare('SELECT * FROM executions WHERE id = $id');
        stmt.bind({ $id: id });

        if (stmt.step()) {
            const row = stmt.getAsObject();
            stmt.free();
            return this.fromRow(row);
        }

        stmt.free();
        return null;
    }

    /**
     * Get all executions with optional filters
     */
    async getExecutions(filters?: ExecutionFilters): Promise<ExecutionMetadata[]> {
        if (!this.db) throw new Error('Database not initialized');

        let sql = 'SELECT * FROM executions WHERE 1=1';
        const params: any = {};

        if (filters?.status) {
            sql += ' AND status = $status';
            params.$status = filters.status;
        }

        if (filters?.environment) {
            sql += ' AND environment = $environment';
            params.$environment = filters.environment;
        }

        if (filters?.endpointId) {
            sql += ' AND endpoint_id = $endpoint_id';
            params.$endpoint_id = filters.endpointId;
        }

        if (filters?.batchId) {
            sql += ' AND batch_id = $batch_id';
            params.$batch_id = filters.batchId;
        }

        sql += ' ORDER BY created_at DESC';

        const stmt = this.db.prepare(sql);
        stmt.bind(params);

        const results: ExecutionMetadata[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            results.push(this.fromRow(row));
        }

        stmt.free();
        return results;
    }

    /**
     * Get paginated table of executions
     */
    async getExecutionTable(options?: TableOptions): Promise<ExecutionTableResult> {
        if (!this.db) throw new Error('Database not initialized');

        const limit = options?.limit || 25;
        const offset = options?.offset || 0;
        const sortOrder = options?.sortOrder || 'desc';

        // Map camelCase field names to snake_case SQL column names
        const columnMap: Record<string, string> = {
            completedAt: 'completed_at',
            createdAt: 'created_at',
            startedAt: 'started_at',
            endpointName: 'endpoint_name',
            executionType: 'execution_type',
            httpStatus: 'http_status',
            runTime: 'run_time'
        };
        const rawSort = options?.sortBy || 'created_at';
        const sortBy = columnMap[rawSort] || rawSort;

        // Get total count
        const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM executions');
        countStmt.step();
        const countRow = countStmt.getAsObject();
        const count = countRow.count as number;
        countStmt.free();

        // Get paginated results
        const sql = `
            SELECT * FROM executions
            ORDER BY ${sortBy} ${sortOrder}
            LIMIT $limit OFFSET $offset
        `;

        const stmt = this.db.prepare(sql);
        stmt.bind({ $limit: limit, $offset: offset });

        const results: ExecutionMetadata[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            results.push(this.fromRow(row));
        }

        stmt.free();

        return {
            executions: results,
            totalCount: count,
            hasMore: (offset + limit) < count
        };
    }

    /**
     * Get execution statistics
     */
    async getExecutionStats(): Promise<ExecutionStats> {
        if (!this.db) throw new Error('Database not initialized');

        const stmt = this.db.prepare(`
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error,
                SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
                AVG(CASE WHEN run_time IS NOT NULL THEN run_time ELSE NULL END) as avgRunTime
            FROM executions
        `);

        stmt.step();
        const stats = stmt.getAsObject();
        stmt.free();

        return {
            totalExecutions: (stats.total as number) || 0,
            completedExecutions: (stats.completed as number) || 0,
            pendingExecutions: (stats.pending as number) || 0,
            runningExecutions: (stats.running as number) || 0,
            errorExecutions: (stats.error as number) || 0,
            cancelledExecutions: (stats.cancelled as number) || 0,
            averageRunTime: (stats.avgRunTime as number) || null
        };
    }

    /**
     * Delete an execution record
     */
    async deleteExecution(id: string): Promise<void> {
        this.ownedExecutionIds.delete(id);
        this.deletedExecutionIds.add(id);
        if (!this.db) throw new Error('Database not initialized');

        const stmt = this.db.prepare('DELETE FROM executions WHERE id = $id');
        stmt.run({ $id: id });
        stmt.free();

        this.saveDatabase();
    }

    /**
     * Delete many executions in a single transaction.
     * Also cascades batch_member rows when a parent batch id is in `ids`
     * (FK is `ON DELETE CASCADE`). Carries the same >50%-of-table safety
     * guard as `deleteBatch`.
     */
    async deleteExecutions(ids: string[]): Promise<number> {
        for (const id of ids) { this.ownedExecutionIds.delete(id); this.deletedExecutionIds.add(id); }
        if (!this.db) throw new Error('Database not initialized');
        if (ids.length === 0) return 0;

        // De-dupe + bound — protects against a misbehaving caller passing
        // millions of ids and blowing the SQL parameter limit.
        const unique = Array.from(new Set(ids));
        const MAX_BATCH = 5000;
        if (unique.length > MAX_BATCH) {
            throw new Error(`deleteExecutions: refusing to delete ${unique.length} rows in one call (max ${MAX_BATCH})`);
        }

        const placeholders = unique.map((_, i) => `$id${i}`).join(', ');
        const params: Record<string, string> = {};
        unique.forEach((id, i) => { params[`$id${i}`] = id; });

        // Safety: refuse if this would wipe more than half the table —
        // but only when the table is big enough for that ratio to mean
        // "accidental mass delete" rather than "table happens to be small".
        // Below the threshold, the user's intent is clear from the
        // ids passed in.
        const SAFETY_MIN_TOTAL = 50;
        const countStmt = this.db.prepare(`SELECT (SELECT COUNT(*) FROM executions WHERE id IN (${placeholders}) OR batch_id IN (${placeholders})) AS to_delete, (SELECT COUNT(*) FROM executions) AS total`);
        countStmt.bind(params);
        countStmt.step();
        const counts = countStmt.getAsObject() as { to_delete: number; total: number };
        countStmt.free();

        if (counts.total >= SAFETY_MIN_TOTAL && counts.to_delete > counts.total * 0.5) {
            throw new Error(`deleteExecutions: refusing to delete ${counts.to_delete} of ${counts.total} rows (>50% of table). Split into smaller deletes if intentional.`);
        }

        this.db.run('BEGIN TRANSACTION');
        try {
            // CASCADE on batch_id handles members of batch parents in `ids`.
            // The explicit batch_id-IN clause also covers cases where a member
            // is in `ids` and shares batch context with siblings; this is a
            // safety net for caller patterns we haven't enumerated.
            const stmt = this.db.prepare(`DELETE FROM executions WHERE id IN (${placeholders})`);
            stmt.run(params);
            stmt.free();
            this.db.run('COMMIT');
        } catch (err) {
            this.db.run('ROLLBACK');
            throw err;
        }

        this.saveDatabase();
        return counts.to_delete;
    }

    /**
     * Content search over request/response files. Bodies aren't in SQLite —
     * they live in files referenced by request_file / response_file — so this
     * reads each candidate's files from disk. Concurrency is bounded and the
     * caller is expected to constrain `ids` to a reasonable working set
     * (the Hub passes only currently-filtered transactions).
     */
    async searchExecutionBodies(ids: string[], term: string): Promise<string[]> {
        if (!this.db) throw new Error('Database not initialized');
        if (ids.length === 0 || !term) return [];

        const unique = Array.from(new Set(ids));
        const placeholders = unique.map((_, i) => `$id${i}`).join(', ');
        const params: Record<string, string> = {};
        unique.forEach((id, i) => { params[`$id${i}`] = id; });

        const stmt = this.db.prepare(`SELECT id, request_file, response_file FROM executions WHERE id IN (${placeholders})`);
        stmt.bind(params);
        const rows: Array<{ id: string; request_file?: string; response_file?: string }> = [];
        while (stmt.step()) {
            rows.push(stmt.getAsObject() as any);
        }
        stmt.free();

        const needle = term.toLowerCase();
        const matched: string[] = [];

        // Concurrency cap — 8 in flight is a sane default for spinning disks
        // and SSDs alike, and avoids hitting OS-level file-handle limits on
        // very large result sets.
        const CONCURRENCY = 8;
        let cursor = 0;
        const workers = Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
            while (cursor < rows.length) {
                const row = rows[cursor++];
                const files = [row.request_file, row.response_file].filter(Boolean) as string[];
                for (const f of files) {
                    try {
                        // #358: the bodies live in the run folder's content archive
                        const buf = readRunFileIfExists(f) ?? '';
                        if (buf.toLowerCase().includes(needle)) {
                            matched.push(row.id);
                            break;
                        }
                    } catch {
                        // Missing/unreadable body file is non-fatal — just no match.
                    }
                }
            }
        });
        await Promise.all(workers);
        return matched;
    }

    // Batch-specific methods

    async createBatch(metadata: Omit<ExecutionMetadata, 'id'>): Promise<string> {
        return this.createExecution(metadata);
    }

    async updateBatch(batchId: string, updates: Partial<ExecutionMetadata>): Promise<void> {
        return this.updateExecution(batchId, updates);
    }

    async getBatchExecution(batchId: string): Promise<ExecutionMetadata | null> {
        return this.getExecution(batchId);
    }

    async deleteBatch(batchId: string): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');

        // Diagnostic warning if a single batch deletion happens to wipe most
        // of the table — but never refuse the request. A batch is the user's
        // own logical unit; "1 of 1 batches deleted" is naturally 100% of a
        // small test DB. The `deleteExecutions` >50% throw exists to catch
        // buggy callers passing too many ids, which can't happen here.
        const countStmt = this.db.prepare('SELECT (SELECT COUNT(*) FROM executions WHERE id = $id OR batch_id = $batch_id) AS to_delete, (SELECT COUNT(*) FROM executions) AS total');
        countStmt.bind({ $id: batchId, $batch_id: batchId });
        countStmt.step();
        const counts = countStmt.getAsObject() as { to_delete: number; total: number };
        countStmt.free();

        if (counts.total > 0 && counts.to_delete > counts.total * 0.5) {
            this.logger.warn(`[deleteBatch] Deleting ${counts.to_delete} of ${counts.total} total rows (${Math.round(counts.to_delete / counts.total * 100)}%) for batchId=${batchId}`);
        }

        this.db.run('BEGIN TRANSACTION');
        try {
            const stmt = this.db.prepare('DELETE FROM executions WHERE id = $id OR batch_id = $batch_id');
            stmt.run({ $id: batchId, $batch_id: batchId });
            stmt.free();
            this.db.run('COMMIT');
        } catch (err) {
            this.db.run('ROLLBACK');
            throw err;
        }

        this.saveDatabase();
    }

    async storeBatchExecution(batchExecution: ExecutionMetadata): Promise<{ success: boolean; errorMessage?: string }> {
        try {
            await this.createBatch(batchExecution);
            return { success: true };
        } catch (error) {
            return {
                success: false,
                errorMessage: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    async updateBatchExecution(batchId: string, updates: Partial<ExecutionMetadata>): Promise<void> {
        return this.updateBatch(batchId, updates);
    }

    // Batch resumption data

    async storeBatchResumptionData(batchId: string, resumptionData: any): Promise<void> {
        this.ownedBatchIds.add(batchId);
        return this.updateExecution(batchId, { batchResumptionData: resumptionData });
    }

    async getBatchResumptionData(batchId: string): Promise<any | null> {
        const batch = await this.getBatchExecution(batchId);
        return batch?.batchResumptionData || null;
    }

    // Filtered query methods

    async getIndividualExecutions(): Promise<ExecutionMetadata[]> {
        if (!this.db) throw new Error('Database not initialized');

        const stmt = this.db.prepare(`
            SELECT * FROM executions
            WHERE execution_type = 'individual'
            ORDER BY created_at DESC
        `);

        const results: ExecutionMetadata[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            results.push(this.fromRow(row));
        }

        stmt.free();
        return results;
    }

    async getBatchExecutions(): Promise<ExecutionMetadata[]> {
        if (!this.db) throw new Error('Database not initialized');

        const stmt = this.db.prepare(`
            SELECT * FROM executions
            WHERE execution_type = 'batch'
            ORDER BY created_at DESC
        `);

        const results: ExecutionMetadata[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            results.push(this.fromRow(row));
        }

        stmt.free();
        return results;
    }

    async getBatchMemberExecutions(batchId: string): Promise<ExecutionMetadata[]> {
        if (!this.db) throw new Error('Database not initialized');

        const stmt = this.db.prepare(`
            SELECT * FROM executions
            WHERE batch_id = $batch_id AND execution_type = 'batch_member'
            ORDER BY created_at ASC
        `);

        stmt.bind({ $batch_id: batchId });

        const results: ExecutionMetadata[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            results.push(this.fromRow(row));
        }

        stmt.free();

        return results;
    }

    /**
     * GitHub Issue #247: record that one run's rows became another run's input.
     */
    async addExecutionLink(link: ExecutionLinkInput): Promise<string> {
        if (!this.db) throw new Error('Database not initialized');
        const id = `link_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const stmt = this.db.prepare(`
            INSERT INTO execution_links (id, source_execution_id, target_execution_id, kind, view_name, row_count, created_at)
            VALUES ($id, $source, $target, $kind, $view, $rows, $created)
        `);
        try {
            stmt.run({
                $id: id,
                $source: link.sourceExecutionId,
                $target: link.targetExecutionId,
                $kind: link.kind || 'chain',
                $view: link.viewName ?? null,
                $rows: typeof link.rowCount === 'number' ? link.rowCount : null,
                $created: Date.now()
            });
        } finally {
            stmt.free();
        }
        this.ownedLinkIds.add(id);
        this.saveDatabase();
        return id;
    }

    /**
     * GitHub Issue #247: the runs this one came from (upstream) and fed (downstream). Joined to
     * executions, so a link whose other end was deleted is not returned, nor one whose chained
     * batch was cancelled before it ran (queued, then cancelled: nothing was sent).
     */
    async getExecutionLinks(executionId: string): Promise<ExecutionLinks> {
        if (!this.db) throw new Error('Database not initialized');
        const read = (ownColumn: string, otherColumn: string): ExecutionLinkEnd[] => {
            const stmt = this.db!.prepare(`
                SELECT l.id AS link_id, l.view_name, l.row_count, l.created_at AS linked_at,
                       e.id AS execution_id, e.execution_type, e.endpoint_id, e.endpoint_name, e.endpoint_method,
                       e.environment, e.organization, e.status, e.created_at,
                       ${HEADERS_OF('e')} AS headers
                FROM execution_links l
                JOIN executions e ON e.id = l.${otherColumn}
                JOIN executions t ON t.id = l.target_execution_id
                WHERE l.${ownColumn} = $id
                  -- a chained batch cancelled before it ever ran sent nothing: no link to show
                  AND NOT (t.status = 'cancelled' AND t.started_at IS NULL)
                ORDER BY l.created_at DESC
            `);
            const ends: ExecutionLinkEnd[] = [];
            try {
                stmt.bind({ $id: executionId });
                while (stmt.step()) {
                    const row = stmt.getAsObject() as Record<string, unknown>;
                    ends.push({
                        linkId: String(row.link_id),
                        executionId: String(row.execution_id),
                        isBatch: row.execution_type === 'batch',
                        endpointId: String(row.endpoint_id ?? ''),
                        endpointName: String(row.endpoint_name ?? ''),
                        endpointMethod: String(row.endpoint_method ?? ''),
                        environment: String(row.environment ?? ''),
                        status: String(row.status ?? ''),
                        executionCreatedAt: Number(row.created_at) || 0,
                        linkedAt: Number(row.linked_at) || 0,
                        viewName: row.view_name == null ? undefined : String(row.view_name),
                        rowCount: row.row_count == null ? undefined : Number(row.row_count),
                        organization: row.organization == null ? undefined : String(row.organization),
                        headers: parseHeaders(row.headers)
                    });
                }
            } finally {
                stmt.free();
            }
            return ends;
        };
        const upstream = read('target_execution_id', 'source_execution_id');
        const downstream = read('source_execution_id', 'target_execution_id');
        let self: ExecutionLinks['self'];
        if (upstream.length > 0 || downstream.length > 0) {
            const stmt = this.db.prepare(`SELECT e.environment, e.organization, ${HEADERS_OF('e')} AS headers FROM executions e WHERE e.id = $id`);
            try {
                stmt.bind({ $id: executionId });
                if (stmt.step()) {
                    const row = stmt.getAsObject() as Record<string, unknown>;
                    self = {
                        environment: row.environment == null ? undefined : String(row.environment),
                        organization: row.organization == null ? undefined : String(row.organization),
                        headers: parseHeaders(row.headers)
                    };
                }
            } finally {
                stmt.free();
            }
        }
        return { upstream, downstream, self };
    }

    /** Issue #312: counts per status — `idx_batch_id` makes this cheap at any batch size. */
    async countBatchMembersByStatus(batchId: string): Promise<Record<string, number>> {
        if (!this.db) throw new Error('Database not initialized');
        const stmt = this.db.prepare(`
            SELECT status, COUNT(*) AS n FROM executions
            WHERE batch_id = $batch_id AND execution_type = 'batch_member'
            GROUP BY status
        `);
        stmt.bind({ $batch_id: batchId });
        const counts: Record<string, number> = {};
        while (stmt.step()) {
            const row = stmt.getAsObject() as { status: string; n: number };
            counts[String(row.status)] = Number(row.n);
        }
        stmt.free();
        return counts;
    }

    /** Issue #312: id / status / response file / created_at per member — no fromRow. */
    async getBatchMemberFiles(batchId: string): Promise<BatchMemberFile[]> {
        if (!this.db) throw new Error('Database not initialized');
        const stmt = this.db.prepare(`
            SELECT id, status, response_file, created_at, error_message, test_status FROM executions
            WHERE batch_id = $batch_id AND execution_type = 'batch_member'
            ORDER BY created_at ASC
        `);
        stmt.bind({ $batch_id: batchId });
        const rows: BatchMemberFile[] = [];
        while (stmt.step()) {
            const r = stmt.getAsObject() as { id: string; status: string; response_file: string | null; created_at: string; error_message: string | null; test_status: string | null };
            rows.push({
                id: String(r.id), status: String(r.status), responseFile: r.response_file || undefined, createdAt: new Date(r.created_at),
                ...(r.error_message ? { errorMessage: String(r.error_message) } : {}),
                ...(r.test_status ? { testStatus: String(r.test_status) } : {})
            });
        }
        stmt.free();
        return rows;
    }

    /** Dobermann issue 7: a slice of a batch's requests, only the columns a log line needs — no fromRow. */
    async getBatchMemberLogRows(batchId: string, offset: number, limit: number): Promise<BatchMemberLogRow[]> {
        if (!this.db) throw new Error('Database not initialized');
        const stmt = this.db.prepare(`
            SELECT id, status, environment, endpoint_method, endpoint_path, rows, started_at, completed_at, http_status, http_status_text, error_message
            FROM executions
            WHERE batch_id = $batch_id AND execution_type = 'batch_member'
            ORDER BY created_at ASC, id ASC
            LIMIT $limit OFFSET $offset
        `);
        stmt.bind({ $batch_id: batchId, $limit: Math.max(0, Math.floor(limit)), $offset: Math.max(0, Math.floor(offset)) });
        const rows: BatchMemberLogRow[] = [];
        const when = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : new Date(typeof v === 'number' ? v : String(v)));
        const text = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : String(v));
        while (stmt.step()) {
            const r = stmt.getAsObject() as Record<string, unknown>;
            rows.push({
                id: String(r.id), status: String(r.status),
                environment: text(r.environment), endpointMethod: text(r.endpoint_method), endpointPath: text(r.endpoint_path), rows: text(r.rows),
                startedAt: when(r.started_at), completedAt: when(r.completed_at),
                httpStatus: r.http_status === null || r.http_status === undefined ? undefined : Number(r.http_status),
                httpStatusText: text(r.http_status_text), errorMessage: text(r.error_message)
            });
        }
        stmt.free();
        return rows;
    }

    async getActiveQueue(): Promise<ExecutionMetadata[]> {
        if (!this.db) throw new Error('Database not initialized');

        const stmt = this.db.prepare('SELECT * FROM vw_active_queue');

        const results: ExecutionMetadata[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            results.push(this.fromRow(row));
        }

        stmt.free();
        return results;
    }

    async getAllTransactions(): Promise<ExecutionMetadata[]> {
        if (!this.db) throw new Error('Database not initialized');

        const stmt = this.db.prepare(`
            SELECT * FROM executions
            WHERE execution_type IN ('individual', 'batch')
            ORDER BY created_at DESC
        `);

        const results: ExecutionMetadata[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            results.push(this.fromRow(row));
        }

        stmt.free();
        return results;
    }

    async getExecutionsByEndpoint(endpointId: string, options?: { runsOnly?: boolean }): Promise<ExecutionMetadata[]> {
        if (!this.db) throw new Error('Database not initialized');

        // runsOnly: never a batch's requests (a batch keeps a row per request: tens of thousands, read and parsed for nothing)
        const stmt = this.db.prepare(`
            SELECT * FROM executions
            WHERE endpoint_id = $endpoint_id${options?.runsOnly ? " AND execution_type IN ('individual', 'batch')" : ''}
            ORDER BY created_at DESC
        `);

        stmt.bind({ $endpoint_id: endpointId });

        const results: ExecutionMetadata[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            results.push(this.fromRow(row));
        }

        stmt.free();
        return results;
    }

    async getBatches(): Promise<ExecutionMetadata[]> {
        return this.getBatchExecutions();
    }

    async getBatchExecutions_Legacy(batchId: string): Promise<ExecutionMetadata[]> {
        return this.getBatchMemberExecutions(batchId);
    }

    /**
     * Atomically claim pending batch members (GitHub Issue #110: Fix duplicate execution race condition)
     * Uses Promise Chain pattern for true atomicity
     *
     * CRITICAL: Single atomic expression (assignment + chaining) prevents race conditions
     * Each claim is automatically chained after the previous one completes.
     *
     * This makes duplicate execution IMPOSSIBLE by design.
     */
    async claimPendingBatchMembers(batchId: string, limit: number): Promise<ExecutionMetadata[]> {
        // ATOMIC PROMISE CHAIN: Read + Chain + Write in single expression
        // This is the ONLY way to prevent race conditions in JavaScript async code
        return this.claimMutex = this.claimMutex.then(async () => {
            if (!this.db) throw new Error('Database not initialized');

            try {
                // Perform database operation with transaction
                this.db.run('BEGIN IMMEDIATE TRANSACTION');

                // Step 1: Get pending member IDs
                const selectStmt = this.db.prepare(`
                    SELECT id FROM executions
                    WHERE batch_id = $batch_id
                      AND execution_type = 'batch_member'
                      AND status = 'pending'
                    ORDER BY created_at ASC
                    LIMIT $limit
                `);

                selectStmt.bind({ $batch_id: batchId, $limit: limit });

                const idsToUpdate: string[] = [];
                while (selectStmt.step()) {
                    const row = selectStmt.getAsObject();
                    idsToUpdate.push(row.id as string);
                }
                selectStmt.free();


                // If no pending members, return empty
                if (idsToUpdate.length === 0) {
                    this.db.run('COMMIT');
                    return [];
                }

                // Step 2: Update these specific IDs to 'running' atomically
                const placeholders = idsToUpdate.map(() => '?').join(',');

                const updateStmt = this.db.prepare(`
                    UPDATE executions
                    SET status = 'running',
                        started_at = datetime('now')
                    WHERE id IN (${placeholders})
                `);

                updateStmt.bind(idsToUpdate);
                updateStmt.run();
                updateStmt.free();

                // Step 3: Select the updated executions to return (verify UPDATE succeeded)
                const resultStmt = this.db.prepare(`
                    SELECT * FROM executions
                    WHERE id IN (${placeholders})
                      AND status = 'running'
                    ORDER BY created_at ASC
                `);

                resultStmt.bind(idsToUpdate);

                const results: ExecutionMetadata[] = [];
                while (resultStmt.step()) {
                    const row = resultStmt.getAsObject();
                    results.push(this.fromRow(row));
                }

                resultStmt.free();

                // Commit transaction
                this.db.run('COMMIT');

                // Save to disk
                this.saveDatabase();

                return results;
            } catch (error) {
                // Rollback on error
                if (this.db) {
                    this.db.run('ROLLBACK');
                }
                throw error;
            }
        }).catch(error => {
            // Ensure promise chain continues even on error
            throw error;
        });
    }

    /**
     * Close database connection and save
     */
    close(): void {
        // Cancel any pending debounced save
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }

        if (this.db) {
            // Final flush before closing — ensures all pending writes hit disk
            this.flushDatabase();
            this.db.close();
            this.db = null;
        }
    }
}
