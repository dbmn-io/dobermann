// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The token requests OAuthFlowHandler sends: what goes in them (#363) and what goes in the log (#369).
 */
import { expect } from 'chai';
import * as sinon from 'sinon';
import { OAuthFlowHandler } from '../../../services/oauth/oauth-flow-handler';
import type { IExtensionDiagnosticLogger } from '../../../services/logging/extension-diagnostic-logger.interface';
import type { OAuthConfig } from '../../../types/oauth';

const config = (overrides: Partial<OAuthConfig> = {}): OAuthConfig => ({
    provider: 'custom',
    authorizationUrl: 'https://login.example/authorize',
    tokenUrl: 'https://login.example/token',
    clientId: 'web-app',
    clientSecret: 's3cret-value',
    flowType: 'authorization_code',
    usePKCE: true,
    ...overrides
} as OAuthConfig);

describe('OAuthFlowHandler token requests', () => {
    let sent: { headers: Record<string, string>; body: URLSearchParams } | undefined;
    const logged: string[] = [];
    const logger = new Proxy({}, {
        get: () => (...args: unknown[]) => { logged.push(JSON.stringify(args)); }
    }) as IExtensionDiagnosticLogger;

    beforeEach(() => {
        sent = undefined;
        logged.length = 0;
        sinon.stub(globalThis, 'fetch').callsFake(async (_url, init) => {
            sent = { headers: init?.headers as Record<string, string>, body: new URLSearchParams(String(init?.body)) };
            return new Response(JSON.stringify({ access_token: 'at', token_type: 'Bearer', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
        });
    });
    afterEach(() => sinon.restore());

    const exchange = (c: OAuthConfig) => new OAuthFlowHandler(logger, { redirectUri: () => 'https://app.example/cb' })
        .exchangeCodeForToken({ config: c, code: 'the-code', state: 's', codeVerifier: 'the-verifier', environmentId: 'env-1' });

    it('#363: PKCE with a client secret sends both (a confidential client, e.g. Azure AD or Okta web apps)', async () => {
        await exchange(config());
        expect(sent?.body.get('code_verifier')).to.equal('the-verifier');
        expect(sent?.body.get('client_id')).to.equal('web-app');
        expect(sent?.body.get('client_secret')).to.equal('s3cret-value');
    });

    it('PKCE without a secret: a public client, client_id and verifier only', async () => {
        await exchange(config({ clientSecret: undefined }));
        expect(sent?.body.get('code_verifier')).to.equal('the-verifier');
        expect(sent?.body.get('client_id')).to.equal('web-app');
        expect(sent?.body.has('client_secret')).to.equal(false);
    });

    it('the legacy host rule (no setting yet) keeps Basic auth with PKCE', async () => {
        await exchange(config({ tokenUrl: 'https://x.manh.com/oauth/token' }));
        expect(sent?.headers['Authorization']).to.match(/^Basic /);
        expect(sent?.body.has('client_secret')).to.equal(false);
    });

    for (const [name, c] of [
        ['Basic (legacy host rule)', config({ tokenUrl: 'https://x.manh.com/oauth/token', usePKCE: false })],
        ['body', config({ usePKCE: false })],
        ['PKCE + secret', config()]
    ] as const) {
        it(`#369: the client secret is never logged (${name}), in clear or in its Basic form`, async () => {
            await exchange(c);
            const basic = Buffer.from('web-app:s3cret-value').toString('base64');
            const log = logged.join('\n');
            expect(log).not.to.contain('s3cret-value');
            expect(log).not.to.contain(basic);
        });
    }
});

describe('OAuthFlowHandler.refreshAccessToken (#359)', () => {
    afterEach(() => sinon.restore());

    it('resolves a relative token URL against the base URL, as the code exchange does', async () => {
        let url = '';
        sinon.stub(globalThis, 'fetch').callsFake(async input => {
            url = String(input);
            return new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt2' }), { status: 200 });
        });
        const token = await new OAuthFlowHandler().refreshAccessToken({ config: config({ tokenUrl: '/oauth/token', baseUrl: 'https://api.example/v1' }), refreshToken: 'rt1', environmentId: 'env-1' });
        expect(url).to.equal('https://api.example/oauth/token');
        expect(token.refresh_token).to.equal('rt2');
    });

    it('a 400 (invalid_grant) is a refusal; a 503 is not', async () => {
        const answer = sinon.stub(globalThis, 'fetch');
        answer.onFirstCall().resolves(new Response('{"error":"invalid_grant"}', { status: 400 }));
        answer.onSecondCall().resolves(new Response('busy', { status: 503 }));
        const flow = new OAuthFlowHandler();
        const refusedOrNot = async () => {
            try { await flow.refreshAccessToken({ config: config(), refreshToken: 'rt', environmentId: 'env-1' }); return 'ok'; }
            catch (error) { return (error as { refused?: boolean }).refused; }
        };
        expect(await refusedOrNot()).to.equal(true);
        expect(await refusedOrNot()).to.equal(false);
    });
});

describe('#415: client authentication is the environment\'s own setting', () => {
    let sent: { headers: Record<string, string>; body: URLSearchParams } | undefined;
    beforeEach(() => {
        sent = undefined;
        sinon.stub(globalThis, 'fetch').callsFake(async (_url, init) => {
            sent = { headers: init?.headers as Record<string, string>, body: new URLSearchParams(String(init?.body)) };
            return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', token_type: 'Bearer', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
        });
    });
    afterEach(() => sinon.restore());

    const flow = () => new OAuthFlowHandler(undefined, { redirectUri: () => 'https://app.example/cb' });
    const exchange = (c: OAuthConfig) => flow().exchangeCodeForToken({ config: c, code: 'the-code', state: 's', codeVerifier: 'the-verifier', environmentId: 'env-1' });
    const refresh = (c: OAuthConfig) => flow().refreshAccessToken({ config: c, refreshToken: 'rt1', environmentId: 'env-1' });

    it('"basic": an Authorization header on any token URL, with PKCE too, and no client_id in the form', async () => {
        await exchange(config({ clientAuth: 'basic' }));
        expect(sent?.headers['Authorization']).to.equal(`Basic ${Buffer.from('web-app:s3cret-value').toString('base64')}`);
        expect(sent?.body.get('client_id')).to.equal(null);
        expect(sent?.body.get('code_verifier')).to.equal('the-verifier');
    });

    it('"body" wins over the legacy rule: a manh.com token URL gets client_id and client_secret in the form', async () => {
        await exchange(config({ clientAuth: 'body', tokenUrl: 'https://x.manh.com/oauth/token', usePKCE: false }));
        expect(sent?.headers['Authorization']).to.equal(undefined);
        expect(sent?.body.get('client_id')).to.equal('web-app');
        expect(sent?.body.get('client_secret')).to.equal('s3cret-value');
    });

    it('no setting yet: the legacy rule decides, until phase 3 deletes it', async () => {
        await exchange(config({ tokenUrl: 'https://x.manh.com/oauth/token', usePKCE: false }));
        expect(sent?.headers['Authorization']).to.match(/^Basic /);
        await exchange(config({ usePKCE: false }));
        expect(sent?.headers['Authorization']).to.equal(undefined);
        expect(sent?.body.get('client_secret')).to.equal('s3cret-value');
    });

    it('the refresh request follows the same setting', async () => {
        await refresh(config({ clientAuth: 'basic' }));
        expect(sent?.headers['Authorization']).to.match(/^Basic /);
        expect(sent?.body.get('client_secret')).to.equal(null);
        await refresh(config({ clientAuth: 'body', tokenUrl: 'https://x.manh.com/oauth/token' }));
        expect(sent?.headers['Authorization']).to.equal(undefined);
        expect(sent?.body.get('client_secret')).to.equal('s3cret-value');
    });
});

describe('#415 phase 4: token request headers come from the Standard System and the environment', () => {
    let sent: { headers: Record<string, string> } | undefined;
    beforeEach(() => {
        sent = undefined;
        sinon.stub(globalThis, 'fetch').callsFake(async (_url, init) => {
            sent = { headers: init?.headers as Record<string, string> };
            return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt' }), { status: 200, headers: { 'content-type': 'application/json' } });
        });
    });
    afterEach(() => sinon.restore());
    const flow = (userAgent?: string) => new OAuthFlowHandler(undefined, { redirectUri: () => 'https://app.example/cb', userAgent: () => userAgent });
    const system = { name: 'samplewms', tokenRequestHeaders: { Accept: '*/*', 'X-Who': 'system' } };

    it('our User-Agent, then the System\'s headers, then the environment\'s own, which win; on the exchange and the refresh alike', async () => {
        await flow('Dobermann/1.2.3').exchangeCodeForToken({ config: config({ system, tokenRequestHeaders: { 'X-Who': 'environment' } }), code: 'c', state: 's', codeVerifier: 'v', environmentId: 'env-1' });
        expect(sent?.headers).to.include({ 'User-Agent': 'Dobermann/1.2.3', Accept: '*/*', 'X-Who': 'environment', 'Content-Type': 'application/x-www-form-urlencoded' });
        await flow('Dobermann/1.2.3').refreshAccessToken({ config: config({ system }), refreshToken: 'rt', environmentId: 'env-1' });
        expect(sent?.headers).to.include({ 'User-Agent': 'Dobermann/1.2.3', Accept: '*/*', 'X-Who': 'system' });
    });

    it('no System and no User-Agent of our own (the browser): the plain request, and nothing from any past rule', async () => {
        await flow().exchangeCodeForToken({ config: config({ tokenUrl: 'https://x.manh.com/oauth/token' }), code: 'c', state: 's', codeVerifier: 'v', environmentId: 'env-1' });
        expect(sent?.headers).to.deep.include({ Accept: 'application/json' });
        expect(sent?.headers).to.not.have.property('User-Agent');
        expect(sent?.headers).to.not.have.property('Cache-Control');
    });
});
