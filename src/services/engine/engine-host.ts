// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Where Query's engine runs, behind one asynchronous face (EngineHost): in the same thread
 * (`localEngineHost`, the VS Code host, whose controller is not the page), or in a worker of its
 * own (`remoteEngineHost` here, served by `serveEngine` in the worker), so a long run never holds
 * the page. Calls and answers are plain messages over a port: no DOM, no worker types here; the
 * host that makes the worker gives the port (web/src/shell/engine-worker.ts).
 *
 * Tables go in in pieces (`load` with `more`, then `append` … `last`), so a big view never has to
 * be copied to the worker in one message.
 */
import { QueryEngine } from './engine';
import type { CompareStats, JoinStats, Progress, Query, ResultId, RunOutcome, StatsWindow, Table, TableWindow } from './engine-types';

export interface EngineHost {
    load(name: string, table: Table, options?: { more?: boolean }): Promise<void>;
    append(name: string, table: Table, options?: { last?: boolean }): Promise<void>;
    drop(name: string): Promise<void>;
    run(query: Query, options?: { onProgress?: (progress: Progress) => void; countNotNumbers?: string[]; hold?: boolean }): Promise<RunOutcome>;
    cancel(result: ResultId): void;
    read(result: ResultId, from: number, count: number): Promise<TableWindow>;
    readRows(result: ResultId, rows: number[]): Promise<TableWindow>;
    stats(result: ResultId, step: string, window?: StatsWindow): Promise<JoinStats | CompareStats | Table>;
    release(result: ResultId): Promise<void>;
    /** A result with these columns stored (QueryEngine.hold): its id. */
    hold(result: ResultId, columns: string[]): Promise<ResultId>;
    /** Ends it (a worker is stopped). */
    close(): void;
    /** False once it has stopped working (its worker died): every call is refused, and a new one is needed. */
    alive(): boolean;
}

/** The engine in this thread. */
export function localEngineHost(engine: QueryEngine = new QueryEngine()): EngineHost {
    return {
        load: async (name, table, options) => engine.load(name, table, options),
        append: async (name, table, options) => engine.append(name, table, options),
        drop: async name => engine.drop(name),
        run: (query, options) => engine.run(query, options),
        cancel: result => engine.cancel(result),
        read: async (result, from, count) => engine.read(result, from, count),
        readRows: async (result, rows) => engine.readRows(result, rows),
        stats: async (result, step, window) => engine.stats(result, step, window),
        release: async result => engine.release(result),
        hold: async (result, columns) => engine.hold(result, columns),
        close: () => undefined,
        alive: () => true
    };
}

/** A port: messages one way, a listener for the other (a Worker, or the worker's own scope). */
export interface EnginePort {
    post(message: unknown): void;
    listen(handler: (message: unknown) => void): void;
    close?(): void;
    /** The other end has failed (a worker's error): what happened. */
    onFail?(handler: (reason: string) => void): void;
}

type Call = { id: number; call: string; args: unknown[] };
type Answer = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string } | { id: number; progress: Progress };

/** The engine in a worker, through its port. */
export function remoteEngineHost(port: EnginePort): EngineHost {
    let next = 1;
    let failed: string | undefined;
    const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (p: Progress) => void }>();
    // A worker that dies answers nothing more: every call waiting is refused, and every call after
    port.onFail?.(reason => {
        failed = `The query engine stopped (${reason}). Run the query again.`;
        for (const w of waiting.values()) w.reject(new Error(failed));
        waiting.clear();
    });
    port.listen(message => {
        const m = message as Answer;
        const w = waiting.get(m.id);
        if (!w) return;
        if ('progress' in m) { w.onProgress?.(m.progress); return; }
        waiting.delete(m.id);
        if (m.ok) w.resolve(m.value); else w.reject(new Error(m.error));
    });
    const call = <T>(name: string, args: unknown[], onProgress?: (p: Progress) => void): Promise<T> => new Promise<T>((resolve, reject) => {
        if (failed) { reject(new Error(failed)); return; }
        const id = next++;
        waiting.set(id, { resolve: v => resolve(v as T), reject, onProgress });
        port.post({ id, call: name, args } satisfies Call);
    });
    return {
        load: (name, table, options) => call('load', [name, table, options]),
        append: (name, table, options) => call('append', [name, table, options]),
        drop: name => call('drop', [name]),
        run: (query, options) => call('run', [query, { ...(options?.countNotNumbers ? { countNotNumbers: options.countNotNumbers } : {}), ...(options?.hold ? { hold: true } : {}) }], options?.onProgress),
        cancel: result => { port.post({ id: next++, call: 'cancel', args: [result] } satisfies Call); },
        read: (result, from, count) => call('read', [result, from, count]),
        readRows: (result, rows) => call('readRows', [result, rows]),
        stats: (result, step, window) => call('stats', [result, step, window]),
        release: result => call('release', [result]),
        hold: (result, columns) => call('hold', [result, columns]),
        close: () => { for (const w of waiting.values()) w.reject(new Error('The engine was closed')); waiting.clear(); port.close?.(); },
        alive: () => !failed
    };
}

/** The worker's side: every call on its port answered by one engine; a run's progress sent as it comes. */
export function serveEngine(port: EnginePort, engine: QueryEngine = new QueryEngine()): void {
    port.listen(async message => {
        const { id, call, args } = message as Call;
        try {
            let value: unknown;
            switch (call) {
                case 'load': engine.load(args[0] as string, args[1] as Table, args[2] as { more?: boolean } | undefined); break;
                case 'append': engine.append(args[0] as string, args[1] as Table, args[2] as { last?: boolean } | undefined); break;
                case 'drop': engine.drop(args[0] as string); break;
                case 'run': value = await engine.run(args[0] as Query, { ...(args[1] as { countNotNumbers?: string[]; hold?: boolean } | undefined), onProgress: progress => port.post({ id, progress } satisfies Answer) }); break;
                case 'cancel': engine.cancel(args[0] as ResultId); return;
                case 'read': value = engine.read(args[0] as ResultId, args[1] as number, args[2] as number); break;
                case 'readRows': value = engine.readRows(args[0] as ResultId, args[1] as number[]); break;
                case 'stats': value = engine.stats(args[0] as ResultId, args[1] as string, args[2] as StatsWindow | undefined); break;
                case 'release': engine.release(args[0] as ResultId); break;
                case 'hold': value = engine.hold(args[0] as ResultId, args[1] as string[]); break;
                default: throw new Error(`Engine: no call "${call}"`);
            }
            port.post({ id, ok: true, value } satisfies Answer);
        } catch (error) {
            port.post({ id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies Answer);
        }
    });
}
