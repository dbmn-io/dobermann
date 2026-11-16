// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The local agent (#344 step 4, #374). The web app runs a batch as it always does (preparing a
 * few requests ahead, its threads, its history and logs); for an environment set to "Run in:
 * Local agent", each prepared request goes to DBMN for VS Code to send instead of the browser's
 * fetch. VS Code adds the environment's base URL, token and headers, sends it, and hands the
 * response back. It never writes history: the web app does.
 *
 * The two talk over loopback (agent-http.ts): VS Code listens on `127.0.0.1`, the web app finds
 * the port on the user's DBMN account (agent-discovery.ts) and calls it. One message in, its
 * reply out, on one connection. Nothing secret crosses: tokens stay in VS Code.
 *
 * VS Code not there: a sign-in or status question fails at once ("Please open VS Code"); a
 * request waits, saying so, and goes the moment VS Code answers. The open connection is "the
 * tab that asked is still there": a tab that closes takes its request with it.
 *
 * Signing in is VS Code's too: the web app's gate asks it "signed in to this environment?" and,
 * on Sign In, VS Code signs in (the provider's page in the web app's popup, the exchange in VS Code).
 *
 * Cancel (#335): a request still waiting for VS Code is never sent; one VS Code is sending is
 * cancelled by hanging up, and VS Code aborts it. Either way the run records it as cancelled.
 *
 * Nothing that arrives is trusted (#375, agent-protocol.ts): any page or local process can call
 * the listener. What VS Code goes by is the signature (agent-signature.ts): every message is
 * signed by the web app's key, whose public half is on the user's DBMN account, and VS Code acts
 * only on what a key of its own signed-in account signed. That, and nothing else, says "this
 * user's web app": VS Code then runs what it is given, in any environment it holds (decided
 * 2026-10-11; it no longer asks whether the environment is set to run here). It also parses and
 * version-checks every message, takes only ones stamped in the last ALIVE_MS and addressed to
 * its own listener, and answers an id once. The web app parses every reply, and opens only a
 * sign-in page on the environment's own authorize host.
 *
 * The production confirmation is the web app's, asked once, where the user is: VS Code stays in
 * the background and never prompts for a web app run (decided 2026-10-11).
 *
 * Replies are not signed: the web app knows the listener by the port on its own account.
 */
import type { APIEndpointConfig } from '../../apiConfigManager';
import type { EnvironmentConfig } from '../../environmentManager';
import type { EndpointExecutionOptions, EndpointResponse, IRequestExecutor } from '../execution/request-executor.interface';
import type { GateEnvironment, IEnvironmentAuthGate } from '../environment/auth-gate';
import { promptAuthExpiredInModal } from '../environment/auth-gate';
import type { ModalHost } from '../../screens/modal.types';
import {
    AGENT_PROTOCOL_VERSION, RELOAD_WEB_APP, type AgentRefusalCode, type SignedAgentMessage, isAllowedRedirectUri, isEnvironmentSignInUrl,
    readAgentReply, readSignedMessage
} from './agent-protocol';
import { type AgentSigner, verifyAgentSignature } from './agent-signature';

/** How long ago a message may have been stamped and still be acted on. */
export const ALIVE_MS = 30_000;

/** What fetch rejects with on abort: the run records it as cancelled, not as an error (#335). */
export function abortError(message: string): Error {
    return Object.assign(new Error(message), { name: 'AbortError' });
}

interface MessageBase {
    /** The protocol version (#375): AGENT_PROTOCOL_VERSION. */
    v: number;
    id: string;
    /** The DBMN user the web app is signed in as: VS Code only answers its own user. */
    userId: string;
    environmentId: string;
    sentAt: string;
    /** The listener this is for: a copy can't be played to another VS Code window. */
    to: string;
}

export type AgentMessage =
    | MessageBase & { kind: 'auth-status' }
    | MessageBase & { kind: 'sign-in-start'; redirectUri: string; forceLogin?: boolean }
    | MessageBase & { kind: 'sign-out' }
    | MessageBase & { kind: 'sign-in-finish'; code: string; state: string }
    | MessageBase & { kind: 'request'; endpoint: APIEndpointConfig; options?: EndpointExecutionOptions };

/** A message before it's addressed (one per kind: Omit on a union would merge them). */
type Outgoing = AgentMessage extends infer M ? M extends AgentMessage ? Omit<M, 'v' | 'id' | 'userId' | 'sentAt' | 'to'> : never : never;

/** Every reply says which protocol it speaks and which DBMN for VS Code sent it (#375). */
interface ReplyBase { id: string; v?: number; agentVersion?: string }

export type AgentReply =
    | ReplyBase & { ok: true; response?: EndpointResponse; signedIn?: boolean; signIn?: { url: string; state: string } }
    | ReplyBase & { ok: false; error: string; code?: AgentRefusalCode | string };

export const AGENT_NOT_RUNNING = 'Please open VS Code, then try again.';
/** A run waits for VS Code instead of failing (#344): VS Code just needs to be open. */
export const AGENT_WAITING = 'Please open VS Code: the run starts as soon as it\'s connected.';
export const AGENT_WAITING_FOR = 'VS Code';
/** #375: refusals VS Code answers with. */
export const AGENT_STALE = 'DBMN for VS Code refused this request: it was written too long ago. Run again.';
/** No key of VS Code's account signed it: the web app registers its key again and sends again; this is said when that didn't help. */
export const AGENT_UNKNOWN_BROWSER = 'DBMN for VS Code doesn\'t know this browser. Check both are online and signed in to the same DBMN account, then run again.';
export const AGENT_NOT_SIGNED = 'DBMN for VS Code refused this request: it isn\'t signed by your DBMN web app.';
/** #374: sent to one VS Code window's listener, arrived at another's. */
export const AGENT_WRONG_LISTENER = 'DBMN for VS Code refused this request: it was meant for another VS Code window. Run again.';
export const AGENT_ANSWERED_BEFORE = 'DBMN for VS Code refused this request: it has already been answered.';
export const AGENT_REDIRECT_REFUSED = 'DBMN for VS Code only signs in for the DBMN web app (app.dbmn.io): this page can\'t receive the sign-in.';
export const AGENT_SIGN_IN_PAGE_REFUSED = 'Sign-in stopped: DBMN for VS Code sent a sign-in page that isn\'t on this environment\'s authorize host. Nothing was opened.';
/** The connection went before the answer came: nobody knows whether the API got the request. */
export const AGENT_LOST = 'DBMN for VS Code stopped answering before this request finished. It may or may not have been sent: check before running it again.';
/** A request lost because VS Code went away, not because the API failed. */
export function isAgentLost(errorMessage: string | undefined): boolean {
    return !!errorMessage && errorMessage.includes(AGENT_LOST);
}
/** #356: the API answered, but not to a browser (CORS). */
export const BROWSER_BLOCKED = 'This API doesn\'t accept requests from a browser. Set the environment\'s Run in to Local agent and open DBMN for VS Code, then run again.';

/** At most this many requests at once in an environment: its batch threads, or one. */
export function environmentThreads(environment: Pick<EnvironmentConfig, 'parallelProcessing'> | undefined): number {
    const parallel = environment?.parallelProcessing;
    if (!parallel?.enabled) return 1;
    return Math.max(1, Math.floor(parallel.maxConcurrency || 1));
}

/** Holds requests back so no environment ever has more in flight than its threads. */
export class EnvironmentLimiter {
    private readonly running = new Map<string, number>();
    private readonly waiting = new Map<string, Array<() => void>>();

    async run<T>(environmentId: string, limit: number, work: () => Promise<T>): Promise<T> {
        while ((this.running.get(environmentId) ?? 0) >= limit) {
            await new Promise<void>(resolve => {
                const queue = this.waiting.get(environmentId) ?? [];
                queue.push(resolve);
                this.waiting.set(environmentId, queue);
            });
        }
        this.running.set(environmentId, (this.running.get(environmentId) ?? 0) + 1);
        try {
            return await work();
        } finally {
            this.running.set(environmentId, (this.running.get(environmentId) ?? 1) - 1);
            this.waiting.get(environmentId)?.shift()?.();
        }
    }

    inFlight(environmentId: string): number {
        return this.running.get(environmentId) ?? 0;
    }
}

/** One DBMN for VS Code listener the web app can reach right now. */
export interface AgentConnection {
    listenerId: string;
    /**
     * One signed message in, its reply as it arrived (unparsed). `signal` hangs up: that is the
     * request's Cancel. Rejects with AGENT_LOST when the connection goes before the reply.
     */
    send(message: SignedAgentMessage, signal?: AbortSignal): Promise<unknown>;
}

/** How the web app reaches DBMN for VS Code (loopback: web/src/shell/agent-loopback.ts). */
/**
 * Is DBMN for VS Code there (#344: the icon beside an environment that runs in it)? `unchecked`:
 * finding out would make the browser ask its permission, or the browser won't let it; it is
 * found out when something runs.
 */
export type AgentConnectionState = 'connected' | 'away' | 'unchecked';

export interface AgentTransport {
    /** The listener to use, or undefined when DBMN for VS Code isn't there. `fresh`: look again, whatever was found before. */
    connect(fresh?: boolean): Promise<AgentConnection | undefined>;
    /** As `connect`, but never asks the user anything (no explainer, no browser prompt). */
    state?(): Promise<AgentConnectionState>;
}

export interface AgentClientOptions {
    timeoutMs?: { request: number; 'sign-in-start': number; 'sign-in-finish': number; 'sign-out': number; 'auth-status': number };
    /**
     * OAuth's browser half, in the web app: open the provider's page (`url`) and resolve with the
     * code its callback page gets for `state`. Without it, the web app can't sign in through VS Code.
     */
    browserSignIn?: { redirectUri: () => string; run(url: string, state: string): Promise<string> };
    /** The environment as the web app has it: a sign-in page is opened only on its authorize host (#375). */
    environment?: (environmentId: string) => Promise<unknown>;
    /** A request starts or stops waiting for VS Code to come (the web app says so). */
    onWaiting?: (waiting: boolean) => void;
    /** The same, for one request's execution (its Console shows it). */
    onRequestWaiting?: (executionId: string, waiting: boolean) => void;
    /** Signs every message with this browser's key (agent-signature.ts). Without it nothing can be sent. */
    signer?: AgentSigner;
    newId?: () => string;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

/** A message as it crosses: its JSON, signed (the envelope repeats `v` and `id` for a refusal's sake). */
export async function signAgentMessage(message: AgentMessage, signer: Pick<AgentSigner, 'keyId' | 'sign'>): Promise<SignedAgentMessage> {
    const payload = JSON.stringify(message);
    return { v: message.v, id: message.id, keyId: signer.keyId, payload, signature: await signer.sign(payload) };
}

/** The web app's side: one message out, its reply back. */
export class AgentClient {
    private readonly onWaiting: AgentClientOptions['onWaiting'];
    private readonly onRequestWaiting: AgentClientOptions['onRequestWaiting'];
    private waiting = 0;
    private readonly timeoutMs: NonNullable<AgentClientOptions['timeoutMs']>;
    private readonly browserSignIn: AgentClientOptions['browserSignIn'];
    private readonly environment: AgentClientOptions['environment'];
    private readonly signer: AgentClientOptions['signer'];
    private readonly newId: () => string;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(private readonly transport: AgentTransport, private readonly userId: () => string, options: AgentClientOptions = {}) {
        this.timeoutMs = options.timeoutMs ?? { request: 10 * 60_000, 'sign-in-start': 30_000, 'sign-in-finish': 60_000, 'sign-out': 30_000, 'auth-status': 15_000 };
        this.browserSignIn = options.browserSignIn;
        this.environment = options.environment;
        this.signer = options.signer;
        this.newId = options.newId ?? (() => crypto.randomUUID());
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
        this.onWaiting = options.onWaiting;
        this.onRequestWaiting = options.onRequestWaiting;
    }

    /** Is DBMN for VS Code there to answer? */
    async connected(): Promise<boolean> {
        return !!(await this.transport.connect());
    }

    /** The same, for showing: never asks the user anything to find out. */
    async connectionState(): Promise<AgentConnectionState> {
        if (this.transport.state) return this.transport.state();
        return (await this.connected()) ? 'connected' : 'away';
    }

    /**
     * Waits, saying so, until VS Code is there. True if it had to wait (the caller then checks the
     * sign-in before anything is sent: VS Code was away when the run's own check happened).
     */
    async waitUntilConnected(signal?: AbortSignal, executionId?: string): Promise<boolean> {
        if (await this.connected()) return false;
        await this.waitForConnection(signal, executionId, 'Cancelled while waiting for VS Code.');
        return true;
    }

    private async waitForConnection(signal: AbortSignal | undefined, executionId: string | undefined, cancelled: string): Promise<AgentConnection> {
        if (this.waiting++ === 0) this.onWaiting?.(true);
        try {
            for (;;) {
                if (signal?.aborted) throw abortError(cancelled);
                // Said again each second: the run's Console may open after the wait began
                if (executionId) this.onRequestWaiting?.(executionId, true);
                await this.sleep(1000);
                const connection = await this.transport.connect();
                if (connection) return connection;
            }
        } finally {
            if (executionId) this.onRequestWaiting?.(executionId, false);
            if (--this.waiting === 0) this.onWaiting?.(false);
        }
    }

    /**
     * Sends one prepared request through VS Code. Failures come back the way fetch's do. Without
     * VS Code it waits, queued, until VS Code comes; `signal` gives up waiting (Cancel).
     */
    async execute(environmentId: string, endpoint: APIEndpointConfig, options?: EndpointExecutionOptions, signal?: AbortSignal): Promise<EndpointResponse> {
        const reply = await this.send({ kind: 'request', environmentId, endpoint, options }, signal);
        if (!reply.ok) throw new Error(reply.error);
        if (!reply.response) throw new Error('DBMN for VS Code sent back no response.');
        return reply.response;
    }

    async isSignedIn(environmentId: string): Promise<boolean> {
        const reply = await this.send({ kind: 'auth-status', environmentId });
        if (!reply.ok) throw new Error(reply.error);
        return !!reply.signedIn;
    }

    /**
     * OAuth for an environment that runs in VS Code. The browser half happens here, in the web app
     * (never in VS Code's window): VS Code starts the sign-in and keeps its verifier, state and
     * client secret; the provider's page comes back to the web app's callback page; VS Code
     * exchanges the code and keeps the token. Nothing secret crosses: a code is useless without
     * VS Code's verifier and secret.
     */
    async signIn(environmentId: string, options: { forceLogin?: boolean } = {}): Promise<boolean> {
        if (!this.browserSignIn) throw new Error('Signing in through DBMN for VS Code isn\'t available here.');
        const started = await this.send({ kind: 'sign-in-start', environmentId, redirectUri: this.browserSignIn.redirectUri(), forceLogin: options.forceLogin });
        if (!started.ok) throw new Error(started.error);
        if (!started.signIn) throw new Error('DBMN for VS Code didn\'t start the sign-in.');
        // #375: the page comes from outside this app; only the environment's own authorize host is opened
        const environment = await this.environment?.(environmentId) as Parameters<typeof isEnvironmentSignInUrl>[1];
        if (!isEnvironmentSignInUrl(started.signIn.url, environment)) throw new Error(AGENT_SIGN_IN_PAGE_REFUSED);
        const code = await this.browserSignIn.run(started.signIn.url, started.signIn.state);
        const finished = await this.send({ kind: 'sign-in-finish', environmentId, code, state: started.signIn.state });
        if (!finished.ok) throw new Error(finished.error);
        return !!finished.signedIn;
    }

    /** Signs VS Code out of the environment: its session and token there go. */
    async signOut(environmentId: string): Promise<void> {
        const reply = await this.send({ kind: 'sign-out', environmentId });
        if (!reply.ok) throw new Error(reply.error);
    }

    /**
     * Two refusals are worth one more try, because nothing was sent: VS Code doesn't know this
     * browser's key (it registered while offline, or the account lost it), so the key is
     * registered again; or the window the message was for has gone and another answered in its
     * place, so the listener is looked up again.
     */
    private async send(message: Outgoing, signal?: AbortSignal): Promise<AgentReply> {
        let registered = false;
        let lookedAgain = false;
        for (;;) {
            const reply = await this.sendOnce(message, signal, lookedAgain);
            if (!reply.ok && reply.code === 'unknown-key' && !registered && this.signer?.register) {
                registered = true;
                await this.signer.register();
                continue;
            }
            if (!reply.ok && reply.code === 'wrong-listener' && !lookedAgain) {
                lookedAgain = true;
                continue;
            }
            return reply;
        }
    }

    private async sendOnce(message: Outgoing, signal: AbortSignal | undefined, fresh: boolean): Promise<AgentReply> {
        if (!this.signer) throw new Error(RELOAD_WEB_APP);
        let connection = await this.transport.connect(fresh);
        if (!connection) {
            // Only a request waits for VS Code to come; a sign-in or status question needs it now
            if (message.kind !== 'request') throw new Error(AGENT_NOT_RUNNING);
            connection = await this.waitForConnection(signal, message.options?.executionId, 'Cancelled before DBMN for VS Code picked it up.');
        }
        if (signal?.aborted) throw abortError('Cancelled before DBMN for VS Code picked it up.');
        const id = this.newId();
        const full = { ...message, v: AGENT_PROTOCOL_VERSION, id, userId: this.userId(), sentAt: new Date(this.now()).toISOString(), to: connection.listenerId } as AgentMessage;
        const signed = await signAgentMessage(full, this.signer);
        // The run's Cancel, and this kind of message's own time limit: either hangs up, and VS Code aborts the request
        const hangUp = new AbortController();
        const cancel = () => hangUp.abort();
        signal?.addEventListener('abort', cancel, { once: true });
        let tooLong = false;
        const limit = setTimeout(() => { tooLong = true; hangUp.abort(); }, this.timeoutMs[message.kind]);
        try {
            return this.readReply(await connection.send(signed, hangUp.signal), id);
        } catch (error) {
            if (signal?.aborted) throw abortError('Cancelled: DBMN for VS Code stopped the request.');
            if (tooLong) throw new Error('DBMN for VS Code took too long to answer.');
            throw error;
        } finally {
            clearTimeout(limit);
            signal?.removeEventListener('abort', cancel);
        }
    }

    /** #375: a reply is read like anything else from outside: parsed, and its version checked. */
    private readReply(raw: unknown, id: string): AgentReply {
        return readAgentReply(raw, id) as AgentReply;
    }
}

/**
 * The web app's request executor: environments set to run in the local agent go through VS Code,
 * the rest through the browser.
 *
 * #356: a browser reports a CORS block exactly as it reports no network. After a network failure,
 * `reachable` asks again without CORS (an opaque answer, whatever the status, means a server is
 * there); if one answered, the browser was kept out, and the error says how to run it instead.
 */
export function routeByEnvironment(deps: {
    environments: { getEnvironment(id: string): Promise<unknown>; getActiveEnvironment(): Promise<unknown> };
    browser: IRequestExecutor;
    agent: Pick<AgentClient, 'execute'>;
    reachable?: (url: string) => Promise<boolean>;
    /**
     * Before a single run's request goes to VS Code (#344): wait for VS Code, then check the
     * sign-in if it had to wait. Batch members don't: their batch waited and checked first.
     */
    beforeAgentRequest?: (environment: EnvironmentConfig, signal: AbortSignal | undefined, options: EndpointExecutionOptions | undefined) => Promise<void>;
}): IRequestExecutor {
    return {
        async executeEndpoint(endpoint, abortSignal, environmentId, options) {
            const environment = (environmentId
                ? await deps.environments.getEnvironment(environmentId)
                : await deps.environments.getActiveEnvironment()) as EnvironmentConfig | undefined;
            if (environment?.runOn === 'local-agent') {
                if (!options?.isBatchMember) await deps.beforeAgentRequest?.(environment, abortSignal, options);
                const startedAt = Date.now();
                try {
                    return await deps.agent.execute(environment.id, endpoint, options, abortSignal);
                } catch (error) {
                    // VS Code closed mid-request: a request that failed, as a network failure is
                    // (recorded with its response, so the Console lists it under Errors)
                    if (!(error instanceof Error) || !isAgentLost(error.message)) throw error;
                    return {
                        success: false, status: undefined, statusText: AGENT_LOST, data: null, error: AGENT_LOST,
                        duration: Date.now() - startedAt, url: `${environment.baseUrl ?? ''}${endpoint.path}`
                    };
                }
            }
            const response = await deps.browser.executeEndpoint(endpoint, abortSignal, environmentId, options);
            if (!response.success && response.status === undefined && response.error?.startsWith('Network error') && deps.reachable
                && await deps.reachable(response.url).catch(() => false)) {
                return { ...response, error: BROWSER_BLOCKED, statusText: BROWSER_BLOCKED };
            }
            return response;
        }
    };
}

/**
 * The web app's sign-in gate: an environment that runs in the local agent asks VS Code (whose
 * tokens they are), with the same "Authentication expired" choices; the rest use `inner`.
 */
export function agentAwareAuthGate(inner: IEnvironmentAuthGate, agent: Pick<AgentClient, 'isSignedIn' | 'signIn' | 'connected'>, deps: {
    environments: { getEnvironment(id: string): Promise<unknown> };
    modal: () => ModalHost;
    toast: { info(message: string): void; error(message: string): void };
}): IEnvironmentAuthGate {
    const runsInAgent = (environment: GateEnvironment) => (environment as Partial<EnvironmentConfig>).runOn === 'local-agent';
    const viaAgent = async (environment: GateEnvironment): Promise<boolean> => {
        try {
            // VS Code isn't running: the run goes ahead and waits, queued, for it (the engine asks
            // again, and checks the sign-in, once it's there)
            if (!(await agent.connected())) {
                deps.toast.info(AGENT_WAITING);
                return true;
            }
            if (await agent.isSignedIn(environment.id)) return true;
            const choice = await promptAuthExpiredInModal(deps.modal(), environment.name);
            if (choice === 'Continue') return true;
            if (choice !== 'Sign In') return false;
        } catch (error) {
            deps.toast.error(error instanceof Error ? error.message : String(error));
            return false;
        }
        deps.toast.info(agentSignInMessages.started(environment.name));
        try {
            const signedIn = await agent.signIn(environment.id);
            if (signedIn) deps.toast.info(agentSignInMessages.done(environment.name));
            return signedIn;
        } catch (error) {
            deps.toast.error(agentSignInMessages.failed(environment.name, error));
            return false;
        }
    };
    return {
        isAuthenticationValid: environment => runsInAgent(environment)
            ? agent.connected().then(up => up && agent.isSignedIn(environment.id)).catch(() => false)
            : inner.isAuthenticationValid(environment),
        ensureAuthenticated: environment => runsInAgent(environment) ? viaAgent(environment) : inner.ensureAuthenticated(environment),
        ensureAuthenticatedForBatch: async batch => {
            const environment = batch.environmentId
                ? await deps.environments.getEnvironment(batch.environmentId) as GateEnvironment | undefined
                : undefined;
            return environment && runsInAgent(environment) ? viaAgent(environment) : inner.ensureAuthenticatedForBatch(batch);
        }
    };
}

/** What the VS Code side needs to answer a message. */
export interface AgentHostPorts {
    /** The DBMN user VS Code is signed in as; undefined when signed out. */
    userId(): string | undefined;
    getEnvironment(id: string): Promise<EnvironmentConfig | undefined>;
    /** How long to wait for an environment to appear: VS Code loads the account's catalogue just after it starts. */
    environmentWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    executor: IRequestExecutor;
    authGate: Pick<IEnvironmentAuthGate, 'isAuthenticationValid'>;
    /** OAuth, browser half in the web app: the provider's page for the web app's callback (`forceLogin`: its login page, even if it remembers the user). */
    oauthStart(environmentId: string, redirectUri: string, forceLogin?: boolean): Promise<{ url: string; state: string }>;
    oauthSignOut(environmentId: string): Promise<void>;
    /** ...and the code it came back with, exchanged and kept here. */
    oauthFinish(environmentId: string, code: string, state: string): Promise<void>;
    /**
     * The public key named `keyId` on VS Code's own signed-in DBMN account, or undefined
     * (agent-keys.ts). What a message must be signed by to be acted on.
     */
    publicKey(keyId: string): Promise<string | undefined>;
    /** #375: this DBMN for VS Code's version: every reply carries it. */
    agentVersion?: string;
    /** #375: a dev build also signs in for a local dev server's callback page. */
    devBuild?: () => boolean;
    now?: () => number;
    log(message: string, error?: unknown): void;
}

/** The provider refused this client: its secret (or id) in DBMN for VS Code is wrong. */
export function signInFailure(error: unknown): string {
    const message = (error instanceof Error ? error.message : String(error)).replace(/^(OAuth authentication failed: )+/, '');
    // The provider's own words, when it gave them (a token endpoint's JSON error)
    const said = /"error_description"\s*:\s*"([^"]+)"/.exec(message)?.[1];
    if (/invalid_client/.test(message)) {
        return `${said ?? 'the provider refused this client'}. Update the client ID and secret in DBMN for VS Code (the environment's Authentication tab): they're kept there, not in the browser.`;
    }
    return said ?? message;
}

/** What the web app says while VS Code signs in for it (#344): the user sees who is doing it. */
export const agentSignInMessages = {
    started: (environment: string) => `Signing in to ${environment} through DBMN for VS Code…`,
    done: (environment: string) => `Signed in to ${environment} through DBMN for VS Code.`,
    failed: (environment: string, error: unknown) =>
        `DBMN for VS Code couldn't sign in to ${environment}: ${error instanceof Error ? error.message : String(error)}`
};

/** VS Code's side: answers one message. Never throws: every failure is a reply. */
export class AgentHost {
    private readonly limiter = new EnvironmentLimiter();
    /** Ids answered lately, and when: a signed message is good once (a copy of it is refused). */
    private readonly answered = new Map<string, number>();

    constructor(private readonly ports: AgentHostPorts) {}

    /** VS Code just started: its account catalogue loads a moment after it starts answering. */
    private async findEnvironment(id: string): Promise<EnvironmentConfig | undefined> {
        const sleep = this.ports.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
        const giveUpAt = Date.now() + (this.ports.environmentWaitMs ?? 20_000);
        for (;;) {
            const environment = await this.ports.getEnvironment(id);
            if (environment || Date.now() >= giveUpAt) return environment;
            await sleep(500);
        }
    }

    /** A reply, as every reply goes out: with the protocol version and this agent's own. */
    private stamped(reply: AgentReply): AgentReply {
        return { ...reply, v: AGENT_PROTOCOL_VERSION, ...(this.ports.agentVersion ? { agentVersion: this.ports.agentVersion } : {}) };
    }

    /** A refusal for a message that couldn't even be read. */
    refusal(id: string, error: string): AgentReply {
        return this.stamped({ id, ok: false, error });
    }

    /**
     * `raw`: the message as it arrived, unparsed. `signal`: the web app cancelled this request
     * (#335): VS Code aborts it. `addressedTo`: the listener it arrived at; the signed message
     * must name it.
     */
    async answer(raw: unknown, addressedTo: string, signal?: AbortSignal): Promise<AgentReply> {
        return this.stamped(await this.decide(raw, addressedTo, signal));
    }

    private async decide(raw: unknown, addressedTo: string, signal?: AbortSignal): Promise<AgentReply> {
        const read = readSignedMessage(raw);
        if (!read.ok) return { id: read.id, ok: false, error: read.error, ...(read.code ? { code: read.code } : {}) };
        // Read, not yet believed: nothing below the signature check is acted on before it
        const message = read.message as AgentMessage;
        const id = message.id;
        try {
            const userId = this.ports.userId();
            if (!userId) return { id, ok: false, error: 'DBMN for VS Code is signed out. Sign in there with the same account, then run again.' };
            if (userId !== message.userId) return { id, ok: false, error: 'DBMN for VS Code is signed in to a different DBMN account. Sign in there with this account, then run again.' };
            // Who is asking: a key of this account must have signed exactly these bytes
            const publicKey = await this.ports.publicKey(read.signed.keyId);
            if (!publicKey) return { id, ok: false, error: AGENT_UNKNOWN_BROWSER, code: 'unknown-key' };
            if (!(await verifyAgentSignature(publicKey, read.signed.payload, read.signed.signature))) return { id, ok: false, error: AGENT_NOT_SIGNED };
            if (message.to !== addressedTo) return { id, ok: false, error: AGENT_WRONG_LISTENER, code: 'wrong-listener' };
            // Written too long ago (or stamped ahead): never sent late. The web app sends it again.
            const now = (this.ports.now ?? Date.now)();
            if (Math.abs(now - Date.parse(message.sentAt)) > ALIVE_MS) return { id, ok: false, error: AGENT_STALE, code: 'stale' };
            // ...and good once: a copy of a signed message, put back while it's still fresh, is refused
            if (this.answered.has(id)) return { id, ok: false, error: AGENT_ANSWERED_BEFORE };
            this.answered.set(id, now);
            for (const [seen, at] of this.answered) {
                if (Math.abs(now - at) <= ALIVE_MS * 2) break;
                this.answered.delete(seen);
            }
            const environment = await this.findEnvironment(message.environmentId);
            if (!environment) return { id, ok: false, error: 'DBMN for VS Code doesn\'t have this environment yet. Give it a moment to sync, then run again.' };

            switch (message.kind) {
                case 'auth-status':
                    return { id, ok: true, signedIn: await this.ports.authGate.isAuthenticationValid(environment) };
                case 'sign-in-start':
                    if (environment.authMethod !== 'oauth') return { id, ok: false, error: `${environment.name} doesn't sign in with OAuth.` };
                    if (!isAllowedRedirectUri(message.redirectUri, this.ports.devBuild?.() ?? false)) return { id, ok: false, error: AGENT_REDIRECT_REFUSED };
                    this.ports.log(`[Agent] the web app is signing in to ${environment.name}`);
                    try {
                        return { id, ok: true, signIn: await this.ports.oauthStart(environment.id, message.redirectUri, message.forceLogin) };
                    } catch (error) {
                        return { id, ok: false, error: signInFailure(error) };
                    }
                case 'sign-in-finish':
                    try {
                        await this.ports.oauthFinish(environment.id, message.code, message.state);
                    } catch (error) {
                        return { id, ok: false, error: signInFailure(error) };
                    }
                    this.ports.log(`[Agent] signed in to ${environment.name} for the web app`);
                    return { id, ok: true, signedIn: await this.ports.authGate.isAuthenticationValid(environment) };
                case 'sign-out':
                    await this.ports.oauthSignOut(environment.id);
                    this.ports.log(`[Agent] signed out of ${environment.name} for the web app`);
                    return { id, ok: true, signedIn: false };
                case 'request': {
                    const response = await this.limiter.run(environment.id, environmentThreads(environment), () => {
                        if (signal?.aborted) throw abortError('Cancelled before it was sent.');
                        return this.ports.executor.executeEndpoint(message.endpoint, signal, environment.id, message.options);
                    });
                    return { id, ok: true, response };
                }
                default:
                    return { id, ok: false, error: 'DBMN for VS Code doesn\'t understand this request. Update it, then run again.' };
            }
        } catch (error) {
            return { id, ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
}
