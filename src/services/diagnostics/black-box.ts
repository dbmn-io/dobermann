// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The app's black box: what it was doing when it stopped answering.
 *
 * In the web app the screens' host runs in the page, so a slow piece of work freezes the page, and a frozen page
 * can't say what froze it (platform issue 478: a Console open on a cancelled batch, the page never came back).
 * So, before each message to the app is handled, a note of it is kept where a frozen page can't lose it (the
 * browser's storage), and taken away when the work is done. Then:
 *
 *   - work that took long gets a line in Logs (what, and how long);
 *   - a page that stopped answering for a while and came back says for how long, and what was being handled;
 *   - a page that never came back leaves its note behind: the next start writes "stopped while handling …" to Logs.
 *
 * Nothing of a message is kept but its type and the few ids and sizes named in KEPT: never a value, a body or a header.
 * Nothing here knows a browser: the shell gives it the storage, the clock and the log.
 */
export interface BlackBoxStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    keys(): string[];
}

export interface BlackBoxOptions {
    store: BlackBoxStore;
    log: (level: 'info' | 'warn', message: string) => void;
    now?: () => number;
    /** This page's own name among the app's open pages (two windows keep a note each). */
    id?: string;
    /** Work longer than this gets a line (ms). */
    slowMs?: number;
    /** A page silent for longer than this, while on screen, is said to have stopped answering (ms). */
    stallMs?: number;
    /** A note whose page hasn't been heard from for this long is a page that stopped (ms). */
    deadMs?: number;
}

interface Work { n: number; where: string; what: string; at: number }
interface Note { beat: number; started: number; work: Work[] }

const PREFIX = 'dbmn.blackbox.';
/** What of a message is kept beside its type: which run, which page of it, how much. */
const KEPT = ['executionId', 'batchId', 'id', 'tab', 'page', 'offset', 'limit', 'size', 'seq'];
const MOST = 12;
/** Silence longer than this is rest (a sleeping computer, a tab the browser put to sleep), not work. */
const REST_MS = 5 * 60 * 1000;

/** A message as the box keeps it: `console.requests.page (batchId b1, offset 200)`. */
export function describeMessage(message: Record<string, unknown>): string {
    const type = typeof message.type === 'string' ? message.type : 'a message';
    const said: string[] = [];
    for (const key of KEPT) {
        const value = message[key];
        if (typeof value === 'number' || (typeof value === 'string' && value.length > 0 && value.length <= 60)) said.push(`${key} ${value}`);
    }
    return said.length ? `${type} (${said.join(', ')})` : type;
}

const seconds = (ms: number): string => (ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : ms < 120000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`);
const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 8);

export class BlackBox {
    private readonly store: BlackBoxStore;
    private readonly log: (level: 'info' | 'warn', message: string) => void;
    private readonly now: () => number;
    private readonly key: string;
    private readonly slowMs: number;
    private readonly stallMs: number;
    private readonly deadMs: number;
    private readonly started: number;
    private work: Work[] = [];
    /** Work finished lately: what a stall names when the work that caused it has since ended. */
    private ended: { where: string; what: string; at: number; took: number }[] = [];
    private count = 0;
    private lastBeat: number;
    private broken = false;

    constructor(options: BlackBoxOptions) {
        this.store = options.store;
        this.log = options.log;
        this.now = options.now ?? Date.now;
        this.key = PREFIX + (options.id ?? Math.random().toString(36).slice(2, 10));
        this.slowMs = options.slowMs ?? 250;
        this.stallMs = options.stallMs ?? 2000;
        this.deadMs = options.deadMs ?? 15000;
        this.started = this.now();
        this.lastBeat = this.started;
    }

    /** At start: every note a page left behind and no longer keeps up is a page that stopped. Each is said once. */
    recover(): void {
        let keys: string[] = [];
        try { keys = this.store.keys().filter(k => k.startsWith(PREFIX) && k !== this.key); } catch { return; }
        for (const key of keys) {
            let note: Note | undefined;
            try { note = JSON.parse(this.store.getItem(key) ?? 'null') as Note; } catch { note = undefined; }
            if (note && typeof note.beat === 'number' && this.now() - note.beat < this.deadMs) continue;   // another window, alive
            try { this.store.removeItem(key); } catch { /* said again next time */ }
            if (!note || !Array.isArray(note.work) || !note.work.length) continue;
            const what = note.work.map(w => `${w.where}: ${w.what}, started ${clock(w.at)}`).join('; ');
            this.log('warn', `The app stopped or was closed without finishing, last heard from at ${clock(note.beat)}, while handling: ${what}`);
        }
    }

    /** A message about to be handled. Call what it returns when the work is done (or has failed). */
    handling(where: string, message: Record<string, unknown>): () => void {
        const work: Work = { n: ++this.count, where, what: describeMessage(message), at: this.now() };
        this.work.push(work);
        this.keep();
        return () => {
            const at = this.work.indexOf(work);
            if (at < 0) return;
            this.work.splice(at, 1);
            const took = this.now() - work.at;
            this.ended.push({ where: work.where, what: work.what, at: work.at, took });
            if (this.ended.length > MOST) this.ended.shift();
            this.keep();
            if (took >= this.slowMs) this.log('info', `${work.where}: ${work.what} took ${seconds(took)}, start to finish`);
        };
    }

    /**
     * Called on a steady timer (every `every` ms). The page is heard from; and a call that comes much later than its
     * timer asked, with the page on screen, is a page that stopped answering in between: said, with what was being
     * handled across it.
     */
    beat(every: number, onScreen = true): void {
        const now = this.now();
        const silent = now - this.lastBeat - every;
        const from = this.lastBeat;
        this.lastBeat = now;
        if (onScreen && silent >= REST_MS) {
            // (far too long for work: the computer slept, or the browser rested the page)
            this.log('info', `The app was not running for ${seconds(silent)}: the computer or the browser rested it`);
        } else if (onScreen && silent >= this.stallMs) {
            const across = this.work.filter(w => w.at <= now).map(w => `${w.where}: ${w.what} (not finished)`)
                .concat(this.ended.filter(w => w.at + w.took >= from).map(w => `${w.where}: ${w.what} (${seconds(w.took)})`));
            this.log('warn', `The app did not respond for ${seconds(silent)}. ${across.length ? `Being handled then: ${across.join('; ')}` : 'No message was being handled then.'}`);
        }
        this.keep();
    }

    /** The page back on screen: whatever time passed off screen is the browser's doing, not a stall. */
    awake(): void { this.lastBeat = this.now(); }

    /** The page closing as pages do (a reload, the tab shut): nothing stopped, no note is left. */
    closing(): void {
        try { this.store.removeItem(this.key); } catch { /* found dead next time, with whatever was in flight */ }
    }

    private keep(): void {
        if (this.broken) return;
        const note: Note = { beat: this.now(), started: this.started, work: this.work.slice(-MOST) };
        // (storage full or refused: the box goes quiet; the app carries on)
        try { this.store.setItem(this.key, JSON.stringify(note)); } catch { this.broken = true; }
    }
}
