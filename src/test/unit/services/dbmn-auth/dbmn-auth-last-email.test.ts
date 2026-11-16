// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for the `lastEmail` persistence added in GitHub Issue #263.
 *
 * `sendMagicLink` should persist the email on a successful Supabase OTP
 * response and leave the stored value untouched when the request errors.
 * `handleAuthCallback` should persist `payload.email` once the callback
 * mints a session. `getLastEmail` should round-trip whatever was stored.
 */
import '../../../setup';
import { expect } from 'chai';
import { stub, restore, SinonStub } from 'sinon';
import { DbmnAuthService } from '../../../../services/dbmn-auth/dbmn-auth.service';
import { DBMN_STORAGE_KEYS } from '../../../../types/dbmn-auth';

// Minimal JWT with sub, email, exp claims (HS256 header, fake signature)
function makeJwt(claims: { sub: string; email: string; exp: number }): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${header}.${payload}.fake-signature`;
}

/** Build a fake ExtensionContext whose globalState behaves like a Map. */
function fakeContext() {
    const store = new Map<string, unknown>();
    const secrets = new Map<string, string>();
    return {
        context: {
            globalState: {
                get: <T>(key: string) => store.get(key) as T | undefined,
                update: async (key: string, value: unknown) => {
                    if (value === undefined) store.delete(key);
                    else store.set(key, value);
                },
                keys: () => Array.from(store.keys())
            },
            secrets: {
                get: async (key: string) => secrets.get(key),
                store: async (key: string, value: string) => { secrets.set(key, value); },
                delete: async (key: string) => { secrets.delete(key); }
            },
            // Bits the service touches on construction / initialize but not in
            // these tests — leave as no-ops.
            subscriptions: []
        } as any,
        store,
        secrets
    };
}

describe('DbmnAuthService — lastEmail persistence (#263)', () => {
    let fetchStub: SinonStub;
    let executeCommandStub: SinonStub;

    beforeEach(() => {
        fetchStub = stub(globalThis, 'fetch');
        // The service calls vscode.commands.executeCommand and showInformationMessage.
        // Stub both so the tests don't need a live VS Code host.
        const vscode = require('vscode');
        executeCommandStub = stub(vscode.commands, 'executeCommand').resolves();
        stub(vscode.window, 'showInformationMessage');
    });

    afterEach(() => {
        restore();
    });

    describe('sendMagicLink', () => {
        it('persists lastEmail on a 200 response', async () => {
            const { context, store } = fakeContext();
            fetchStub.resolves({ ok: true, status: 200, json: async () => ({}) } as Response);

            const service = new DbmnAuthService(context);
            await service.sendMagicLink('user@example.com');

            expect(store.get(DBMN_STORAGE_KEYS.lastEmail)).to.equal('user@example.com');
        });

        it('does not persist lastEmail when the OTP request fails', async () => {
            const { context, store } = fakeContext();
            store.set(DBMN_STORAGE_KEYS.lastEmail, 'previous@example.com');
            fetchStub.resolves({
                ok: false,
                status: 400,
                json: async () => ({ msg: 'Rate limited' })
            } as Response);

            const service = new DbmnAuthService(context);
            try {
                await service.sendMagicLink('new@example.com');
                expect.fail('sendMagicLink should throw on non-2xx response');
            } catch (err) {
                // Message carries the provider text plus the HTTP status, so a
                // user/support can see e.g. rate-limit (429) vs bad request (400).
                expect((err as Error).message).to.equal('Rate limited (HTTP 400)');
            }

            // Untouched — the previously stored email survives a failed send.
            expect(store.get(DBMN_STORAGE_KEYS.lastEmail)).to.equal('previous@example.com');
        });
    });

    describe('handleAuthCallback', () => {
        it('persists the JWT email after a successful callback', async () => {
            const { context, store } = fakeContext();
            const exp = Math.floor(Date.now() / 1000) + 3600;
            const accessToken = makeJwt({ sub: 'user-1', email: 'callback@example.com', exp });

            // refreshAccount runs as part of the callback — stub it out.
            fetchStub.resolves({ ok: false, status: 503, json: async () => ({}) } as Response);

            const service = new DbmnAuthService(context);
            await service.handleAuthCallback(accessToken, 'refresh-token-abc');

            expect(store.get(DBMN_STORAGE_KEYS.lastEmail)).to.equal('callback@example.com');
            // Sanity: the VS Code context flag also got flipped.
            expect(executeCommandStub.calledWith('setContext', 'dbmn.isDbmnAuthenticated', true)).to.equal(true);
        });
    });

    describe('getLastEmail', () => {
        it('returns the persisted value', () => {
            const { context, store } = fakeContext();
            store.set(DBMN_STORAGE_KEYS.lastEmail, 'kept@example.com');

            const service = new DbmnAuthService(context);
            expect(service.getLastEmail()).to.equal('kept@example.com');
        });

        it('returns undefined on a fresh install', () => {
            const { context } = fakeContext();
            const service = new DbmnAuthService(context);
            expect(service.getLastEmail()).to.equal(undefined);
        });
    });
});
