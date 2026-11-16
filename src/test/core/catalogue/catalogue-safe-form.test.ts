// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #339: what may leave the machine. Endpoints are templates (no run counters); environments
 * lose secrets (#289 redaction), per-device state, and the values of anything marked secret.
 */
import { expect } from 'chai';
import type { APIEndpointConfig } from '../../../apiConfigManager';
import type { EnvironmentConfig } from '../../../environmentManager';
import { toCatalogueEndpoint, toCatalogueEnvironment, unmarkedSecretLookingNames } from '../../../services/catalogue/catalogue-safe-form';

function environment(fields: Partial<EnvironmentConfig> & { secretVariables?: string[]; token?: string }): EnvironmentConfig & { secretVariables?: string[] } {
    return { id: 'env-1', name: 'ACMAUS', baseUrl: 'https://acmaus.example.com', isActive: true, createdAt: 1, ...fields } as EnvironmentConfig;
}

describe('catalogue safe form (Issue #339)', () => {
    it('an endpoint keeps its template and loses its run counters', () => {
        const endpoint = {
            id: 'ep-1', name: 'Orders', path: '/orders', method: 'POST', headers: { Organization: 'ORG1' }, queryParams: {},
            body: '{"id": "{{id}}"}', tags: ['orders'], sequenceCounter: 41, arraySequenceCounters: { 'lines[]': 7 }
        } as unknown as APIEndpointConfig;

        const shared = toCatalogueEndpoint(endpoint);

        expect(shared).to.not.have.property('sequenceCounter');
        expect(shared).to.not.have.property('arraySequenceCounters');
        expect(shared).to.deep.include({ id: 'ep-1', path: '/orders', body: '{"id": "{{id}}"}', tags: ['orders'] });
        expect(endpoint.sequenceCounter, 'input untouched').to.equal(41);
    });

    it('an environment loses secrets (#289), session tokens and per-device state, and says credentials are needed', () => {
        const env = environment({
            authMethod: 'oauth',
            oauthConfig: { clientId: 'dbmn-client', clientSecret: 'shh' } as EnvironmentConfig['oauthConfig'],
            googleServiceAccountConfig: { client_email: 'svc@x', private_key: '-----KEY-----', private_key_id: 'k1' } as unknown as EnvironmentConfig['googleServiceAccountConfig'],
            token: 'session-token',
            lastUsed: 123
        });

        const shared = toCatalogueEnvironment(env) as unknown as Record<string, unknown>;

        expect(shared).to.not.have.any.keys('isActive', 'lastUsed', 'token', 'credentialsRedacted');
        expect((shared.oauthConfig as Record<string, unknown>).clientSecret).to.equal(undefined);
        expect((shared.oauthConfig as Record<string, unknown>).clientId).to.equal('dbmn-client');
        expect(shared.googleServiceAccountConfig).to.deep.equal({ client_email: 'svc@x' });
        expect(shared.credentialsRequired).to.equal(true);
        expect(shared.baseUrl).to.equal('https://acmaus.example.com');
        expect(env.oauthConfig?.clientSecret, 'input untouched').to.equal('shh');
    });

    it('header and variable values marked secret are shared by name only', () => {
        const env = environment({
            headers: {
                Organization: { value: 'ORG1', enabled: true },
                'X-Api-Key': { value: 'abc123', enabled: true, secret: true } as { value: string; enabled: boolean }
            },
            variables: { region: 'au', password: 'hunter2' },
            secretVariables: ['password']
        });

        const shared = toCatalogueEnvironment(env);

        expect(shared.headers).to.deep.equal({
            Organization: { value: 'ORG1', enabled: true },
            'X-Api-Key': { value: '', enabled: true, secret: true }
        });
        expect(shared.variables).to.deep.equal({ region: 'au', password: '' });
        expect(shared.secretVariables).to.deep.equal(['password']);
        expect(shared.credentialsRequired).to.equal(undefined);
    });

    it('flags names that look secret but are not marked, so the upload can ask first', () => {
        const env = environment({
            headers: { Authorization: { value: 'Bearer x', enabled: true }, Location: { value: 'DC1', enabled: true } },
            variables: { apiKey: 'k', region: 'au', token: '' }
        });
        expect(unmarkedSecretLookingNames(env)).to.deep.equal(['header Authorization', 'variable apiKey']);
    });
});
