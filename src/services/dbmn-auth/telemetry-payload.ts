// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #419: exactly what DBMN's usage telemetry sends, in one place, so TELEMETRY.md can be
 * checked against it (telemetry-document.test.ts fails when the two drift). One RPC,
 * `upsert_telemetry_events`: one row per day of counts and run time.
 *
 * 0.4.0: no environment address and no per-endpoint method or path any more. Never a
 * request or response body, a header, a variable value or an id from the data. The user is
 * the signed-in account (the RPC uses auth.uid()); signed out, nothing is sent.
 */
import type { DbmnTelemetryEntry } from '../../types/dbmn-auth';

export interface TelemetryClientInfo {
    /** The extension's version; a dev build says `<version>-dev`. */
    extensionVersion: string;
    vscodeVersion: string;
    osPlatform: string;
}

/** The `p_events` rows of `upsert_telemetry_events`. */
export function telemetryEventsPayload(entries: DbmnTelemetryEntry[], client: TelemetryClientInfo): Array<Record<string, unknown>> {
    return entries.map(entry => ({
        event_date: entry.eventDate,
        api_calls: entry.apiCalls,
        batch_runs: entry.batchRuns,
        batch_records: entry.batchRecords,
        batch_successes: entry.batchSuccesses,
        batch_failures: entry.batchFailures,
        export_records: entry.exportRecords,
        import_records: entry.importRecords,
        execution_time_ms: entry.executionTimeMs,
        features_used: entry.featuresUsed,
        extension_version: client.extensionVersion,
        vscode_version: client.vscodeVersion,
        os_platform: client.osPlatform
    }));
}
