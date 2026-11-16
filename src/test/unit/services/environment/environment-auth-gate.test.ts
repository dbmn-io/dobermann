// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #311: the environment auth gate — the one credential check
 * that Run, Resume and Reprocess all go through. Resume used to skip it, so
 * a batch that stopped on an expired token was resumed with the same token.
 */

import { expect } from 'chai';
import { stub, SinonStub } from 'sinon';
import { EnvironmentAuthGateService } from '../../../../services/environment/environment-auth-gate.service';
import { ServiceTokens } from '../../../../container/service-container.interface';
import { UIServiceTokens } from '../../../../container/ui-services-registry';
import { createMockLogger } from '../../../helpers/logging/mock-logger';

describe('EnvironmentAuthGateService (GitHub Issue #311)', () => {
    let prompt: SinonStub;
    let tokenExpired: boolean;
    let environments: any[];
    let gate: EnvironmentAuthGateService;
    let warned: string[];

    beforeEach(() => {
        prompt = stub().resolves(undefined);
        tokenExpired = true;
        warned = [];
        environments = [
            { id: 'env-jwt', name: 'Prod', authMethod: 'jwt' },
            { id: 'env-none', name: 'Open', authMethod: 'none' }
        ];
        const container = {
            resolve: (token: unknown) => {
                if (token === ServiceTokens.EnvironmentManager) {
                    return {
                        getEnvironment: async (id: string) => environments.find(e => e.id === id),
                        getAllEnvironments: async () => environments,
                        getEnvironmentToken: async () => 'header.payload.sig'
                    };
                }
                if (token === UIServiceTokens.TokenExpiryService) {
                    return { isTokenExpired: () => tokenExpired };
                }
                throw new Error(`unexpected token ${String(token)}`);
            }
        } as any;
        (global as any).dbmnToastService = { warn: (m: string) => warned.push(m), error: () => undefined, info: () => undefined };
        gate = new EnvironmentAuthGateService(container, createMockLogger(), { promptEnvAuthExpired: prompt });
    });

    afterEach(() => { delete (global as any).dbmnToastService; });

    it('a valid token passes without a prompt', async () => {
        tokenExpired = false;
        expect(await gate.ensureAuthenticated(environments[0])).to.equal(true);
        expect(prompt.called).to.equal(false);
    });

    it('no authentication passes without a prompt', async () => {
        expect(await gate.ensureAuthenticated(environments[1])).to.equal(true);
        expect(prompt.called).to.equal(false);
    });

    it('an expired token prompts; closing the prompt stops the run', async () => {
        expect(await gate.ensureAuthenticated(environments[0])).to.equal(false);
        expect(prompt.calledOnceWith('Prod')).to.equal(true);
    });

    it('"Continue" lets the run go ahead with the expired token', async () => {
        prompt.resolves('Continue');
        expect(await gate.ensureAuthenticated(environments[0])).to.equal(true);
    });

    it('"Sign In" on a JWT environment points at the environment settings and stops', async () => {
        prompt.resolves('Sign In');
        expect(await gate.ensureAuthenticated(environments[0])).to.equal(false);
        expect(warned[0]).to.include('JWT token');
    });

    // Issue #396: a DBMN-authenticated environment (the Training Ground) is signed in to with
    // the DBMN session itself. A session that exists but can no longer refresh passed this
    // gate, and the run then failed on HTTP 401 with no prompt at all.
    describe('an environment that signs in with the DBMN account', () => {
        const playground = { id: 'env-dbmn', name: 'DBMN Playground', authMethod: 'dbmn' as const };
        let signInModal: SinonStub;

        function withSession(status: 'success' | 'auth_error' | 'network_error', signedIn = true) {
            (global as any).dbmnAuthService = {
                isAuthenticated: () => signedIn,
                ensureValidSession: async () => (status === 'success' ? { status, session: {} } : { status })
            };
            signInModal = stub().resolves();
            gate = new EnvironmentAuthGateService({ resolve: () => { throw new Error('not needed'); } } as any, createMockLogger(),
                { promptEnvAuthExpired: prompt, sendDbmnSignInLinkInApp: signInModal });
        }

        afterEach(() => { delete (global as any).dbmnAuthService; });

        it('a live session passes without a prompt', async () => {
            withSession('success');
            expect(await gate.ensureAuthenticated(playground)).to.equal(true);
            expect(prompt.called).to.equal(false);
        });

        it('a session that can no longer refresh is not signed in', async () => {
            withSession('auth_error');
            expect(await gate.isAuthenticationValid(playground)).to.equal(false);
        });

        it('offline is not a reason to ask for sign-in', async () => {
            withSession('network_error');
            expect(await gate.isAuthenticationValid(playground)).to.equal(true);
        });

        it('one prompt, not two: it opens the DBMN sign-in directly, and the run waits for it', async () => {
            withSession('auth_error');
            expect(await gate.ensureAuthenticated(playground)).to.equal(false);
            expect(signInModal.calledOnce).to.equal(true);
            expect(prompt.called, 'no "authentication expired" modal in front of the sign-in').to.equal(false);
        });

        it('signed out altogether: the same single DBMN sign-in', async () => {
            withSession('auth_error', false);
            expect(await gate.ensureAuthenticated(playground)).to.equal(false);
            expect(signInModal.calledOnce).to.equal(true);
            expect(prompt.called).to.equal(false);
        });
    });

    describe('for a stored batch', () => {
        it('finds the environment by id and gates it', async () => {
            expect(await gate.ensureAuthenticatedForBatch({ environmentId: 'env-jwt', environment: 'Prod' })).to.equal(false);
            expect(prompt.calledOnce).to.equal(true);
        });

        it('falls back to the environment name for older batches', async () => {
            expect(await gate.ensureAuthenticatedForBatch({ environment: 'Prod' })).to.equal(false);
            expect(prompt.calledOnce).to.equal(true);
        });

        it('an environment that no longer exists cannot be checked — the batch goes ahead', async () => {
            expect(await gate.ensureAuthenticatedForBatch({ environmentId: 'gone', environment: 'Gone' })).to.equal(true);
            expect(prompt.called).to.equal(false);
        });
    });
});

// Issue #396: the DBMN account and the environment's own sign-in can lapse together.
