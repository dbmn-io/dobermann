// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Dobermann issue 7: where the app's log is kept, one JSON line per log line, in a file of the
 * host's choosing. The same code serves every app: VS Code and the desktop app's background
 * process give a real file (VS Code's global storage, per computer); the web app's `fs` keeps
 * its files in the browser's IndexedDB (web/src/shell/node/fs.ts), appending without rewriting.
 *
 * A line that will not read (a half-written last line after a crash) is skipped.
 */
import { promises as fsp } from 'fs';
import * as path from 'path';
import type { AppLogPersistence, LogLine } from './app-log';

/** The part of `fs.promises` this needs: a test or a host can give its own. */
export interface AppLogFileSystem {
    readFile(file: string, encoding: 'utf8'): Promise<string>;
    appendFile(file: string, data: string): Promise<void>;
    writeFile(file: string, data: string): Promise<void>;
    mkdir(dir: string, options: { recursive: true }): Promise<unknown>;
}

export class AppLogFile implements AppLogPersistence {
    private ready: Promise<unknown> | undefined;

    constructor(private readonly file: string, private readonly fs: AppLogFileSystem = fsp as unknown as AppLogFileSystem) {}

    async load(): Promise<LogLine[]> {
        let text: string;
        try {
            text = await this.fs.readFile(this.file, 'utf8');
        } catch {
            return [];
        }
        const lines: LogLine[] = [];
        for (const raw of text.split('\n')) {
            if (!raw.trim()) continue;
            try {
                lines.push(JSON.parse(raw) as LogLine);
            } catch {
                // a line cut short when the app stopped: skipped
            }
        }
        return lines;
    }

    async append(lines: LogLine[]): Promise<void> {
        if (lines.length === 0) return;
        await this.folder();
        await this.fs.appendFile(this.file, toJsonLines(lines));
    }

    async replace(lines: LogLine[]): Promise<void> {
        await this.folder();
        await this.fs.writeFile(this.file, toJsonLines(lines));
    }

    private folder(): Promise<unknown> {
        this.ready ??= this.fs.mkdir(path.dirname(this.file), { recursive: true }).catch(() => undefined);
        return this.ready;
    }
}

function toJsonLines(lines: LogLine[]): string {
    return lines.map(l => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '');
}
