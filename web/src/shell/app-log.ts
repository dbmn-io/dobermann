// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Dobermann issue 7: the web app's (and the desktop app's window's) one log, the core AppLog.
 * Lines are kept in this browser's storage for the signed-in user (the `fs` shim writes to
 * IndexedDB, appending), from the moment `startAppLog` is called; lines written before that wait
 * and are kept after the ones from before.
 *
 * Warnings and errors also go to the browser's console, where a developer looks first.
 */
import { AppLog, type LogLine } from '../../../src/services/logging/app-log';
import { AppLogFile } from '../../../src/services/logging/app-log-file';
import { promises as fsp } from './node/fs';

/** Outside the workspace root (/dbmn, or a picked folder): this browser's own, never a user's folder. */
const LOG_FILE = '/dbmn-app/logs/app-log.jsonl';

function toConsole(line: LogLine): void {
    if (line.level !== 'warn' && line.level !== 'error') return;
    const text = `[${line.source}] ${line.message}${line.detail ? `\n${line.detail}` : ''}`;
    // eslint-disable-next-line no-console -- the browser's console is a developer's first look
    if (line.level === 'error') console.error(text); else console.warn(text);
}

export const appLog = new AppLog({ mirror: toConsole });

/** Once the browser's files are mounted for this user: read the lines from before and keep new ones. */
export function startAppLog(): Promise<void> {
    return appLog.start(new AppLogFile(LOG_FILE, fsp as unknown as ConstructorParameters<typeof AppLogFile>[1]));
}
