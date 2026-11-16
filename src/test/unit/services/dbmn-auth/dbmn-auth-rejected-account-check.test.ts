// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #396 — a rejected account check must not sign the user out.
 *
 * The rule: DBMN sign-in is required once; after that it must not get in the way. When the
 * server ended a session (the website presented an old copy of it, Sign Out elsewhere) the
 * extension's access token still looked valid for up to an hour. A check in that hour came
 * back 401, and the extension used to sign out completely: the Hub swapped the environment
 * selector for "Sign in to DBMN" and Run API was blocked. It is an expired sign-in instead.
 * (0.4.1: the check is the account function; there are no licences.)
 */
import '../../../setup';
import { expect } from 'chai';
import { stub, restore, SinonStub } from 'sinon';
import { DbmnAuthService } from '../../../../services/dbmn-auth/dbmn-auth.service';
import { DBMN_STORAGE_KEYS } from '../../../../types/dbmn-auth';

function makeJwt(claims: Record<string, unknown>): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}.fake-signature`;
}

function signedInContext() {
    const store = new Map<string, unknown>();
    const secrets = new Map<string, string>();
    const exp = Math.floor(Date.now() / 1000) + 3000;     // the access token still looks valid
    secrets.set(DBMN_STORAGE_KEYS.session, JSON.stringify({
        userId: 'u-1', email: 'user@example.com', displayName: 'User',
        accessToken: makeJwt({ sub: 'u-1', email: 'user@example.com', exp }), refreshToken: 'rt-current', expiresAt: exp
    }));
    // What an older version left behind
    secrets.set(DBMN_STORAGE_KEYS.licenseCache, JSON.stringify({ accessLevel: 'full', fetchedAt: Date.now() }));
    const context = {
        globalState: {
            get: <T>(key: string) => store.get(key) as T | undefined,
            update: async (key: string, value: unknown) => { if (value === undefined) { store.delete(key); } else { store.set(key, value); } },
            keys: () => Array.from(store.keys())
        },
        secrets: {
            get: async (key: string) => secrets.get(key),
            store: async (key: string, value: string) => { secrets.set(key, value); },
            delete: async (key: string) => { secrets.delete(key); },
            onDidChange: () => ({ dispose: () => undefined })
        },
        subscriptions: []
    };
    return { context: context as never, secrets };
}

describe('DbmnAuthService — a rejected account check does not sign the user out (#396)', () => {
    let fetchStub: SinonStub;
    let service: DbmnAuthService;

    beforeEach(() => {
        fetchStub = stub(globalThis, 'fetch');
        const vscode = require('vscode');
        stub(vscode.commands, 'executeCommand').resolves();
        stub(vscode.window, 'showInformationMessage');
    });

    afterEach(() => {
        service?.dispose();
        restore();
    });

    const answer = (status: number, body: unknown = {}) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

    it('the server says 401: still signed in, the session is kept', async () => {
        const { context, secrets } = signedInContext();
        fetchStub.callsFake(async (url: string) => answer(String(url).includes('/account') ? 401 : 200));
        service = new DbmnAuthService(context);
        await service.initialize();

        const answered = await service.refreshAccount();

        expect(answered, 'the last known values stand').to.equal(false);
        expect(service.isAuthenticated(), 'not signed out').to.equal(true);
        expect(secrets.has(DBMN_STORAGE_KEYS.session), 'the session is kept').to.equal(true);
    });

    it('asks the account function, never the old licence check', async () => {
        const { context } = signedInContext();
        fetchStub.callsFake(async () => answer(200, { displayName: 'Server Name', weekStart: '2026-11-16' }));
        service = new DbmnAuthService(context);
        await service.initialize();

        expect(await service.refreshAccount(true)).to.equal(true);

        const urls = fetchStub.getCalls().map(call => String(call.args[0]));
        expect(urls.some(url => url.includes('/functions/v1/account?include_stats=true'))).to.equal(true);
        expect(urls.some(url => url.includes('check-license'))).to.equal(false);
        expect(service.getUsageStatus()).to.deep.equal({ weekStart: '2026-11-16' });
        expect(service.getAuthState().session?.displayName).to.equal('Server Name');
    });

    it('startup deletes the licence an older version saved', async () => {
        const { context, secrets } = signedInContext();
        fetchStub.callsFake(async () => answer(200, { displayName: '', weekStart: '2026-11-16' }));
        service = new DbmnAuthService(context);
        await service.initialize();
        expect(secrets.has(DBMN_STORAGE_KEYS.licenseCache)).to.equal(false);
    });

    it('and it is shown as an expired sign-in, so the Hub header can say so', async () => {
        const { context } = signedInContext();
        fetchStub.callsFake(async (url: string) => answer(String(url).includes('/account') ? 401 : 200));
        service = new DbmnAuthService(context);
        await service.initialize();
        const seen: string[] = [];
        service.onAuthStateChanged(state => seen.push(String(state.connectivityStatus)));

        await service.refreshAccount();

        expect(service.getAuthState().connectivityStatus).to.equal('auth_error');
        expect(seen, 'listeners were told').to.include('auth_error');
    });

    it('a later check that succeeds clears the warning', async () => {
        const { context } = signedInContext();
        let reject = true;
        fetchStub.callsFake(async (url: string) => {
            if (!String(url).includes('/account')) { return answer(200); }
            return reject ? answer(401) : answer(200, { displayName: 'User', weekStart: '2026-10-12' });
        });
        service = new DbmnAuthService(context);
        await service.initialize();
        await service.refreshAccount();
        expect(service.getAuthState().connectivityStatus).to.equal('auth_error');

        reject = false;
        await service.refreshAccount();
        expect(service.getAuthState().connectivityStatus).to.equal('ok');
    });
});
