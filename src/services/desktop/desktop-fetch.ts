// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #392: a request sent by the desktop app's main process instead of its window, so the
 * browser's CORS rule doesn't apply and an API that refuses a browser still answers. Both
 * halves are here, with nothing of Electron in them, so the rules are tested without it:
 *
 * - `bridgeFetch` (the window): a `fetch` for `FetchRequestExecutor` that asks the main process.
 *   Cancel reaches the request in flight; a network failure reads as `fetch` reports one.
 * - `desktopFetcher` (the main process): parses what the window sent, sends it, answers.
 *
 * The whole body comes back in one piece: no download progress in the Console yet.
 */
import {
    desktopFetchCancelSchema,
    desktopFetchRequestSchema,
    type DesktopBridge,
    type DesktopFetchReply,
    type DesktopFetchRequest
} from './desktop-protocol';

export type ExecutorFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Cancel, as `fetch` reports it. */
const abortError = (message: string): Error => Object.assign(new Error(message), { name: 'AbortError' });

/** Statuses whose response has no body: `Response` refuses one. */
const NO_BODY = new Set([204, 205, 304]);

export function bridgeFetch(bridge: Pick<DesktopBridge, 'fetch' | 'cancelFetch'>, newId: () => string = () => crypto.randomUUID()): ExecutorFetch {
    return async (url, init) => {
        const signal = init.signal ?? undefined;
        if (signal?.aborted) throw abortError('Cancelled.');
        if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
            throw new Error('The desktop app sends text bodies only.');
        }
        const request: DesktopFetchRequest = {
            id: newId(),
            url,
            method: (init.method ?? 'GET').toUpperCase() as DesktopFetchRequest['method'],
            headers: Object.fromEntries(new Headers(init.headers).entries()),
            ...(typeof init.body === 'string' ? { body: init.body } : {})
        };
        const cancel = () => bridge.cancelFetch(request.id);
        signal?.addEventListener('abort', cancel, { once: true });
        let reply: DesktopFetchReply;
        try {
            reply = await bridge.fetch(request);
        } finally {
            signal?.removeEventListener('abort', cancel);
        }
        if (!reply.ok) {
            if (reply.aborted || signal?.aborted) throw abortError('Cancelled.');
            // As `fetch` reports no answer, so the executor words it as it does a network error
            throw new TypeError(`fetch failed: ${reply.error}`);
        }
        return new Response(NO_BODY.has(reply.status) ? null : reply.body, { status: reply.status, statusText: reply.statusText, headers: reply.headers });
    };
}

export interface DesktopFetcher {
    /** One request from the window: parsed, sent, answered. Never throws. */
    fetch(raw: unknown): Promise<DesktopFetchReply>;
    cancel(raw: unknown): void;
    /** The window closed or reloaded: nothing it asked for is still wanted. */
    cancelAll(): void;
}

export function desktopFetcher(deps: { fetch: typeof fetch; log?(message: string, error?: unknown): void }): DesktopFetcher {
    const inFlight = new Map<string, AbortController>();
    return {
        async fetch(raw) {
            const parsed = desktopFetchRequestSchema.safeParse(raw);
            if (!parsed.success) {
                deps.log?.('[Desktop] a request from the window was not one', parsed.error);
                return { ok: false, aborted: false, error: 'Not a request.' };
            }
            const request = parsed.data;
            if (inFlight.has(request.id)) return { ok: false, aborted: false, error: 'This request is already being sent.' };
            const controller = new AbortController();
            inFlight.set(request.id, controller);
            try {
                const response = await deps.fetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal: controller.signal });
                const body = new Uint8Array(await response.arrayBuffer());
                return { ok: true, status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()), body };
            } catch (error) {
                // Node's fetch says "fetch failed" and keeps why (refused, no such host) in `cause`
                const why = (error as { cause?: unknown } | undefined)?.cause;
                const cause = why instanceof Error ? `: ${why.message}` : '';
                return { ok: false, aborted: controller.signal.aborted, error: `${error instanceof Error ? error.message : String(error)}${cause}` };
            } finally {
                inFlight.delete(request.id);
            }
        },
        cancel(raw) {
            const parsed = desktopFetchCancelSchema.safeParse(raw);
            if (parsed.success) inFlight.get(parsed.data.id)?.abort();
        },
        cancelAll() {
            for (const controller of inFlight.values()) controller.abort();
        }
    };
}
