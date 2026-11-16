// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
    CREDENTIALS_REDACTED_FIELD,
    EnvironmentWithRedaction,
    describeCredentialsNeeded,
    hasExportableCredentials,
    redactEnvironmentForExport,
    redactedEnvironmentNames,
    takeRedactionMarker
} from '../../../../services/import-export/credential-redaction';
import { EnvironmentConfig } from '../../../../environmentManager';

/**
 * GitHub Issue #289 — exports carried OAuth client secrets and Google
 * service-account private keys in plaintext while the docs promised they were
 * stripped. Credentials are now removed unless explicitly opted in.
 */

function oauthEnvironment(fields: Partial<EnvironmentConfig> = {}): EnvironmentConfig {
    return {
        id: 'env-1',
        name: 'Staging',
        isActive: false,
        createdAt: 0,
        authMethod: 'oauth',
        oauthConfig: {
            provider: 'custom',
            authorizationUrl: '/oauth/authorize',
            tokenUrl: '/oauth/token',
            clientId: 'dbmn-client',
            clientSecret: 'super-secret-value',
            flowType: 'client_credentials',
            usePKCE: false
        },
        ...fields
    } as EnvironmentConfig;
}

function serviceAccountEnvironment(fields: Partial<EnvironmentConfig> = {}): EnvironmentConfig {
    return {
        id: 'env-2',
        name: 'Prod',
        isActive: false,
        createdAt: 0,
        authMethod: 'google-service-account',
        googleServiceAccountConfig: {
            type: 'service_account',
            project_id: 'acme-prod',
            private_key_id: 'key-abc123',
            private_key: '-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----\n',
            client_email: 'dbmn@acme-prod.iam.gserviceaccount.com',
            client_id: '1234567890',
            auth_uri: 'https://accounts.google.com/o/oauth2/auth',
            token_uri: 'https://oauth2.googleapis.com/token',
            auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
            client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/dbmn'
        },
        ...fields
    } as EnvironmentConfig;
}

describe('credential redaction (#289)', () => {
    describe('session tokens', () => {
        it('removes tokens whether or not credentials are included', () => {
            const env = oauthEnvironment({
                token: 'jwt-value',
                accessToken: 'access-value',
                refreshToken: 'refresh-value'
            } as Partial<EnvironmentConfig>);

            for (const includeCredentials of [true, false]) {
                const exported = redactEnvironmentForExport(env, includeCredentials) as unknown as Record<string, unknown>;
                expect(exported.token, `token @ include=${includeCredentials}`).to.be.undefined;
                expect(exported.accessToken, `accessToken @ include=${includeCredentials}`).to.be.undefined;
                expect(exported.refreshToken, `refreshToken @ include=${includeCredentials}`).to.be.undefined;
            }
        });
    });

    describe('stripping by default', () => {
        it('removes the OAuth client secret but keeps the rest of the config', () => {
            const exported = redactEnvironmentForExport(oauthEnvironment(), false);

            expect(exported.oauthConfig?.clientSecret).to.be.undefined;
            expect(exported.oauthConfig?.clientId).to.equal('dbmn-client');
            expect(exported.oauthConfig?.tokenUrl).to.equal('/oauth/token');
        });

        it('removes the service-account private key but keeps the identifying fields', () => {
            const exported = redactEnvironmentForExport(serviceAccountEnvironment(), false);
            const config = exported.googleServiceAccountConfig as unknown as Record<string, unknown>;

            expect(config.private_key).to.be.undefined;
            expect(config.private_key_id).to.be.undefined;
            expect(config.project_id).to.equal('acme-prod');
            expect(config.client_email).to.equal('dbmn@acme-prod.iam.gserviceaccount.com');
        });

        it('marks the environment so import can flag it', () => {
            const exported = redactEnvironmentForExport(oauthEnvironment(), false);
            expect(exported[CREDENTIALS_REDACTED_FIELD]).to.equal(true);
        });

        it('does not mark an environment that had no credentials to remove', () => {
            const env = { id: 'env-3', name: 'Local', isActive: false, createdAt: 0 } as EnvironmentConfig;
            const exported = redactEnvironmentForExport(env, false);
            expect(exported[CREDENTIALS_REDACTED_FIELD]).to.be.undefined;
        });

        it('never mutates the stored environment', () => {
            const env = oauthEnvironment();
            redactEnvironmentForExport(env, false);

            expect(env.oauthConfig?.clientSecret).to.equal('super-secret-value');
            expect((env as EnvironmentWithRedaction)[CREDENTIALS_REDACTED_FIELD]).to.be.undefined;
        });

        it('leaves the service-account config on the stored environment intact', () => {
            const env = serviceAccountEnvironment();
            redactEnvironmentForExport(env, false);

            const config = env.googleServiceAccountConfig as unknown as Record<string, unknown>;
            expect(config.private_key).to.contain('BEGIN PRIVATE KEY');
            expect(config.private_key_id).to.equal('key-abc123');
        });
    });

    describe('opting in', () => {
        it('keeps the OAuth client secret and leaves no redaction marker', () => {
            const exported = redactEnvironmentForExport(oauthEnvironment(), true);

            expect(exported.oauthConfig?.clientSecret).to.equal('super-secret-value');
            expect(exported[CREDENTIALS_REDACTED_FIELD]).to.be.undefined;
        });

        it('keeps the service-account private key', () => {
            const exported = redactEnvironmentForExport(serviceAccountEnvironment(), true);
            const config = exported.googleServiceAccountConfig as unknown as Record<string, unknown>;

            expect(config.private_key).to.contain('BEGIN PRIVATE KEY');
            expect(config.private_key_id).to.equal('key-abc123');
        });
    });

    describe('hasExportableCredentials', () => {
        it('is true for an OAuth environment with a secret', () => {
            expect(hasExportableCredentials(oauthEnvironment())).to.equal(true);
        });

        it('is true for a service-account environment', () => {
            expect(hasExportableCredentials(serviceAccountEnvironment())).to.equal(true);
        });

        it('is false for an OAuth environment with no secret (PKCE)', () => {
            const env = oauthEnvironment();
            delete env.oauthConfig!.clientSecret;
            expect(hasExportableCredentials(env)).to.equal(false);
        });

        it('is false for an environment with no auth config at all', () => {
            const env = { id: 'env-4', name: 'Local', isActive: false, createdAt: 0 } as EnvironmentConfig;
            expect(hasExportableCredentials(env)).to.equal(false);
        });
    });

    describe('reporting', () => {
        it('names only the environments that were redacted', () => {
            const redacted = [
                redactEnvironmentForExport(oauthEnvironment(), false),
                redactEnvironmentForExport(serviceAccountEnvironment(), false),
                redactEnvironmentForExport(
                    { id: 'env-5', name: 'Local', isActive: false, createdAt: 0 } as EnvironmentConfig,
                    false
                )
            ];

            expect(redactedEnvironmentNames(redacted)).to.deep.equal(['Staging', 'Prod']);
        });

        it('returns no names when credentials were included', () => {
            const included = [redactEnvironmentForExport(oauthEnvironment(), true)];
            expect(redactedEnvironmentNames(included)).to.deep.equal([]);
        });

        it('takes the marker off and reports it', () => {
            const exported = redactEnvironmentForExport(oauthEnvironment(), false);

            expect(takeRedactionMarker(exported)).to.equal(true);
            expect(CREDENTIALS_REDACTED_FIELD in exported).to.equal(false);
            // Second call sees nothing left
            expect(takeRedactionMarker(exported)).to.equal(false);
        });

        it('describes one environment in the singular', () => {
            expect(describeCredentialsNeeded(['Staging']))
                .to.contain('Environment "Staging"')
                .and.to.contain('re-enter');
        });

        it('describes several environments with a count', () => {
            const message = describeCredentialsNeeded(['Staging', 'Prod']) as string;
            expect(message).to.contain('2 environments');
            expect(message).to.contain('Staging, Prod');
        });

        it('says nothing when no environment needs credentials', () => {
            expect(describeCredentialsNeeded([])).to.be.undefined;
        });
    });
});
