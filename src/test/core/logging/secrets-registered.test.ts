// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Dobermann issue 7: the secrets the app holds are registered with the log, so a secret is
 * removed whatever it is called. These go through the real pieces: the environment manager,
 * the request executor and the OAuth token request, each writing into a real AppLog.
 */
import { expect } from 'chai';
import * as sinon from 'sinon';
import { AppLog, type LogLine } from '../../../services/logging/app-log';
import { REMOVED } from '../../../services/logging/redact';
import { EnvironmentManager } from '../../../environmentManager';
import { memoryStoreContext } from '../../../platform/memory/memory-store-context';
import { FetchRequestExecutor } from '../../../services/execution/fetch-request-executor';
import { OAuthFlowHandler } from '../../../services/oauth/oauth-flow-handler';
import type { OAuthConfig } from '../../../types/oauth';
import type { APIEndpointConfig } from '../../../apiConfigManager';

/** Everything a person could copy or save from the log, as one text. */
const everything = (lines: readonly LogLine[]) => lines.map(l => JSON.stringify(l)).join('\n');

describe('Secrets the app holds never reach the log', () => {
    afterEach(() => sinon.restore());

    it('an environment\'s secret header under its own name, a secret variable, its client secret', async () => {
        const log = new AppLog();
        // as the catalogue keeps it: the header marked secret, the variable named in secretVariables
        const environments = new EnvironmentManager(memoryStoreContext({
            environments: {
                version: '1.2.0',
                folders: [],
                environments: [{
                    id: 'env-c', name: 'Customer Test', baseUrl: 'https://api.customer.test', isActive: true, createdAt: 1,
                    headers: { 'X-Company-Key': { value: 'ck_live_9f8e7d6c5b', enabled: true, secret: true } },
                    variables: { pin: '77441122', org: 'NORTH' },
                    secretVariables: ['pin'],
                    oauthConfig: { clientId: 'loader', clientSecret: 'cs-Very-Private-1', tokenUrl: 'https://login.customer.test/token' }
                }]
            }
        }));
        environments.setSecretSink(value => log.addSecret(value));
        await environments.getAllEnvironments();

        const logger = log.logger('environments', { environment: 'Customer Test' });
        logger.info('Sent with X-Company-Key ck_live_9f8e7d6c5b and pin 77441122 for org NORTH');
        logger.warn('Request failed', { headers: { 'X-Company-Key': 'ck_live_9f8e7d6c5b', 'X-Org': 'NORTH' }, note: 'cs-Very-Private-1' });

        const text = everything(log.recent());
        for (const secret of ['ck_live_9f8e7d6c5b', '77441122', 'cs-Very-Private-1']) expect(text, secret).to.not.contain(secret);
        expect(text).to.contain('NORTH');   // a variable that is not secret stays
        expect(log.recent()[0].message).to.equal(`Sent with X-Company-Key ${REMOVED} and pin ${REMOVED} for org NORTH`);
    });

    it('a token set or read for an environment (OAuth, a pasted JWT)', async () => {
        const log = new AppLog();
        const environments = new EnvironmentManager(memoryStoreContext());
        environments.setSecretSink(value => log.addSecret(value));
        await environments.setEnvironmentToken('env-1', 'opaque-token-not-a-jwt-123');
        log.write({ level: 'info', source: 'sign-in', message: 'got opaque-token-not-a-jwt-123 back' });
        expect(log.recent()[0].message).to.equal(`got ${REMOVED} back`);
    });

    it('the token a request is sent with, whatever the sign-in (here the DBMN account\'s)', async () => {
        const log = new AppLog();
        sinon.stub(globalThis, 'fetch').resolves(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
        const environment = { id: 'env-dbmn', name: 'Training Ground', baseUrl: 'https://training.test', authMethod: 'dbmn' };
        const executor = new FetchRequestExecutor({
            environments: { getEnvironment: async () => environment, getActiveEnvironment: async () => environment },
            getToken: async () => 'dbmn-session-token-abc123',
            secretSink: value => log.addSecret(value),
            logger: log.logger('run')
        });
        await executor.executeEndpoint({ id: 'e', name: 'Get', method: 'GET', path: '/items', headers: {} } as unknown as APIEndpointConfig, undefined, 'env-dbmn');
        log.write({ level: 'error', source: 'app', message: 'echoed dbmn-session-token-abc123' });
        expect(log.recent()).to.have.length.greaterThan(0);
        expect(everything(log.recent())).to.not.contain('dbmn-session-token-abc123');
    });

    // client-auth.ts sends a Basic header to the legacy host; its name is built from parts so the
    // public repo never spells it out
    const legacyHost = ['manh', 'com'].join('.');
    for (const [name, tokenUrl, usePKCE] of [
        ['Basic header (the legacy host rule)', `https://x.${legacyHost}/oauth/token`, false],
        ['secret in the body', 'https://login.customer.test/token', false]
    ] as const) {
        it(`an OAuth token request, ${name}: neither the secret nor its Basic form, nor the tokens back`, async () => {
            const log = new AppLog();
            log.addSecret('cs-Very-Private-1');
            sinon.stub(globalThis, 'fetch').resolves(new Response(
                JSON.stringify({ error: 'invalid_client', error_description: 'bad client', access_token: 'at-leaked-123456', refresh_token: 'rt-leaked-123456' }),
                { status: 401, headers: { 'content-type': 'application/json' } }
            ));
            const config = { provider: 'custom', authorizationUrl: 'https://login.customer.test/authorize', tokenUrl, clientId: 'loader', clientSecret: 'cs-Very-Private-1', flowType: 'authorization_code', usePKCE } as OAuthConfig;
            await new OAuthFlowHandler(log.logger('sign-in'), { redirectUri: () => 'https://app.example/cb' })
                .exchangeCodeForToken({ config, code: 'one-time-code-xyz', state: 's', codeVerifier: 'verifier-abcdefgh', environmentId: 'env-1' })
                .catch(() => undefined);
            const text = everything(log.recent());
            const basic = Buffer.from('loader:cs-Very-Private-1').toString('base64');
            expect(log.recent().length).to.be.greaterThan(0);
            for (const secret of ['cs-Very-Private-1', basic, 'at-leaked-123456', 'rt-leaked-123456', 'verifier-abcdefgh']) {
                expect(text, secret).to.not.contain(secret);
            }
        });
    }
});
