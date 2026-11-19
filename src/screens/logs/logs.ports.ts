// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * What the Logs screen (Dobermann issue 7) needs from its host. Every app gives it the same
 * pieces: the app's log, read back from its day files, and the run history (LogReader); only saving a file
 * differs (VS Code asks where, a browser downloads).
 */
import type { LogCursor, LogPage } from '../../services/logging/log-reader';
import type { LogEvent } from '../../services/logging/execution-logging.interface';

export interface LogsPorts {
    /** Every line kept, newest first, a page at a time (LogReader). */
    reader: {
        page(query: { search?: string; before?: LogCursor; want?: number; budget?: number; stop?: () => boolean }): Promise<LogPage>;
        /** What it remembers of finished batches, dropped (Refresh reads them again). */
        forget?(): void;
    };
    /** A request's own run log (ExecutionLoggingService), to open it from its line. */
    requests?: {
        events(executionId: string): Promise<LogEvent[]>;
    };
    /** Secret removal, as the app log's (AppLog.redactor). */
    redact(text: string): string;
    files: {
        /** Save text under a suggested name. False when the user changed their mind. */
        save(name: string, text: string): Promise<boolean>;
    };
    toast: {
        info(message: string): void;
        warn(message: string): void;
        error(message: string): void;
    };
    /** Ms since 1970: tests set the clock. */
    now?(): number;
}
