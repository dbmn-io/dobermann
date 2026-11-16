// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #374: the web app's side of the loopback connection to DBMN for VS Code (agent-http.ts is the
 * other side). Everything a browser decides is passed in, so the rules are tested without one;
 * the web app's shell (web/src/shell/execution.ts) only wires `fetch`, the permission and the
 * prompts.
 *
 * - Where: the listeners VS Code announced on the user's DBMN account (agent-discovery.ts),
 *   newest first. The first that answers hello as itself is used, and remembered for a few
 *   seconds so a batch doesn't ask the account before every request.
 * - The browser's permission: a secure page reaching an app on this device is the user's to
 *   allow (Chrome: Local Network Access, asked once per site). Before the browser asks, DBMN
 *   says why, once. Blocked: said, with where to change it; nothing is tried.
 * - No listener on the account: VS Code isn't open (or is signed out). The browser is never
 *   asked for anything then.
 */
import type { AgentListener } from './agent-listener';
import { AGENT_HELLO_PATH, AGENT_MESSAGE_PATH, type AgentHello } from './agent-http';
import { UNREADABLE_REPLY } from './agent-protocol';
import { AGENT_LOST, abortError, type AgentConnection, type AgentConnectionState, type AgentTransport } from './local-agent';

/** Shown once, before the browser's own prompt. */
export const AGENT_CONNECT_EXPLAINER = {
    title: 'Connect to DBMN for VS Code',
    body: 'This environment runs through DBMN for VS Code on this computer. Your browser will ask once whether DBMN may reach apps on this device. Choose Allow.',
    actions: [
        { id: 'cancel', label: 'Cancel', variant: 'secondary' as const },
        { id: 'continue', label: 'Continue', variant: 'primary' as const }
    ],
    dismissible: true,
    size: 'sm' as const
};
export const AGENT_BROWSER_BLOCKED = 'Your browser is blocking DBMN from reaching VS Code. Allow "Local network access" for this site in your browser\'s site settings, then run again.';
export const AGENT_SAFARI = 'Safari can\'t reach DBMN for VS Code. Use Chrome, Edge or Firefox for environments that run through VS Code.';

/** `unknown`: this browser can't be asked, or never asks (a page that is itself on this device). */
export type LoopbackPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

export interface LoopbackFetchInit { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
export interface LoopbackResponse { ok: boolean; status: number; json(): Promise<unknown> }

export interface LoopbackDeps {
    /** The account's listeners, newest first (agent-discovery.ts). */
    listeners(): Promise<AgentListener[]>;
    fetch(url: string, init?: LoopbackFetchInit): Promise<LoopbackResponse>;
    permission(): Promise<LoopbackPermission>;
    /** The explainer (AGENT_CONNECT_EXPLAINER): true to go on to the browser's prompt. */
    explain(): Promise<boolean>;
    say(message: string): void;
    /** A browser known to keep a secure page from loopback (Safari). */
    blocksLoopback?: boolean;
    now?: () => number;
    log?(message: string, error?: unknown): void;
}

/** A connection that answered is used this long before the account is asked again. */
const REMEMBER_MS = 5_000;
/** ...and "nobody there" this long: a waiting run asks every second, the account is asked this often. */
const LOOK_AGAIN_MS = 3_000;
/** Nobody there for a while (a tab left waiting): the account is asked less often. */
const LONG_WAIT_MS = 2 * 60_000;
const LOOK_AGAIN_LONG_WAIT_MS = 10_000;
/**
 * The explainer isn't shown again this soon, whatever was answered (a waiting run keeps looking):
 * after Cancel, and after Continue when the browser's own prompt was then closed unanswered.
 */
const EXPLAIN_AGAIN_MS = 30_000;
const HELLO_MS = 1_500;
/** The first hello may sit behind the browser's own prompt: the user's to answer. */
const HELLO_BEHIND_PROMPT_MS = 120_000;

export function loopbackTransport(deps: LoopbackDeps): AgentTransport {
    const now = deps.now ?? Date.now;
    let found: { connection: AgentConnection; at: number } | undefined;
    let lookedAt = -Infinity;
    let nobodySince: number | undefined;
    let looking: Promise<AgentConnection | undefined> | undefined;
    let explainedAt = -Infinity;
    let saidBlocked = false;
    let saidSafari = false;

    const url = (listener: AgentListener, path: string) => `http://127.0.0.1:${listener.port}${path}`;

    /** May the browser be asked to reach this device? Says why first; says so when it's blocked. */
    async function allowed(): Promise<{ go: boolean; behindPrompt: boolean }> {
        const permission = await deps.permission().catch(() => 'unknown' as const);
        if (permission !== 'denied') saidBlocked = false;
        if (permission === 'denied') {
            if (!saidBlocked) deps.say(AGENT_BROWSER_BLOCKED);
            saidBlocked = true;
            return { go: false, behindPrompt: false };
        }
        if (permission !== 'prompt') return { go: true, behindPrompt: false };
        if (now() - explainedAt < EXPLAIN_AGAIN_MS) return { go: false, behindPrompt: false };
        const goOn = await deps.explain();
        explainedAt = now();
        return { go: goOn, behindPrompt: goOn };
    }

    async function answers(listener: AgentListener, behindPrompt: boolean): Promise<boolean> {
        try {
            const response = await deps.fetch(url(listener, AGENT_HELLO_PATH), { signal: AbortSignal.timeout(behindPrompt ? HELLO_BEHIND_PROMPT_MS : HELLO_MS) });
            return response.ok && (await response.json() as Partial<AgentHello>).listenerId === listener.listenerId;
        } catch {
            return false;
        }
    }

    function connectionTo(listener: AgentListener): AgentConnection {
        return {
            listenerId: listener.listenerId,
            send: async (message, signal) => {
                let response: LoopbackResponse;
                try {
                    response = await deps.fetch(url(listener, AGENT_MESSAGE_PATH), {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message), signal
                    });
                } catch (error) {
                    if (signal?.aborted) throw abortError('Cancelled.');
                    found = undefined;   // gone mid-request: look again next time
                    lookedAt = -Infinity;
                    deps.log?.('[Agent] the connection to DBMN for VS Code went before its answer', error);
                    throw new Error(AGENT_LOST);
                }
                if (!response.ok) throw new Error(`DBMN for VS Code didn't take this request (${response.status}). Update DBMN for VS Code, then run again.`);
                try {
                    return await response.json();
                } catch {
                    throw new Error(UNREADABLE_REPLY);
                }
            }
        };
    }

    async function look(): Promise<AgentConnection | undefined> {
        lookedAt = now();
        let listeners: AgentListener[];
        try {
            listeners = await deps.listeners();
        } catch (error) {
            deps.log?.('[Agent] could not read where DBMN for VS Code is listening', error);
            return found?.connection;   // the account can't be reached: what answered last may still
        }
        if (listeners.length === 0) {
            found = undefined;
            return undefined;
        }
        const access = await allowed();
        if (!access.go) {
            found = undefined;
            return undefined;
        }
        for (const listener of listeners) {
            if (await answers(listener, access.behindPrompt)) {
                found = { connection: connectionTo(listener), at: now() };
                return found.connection;
            }
            access.behindPrompt = false;   // the browser's prompt, if any, has been answered by now
        }
        found = undefined;
        if (deps.blocksLoopback && !saidSafari) {
            saidSafari = true;
            deps.say(AGENT_SAFARI);
        }
        return undefined;
    }

    return {
        connect(fresh = false) {
            if (!fresh && found && now() - found.at < REMEMBER_MS) return Promise.resolve(found.connection);
            const every = nobodySince !== undefined && now() - nobodySince > LONG_WAIT_MS ? LOOK_AGAIN_LONG_WAIT_MS : LOOK_AGAIN_MS;
            if (!fresh && !found && now() - lookedAt < every) return Promise.resolve(undefined);
            looking ??= look()
                .then(connection => { nobodySince = connection ? undefined : nobodySince ?? now(); return connection; })
                .finally(() => { looking = undefined; });
            return looking;
        },
        async state(): Promise<AgentConnectionState> {
            if (found && now() - found.at < REMEMBER_MS) return 'connected';
            // Looking would need the browser's permission (asked, or refused): not until something runs
            if (deps.blocksLoopback) return 'unchecked';
            const permission = await deps.permission().catch(() => 'unknown' as const);
            if (permission === 'prompt' || permission === 'denied') return 'unchecked';
            return (await this.connect()) ? 'connected' : 'away';
        }
    };
}
