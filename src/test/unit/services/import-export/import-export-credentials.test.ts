// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';
import * as JSZip from 'jszip';
import { ImportExportService } from '../../../../services/import-export/import-export.service';
import { ImportItem, ExportMetadata } from '../../../../services/import-export/import-export.service.interface';
import { IFileSink, FileSaveRequest } from '../../../../services/io/file-sink.interface';
import { EnvironmentConfig } from '../../../../environmentManager';

/**
 * GitHub Issue #289 — the wiring, not just the helper: an export must not
 * write OAuth client secrets or Google service-account private keys into the
 * ZIP unless the user opted in, and an import must flag what needs re-keying.
 */

const SECRET = 'super-secret-value';
const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----\n';

function oauthEnv(fields: Partial<EnvironmentConfig> = {}): EnvironmentConfig {
    return {
        id: 'env-1',
        name: 'Staging',
        baseUrl: 'https://orders.acme.com',
        isActive: false,
        createdAt: 0,
        authMethod: 'oauth',
        oauthConfig: {
            provider: 'custom',
            authorizationUrl: '/oauth/authorize',
            tokenUrl: '/oauth/token',
            clientId: 'dbmn-client',
            clientSecret: SECRET,
            flowType: 'client_credentials',
            usePKCE: false
        },
        ...fields
    } as EnvironmentConfig;
}

function serviceAccountEnv(fields: Partial<EnvironmentConfig> = {}): EnvironmentConfig {
    return {
        id: 'env-2',
        name: 'Prod',
        baseUrl: 'https://prod.acme.com',
        isActive: false,
        createdAt: 0,
        authMethod: 'google-service-account',
        googleServiceAccountConfig: {
            type: 'service_account',
            project_id: 'acme-prod',
            private_key_id: 'key-abc123',
            private_key: PRIVATE_KEY,
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

interface Written {
    environments: Partial<EnvironmentConfig>[];
    zips: FileSaveRequest[];
}

function makeService(seed: { environments?: EnvironmentConfig[] }) {
    const written: Written = { environments: [], zips: [] };

    const endpointManager = {
        getAllEndpoints: async () => [],
        addEndpoint: async (config: unknown) => ({ ...(config as object), id: 'ep-new' }),
        updateEndpoint: async (_id: string, config: unknown) => config
    };
    const environmentManager = {
        getAllEnvironments: async () => seed.environments ?? [],
        addEnvironment: async (config: Partial<EnvironmentConfig>) => {
            written.environments.push(config);
            return { ...config, id: 'env-new' };
        },
        updateEnvironment: async (_id: string, config: Partial<EnvironmentConfig>) => {
            written.environments.push(config);
            return config;
        }
    };
    const sink: IFileSink = {
        save: async request => {
            written.zips.push(request);
            return { saved: true, path: '/tmp/export.dbmn.zip' };
        }
    };
    const logger = { info() {}, error() {}, debug() {}, warn() {} };
    const context = { extension: { packageJSON: { version: '0.0.0-test' } } };

    const service = new ImportExportService(
        endpointManager as never,
        environmentManager as never,
        undefined as never,
        context as never,
        logger as never,
        sink
    );
    return { service, written };
}

async function readZipJson<T>(request: FileSaveRequest, file: string): Promise<T> {
    const zip = await JSZip.loadAsync(request.data);
    return JSON.parse(await zip.file(file)!.async('string')) as T;
}

/** The raw bytes of the ZIP entry — catches a secret hiding anywhere in the file. */
async function readZipText(request: FileSaveRequest, file: string): Promise<string> {
    const zip = await JSZip.loadAsync(request.data);
    return zip.file(file)!.async('string');
}

async function exportEnvironments(
    environments: EnvironmentConfig[],
    includeCredentials?: boolean
) {
    const { service, written } = makeService({ environments });
    const result = await service.exportToZip({
        endpoints: [],
        environments: environments.map(e => e.id),
        includeConsoleSettings: false,
        includeCredentials,
        filename: 'export'
    });
    return { result, written };
}

describe('ImportExportService — credentials in exports (#289)', () => {
    describe('stripped by default', () => {
        it('writes no OAuth client secret into environments.json', async () => {
            const { result, written } = await exportEnvironments([oauthEnv()]);

            expect(result.success).to.equal(true);
            const raw = await readZipText(written.zips[0], 'environments.json');
            expect(raw).to.not.contain(SECRET);

            const parsed = await readZipJson<{ environments: EnvironmentConfig[] }>(
                written.zips[0], 'environments.json'
            );
            expect(parsed.environments[0].oauthConfig).to.not.have.property('clientSecret');
            // the rest of the config still travels, so the recipient can re-key it
            expect(parsed.environments[0].oauthConfig?.clientId).to.equal('dbmn-client');
        });

        it('writes no service-account private key into environments.json', async () => {
            const { written } = await exportEnvironments([serviceAccountEnv()]);

            const raw = await readZipText(written.zips[0], 'environments.json');
            expect(raw).to.not.contain(PRIVATE_KEY);
            expect(raw).to.not.contain('key-abc123');

            const parsed = await readZipJson<{ environments: EnvironmentConfig[] }>(
                written.zips[0], 'environments.json'
            );
            const config = parsed.environments[0].googleServiceAccountConfig as unknown as Record<string, unknown>;
            expect(config).to.not.have.property('private_key');
            expect(config).to.not.have.property('private_key_id');
            expect(config.client_email).to.equal('dbmn@acme-prod.iam.gserviceaccount.com');
        });

        it('reports which environments were redacted', async () => {
            const { result } = await exportEnvironments([oauthEnv(), serviceAccountEnv()]);

            expect(result.credentialsIncluded).to.equal(false);
            expect(result.redactedEnvironments).to.deep.equal(['Staging', 'Prod']);
        });

        it('says in the metadata that credentials were removed', async () => {
            const { written } = await exportEnvironments([oauthEnv()]);
            const metadata = await readZipJson<ExportMetadata>(written.zips[0], 'metadata.json');

            expect(metadata.warnings!.join(' ')).to.contain('removed');
            expect(metadata.warnings!.join(' ')).to.not.contain('included - handle with care');
        });

        it('leaves the stored environment untouched', async () => {
            const stored = oauthEnv();
            await exportEnvironments([stored]);

            expect(stored.oauthConfig?.clientSecret).to.equal(SECRET);
        });
    });

    describe('opted in', () => {
        it('keeps both credentials in the file', async () => {
            const { result, written } = await exportEnvironments(
                [oauthEnv(), serviceAccountEnv()], true
            );

            const raw = await readZipText(written.zips[0], 'environments.json');
            expect(raw).to.contain(SECRET);
            expect(raw).to.contain('BEGIN PRIVATE KEY');
            expect(result.credentialsIncluded).to.equal(true);
            expect(result.redactedEnvironments).to.deep.equal([]);
        });

        it('warns in the metadata that the file holds secrets', async () => {
            const { written } = await exportEnvironments([oauthEnv()], true);
            const metadata = await readZipJson<ExportMetadata>(written.zips[0], 'metadata.json');

            expect(metadata.warnings!.join(' ')).to.contain('treat this file as a secret');
        });

        it('never exports session tokens even when opted in', async () => {
            const env = oauthEnv({
                token: 'jwt-value',
                accessToken: 'access-value',
                refreshToken: 'refresh-value'
            } as Partial<EnvironmentConfig>);
            const { written } = await exportEnvironments([env], true);

            const raw = await readZipText(written.zips[0], 'environments.json');
            expect(raw).to.not.contain('jwt-value');
            expect(raw).to.not.contain('access-value');
            expect(raw).to.not.contain('refresh-value');
        });
    });

    describe('importing a stripped export', () => {
        it('warns which environment needs its credentials re-entered', async () => {
            const { written: exported } = await exportEnvironments([oauthEnv()]);
            const parsed = await readZipJson<{ environments: EnvironmentConfig[] }>(
                exported.zips[0], 'environments.json'
            );

            const { service, written } = makeService({});
            const items: ImportItem[] = [
                { type: 'environment', action: 'create', selected: true, importItem: parsed.environments[0] }
            ];

            const result = await service.executeImportWithSelection(items);

            expect(result.success).to.equal(true);
            expect(result.warnings).to.have.length(1);
            expect(result.warnings![0]).to.contain('Staging');
            expect(result.warnings![0]).to.contain('re-enter');
        });

        it('does not write the redaction marker into the store', async () => {
            const { written: exported } = await exportEnvironments([oauthEnv()]);
            const parsed = await readZipJson<{ environments: EnvironmentConfig[] }>(
                exported.zips[0], 'environments.json'
            );

            const { service, written } = makeService({});
            await service.executeImportWithSelection([
                { type: 'environment', action: 'create', selected: true, importItem: parsed.environments[0] }
            ]);

            expect(written.environments[0]).to.not.have.property('credentialsRedacted');
        });

        it('raises no warning for an export that carried its credentials', async () => {
            const { written: exported } = await exportEnvironments([oauthEnv()], true);
            const parsed = await readZipJson<{ environments: EnvironmentConfig[] }>(
                exported.zips[0], 'environments.json'
            );

            const { service } = makeService({});
            const result = await service.executeImportWithSelection([
                { type: 'environment', action: 'create', selected: true, importItem: parsed.environments[0] }
            ]);

            expect(result.warnings).to.equal(undefined);
        });
    });
});
