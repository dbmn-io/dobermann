// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Dobermann issue 7: the web app's (and the desktop app's window's) one log, the core AppLog.
 * Lines are kept in this browser's storage for the signed-in user, a file per day (the `fs` shim
 * writes to IndexedDB, appending), from the moment `startAppLog` is called; lines written before
 * that wait for it.
 *
 * Warnings and errors also go to the browser's console, where a developer looks first.
 */
import { AppLog, type LogLine } from '../../../src/services/logging/app-log';
import { AppLogDayFiles } from '../../../src/services/logging/app-log-file';
import { promises as fsp } from './node/fs';

/** Outside the workspace root (/dbmn, or a picked folder): this browser's own, never a user's folder. */
const LOG_FOLDER = '/dbmn-app/logs';

function toConsole(line: LogLine): void {
    if (line.level !== 'warn' && line.level !== 'error') return;
    const text = `[${line.source}] ${line.message}${line.detail ? `\n${line.detail}` : ''}`;
    // eslint-disable-next-line no-console -- the browser's console is a developer's first look
    if (line.level === 'error') console.error(text); else console.warn(text);
}

export const appLog = new AppLog({ mirror: toConsole });

/** Once the browser's files are mounted for this user: keep the lines from now on, a file per day. */
export function startAppLog(): Promise<void> {
    return appLog.start(new AppLogDayFiles(LOG_FOLDER, fsp as unknown as ConstructorParameters<typeof AppLogDayFiles>[1]));
}
