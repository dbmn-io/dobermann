// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #415 phase 3: OAuthConfigService hands a sign-in or a token request the environment's settings
 * with its Standard System's defaults read live, and checks the URLs against what the System requires.
 */
import { expect } from 'chai';
import type { EnvironmentConfig, EnvironmentManager } from '../../../environmentManager';
import type { SystemConfig } from '../../../data-loading/system-schema';
import { OAuthConfigService } from '../../../services/oauth/oauth-config.service';
import type { OAuthConfig } from '../../../types/oauth';

const samplewms: SystemConfig = {
    id: 'samplewms', name: 'samplewms', scope: 'global', createdAt: 0,
    config: { match: '^(?<instance>[a-z0-9-]+)\\.samplewms\\.test$', oauth: {
        authorizeUrl: 'https://{{instance}}-auth.samplewms.test/oauth/authorize', tokenUrl: 'https://{{instance}}-auth.samplewms.test/oauth/token',
        requiredPaths: { authorize: '/oauth/authorize', token: '/oauth/token' }, tokenRequest: { clientAuth: 'basic', headers: { Accept: '*/*' } }
    } }
};
const environments = (env: Partial<EnvironmentConfig>) => ({ getEnvironment: async () => env as EnvironmentConfig } as unknown as EnvironmentManager);
const systems = { getSystem: async (id: string) => (id === 'samplewms' ? samplewms : undefined) };

describe('#415 OAuthConfigService reads the Standard System live', () => {
    const own = { provider: 'custom', clientId: 'c', clientSecret: 's' } as unknown as OAuthConfig;

    it('an environment on a Standard System: its defaults filled from the address, the base URL added, the System\'s request headers along', async () => {
        const config = await new OAuthConfigService(environments({ id: 'e', baseUrl: 'https://acme.samplewms.test', systemId: 'samplewms', oauthConfig: own }), systems).getConfig('e');
        expect(config).to.include({ clientId: 'c', clientSecret: 's', baseUrl: 'https://acme.samplewms.test', authorizationUrl: 'https://acme-auth.samplewms.test/oauth/authorize', tokenUrl: 'https://acme-auth.samplewms.test/oauth/token', clientAuth: 'basic' });
        expect(config?.system).to.deep.equal({ name: 'samplewms', tokenRequestHeaders: { Accept: '*/*' }, requiredPaths: { authorize: '/oauth/authorize', token: '/oauth/token' } });
    });

    it('its own value wins; an environment on an own System, or a host with no Systems, gets what it saved', async () => {
        const mine = { ...own, tokenUrl: 'https://mine.example/token' };
        expect((await new OAuthConfigService(environments({ id: 'e', baseUrl: 'https://acme.samplewms.test', systemId: 'samplewms', oauthConfig: mine }), systems).getConfig('e'))?.tokenUrl).to.equal('https://mine.example/token');
        const ownSystem = await new OAuthConfigService(environments({ id: 'e', baseUrl: 'https://acme.samplewms.test', systemId: 'system_1', oauthConfig: own }), systems).getConfig('e');
        expect(ownSystem).to.deep.equal({ ...own, baseUrl: 'https://acme.samplewms.test' });
        const noSystems = await new OAuthConfigService(environments({ id: 'e', baseUrl: 'https://acme.samplewms.test', systemId: 'samplewms', oauthConfig: own })).getConfig('e');
        expect(noSystems).to.deep.equal({ ...own, baseUrl: 'https://acme.samplewms.test' });
        expect(await new OAuthConfigService(environments({ id: 'e', baseUrl: 'https://x.samplewms.test', systemId: 'samplewms' }), systems).getConfig('e'), 'no OAuth settings at all').to.equal(undefined);
    });

    it('validates the URLs against what the System requires, by name', async () => {
        const service = new OAuthConfigService(environments({}), systems);
        const good = await service.validateConfig({ ...own, authorizationUrl: 'https://a.example/oauth/authorize', tokenUrl: 'https://a.example/oauth/token', system: { name: 'samplewms', requiredPaths: { authorize: '/oauth/authorize', token: '/oauth/token' } } } as OAuthConfig);
        expect(good.errors).to.deep.equal([]);
        const bad = await service.validateConfig({ ...own, authorizationUrl: 'https://a.example/authorize', tokenUrl: 'https://a.example/token', system: { name: 'samplewms', requiredPaths: { authorize: '/oauth/authorize', token: '/oauth/token' } } } as OAuthConfig);
        expect(bad.errors).to.deep.equal(['The authorization URL should contain /oauth/authorize (samplewms)', 'The token URL should contain /oauth/token (samplewms)']);
        const none = await service.validateConfig({ ...own, authorizationUrl: 'https://a.example/authorize', tokenUrl: 'https://a.example/token' } as OAuthConfig);
        expect(none.errors, 'no System: no path rule').to.deep.equal([]);
    });
});
