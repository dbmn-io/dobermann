// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #2: a DBMN sign-in that can no longer refresh (the refresh token rejected) showed an empty catalogue in VS Code
 * instead of saying so. The catalogue's token function gave supabase-js null, supabase-js then sent the project's
 * anonymous key, the account's rows are not the anonymous user's, and every list came back empty: shown as the
 * catalogue, and mirrored over this computer's copy of the account.
 *
 * Now: no catalogue request is ever sent as the anonymous user, and an expired sign-in counts as signed out for the
 * catalogue: this computer's copy, editable, sent to the account at the next sign-in, with one Hub toast saying so.
 * A network error is not an expired sign-in.
 *
 * The real VsCodeCatalogue, its real Supabase client and stores; only fetch is answered here, as the backend answers
 * it: the account's rows for the account's token, none for the anonymous key. The backend is a closed local port, so
 * nothing leaves this process (Realtime there times out, as it does with no network).
 */
import { expect } from 'chai';
import { VsCodeCatalogue } from '../../../../platform/vscode/vscode-catalogue';
import { SwitchableStoreContext } from '../../../../services/catalogue/switchable-store-context';
import { AccountCopy, prefixedStore } from '../../../../services/catalogue/account-copy';
import { MemoryKeyValueStore } from '../../../../platform/memory/memory-key-value-store';
import { getBackend, initBackend, PRODUCTION_BACKEND, resolveBackend } from '../../../../services/dbmn-backend/backend-config';
import type { IDbmnAuthService } from '../../../../services/dbmn-auth/dbmn-auth.interface';

const USER = '11111111-1111-1111-1111-111111111111';
const TOKEN = 'the-account-token';
type Status = 'ok' | 'auth_error' | 'network_error';

function memorySecrets() {
    const kept = new Map<string, string>();
    return {
        get: async (key: string) => kept.get(key),
        store: async (key: string, value: string) => { kept.set(key, value); },
        delete: async (key: string) => { kept.delete(key); }
    };
}

/**
 * A stored session, as DbmnAuthService keeps one: `refresh` is what the next refresh gets. Like the real service, the
 * listeners hear when the sign-in becomes (or stops being) expired: #396's header warning follows the same change.
 */
class StoredSession {
    status: Status = 'ok';
    private readonly listeners = new Set<() => void>();
    constructor(public refresh: 'success' | 'auth_error' | 'network_error') {}
    getSession() { return { userId: USER, email: 'someone@example.com', accessToken: TOKEN, refreshToken: 'rt', expiresAt: 1 }; }
    isAuthenticated() { return true; }
    getAuthState() { return { isAuthenticated: true, session: this.getSession(), connectivityStatus: this.status }; }
    async ensureValidSession() {
        if (this.refresh === 'success') return { status: 'success', session: { ...this.getSession(), expiresAt: Date.now() / 1000 + 3600 } };
        const wasExpired = this.status === 'auth_error';
        this.status = this.refresh;
        if (wasExpired !== (this.status === 'auth_error')) this.listeners.forEach(listener => listener());
        return { status: this.refresh, httpStatus: this.refresh === 'auth_error' ? 400 : 0 };
    }
    onAuthStateChanged(listener: () => void) { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; }
}

describe('#2: a DBMN sign-in that can no longer refresh, in VS Code', function () {
    this.timeout(90_000);
    const realFetch = globalThis.fetch;
    let sent: Array<{ table: string; bearer: string | null }>;
    let toasts: Array<{ kind: string; message: string }>;
    let catalogue: VsCodeCatalogue | undefined;

    beforeEach(() => {
        initBackend(resolveBackend({ isDevelopment: true, env: { DBMN_BACKEND: 'local', DBMN_BACKEND_URL: 'http://127.0.0.1:9' } }));
        sent = [];
        toasts = [];
        const record = (kind: string) => (message: string) => { toasts.push({ kind, message }); };
        (global as Record<string, unknown>).dbmnToastService = { info: record('info'), warn: record('warn'), error: record('error') };
        // The backend: the account's two endpoints for the account's token; the anonymous key sees no rows
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input);
            const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
            const bearer = (headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || null;
            const table = url.includes('/rest/v1/') ? url.replace(/^.*\/rest\/v1\//, '').split('?')[0] : url;
            sent.push({ table, bearer });
            const rows = table === 'catalog_endpoints' && bearer === TOKEN && (init?.method ?? 'GET') === 'GET'
                ? [1, 2].map(n => ({ id: `ep-${n}`, item: { id: `ep-${n}`, name: `Endpoint ${n}` }, version: 1, updated_at: '2026-11-01T00:00:00Z', deleted_at: null }))
                : [];
            return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
    });
    afterEach(() => {
        catalogue?.dispose();
        catalogue = undefined;
        globalThis.fetch = realFetch;
        delete (global as Record<string, unknown>).dbmnToastService;
        initBackend(PRODUCTION_BACKEND);
    });

    /** This computer: its catalogue moved to the account earlier, and a copy of the account's two endpoints. */
    async function thisComputer() {
        const profile = getBackend().profile;
        const globalState = new MemoryKeyValueStore({
            [`catalogue:${profile}:deviceMoved`]: '2026-11-01T00:00:00Z',
            [`catalogue:${profile}:lastAccount`]: USER,
            [`catalogue:${profile}:${USER}:movedToAccountAt`]: '2026-11-01T00:00:00Z'
        });
        const copy = new AccountCopy(prefixedStore(globalState, `catalogue:${profile}:${USER}:copy:`));
        for (const kind of ['environments', 'systems', 'views'] as const) await copy.mirror(kind, []);
        await copy.mirror('endpoints', [1, 2].map(n => ({ item: { id: `ep-${n}`, name: `Endpoint ${n}` }, version: 1, updatedAt: 0 })) as never);
        const store = new SwitchableStoreContext({ globalState: new MemoryKeyValueStore(), secrets: memorySecrets() });
        return { globalState, copy, store };
    }

    function start(at: Awaited<ReturnType<typeof thisComputer>>, auth: StoredSession) {
        catalogue = new VsCodeCatalogue({ globalState: at.globalState, secrets: memorySecrets(), subscriptions: [] } as never, at.store, {} as never,
            auth as unknown as IDbmnAuthService, () => undefined);
        catalogue.start();
    }

    /** Until VS Code has followed every sign-in change so far. */
    async function followed(): Promise<void> {
        const pending = () => (catalogue as unknown as { pending: Promise<void> }).pending;
        let seen: Promise<void> | undefined;
        while (seen !== pending()) { seen = pending(); await seen; }
    }

    const listed = (store: SwitchableStoreContext) =>
        ((store.globalState.get('apiEndpoints') as { endpoints?: Array<{ id: string }> } | undefined)?.endpoints ?? []).map(e => e.id).sort();
    const anonymous = () => sent.filter(r => r.bearer === getBackend().anonKey && !r.table.startsWith('http')).map(r => r.table);
    const expiredToasts = () => toasts.filter(t => /sign-in has expired/i.test(t.message));

    it('at start-up: this computer\'s copy, nothing asked for as the anonymous user, and the Hub says the sign-in expired', async () => {
        const at = await thisComputer();
        start(at, new StoredSession('auth_error'));
        await followed();
        expect({
            'catalogue requests sent as the anonymous user': anonymous(),
            'endpoints the Hub lists': listed(at.store),
            "this computer's copy of the account's endpoints": (await at.copy.local.endpoints.list()).length,
            'toasts saying the sign-in expired': expiredToasts().length,
            'other warnings': toasts.filter(t => !/sign-in has expired/i.test(t.message)).map(t => t.message)
        }).to.deep.equal({
            'catalogue requests sent as the anonymous user': [],
            'endpoints the Hub lists': ['ep-1', 'ep-2'],
            "this computer's copy of the account's endpoints": 2,
            'toasts saying the sign-in expired': 1,
            'other warnings': []
        });
        expect(expiredToasts()[0].kind).to.equal('warn');
    });

    it('a change made on this computer while signed out survives, still waiting to go to the account', async () => {
        const at = await thisComputer();
        await at.copy.local.endpoints.save({ id: 'ep-3', name: 'Made while signed out' } as never);
        expect(at.copy.pending(), 'waiting before').to.deep.equal([{ kind: 'endpoints', id: 'ep-3', change: 'created' }]);
        start(at, new StoredSession('auth_error'));
        await followed();
        expect(listed(at.store)).to.deep.equal(['ep-1', 'ep-2', 'ep-3']);
        expect((await at.copy.local.endpoints.list()).map(r => r.item.id).sort()).to.deep.equal(['ep-1', 'ep-2', 'ep-3']);
        expect(at.copy.pending(), 'still waiting for the next sign-in').to.deep.equal([{ kind: 'endpoints', id: 'ep-3', change: 'created' }]);
        expect(anonymous()).to.deep.equal([]);
    });

    it('expiring while VS Code is open: back to this computer\'s copy, said once, nothing asked for anonymously', async () => {
        const at = await thisComputer();
        const auth = new StoredSession('success');
        start(at, auth);
        await followed();
        expect(listed(at.store), 'on the account\'s catalogue').to.deep.equal(['ep-1', 'ep-2']);
        expect(at.store.isLocal).to.equal(false);

        // The refresh token dies; the next refresh (the auth service's own, or any request's) is refused
        auth.refresh = 'auth_error';
        await auth.ensureValidSession();
        await auth.ensureValidSession();
        await followed();
        expect({
            'catalogue requests sent as the anonymous user': anonymous(),
            'endpoints the Hub lists': listed(at.store),
            "this computer's copy of the account's endpoints": (await at.copy.local.endpoints.list()).length,
            'toasts saying the sign-in expired': expiredToasts().length
        }).to.deep.equal({
            'catalogue requests sent as the anonymous user': [],
            'endpoints the Hub lists': ['ep-1', 'ep-2'],
            "this computer's copy of the account's endpoints": 2,
            'toasts saying the sign-in expired': 1
        });
    });

    it('a network error is not an expired sign-in: nothing anonymous, nothing said about the sign-in, the copy kept', async () => {
        const at = await thisComputer();
        start(at, new StoredSession('network_error'));
        await followed();
        expect(anonymous()).to.deep.equal([]);
        expect(expiredToasts()).to.deep.equal([]);
        expect(listed(at.store)).to.deep.equal(['ep-1', 'ep-2']);
        expect((await at.copy.local.endpoints.list()).length).to.equal(2);
    });
});
