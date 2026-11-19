// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Logs screen (Dobermann issue 7): every line, from where it is kept, in every app.
 *
 * The app's own lines come from its day files and runs from the run history, merged by time
 * (LogReader); nothing is copied and nothing is capped. The page gets the newest lines first and
 * older ones as it scrolls back. A search runs here, over every line kept, so it reaches back to
 * the first one.
 *
 * Not live (James, 2026-11-19: "let's just do the basics… if I want to refresh there's a refresh
 * button"): the lines are read when the screen opens, searches, or Refresh is clicked, and stay
 * still while they are read.
 *
 * Copy is the page's, of the lines it shows. Save is here: every line the search finds, from
 * all of them, written to one file. Secrets were removed when each line was written (redact.ts).
 */
import type { ScreenSession } from '../screen-session';
import { logRowText, type LogCursor, type LogRow } from '../../services/logging/log-reader';
import { requestDetail } from '../../services/logging/request-detail';
import type { LogsPorts } from './logs.ports';

export interface LogsConfig {
    /** Open with this in the search box (a toast's Show in Logs, a run's own lines). */
    search?: string;
}

export type LogsMessage =
    | { type: 'logs.ready' }
    | { type: 'logs.typing' }
    | { type: 'logs.search'; text: string }
    | { type: 'logs.refresh'; text?: string }
    | { type: 'logs.older' }
    | { type: 'logs.save'; text?: string }
    | { type: 'logs.open'; open: string; key?: string }
    | { type: string; [key: string]: unknown };

/** Lines a page brings. */
export const LOGS_PAGE = 500;
/** Lines looked at per page asked of the reader (it is asked again until it has a page or is done). */
export const LOGS_LOOK = 50_000;
/** How often the page hears how far back a search has got. */
const PROGRESS_MS = 150;

export class LogsController {
    private closed = false;
    private search = '';
    /** Each search (and the screen's first page) is numbered: an answer to an older one is dropped. */
    private asked = 0;
    private next: LogCursor | undefined;
    private done = false;
    private reading = false;

    constructor(private readonly session: ScreenSession, private readonly ports: LogsPorts, private readonly config: LogsConfig = {}) {}

    async handleMessage(message: LogsMessage): Promise<void> {
        try {
            switch (message.type) {
                case 'logs.ready': return await this.find(this.config.search ?? '', true);
                // Refresh: read again, as the search box has it now
                case 'logs.refresh':
                    this.ports.reader.forget?.();
                    return await this.find(typeof message.text === 'string' ? message.text : this.search);
                // A key in the search box: whatever is still looking stops at once
                case 'logs.typing': this.asked++; return;
                case 'logs.search': return await this.find(typeof message.text === 'string' ? message.text : '');
                case 'logs.older': return await this.older();
                case 'logs.save': return await this.save();
                case 'logs.open': return await this.openRequest(String(message.open ?? ''), String(message.key ?? ''));
                default: return;
            }
        } catch (error) {
            this.ports.toast.error(`Logs: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** Already open, asked for again (Show in Logs): search for this. */
    showSearch(text: string): void {
        this.post({ type: 'logs.searchFor', text });
        void this.find(text);
    }

    dispose(): void {
        this.closed = true;
        this.asked++;
        this.session.dismissAll();
    }

    /** The newest lines the search finds, replacing what the page shows. */
    private async find(search: string, first = false): Promise<void> {
        const asked = ++this.asked;
        this.search = search.trim();
        this.next = undefined;
        this.done = false;
        const lines = await this.read(asked, undefined);
        if (asked !== this.asked) return;
        this.post({ type: 'logs.lines', lines, done: this.done, search: first ? this.search : undefined });
    }

    /** The page has scrolled back to its oldest line: the page before it. */
    private async older(): Promise<void> {
        if (this.done || this.reading || !this.next) return;
        const asked = this.asked;
        const lines = await this.read(asked, this.next);
        if (asked !== this.asked) return;
        this.post({ type: 'logs.older', lines, done: this.done });
    }

    /** Up to a page of lines older than `before`, telling the page how far back it has looked while it looks. */
    private async read(asked: number, before: LogCursor | undefined): Promise<LogRow[]> {
        this.reading = true;
        // How far through the days kept it is: from the newest day it started at to the oldest
        let range: { newest: number; oldest: number } | undefined;
        let told = 0;
        const progress = (at: { day: string; oldest: string; newest: string }) => {
            const ms = (day: string) => new Date(`${day}T12:00:00`).getTime();
            range ??= { newest: ms(at.newest), oldest: ms(at.oldest) };
            const now = Date.now();
            if (now - told < PROGRESS_MS || asked !== this.asked) return;
            told = now;
            const span = range.newest - range.oldest;
            const value = span > 0 ? Math.round(100 * (range.newest - ms(at.day)) / span) : 100;
            this.post({ type: 'logs.searching', back: at.day, value: Math.max(0, Math.min(100, value)) });
        };
        this.post({ type: 'logs.searching', value: 0 });
        try {
            const lines: LogRow[] = [];
            let from = before;
            for (;;) {
                const page = await this.ports.reader.page({ search: this.search, before: from, want: LOGS_PAGE - lines.length, budget: LOGS_LOOK, stop: () => asked !== this.asked, progress });
                if (asked !== this.asked) return [];
                lines.push(...page.lines);
                this.done = page.done;
                this.next = page.next;
                from = page.next;
                if (page.done || lines.length >= LOGS_PAGE || !from) break;
            }
            return lines;
        } finally {
            this.reading = false;
        }
    }

    /** A request's line clicked: what its run log holds, the request and the response. */
    private async openRequest(executionId: string, key: string): Promise<void> {
        if (!executionId) return;
        const events = this.ports.requests ? await this.ports.requests.events(executionId) : [];
        this.post({ type: 'logs.opened', key, open: executionId, text: requestDetail(events, text => this.ports.redact(text)) });
    }

    /** Every line the search finds, from all of them, newest first, in one file. */
    private async save(): Promise<void> {
        const found: LogRow[] = [];
        let before: LogCursor | undefined;
        for (;;) {
            const page = await this.ports.reader.page({ search: this.search, before, want: 10_000, budget: 200_000 });
            found.push(...page.lines);
            if (page.done || !page.next) break;
            before = page.next;
        }
        if (!found.length) {
            this.ports.toast.info(this.search ? 'No lines match the search.' : 'No lines to save.');
            return;
        }
        // Newest first, as the screen shows them and Copy copies them
        const text = found.map(logRowText).join('\n') + '\n';
        const now = new Date(this.ports.now ? this.ports.now() : Date.now());
        const pad = (n: number) => String(n).padStart(2, '0');
        const name = `dbmn-log-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.txt`;
        if (await this.ports.files.save(name, text)) this.ports.toast.info(`Saved ${found.length.toLocaleString('en')} line${found.length === 1 ? '' : 's'} to ${name}`);
    }

    private post(message: Record<string, unknown>): void {
        if (!this.closed) this.session.post(message);
    }
}
