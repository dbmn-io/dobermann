// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #396 — a rejected licence check must not sign the user out.
 *
 * The rule: DBMN sign-in is required once; after that it must not get in the way. When the
 * server ended a session (the website presented an old copy of it, Sign Out elsewhere) the
 * extension's access token still looked valid for up to an hour. A licence check in that
 * hour came back 401, and the extension signed out completely and deleted the saved
 * licence: the Hub swapped the environment selector for "Sign in to DBMN" and Run API was
 * blocked as well as batches — worse than the expired sign-in the 4-week grace is for.
 */
import '../../../setup';
import { expect } from 'chai';
import { stub, restore, SinonStub } from 'sinon';
import { DbmnAuthService } from '../../../../services/dbmn-auth/dbmn-auth.service';
import { DBMN_STORAGE_KEYS, DbmnLicenseStatus } from '../../../../types/dbmn-auth';

function makeJwt(claims: Record<string, unknown>): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}.fake-signature`;
}

const LICENCE: DbmnLicenseStatus = {
    licenseType: 'user', accessLevel: 'full', status: 'active', trialEndsAt: null, subscriptionEndsAt: null,
    licensedEnvironmentUrls: [], isLifetime: false, fetchedAt: Date.now()
};

function signedInContext() {
    const store = new Map<string, unknown>();
    const secrets = new Map<string, string>();
    const exp = Math.floor(Date.now() / 1000) + 3000;     // the access token still looks valid
    secrets.set(DBMN_STORAGE_KEYS.session, JSON.stringify({
        userId: 'u-1', email: 'user@example.com', displayName: 'User',
        accessToken: makeJwt({ sub: 'u-1', email: 'user@example.com', exp }), refreshToken: 'rt-current', expiresAt: exp
    }));
    secrets.set(DBMN_STORAGE_KEYS.licenseCache, JSON.stringify(LICENCE));
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

describe('DbmnAuthService — a rejected licence check does not sign the user out (#396)', () => {
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

    it('the server says 401: still signed in, the licence is kept, batches are still allowed', async () => {
        const { context, secrets } = signedInContext();
        fetchStub.callsFake(async (url: string) => answer(String(url).includes('/check-license') ? 401 : 200));
        service = new DbmnAuthService(context);
        await service.initialize();
        const changes: string[] = [];
        service.onAuthStateChanged(state => changes.push(String(state.connectivityStatus)));

        const licence = await service.fetchLicenseStatus();

        expect(licence?.accessLevel, 'the last known licence is what comes back').to.equal('full');
        expect(service.isAuthenticated(), 'not signed out').to.equal(true);
        expect(secrets.has(DBMN_STORAGE_KEYS.session), 'the session is kept').to.equal(true);
        expect(secrets.has(DBMN_STORAGE_KEYS.licenseCache), 'the saved licence is kept').to.equal(true);
    });

    it('and it is shown as an expired sign-in, so the Hub header can say so', async () => {
        const { context } = signedInContext();
        fetchStub.callsFake(async (url: string) => answer(String(url).includes('/check-license') ? 401 : 200));
        service = new DbmnAuthService(context);
        await service.initialize();
        const seen: string[] = [];
        service.onAuthStateChanged(state => seen.push(String(state.connectivityStatus)));

        await service.fetchLicenseStatus();

        expect(service.getAuthState().connectivityStatus).to.equal('auth_error');
        expect(seen, 'listeners were told').to.include('auth_error');
    });

    it('a later check that succeeds clears the warning', async () => {
        const { context } = signedInContext();
        let reject = true;
        fetchStub.callsFake(async (url: string) => {
            if (!String(url).includes('/check-license')) { return answer(200); }
            return reject ? answer(401) : answer(200, { license: { ...LICENCE, fetchedAt: Date.now() }, usage: { weekStart: '2026-10-12', batchCount: 0, exportCount: 0, importCount: 0 } });
        });
        service = new DbmnAuthService(context);
        await service.initialize();
        await service.fetchLicenseStatus();
        expect(service.getAuthState().connectivityStatus).to.equal('auth_error');

        reject = false;
        await service.fetchLicenseStatus();
        expect(service.getAuthState().connectivityStatus).to.equal('ok');
    });
});
