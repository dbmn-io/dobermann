// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * DBMN Telemetry Service (GitHub Issue #208)
 *
 * In-memory buffer aggregated per day. Every record is mirrored to
 * globalState (dbmnStorageKeys().telemetryPending) so nothing is lost when the window
 * reloads or the extension host dies; the pending entries are restored and flushed on
 * the next activation. A flush is scheduled a few seconds after any record — a run is
 * a rare event and one RPC is cheap — and a 5-minute timer backs that up.
 *
 * Privacy-safe: only aggregate counters, never request/response content. TELEMETRY.md says
 * exactly what goes (telemetry-payload.ts builds it). 0.4.0: no environment address and no
 * per-endpoint method or path (James, 2026-11-15). #419: the switch is `dbmn.telemetry.enabled`
 * (default on; signed out nothing is sent anyway), and VS Code's own telemetry setting turns it
 * off too. Off, nothing is recorded, nothing is sent and nothing is kept waiting.
 *
 * EVERY HOST (0.4.1). No `vscode` import: the host hands in where unsent counts wait, the
 * switch and what the rows say about the client (vscode-telemetry-options.ts for VS Code,
 * web/src/shell/telemetry.ts for the web and desktop apps), so a run counts wherever it ran.
 *
 * Following Architecture.md: service interface + DI pattern.
 */

import { DbmnBatchProgressDelta, DbmnTelemetryEntry, DbmnTelemetryStats } from '../../types/dbmn-auth';
import { IDbmnTelemetry } from './dbmn-auth.interface';
import { IDbmnAuthService } from './dbmn-auth.interface';
import { dbmnStorageKeys, getBackend, reportedExtensionVersion } from '../dbmn-backend/backend-config';
import { telemetryEventsPayload, TelemetryClientInfo } from './telemetry-payload';
import type { IKeyValueStore } from '../../platform/interfaces/key-value-store.interface';

/** Where unsent counts wait between sessions: VS Code's globalState, or the browser's storage. */
export interface TelemetryHostContext {
    globalState: Pick<IKeyValueStore, 'get' | 'update'>;
}

export interface TelemetryOptions {
    /** #419: the switch. Without one, telemetry is on (signed out nothing is sent anyway). */
    enabled?: () => boolean;
    /** What each row says about the client: the app's version, the host, the platform. */
    client?: () => TelemetryClientInfo;
}

/** The only part of the sign-in telemetry needs: a token that is still good. */
export type TelemetrySessionSource = Pick<IDbmnAuthService, 'ensureValidSession'>;

/** Backstop flush interval: 5 minutes */
export const FLUSH_INTERVAL_MS = 5 * 60 * 1000;

/** A flush follows any record after this quiet period, so a run shows up in Weekly Usage promptly. */
export const FLUSH_DEBOUNCE_MS = 3 * 1000;

export class DbmnTelemetryService implements IDbmnTelemetry {
    /** Buffered entries keyed by date */
    private buffer: Map<string, DbmnTelemetryEntry> = new Map();
    private flushTimer: ReturnType<typeof setInterval> | null = null;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private authService: TelemetrySessionSource | null = null;
    /** Sent to the server, but not yet reflected in the stats the Account view last fetched. */
    private flushedSinceSync: Map<string, DbmnTelemetryEntry> = new Map();
    private listeners: Set<() => void> = new Set();

    constructor(
        private context: TelemetryHostContext,
        private readonly options: TelemetryOptions = {}
    ) {
        // 0.4.0: per-endpoint usage is no longer kept; drop whatever an older version left waiting
        Promise.resolve(this.context.globalState.update(dbmnStorageKeys().telemetryEndpointPending, undefined))
            .catch(err => console.warn('[DbmnTelemetry] Could not clear old endpoint usage:', err));
        if (this.isEnabled()) this.restorePending();
        else this.dropPending();
        this.startFlushTimer();
    }

    /** #419: whether anything is recorded or sent (the host's switch; VS Code's includes its own setting). */
    isEnabled(): boolean {
        try {
            return this.options.enabled ? this.options.enabled() : true;
        } catch {
            return true;
        }
    }

    /** #419: switched off: whatever was waiting is dropped, here and in storage. */
    private dropPending(): void {
        this.buffer.clear();
        this.persistPending();
    }

    /**
     * Set the auth service reference (avoids circular DI dependency).
     * Anything restored from a previous session can now be sent.
     */
    setAuthService(authService: TelemetrySessionSource): void {
        this.authService = authService;
        if (this.buffer.size > 0) {
            this.scheduleFlush();
        }
    }

    recordApiCall(): void {
        if (!this.isEnabled()) return;
        const entry = this.getOrCreateEntry();
        entry.apiCalls++;
        this.recorded();
    }

    recordBatchRun(recordCount: number, successCount: number, failureCount: number): void {
        if (!this.isEnabled()) return;
        this.recordBatchProgress({ batchRuns: 1, rows: recordCount, successes: successCount, failures: failureCount });
    }

    recordBatchProgress(delta: DbmnBatchProgressDelta): void {
        if (!this.isEnabled()) return;
        const entry = this.getOrCreateEntry();
        entry.batchRuns += delta.batchRuns || 0;
        entry.batchRecords += delta.rows || 0;
        entry.batchSuccesses += delta.successes || 0;
        entry.batchFailures += delta.failures || 0;
        entry.executionTimeMs += Math.round(delta.durationMs || 0);
        this.recorded();
    }

    recordExport(recordCount: number): void {
        if (!this.isEnabled()) return;
        const entry = this.getOrCreateEntry();
        entry.exportRecords += recordCount;
        this.recorded();
    }

    recordImport(recordCount: number): void {
        if (!this.isEnabled()) return;
        const entry = this.getOrCreateEntry();
        entry.importRecords += recordCount;
        this.recorded();
    }

    recordExecutionTime(durationMs: number): void {
        if (!this.isEnabled()) return;
        const entry = this.getOrCreateEntry();
        entry.executionTimeMs += Math.round(durationMs);
        this.recorded();
    }

    recordFeatureUsage(featureFlag: string): void {
        if (!this.isEnabled()) return;
        const entry = this.getOrCreateEntry();
        entry.featuresUsed[featureFlag] = true;
        this.recorded();
    }

    async flush(): Promise<void> {
        if (!this.isEnabled()) {
            this.dropPending();
            return;
        }
        if (this.buffer.size === 0) {
            return;
        }

        if (!this.authService) {
            console.log('[DbmnTelemetry] No auth service — skipping flush');
            return;
        }

        // Resolve a valid access token via the auth service so we don't fire
        // expired JWTs at Supabase every 5 minutes. ensureValidSession() refreshes
        // when needed and short-circuits cleanly when the refresh chain is broken.
        const sessionResult = await this.authService.ensureValidSession();
        if (sessionResult.status !== 'success' || !sessionResult.session) {
            // network_error: leave buffer intact, try again next interval.
            // auth_error: same — the auth service's latch + cooldown will retry
            // refresh on its own schedule; spamming Supabase 401s here serves nothing.
            if (sessionResult.status === 'auth_error') {
                console.log('[DbmnTelemetry] Skipping flush — auth refresh failed (will retry after auth cooldown)');
            } else {
                console.log(`[DbmnTelemetry] Skipping flush — ${sessionResult.status}`);
            }
            return;
        }
        const session = sessionResult.session;

        // Collect entries to flush. The persisted copy is emptied now rather than after
        // the request: a reload during the request then loses one flush instead of
        // sending it twice.
        const entries = Array.from(this.buffer.values());
        this.buffer.clear();
        this.persistPending();

        // What the rows say about the client. A dev build tags its version ("1.2.3-dev") so
        // development noise can be filtered out of production stats (backend-config.ts).
        const client = this.options.client?.() ?? {
            extensionVersion: reportedExtensionVersion('unknown'),
            vscodeVersion: 'unknown',
            osPlatform: typeof process !== 'undefined' && process.platform ? process.platform : 'unknown'
        };

        // The rows, exactly as TELEMETRY.md lists them (no user_id: the RPC uses auth.uid())
        const payload = telemetryEventsPayload(entries, client);

        try {
            const response = await fetch(`${getBackend().apiUrl}/rest/v1/rpc/upsert_telemetry_events`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${session.accessToken}`,
                    'apikey': getBackend().anonKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ p_events: payload })
            });

            if (!response.ok) {
                console.error(`[DbmnTelemetry] Flush failed: ${response.status}`);
                this.rebuffer(entries);
            } else {
                console.log(`[DbmnTelemetry] Flushed ${entries.length} entries`);
                for (const entry of entries) {
                    this.mergeInto(this.flushedSinceSync, entry);
                }
                this.notify();
            }
        } catch (error) {
            console.error('[DbmnTelemetry] Flush error:', error);
            this.rebuffer(entries);
        }
    }

    getUnsyncedStats(): { weekly: DbmnTelemetryStats; alltime: DbmnTelemetryStats } {
        const weekStart = this.getWeekStartISODate();
        const zero = (): DbmnTelemetryStats => ({ apiCalls: 0, batchRuns: 0, rowsProcessed: 0, totalExecutionTimeMs: 0 });
        const weekly = zero();
        const alltime = zero();
        const add = (target: DbmnTelemetryStats, entry: DbmnTelemetryEntry): void => {
            target.apiCalls += entry.apiCalls;
            target.batchRuns += entry.batchRuns;
            target.rowsProcessed += entry.batchRecords;
            target.totalExecutionTimeMs += entry.executionTimeMs;
        };
        for (const entry of [...this.buffer.values(), ...this.flushedSinceSync.values()]) {
            add(alltime, entry);
            if (entry.eventDate >= weekStart) {
                add(weekly, entry);
            }
        }
        return { weekly, alltime };
    }

    markStatsSynced(): void {
        this.flushedSinceSync.clear();
    }

    onDidChange(listener: () => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }

    dispose(): void {
        this.listeners.clear();
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        // Final flush (best-effort, don't await in dispose). Whatever it does not manage
        // to send is still in globalState and goes on the next activation.
        this.flush().catch(() => {});
    }

    // =========================================================================
    // Private Methods
    // =========================================================================

    private getOrCreateEntry(): DbmnTelemetryEntry {
        const today = this.getTodayISODate();

        let entry = this.buffer.get(today);
        if (!entry) {
            entry = {
                eventDate: today,
                apiCalls: 0,
                batchRuns: 0,
                batchRecords: 0,
                batchSuccesses: 0,
                batchFailures: 0,
                exportRecords: 0,
                importRecords: 0,
                executionTimeMs: 0,
                featuresUsed: {}
            };
            this.buffer.set(today, entry);
        }

        return entry;
    }

    /** After every record: mirror to storage, tell the view, and send soon. */
    private recorded(): void {
        this.persistPending();
        this.notify();
        this.scheduleFlush();
    }

    private notify(): void {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch (err) {
                console.warn('[DbmnTelemetry] Change listener threw:', err);
            }
        }
    }

    /** Put entries back after a failed flush (they are persisted again too). */
    private rebuffer(entries: DbmnTelemetryEntry[]): void {
        for (const entry of entries) {
            this.mergeEntry(entry);
        }
        this.persistPending();
    }

    /**
     * Merge an entry back into the buffer (used when flush fails, and on restore).
     */
    private mergeEntry(entry: DbmnTelemetryEntry): void {
        this.mergeInto(this.buffer, entry);
    }

    private mergeInto(target: Map<string, DbmnTelemetryEntry>, entry: DbmnTelemetryEntry): void {
        const key = entry.eventDate;
        const existing = target.get(key);

        if (existing) {
            existing.apiCalls += entry.apiCalls;
            existing.batchRuns += entry.batchRuns;
            existing.batchRecords += entry.batchRecords;
            existing.batchSuccesses += entry.batchSuccesses;
            existing.batchFailures += entry.batchFailures;
            existing.exportRecords += entry.exportRecords;
            existing.importRecords += entry.importRecords;
            existing.executionTimeMs += entry.executionTimeMs;
            Object.assign(existing.featuresUsed, entry.featuresUsed);
        } else {
            target.set(key, {
                eventDate: entry.eventDate, apiCalls: entry.apiCalls, batchRuns: entry.batchRuns, batchRecords: entry.batchRecords,
                batchSuccesses: entry.batchSuccesses, batchFailures: entry.batchFailures, exportRecords: entry.exportRecords,
                importRecords: entry.importRecords, executionTimeMs: entry.executionTimeMs, featuresUsed: { ...entry.featuresUsed }
            });
        }
    }

    /**
     * Entries left unsent by a previous session (reload, crash, stack down). An older version's
     * were kept per environment: they merge into their day, and the address is not carried over.
     */
    private restorePending(): void {
        const pending = this.context.globalState.get<DbmnTelemetryEntry[]>(dbmnStorageKeys().telemetryPending);
        if (!Array.isArray(pending)) {
            return;
        }
        for (const entry of pending) {
            if (entry && typeof entry.eventDate === 'string') {
                this.mergeEntry({ ...entry, featuresUsed: { ...(entry.featuresUsed || {}) } });
            }
        }
        if (this.buffer.size > 0) {
            console.log(`[DbmnTelemetry] Restored ${this.buffer.size} unsent entries from a previous session`);
        }
    }

    private persistPending(): void {
        const entries = this.buffer.size > 0 ? Array.from(this.buffer.values()) : undefined;
        Promise.resolve(this.context.globalState.update(dbmnStorageKeys().telemetryPending, entries))
            .catch(err => console.warn('[DbmnTelemetry] Could not persist pending entries:', err));
    }

    private scheduleFlush(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.flush().catch(err => {
                console.error('[DbmnTelemetry] Debounced flush error:', err);
            });
        }, FLUSH_DEBOUNCE_MS);
    }

    private startFlushTimer(): void {
        this.flushTimer = setInterval(() => {
            this.flush().catch(err => {
                console.error('[DbmnTelemetry] Scheduled flush error:', err);
            });
        }, FLUSH_INTERVAL_MS);
    }

    private getTodayISODate(): string {
        const now = new Date();
        return now.toISOString().split('T')[0];
    }

    /** Monday of the current UTC week — the same week the server's get_telemetry_stats uses. */
    private getWeekStartISODate(): string {
        const now = new Date();
        const day = now.getUTCDay();
        const monday = new Date(now);
        monday.setUTCDate(now.getUTCDate() - (day === 0 ? 6 : day - 1));
        return monday.toISOString().split('T')[0];
    }
}
