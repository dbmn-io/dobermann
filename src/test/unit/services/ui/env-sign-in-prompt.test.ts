// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { promptEnvAuthExpired, DbmnModalSpec, DbmnModalResult } from '../../../../services/ui/dbmn-prompts';

/**
 * GitHub Issue #396: an environment's own sign-in and the DBMN account are two different
 * things. The environment's prompt names the environment and says so; it used to be titled
 * "Authentication expired", which reads the same as an expired DBMN sign-in.
 */
describe('Environment sign-in prompt names the environment (#396)', () => {
    let shown: DbmnModalSpec[];

    function installBridge(result: DbmnModalResult): void {
        shown = [];
        (globalThis as Record<string, unknown>).dbmnShowModal = async (spec: DbmnModalSpec) => { shown.push(spec); return result; };
    }

    afterEach(() => { delete (globalThis as Record<string, unknown>).dbmnShowModal; });

    it('the title is the environment to sign in to, and the body says it is not the DBMN account', async () => {
        installBridge({ actionId: 'sign-in', fields: {} });
        expect(await promptEnvAuthExpired('Sample Store')).to.equal('Sign In');
        expect(shown[0].title).to.equal('Sign in to Sample Store');
        expect(shown[0].body).to.contain('Your sign-in to "Sample Store" has expired.');
        expect(shown[0].body).to.match(/separate from your DBMN account/);
    });

    it('Continue and dismiss still mean what they did', async () => {
        installBridge({ actionId: 'continue', fields: {} });
        expect(await promptEnvAuthExpired('Sample Store')).to.equal('Continue');
        installBridge({ actionId: 'dismiss', fields: {} });
        expect(await promptEnvAuthExpired('Sample Store')).to.equal(undefined);
    });
});
