// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { awaitOAuthCallback, deliverOAuthCallback, OAuthSignInError } from '../../../services/oauth/oauth-callback';

/** #361: the browser's answer reaches the waiting sign-in: errors at once, and only its own code. */
describe('OAuth callback hand-off (#361)', () => {
    const params = (q: string) => new URLSearchParams(q);

    it('an error from the sign-in page fails the sign-in at once, with the server\'s description', async () => {
        const started = Date.now();
        const { code } = awaitOAuthCallback('s1', 60_000);
        expect(deliverOAuthCallback(params('error=access_denied&error_description=The+user+cancelled&state=s1'))).to.equal('failed');
        const error = await code.then(() => null, e => e);
        expect(error).to.be.instanceOf(OAuthSignInError);
        expect(error.message).to.equal('Sign-in failed: The user cancelled');
        expect(error.error).to.equal('access_denied');
        expect(Date.now() - started, 'no waiting for the timeout').to.be.lessThan(1_000);
    });

    it('an error without a description says the error code', async () => {
        const { code } = awaitOAuthCallback('s2', 60_000);
        deliverOAuthCallback(params('error=invalid_scope&state=s2'));
        expect((await code.catch(e => e)).message).to.equal('Sign-in failed: invalid_scope');
    });

    it('its own code continues the sign-in', async () => {
        const { code } = awaitOAuthCallback('s3', 60_000);
        expect(deliverOAuthCallback(params('code=abc&state=s3'))).to.equal('delivered');
        expect(await code).to.equal('abc');
    });

    it('a code for another sign-in (state mismatch) is ignored, and the real one still lands', async () => {
        const logs: string[] = [];
        const { code } = awaitOAuthCallback('mine', 60_000);
        expect(deliverOAuthCallback(params('code=forged&state=theirs'), m => logs.push(m))).to.equal('ignored');
        expect(deliverOAuthCallback(params('error=access_denied&state=theirs'))).to.equal('ignored');
        expect(deliverOAuthCallback(params('code=real&state=mine'))).to.equal('delivered');
        expect(await code).to.equal('real');
        expect(logs.join()).to.contain('state does not match');
    });

    it('a server that drops state still signs in, with a warning', async () => {
        const logs: string[] = [];
        const { code } = awaitOAuthCallback('s4', 60_000);
        expect(deliverOAuthCallback(params('code=xyz'), m => logs.push(m))).to.equal('delivered');
        expect(await code).to.equal('xyz');
        expect(logs.join()).to.contain('no state');
    });

    it('no sign-in waiting: nothing to deliver to', () => {
        expect(deliverOAuthCallback(params('code=late&state=x'))).to.equal('no-sign-in');
    });

    it('a sign-in is answered once: a second callback finds nobody waiting', async () => {
        const { code } = awaitOAuthCallback('s5', 60_000);
        deliverOAuthCallback(params('code=one&state=s5'));
        await code;
        expect(deliverOAuthCallback(params('code=two&state=s5'))).to.equal('no-sign-in');
    });

    it('times out with a clear message, and cancel stops waiting', async () => {
        const slow = awaitOAuthCallback('s6', 20);
        expect((await slow.code.catch(e => e)).message).to.match(/timed out/);
        const cancelled = awaitOAuthCallback('s7', 60_000);
        cancelled.cancel('Authentication cancelled by user');
        expect((await cancelled.code.catch(e => e)).message).to.equal('Authentication cancelled by user');
        expect(deliverOAuthCallback(params('code=c&state=s7'))).to.equal('no-sign-in');
    });
});
