// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Dobermann issue 7: where the app's log is kept, a file per day (app-log-2026-11-19.jsonl), one
 * JSON line per log line, in a folder of the host's choosing. A file is only ever appended to;
 * whole days are deleted when the log keeps to its age and size (AppLog.prune). The same code
 * serves every app: VS Code and the desktop app's background process give a real folder (VS Code's global storage, per computer); the web app's `fs` keeps
 * its files in the browser's IndexedDB (web/src/shell/node/fs.ts), appending without rewriting.
 *
 * A line that will not read (a half-written last line after a crash) is skipped.
 */
import { promises as fsp } from 'fs';
import * as path from 'path';
import { isLogLine, localDay, type AppLogPersistence, type LogLine } from './app-log';

/** The part of `fs.promises` this needs: a test or a host can give its own. */
export interface AppLogFileSystem {
    readFile(file: string, encoding: 'utf8'): Promise<string>;
    appendFile(file: string, data: string): Promise<void>;
    mkdir(dir: string, options: { recursive: true }): Promise<unknown>;
    readdir(dir: string): Promise<string[]>;
    stat(file: string): Promise<{ size: number }>;
    unlink(file: string): Promise<void>;
}

const DAY_FILE = /^app-log-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export class AppLogDayFiles implements AppLogPersistence {
    private ready: Promise<unknown> | undefined;

    constructor(private readonly folder: string, private readonly fs: AppLogFileSystem = fsp as unknown as AppLogFileSystem) {}

    async append(lines: LogLine[]): Promise<void> {
        if (lines.length === 0) return;
        await this.made();
        // Each line in its own day's file: a save just after midnight can hold both days
        const byDay = new Map<string, LogLine[]>();
        for (const line of lines) {
            const day = localDay(line.time);
            const list = byDay.get(day);
            if (list) list.push(line);
            else byDay.set(day, [line]);
        }
        for (const [day, list] of byDay) {
            await this.fs.appendFile(this.file(day), list.map(l => JSON.stringify(l)).join('\n') + '\n');
        }
    }

    async days(): Promise<string[]> {
        let names: string[];
        try {
            names = await this.fs.readdir(this.folder);
        } catch {
            return [];
        }
        return names.map(n => DAY_FILE.exec(n)?.[1]).filter((d): d is string => !!d).sort().reverse();
    }

    async read(day: string): Promise<LogLine[]> {
        let text: string;
        try {
            text = await this.fs.readFile(this.file(day), 'utf8');
        } catch {
            return [];
        }
        const lines: LogLine[] = [];
        for (const raw of text.split('\n')) {
            if (!raw.trim()) continue;
            try {
                const line = JSON.parse(raw) as unknown;
                if (isLogLine(line)) lines.push(line);
            } catch {
                // a line cut short when the app stopped: skipped
            }
        }
        return lines;
    }

    async sizes(): Promise<Record<string, number>> {
        const sizes: Record<string, number> = {};
        for (const day of await this.days()) {
            try {
                sizes[day] = (await this.fs.stat(this.file(day))).size;
            } catch {
                // gone since it was listed
            }
        }
        return sizes;
    }

    async remove(day: string): Promise<void> {
        await this.fs.unlink(this.file(day)).catch(() => undefined);
    }

    private file(day: string): string {
        return path.join(this.folder, `app-log-${day}.jsonl`);
    }

    private made(): Promise<unknown> {
        this.ready ??= this.fs.mkdir(this.folder, { recursive: true }).catch(() => undefined);
        return this.ready;
    }
}
