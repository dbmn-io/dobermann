// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #415 phase 3: a Standard System's sign-in, read live: templates from the address, the
 * environment's own values on top, and only those stored.
 */
import { expect } from 'chai';
import type { SystemConfig } from '../../../data-loading/system-schema';
import type { OAuthConfig } from '../../../types/oauth';
import { fillTemplate, ownOAuthValues, resolveOAuthConfig, systemOAuthDefaults, templateValues } from '../../../services/systems/system-oauth';

const samplewms: SystemConfig = {
    id: 'samplewms', name: 'samplewms', scope: 'global', createdAt: 0,
    config: {
        match: '^(?<instance>[a-z0-9-]+)\\.samplewms\\.test$',
        oauth: {
            authorizeUrl: 'https://{{instance}}-auth.samplewms.test/oauth/authorize',
            tokenUrl: 'https://{{instance}}-auth.samplewms.test/oauth/token',
            scopes: ['openid', 'profile', 'email'], pkce: false, flow: 'authorization_code', realm: 'sample',
            requiredPaths: { authorize: '/oauth/authorize', token: '/oauth/token' },
            tokenRequest: { clientAuth: 'basic', headers: { Accept: '*/*' } }
        }
    }
};
const env = { baseUrl: 'https://acme.samplewms.test/api' };

describe('#415 a Standard System\'s sign-in, read live', () => {
    it('fills templates from the address: the pattern\'s named groups, the host and the origin', () => {
        const values = templateValues(env.baseUrl, { match: samplewms.config!.match as string });
        expect(values).to.deep.equal({ host: 'acme.samplewms.test', origin: 'https://acme.samplewms.test', instance: 'acme' });
        expect(fillTemplate('https://{{instance}}-auth.samplewms.test/x', values!)).to.equal('https://acme-auth.samplewms.test/x');
        expect(fillTemplate('{{ origin }}/oauth/token', values!)).to.equal('https://acme.samplewms.test/oauth/token');
        expect(fillTemplate('https://{{tenant}}.x', values!), 'a name nothing fills: no default').to.equal(undefined);
        expect(templateValues('not a url', {})).to.equal(undefined);
        const optional = templateValues('https://acme.example.test', { match: '^(?<instance>[a-z0-9-]+)(?<region>\\.eu)?\\.example\\.test$' });
        expect(optional, 'an optional group that took no part fills as nothing').to.deep.equal({ host: 'acme.example.test', origin: 'https://acme.example.test', instance: 'acme', region: '' });
        expect(fillTemplate('https://{{instance}}-auth{{region}}.example.test', optional!)).to.equal('https://acme-auth.example.test');
    });

    it('a Standard System\'s defaults for an environment at an address; an own System or one that says nothing about sign-in has none', () => {
        const defaults = systemOAuthDefaults(env, samplewms);
        expect(defaults).to.deep.equal({
            systemName: 'samplewms',
            authorizationUrl: 'https://acme-auth.samplewms.test/oauth/authorize',
            tokenUrl: 'https://acme-auth.samplewms.test/oauth/token',
            scopes: ['openid', 'profile', 'email'], flowType: 'authorization_code', usePKCE: false, clientAuth: 'basic', realm: 'sample',
            tokenRequestHeaders: { Accept: '*/*' }, requiredPaths: { authorize: '/oauth/authorize', token: '/oauth/token' }
        });
        expect(systemOAuthDefaults({ baseUrl: 'https://erp.example.com' }, samplewms)?.authorizationUrl, 'address outside the pattern: no URL default').to.equal(undefined);
        expect(systemOAuthDefaults(env, { ...samplewms, scope: undefined })).to.equal(undefined);
        expect(systemOAuthDefaults(env, { id: 'bare', name: 'bare', scope: 'global', createdAt: 0, config: { match: 'x' } })).to.equal(undefined);
        expect(systemOAuthDefaults(env, undefined)).to.equal(undefined);
    });

    it('resolves: the System underneath, the user\'s own values on top, and the System\'s request-only parts in `system`', () => {
        const own = { provider: 'custom', clientId: 'c', clientSecret: 's', tokenUrl: 'https://mine.example/token', scopes: [] } as unknown as OAuthConfig;
        const resolved = resolveOAuthConfig(own, systemOAuthDefaults(env, samplewms))!;
        expect(resolved).to.include({ clientId: 'c', clientSecret: 's', authorizationUrl: 'https://acme-auth.samplewms.test/oauth/authorize', tokenUrl: 'https://mine.example/token', flowType: 'authorization_code', usePKCE: false, clientAuth: 'basic' });
        expect(resolved.scopes, 'an empty own list counts as not set').to.deep.equal(['openid', 'profile', 'email']);
        expect(resolved.providerConfig).to.deep.equal({ realm: 'sample' });
        expect(resolved.system).to.deep.equal({ name: 'samplewms', tokenRequestHeaders: { Accept: '*/*' }, requiredPaths: { authorize: '/oauth/authorize', token: '/oauth/token' } });
        expect(resolveOAuthConfig(own, undefined), 'no Standard System: as saved').to.equal(own);
    });

    it('stores only the user\'s own values: what equals the System\'s default is the System\'s', () => {
        const defaults = systemOAuthDefaults(env, samplewms);
        const fromPage = {
            provider: 'custom', clientId: 'c', authorizationUrl: 'https://acme-auth.samplewms.test/oauth/authorize',
            tokenUrl: 'https://mine.example/token', scopes: ['openid', 'profile', 'email'], flowType: 'authorization_code', usePKCE: false, clientAuth: 'body',
            system: { name: 'samplewms' }
        } as unknown as OAuthConfig;
        expect(ownOAuthValues(fromPage, defaults)).to.deep.equal({ provider: 'custom', clientId: 'c', tokenUrl: 'https://mine.example/token', clientAuth: 'body' });
        expect(ownOAuthValues(fromPage, undefined), 'no System: everything is the user\'s, bar the request-only part').to.not.have.property('system');
        expect(ownOAuthValues(fromPage, undefined)).to.include({ authorizationUrl: 'https://acme-auth.samplewms.test/oauth/authorize' });
    });
});
