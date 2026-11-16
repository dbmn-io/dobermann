// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #374: DBMN for VS Code listening for the web app on loopback (agent-http.ts has the rules;
 * `AgentHost` decides what a message may ask for). One listener per VS Code
 * window, on `127.0.0.1` and a port the system picks, announced on the signed-in user's DBMN
 * account so only that account's web app learns it (agent-discovery.ts).
 *
 * This file moves bytes; it decides nothing. A connection the web app closes before its reply
 * is that request's Cancel (#335): the request in flight is aborted.
 */
import * as http from 'http';
import { randomUUID } from 'crypto';
import type * as vscode from 'vscode';
import type { AddressInfo } from 'net';
import { AGENT_HELLO_PATH, AGENT_MAX_BODY_BYTES, answerAgentHttp, type AgentHello } from '../../services/agent/agent-http';
import type { AgentListener } from '../../services/agent/agent-listener';
import type { AgentHost } from '../../services/agent/local-agent';

export interface AgentListenerPorts {
    agentVersion: string;
    devBuild: () => boolean;
    deviceId: string;
    /** Signed in to DBMN (there is an account to announce on)? */
    signedIn(): boolean;
    /** The account's record of listeners (agent-discovery.ts), as the signed-in user. */
    announce(listener: Omit<AgentListener, 'updatedAt'>): Promise<void>;
    withdraw(listenerId: string): Promise<void>;
    listeners(): Promise<AgentListener[]>;
    log(message: string, error?: unknown): void;
}

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

export class VsCodeAgentListener implements vscode.Disposable {
    readonly listenerId = randomUUID();
    private server?: http.Server;
    private port?: number;
    private announced = false;

    constructor(private readonly host: AgentHost, private readonly ports: AgentListenerPorts) {}

    /** Where it listens, once started. */
    get address(): { port: number; listenerId: string } | undefined {
        return this.port === undefined ? undefined : { port: this.port, listenerId: this.listenerId };
    }

    async start(): Promise<void> {
        const server = http.createServer((request, response) => { void this.handle(request, response); });
        this.server = server;
        // Loopback only, never another interface; port 0: the system picks a free one
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
        });
        this.port = (server.address() as AddressInfo).port;
        this.ports.log(`[Agent] listening for the web app on 127.0.0.1:${this.port}`);
        await this.announce();
    }

    /** Signed in (or in again): the account learns where this window listens. Signed out: it's taken off. */
    async announce(): Promise<void> {
        if (this.port === undefined) return;
        try {
            if (!this.ports.signedIn()) {
                this.announced = false;   // the row went with the session's access; nothing to remove as nobody
                return;
            }
            await this.ports.announce({ listenerId: this.listenerId, deviceId: this.ports.deviceId, port: this.port, agentVersion: this.ports.agentVersion });
            this.announced = true;
            await this.forgetDeadListeners();
        } catch (error) {
            this.ports.log('[Agent] could not announce the listener on the DBMN account', error);
        }
    }

    /** Listeners this computer announced that are gone (a window that closed without saying so). */
    private async forgetDeadListeners(): Promise<void> {
        for (const listener of await this.ports.listeners()) {
            if (listener.deviceId !== this.ports.deviceId || listener.listenerId === this.listenerId) continue;
            if (await this.answersAs(listener)) continue;
            await this.ports.withdraw(listener.listenerId).catch(() => undefined);
        }
    }

    private async answersAs(listener: AgentListener): Promise<boolean> {
        try {
            const response = await fetch(`http://127.0.0.1:${listener.port}${AGENT_HELLO_PATH}`, { signal: AbortSignal.timeout(1500) });
            return response.ok && (await response.json() as AgentHello).listenerId === listener.listenerId;
        } catch {
            return false;
        }
    }

    private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        const controller = new AbortController();
        // The web app closed the connection before its answer: that request's Cancel
        response.on('close', () => { if (!response.writableEnded) controller.abort(); });
        try {
            const body = request.method === 'POST' ? await this.read(request) : undefined;
            if (body === null) {
                response.writeHead(413, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Too large.' }));
                return;
            }
            const answer = await answerAgentHttp({
                method: request.method ?? '',
                path: (request.url ?? '').split('?')[0],
                host: first(request.headers.host),
                origin: first(request.headers.origin),
                privateNetwork: first(request.headers['access-control-request-private-network']) === 'true',
                body
            }, {
                port: this.port ?? 0,
                listenerId: this.listenerId,
                agentVersion: this.ports.agentVersion,
                devBuild: this.ports.devBuild(),
                answer: (raw, signal) => this.host.answer(raw, this.listenerId, signal)
            }, controller.signal);
            if (controller.signal.aborted) return;
            response.writeHead(answer.status, answer.headers).end(answer.body);
        } catch (error) {
            this.ports.log('[Agent] could not answer a request on the listener', error);
            if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: 'DBMN for VS Code could not answer.' }));
        }
    }

    /** The body as text; null when it's larger than a message can be. */
    private read(request: http.IncomingMessage): Promise<string | null> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let size = 0;
            request.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > AGENT_MAX_BODY_BYTES) {
                    resolve(null);
                    request.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            request.on('error', reject);
        });
    }

    dispose(): void {
        this.server?.close();
        this.server?.closeAllConnections?.();
        this.server = undefined;
        if (this.announced) void this.ports.withdraw(this.listenerId).catch(() => undefined);
        this.announced = false;
        this.port = undefined;
    }
}
