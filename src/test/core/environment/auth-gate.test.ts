// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { AuthGate, authExpiredModal, type AuthExpiredChoice, type AuthGatePorts } from '../../../services/environment/auth-gate';
import type { EnvironmentConfig } from '../../../environmentManager';

/** #311/#343: one gate for both hosts. A run without usable credentials asks first. */
function gate(choice: AuthExpiredChoice, signedIn = false) {
    const calls: string[] = [];
    let token: string | undefined;
    const ports: AuthGatePorts = {
        environments: {
            getEnvironment: async id => ({ id, name: 'Sample Store', authMethod: 'oauth' } as EnvironmentConfig),
            getAllEnvironments: async () => [],
            getEnvironmentToken: async () => token
        },
        oauth: {
            isSignedIn: async () => signedIn,
            signIn: async id => { calls.push(`sign in ${id}`); token = 'signed-in'; }
        },
        dbmn: { isSignedIn: () => true },
        isTokenExpired: () => false,
        promptAuthExpired: async name => { calls.push(`asked about ${name}`); return choice; },
        toast: { warn: m => calls.push(`warn ${m}`), error: m => calls.push(`error ${m}`) },
        log: { info: () => undefined, warn: () => undefined, error: () => undefined }
    };
    return { gate: new AuthGate(ports), calls };
}

const env = { id: 'env-ss', name: 'Sample Store', authMethod: 'oauth' } as const;

describe('AuthGate (#311, #343)', () => {
    it('signed in: the run goes ahead without asking', async () => {
        const { gate: g, calls } = gate(undefined, true);
        expect(await g.ensureAuthenticated(env)).to.equal(true);
        expect(calls).to.deep.equal([]);
    });

    it('OAuth without a token: asks; Sign In signs in, then the run goes ahead', async () => {
        const { gate: g, calls } = gate('Sign In');
        expect(await g.ensureAuthenticated(env)).to.equal(true);
        expect(calls).to.deep.equal(['asked about Sample Store', 'sign in env-ss']);
    });

    it('Continue runs anyway; closing the prompt stops the run', async () => {
        expect(await gate('Continue').gate.ensureAuthenticated(env)).to.equal(true);
        expect(await gate(undefined).gate.ensureAuthenticated(env)).to.equal(false);
    });

    it('a failed sign-in stops the run and says why', async () => {
        const { gate: g, calls } = gate('Sign In');
        (g as unknown as { ports: AuthGatePorts }).ports.oauth.signIn = async () => { throw new Error('This system doesn\'t let a browser sign in (CORS).'); };
        expect(await g.ensureAuthenticated(env)).to.equal(false);
        expect(calls.at(-1)).to.equal('error Authentication failed: This system doesn\'t let a browser sign in (CORS).');
    });

    it('a stored batch is gated through its environment', async () => {
        const { gate: g, calls } = gate('Sign In');
        expect(await g.ensureAuthenticatedForBatch({ environmentId: 'env-ss' })).to.equal(true);
        expect(calls).to.include('sign in env-ss');
    });
});

// GitHub Issue #396: the environment's own sign-in and the DBMN account are different things.
describe('AuthGate — the DBMN account is not the environment (#396)', () => {
    const playground = { id: 'env-pg', name: 'DBMN Playground', authMethod: 'dbmn' } as const;

    function dbmnGate(signedIn: boolean | Promise<boolean>, canSignIn = true) {
        const { gate: g, calls } = gate('Sign In');
        const ports = (g as unknown as { ports: AuthGatePorts }).ports;
        ports.dbmn = {
            isSignedIn: () => signedIn,
            ...(canSignIn ? { sendSignInLink: async () => { calls.push('DBMN sign-in opened'); } } : {})
        };
        return { gate: g, calls };
    }

    it('an environment that signs in with the DBMN account, session usable: no prompt', async () => {
        const { gate: g, calls } = dbmnGate(true);
        expect(await g.ensureAuthenticated(playground)).to.equal(true);
        expect(calls).to.deep.equal([]);
    });

    it('its session can no longer refresh: ONE prompt, the DBMN sign-in itself, and the run waits', async () => {
        const { gate: g, calls } = dbmnGate(Promise.resolve(false));
        expect(await g.isAuthenticationValid(playground)).to.equal(false);
        expect(await g.ensureAuthenticated(playground)).to.equal(false);
        expect(calls, 'no "sign in to the environment" modal in front of it').to.deep.equal(['DBMN sign-in opened']);
    });

    it('a host with no in-app DBMN sign-in still asks, as before', async () => {
        const { gate: g, calls } = dbmnGate(false, false);
        expect(await g.ensureAuthenticated(playground)).to.equal(true);
        expect(calls).to.deep.equal(['asked about DBMN Playground']);
    });

    it('the environment\'s prompt names the environment and says it is not the DBMN account', () => {
        const modal = authExpiredModal('Sample Store');
        expect(modal.title).to.equal('Sign in to Sample Store');
        expect(modal.body).to.contain('Your sign-in to "Sample Store" has expired.').and.to.match(/separate from your DBMN account/);
        expect(modal.actions.map(a => a.label)).to.deep.equal(['Continue', 'Sign In']);
    });
});
