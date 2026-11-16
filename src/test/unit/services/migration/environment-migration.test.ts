// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for EnvironmentMigrationService
 * GitHub Issues #113 and #126
 */

import { expect } from 'chai';
import * as sinon from 'sinon';
import { EnvironmentMigrationService } from '../../../../services/migration/environment-migration.service';
import { CURRENT_CONFIG_VERSION } from '../../../../services/migration/environment-migration.interface';
import { EnvironmentConfig } from '../../../../environmentManager';

// Helper to create minimal valid environment config
function createEnv(overrides: Partial<EnvironmentConfig>): EnvironmentConfig {
    return {
        id: 'env1',
        name: 'Test',
        baseUrl: 'https://api.example.com',
        isActive: false,
        createdAt: Date.now(),
        ...overrides
    };
}

describe('EnvironmentMigrationService', () => {
    let service: EnvironmentMigrationService;
    let mockEnvironmentManager: any;

    beforeEach(() => {
        mockEnvironmentManager = {
            getAllEnvironments: sinon.stub(),
            getEnvironment: sinon.stub(),
            updateEnvironment: sinon.stub()
        };
        service = new EnvironmentMigrationService(mockEnvironmentManager);
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('needsMigration', () => {
        it('should return false for already migrated environments', () => {
            const env = createEnv({
                configVersion: CURRENT_CONFIG_VERSION
            });

            expect(service.needsMigration(env)).to.be.false;
        });

        it('should return true for environments without configVersion', () => {
            const env = createEnv({
                // No configVersion
            });

            expect(service.needsMigration(env)).to.be.true;
        });

        it('should return false for a plain environment at the current version', () => {
            const env = createEnv({
                configVersion: CURRENT_CONFIG_VERSION
            });

            expect(service.needsMigration(env)).to.be.false;
        });
    });

    describe('migrateEnvironment', () => {
        it('should set configVersion to current version', async () => {
            const env = createEnv({});

            mockEnvironmentManager.updateEnvironment.resolves();

            const result = await service.migrateEnvironment(env);

            expect(result.success).to.be.true;

            const updateCall = mockEnvironmentManager.updateEnvironment.getCall(0);
            expect(updateCall.args[1].configVersion).to.equal(CURRENT_CONFIG_VERSION);
        });

        it('should not touch existing variables', async () => {
            const env = createEnv({
                variables: { org: 'ExistingOrg' }
            });

            mockEnvironmentManager.updateEnvironment.resolves();

            await service.migrateEnvironment(env);

            const updateCall = mockEnvironmentManager.updateEnvironment.getCall(0);
            expect(updateCall.args[1].variables).to.deep.equal({ org: 'ExistingOrg' });
        });

        it('should handle migration errors gracefully', async () => {
            const env = createEnv({});

            mockEnvironmentManager.updateEnvironment.rejects(new Error('Update failed'));

            const result = await service.migrateEnvironment(env);

            expect(result.success).to.be.false;
            expect(result.error).to.include('Update failed');
        });
    });

    describe('detectMigrationRequired', () => {
        it('should return environments requiring migration', async () => {
            const environments: EnvironmentConfig[] = [
                createEnv({
                    id: 'env1',
                    name: 'Migrated',
                    configVersion: CURRENT_CONFIG_VERSION
                }),
                createEnv({
                    id: 'env2',
                    name: 'Needs Migration',
                    baseUrl: 'https://test.samplewms.test'
                })
            ];

            mockEnvironmentManager.getAllEnvironments.resolves(environments);

            const result = await service.detectMigrationRequired();

            expect(result.migrationRequired).to.be.true;
            expect(result.totalEnvironments).to.equal(2);
            expect(result.environmentsRequiringMigration).to.have.lengthOf(1);
            expect(result.environmentsRequiringMigration[0].id).to.equal('env2');
        });

        it('should return false when no migration needed', async () => {
            const environments: EnvironmentConfig[] = [
                createEnv({
                    id: 'env1',
                    name: 'Migrated',
                    configVersion: CURRENT_CONFIG_VERSION
                })
            ];

            mockEnvironmentManager.getAllEnvironments.resolves(environments);

            const result = await service.detectMigrationRequired();

            expect(result.migrationRequired).to.be.false;
            expect(result.environmentsRequiringMigration).to.have.lengthOf(0);
        });
    });

    describe('migrateAllEnvironments', () => {
        it('should migrate all environments that need migration', async () => {
            const environments: EnvironmentConfig[] = [
                createEnv({
                    id: 'env1',
                    name: 'Already Migrated',
                    configVersion: CURRENT_CONFIG_VERSION
                }),
                createEnv({
                    id: 'env2',
                    name: 'Needs Migration',
                    baseUrl: 'https://test.samplewms.test'
                })
            ];

            mockEnvironmentManager.getAllEnvironments.resolves(environments);
            mockEnvironmentManager.updateEnvironment.resolves();

            const result = await service.migrateAllEnvironments();

            expect(result.success).to.be.true;
            expect(result.migratedCount).to.equal(1);
            expect(result.skippedCount).to.equal(1);
            expect(result.failedCount).to.equal(0);
        });

        it('should report failures but continue migrating', async () => {
            const environments: EnvironmentConfig[] = [
                createEnv({
                    id: 'env1',
                    name: 'Will Fail',
                    baseUrl: 'https://test1.samplewms.test'
                }),
                createEnv({
                    id: 'env2',
                    name: 'Will Succeed',
                    baseUrl: 'https://test2.samplewms.test'
                })
            ];

            mockEnvironmentManager.getAllEnvironments.resolves(environments);
            mockEnvironmentManager.updateEnvironment
                .onFirstCall().rejects(new Error('Failed'))
                .onSecondCall().resolves();

            const result = await service.migrateAllEnvironments();

            expect(result.success).to.be.false;
            expect(result.migratedCount).to.equal(1);
            expect(result.failedCount).to.equal(1);
        });
    });

    describe('getMigrationStatus', () => {
        it('should return correct migration status counts', async () => {
            const environments: EnvironmentConfig[] = [
                createEnv({ id: 'env1', name: 'Migrated', baseUrl: '', configVersion: CURRENT_CONFIG_VERSION }),
                createEnv({ id: 'env2', name: 'Not Migrated', baseUrl: '' }),
                createEnv({ id: 'env3', name: 'Migrated', baseUrl: '', configVersion: CURRENT_CONFIG_VERSION })
            ];

            mockEnvironmentManager.getAllEnvironments.resolves(environments);

            const status = await service.getMigrationStatus();

            expect(status.totalEnvironments).to.equal(3);
            expect(status.migratedCount).to.equal(2);
            expect(status.pendingCount).to.equal(1);
        });
    });

    describe('Constants', () => {
        it('should have correct config version', () => {
            expect(CURRENT_CONFIG_VERSION).to.equal(2);
        });

    });
});

describe('#415: client authentication becomes each OAuth environment\'s own setting', () => {
    const oauth = (overrides: Record<string, unknown> = {}) => createEnv({
        id: 'env-oauth', configVersion: CURRENT_CONFIG_VERSION, authMethod: 'oauth',
        oauthConfig: { provider: 'custom', authorizationUrl: 'https://login.example/authorize', tokenUrl: 'https://login.example/token', clientId: 'c', flowType: 'authorization_code', usePKCE: true, ...overrides }
    } as Partial<EnvironmentConfig>);
    let updates: Array<[string, Partial<EnvironmentConfig>]>;
    let service: EnvironmentMigrationService;
    beforeEach(() => {
        updates = [];
        service = new EnvironmentMigrationService({ updateEnvironment: async (id: string, u: Partial<EnvironmentConfig>) => { updates.push([id, u]); } } as never);
    });

    it('an OAuth environment with no setting needs the stamp, even at the current config version', () => {
        expect(service.needsMigration(oauth())).to.equal(true);
        expect(service.needsMigration(oauth({ clientAuth: 'body' })), 'already decided').to.equal(false);
        expect(service.needsMigration(createEnv({ configVersion: CURRENT_CONFIG_VERSION, authMethod: 'jwt' } as Partial<EnvironmentConfig>)), 'not OAuth').to.equal(false);
    });

    it('stamps the choice the legacy rule made: basic for the System it knew, body for everyone else', async () => {
        await service.migrateEnvironment(oauth({ tokenUrl: 'https://acme-auth.sce.manh.com/oauth/token' }));
        await service.migrateEnvironment(oauth());
        expect(updates.map(([, u]) => u.oauthConfig?.clientAuth)).to.deep.equal(['basic', 'body']);
        expect(updates[0][1].oauthConfig).to.include({ clientId: 'c', tokenUrl: 'https://acme-auth.sce.manh.com/oauth/token' });
        expect(updates[0][1].configVersion).to.equal(CURRENT_CONFIG_VERSION);
    });

    it('leaves an environment that already has its setting alone', async () => {
        const result = await service.migrateEnvironment(oauth({ clientAuth: 'basic' }));
        expect(result.changes).to.deep.equal([]);
        expect(updates).to.deep.equal([]);
    });
});

/**
 * #424, found reviewing 0.4.0's release notes (2026-11-13): 0.3.1 added Organization,
 * SelectedOrganization, Location and SelectedLocation, each the chosen organisation, to every
 * request of an environment with one. 0.4.0 adds nothing by itself, so after the upgrade those
 * requests went without them. The upgrade now writes them into the environment, once.
 */
describe('#424: an organisation from 0.3.x keeps its headers after the upgrade', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { needsOrgHeaders, withOrgHeaders, LEGACY_ORG_HEADERS } = require('../../../../services/migration/environment-migration.service');
    const v031 = (overrides: Partial<EnvironmentConfig> = {}) =>
        createEnv({ configVersion: CURRENT_CONFIG_VERSION, variables: { org: 'ACME-DC1' }, ...overrides });

    it('an environment with an organisation and no settings for it needs the upgrade, even at the current version', () => {
        const service = new EnvironmentMigrationService({} as never);
        expect(service.needsMigration(v031())).to.equal(true);
        expect(needsOrgHeaders(v031({ variables: { org: '  ' } }))).to.equal(false);
        expect(needsOrgHeaders(v031({ variables: {} }))).to.equal(false);
        // made or touched by 0.4.0: it has settings for org, and its headers are its own
        expect(needsOrgHeaders(v031({ variableSettings: { org: { showInHeader: true, options: ['ACME-DC1'] } } }))).to.equal(false);
    });

    it('adds the four headers as {{ENV:org}}, and org in the Hub header with its value as an option', () => {
        const out = withOrgHeaders(v031({ headers: { 'Content-Type': { value: 'application/json', enabled: true } } }));
        expect(out.added).to.deep.equal([...LEGACY_ORG_HEADERS]);
        expect(out.headers).to.deep.equal({
            'Content-Type': { value: 'application/json', enabled: true },
            Organization: { value: '{{ENV:org}}', enabled: true },
            SelectedOrganization: { value: '{{ENV:org}}', enabled: true },
            Location: { value: '{{ENV:org}}', enabled: true },
            SelectedLocation: { value: '{{ENV:org}}', enabled: true }
        });
        expect(out.variableSettings.org).to.deep.equal({ showInHeader: true, options: ['ACME-DC1'] });
    });

    it('leaves a header the environment already lists, in any case, on or off: its own row always won', () => {
        const out = withOrgHeaders(v031({ headers: {
            organization: { value: '{{org}}', enabled: true },
            Location: { value: 'DC2', enabled: false }
        } }));
        expect(out.added).to.deep.equal(['SelectedOrganization', 'SelectedLocation']);
        expect(out.headers.organization).to.deep.equal({ value: '{{org}}', enabled: true });
        expect(out.headers.Location).to.deep.equal({ value: 'DC2', enabled: false });
        expect(out.headers).to.not.have.property('Organization');
    });

    it('migrates and saves once: the saved environment no longer needs it', async () => {
        const manager = { updateEnvironment: sinon.stub().resolves(), getAllEnvironments: sinon.stub() };
        const service = new EnvironmentMigrationService(manager as never);
        const env = v031();
        const result = await service.migrateEnvironment(env);
        expect(result.success).to.equal(true);
        const saved = manager.updateEnvironment.getCall(0).args[1];
        expect(Object.keys(saved.headers)).to.deep.equal([...LEGACY_ORG_HEADERS]);
        expect(saved.variableSettings.org.showInHeader).to.equal(true);
        expect(service.needsMigration({ ...env, ...saved })).to.equal(false);
    });

    it('a request from the upgraded environment carries the organisation in all four, as 0.3.1 sent it', async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ExecutionHeaderPreparationService } = require('../../../../services/headers/execution-header-preparation.service');
        const env = v031();
        const upgraded = { ...env, ...withOrgHeaders(env) };
        const endpoint = { id: 'e', name: 'Items', method: 'GET', path: '/items', headers: [] };
        const prepared = await new ExecutionHeaderPreparationService().prepareHeadersWithVariables(endpoint, upgraded, upgraded.variables);
        for (const name of LEGACY_ORG_HEADERS) expect(prepared.headers[name], name).to.equal('ACME-DC1');
    });
});
