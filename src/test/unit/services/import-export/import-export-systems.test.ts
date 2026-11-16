// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';
import * as JSZip from 'jszip';
import { ImportExportService } from '../../../../services/import-export/import-export.service';
import { ImportItem } from '../../../../services/import-export/import-export.service.interface';
import { SystemRef } from '../../../../services/import-export/system-refs';
import { IFileSink, FileSaveRequest } from '../../../../services/io/file-sink.interface';
import { APIEndpointConfig } from '../../../../apiConfigManager';
import { EnvironmentConfig } from '../../../../environmentManager';
import { SystemConfig } from '../../../../data-loading/system-schema';

/**
 * GitHub Issue #290 — the service writes `systemName` on export and resolves
 * Systems (creating missing ones) before writing imported items.
 */

type Endpoint = APIEndpointConfig & SystemRef;
type Environment = EnvironmentConfig & SystemRef;

function endpoint(fields: Partial<Endpoint> = {}): Endpoint {
    return {
        id: 'ep-1',
        name: 'Create Order',
        path: '/orders/create',
        method: 'POST',
        headers: {},
        queryParams: {},
        ...fields
    };
}

function environment(fields: Partial<Environment> = {}): Environment {
    return { id: 'env-1', name: 'Staging', baseUrl: 'https://orders.acme.com', ...fields } as Environment;
}

interface Written {
    endpoints: Partial<Endpoint>[];
    environments: Partial<Environment>[];
    systems: Array<Partial<SystemConfig>>;
    zips: FileSaveRequest[];
}

function makeService(seed: { endpoints?: Endpoint[]; environments?: Environment[]; systems?: SystemConfig[] }) {
    const written: Written = { endpoints: [], environments: [], systems: [], zips: [] };
    const systems = [...(seed.systems ?? [])];

    const endpointManager = {
        getAllEndpoints: async () => seed.endpoints ?? [],
        addEndpoint: async (config: Partial<Endpoint>) => {
            written.endpoints.push(config);
            return { ...config, id: 'ep-new' };
        },
        updateEndpoint: async (_id: string, config: Partial<Endpoint>) => {
            written.endpoints.push(config);
            return config;
        }
    };
    const environmentManager = {
        getAllEnvironments: async () => seed.environments ?? [],
        addEnvironment: async (config: Partial<Environment>) => {
            written.environments.push(config);
            return { ...config, id: 'env-new' };
        },
        updateEnvironment: async (_id: string, config: Partial<Environment>) => {
            written.environments.push(config);
            return config;
        }
    };
    const systemStore = {
        getAllSystems: async () => systems,
        addSystem: async (config: Partial<SystemConfig>) => {
            written.systems.push(config);
            const created: SystemConfig = { id: config.id as string, name: config.name as string, createdAt: 0 };
            systems.push(created);
            return created;
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
        sink,
        systemStore as never
    );
    return { service, written };
}

async function readZipJson<T>(request: FileSaveRequest, file: string): Promise<T> {
    const zip = await JSZip.loadAsync(request.data);
    return JSON.parse(await zip.file(file)!.async('string')) as T;
}

describe('ImportExportService — Systems by name (#290)', () => {
    it('exports systemName instead of systemId on endpoints and environments', async () => {
        const { service, written } = makeService({
            endpoints: [endpoint({ systemId: 'sys-1' })],
            environments: [environment({ systemId: 'sys-1' })],
            systems: [{ id: 'sys-1', name: 'acmewms', createdAt: 0 }]
        });

        const result = await service.exportToZip({
            endpoints: ['ep-1'],
            environments: ['env-1'],
            includeConsoleSettings: false,
            filename: 'export'
        });

        expect(result.success).to.equal(true);
        const endpoints = await readZipJson<{ endpoints: Endpoint[] }>(written.zips[0], 'endpoints.json');
        const environments = await readZipJson<{ environments: Environment[] }>(written.zips[0], 'environments.json');
        expect(endpoints.endpoints[0].systemName).to.equal('acmewms');
        expect(endpoints.endpoints[0]).to.not.have.property('systemId');
        expect(environments.environments[0].systemName).to.equal('acmewms');
        expect(environments.environments[0]).to.not.have.property('systemId');
    });

    it('creates a missing System by name and assigns it to created items', async () => {
        const { service, written } = makeService({});
        const items: ImportItem[] = [
            { type: 'endpoint', action: 'create', selected: true, importItem: endpoint({ systemName: 'wms' }) },
            { type: 'environment', action: 'create', selected: true, importItem: environment({ systemName: 'wms' }) }
        ];

        const result = await service.executeImportWithSelection(items);

        expect(result.success).to.equal(true);
        expect(written.systems).to.have.length(1);
        expect(written.systems[0].name).to.equal('wms');
        const systemId = written.systems[0].id;
        expect(written.endpoints[0].systemId).to.equal(systemId);
        expect(written.environments[0].systemId).to.equal(systemId);
        expect(written.endpoints[0]).to.not.have.property('systemName');
        expect(written.environments[0]).to.not.have.property('systemName');
    });

    it('assigns an existing System, matched by name, to updated items without creating one', async () => {
        const { service, written } = makeService({ systems: [{ id: 'sys-local', name: 'wms', createdAt: 0 }] });
        const existing = endpoint({ id: 'ep-9' });
        const items: ImportItem[] = [
            { type: 'endpoint', action: 'update', selected: true, existingItem: existing, importItem: endpoint({ systemName: 'WMS' }) }
        ];

        await service.executeImportWithSelection(items);

        expect(written.systems).to.deep.equal([]);
        expect(written.endpoints[0].systemId).to.equal('sys-local');
    });

    it('creates a System that reuses an unknown legacy systemId', async () => {
        const { service, written } = makeService({});
        const items: ImportItem[] = [
            { type: 'environment', action: 'create', selected: true, importItem: environment({ systemId: 'sys-remote' }) }
        ];

        await service.executeImportWithSelection(items);

        expect(written.systems).to.deep.equal([{ id: 'sys-remote', name: 'acme' }]);
        expect(written.environments[0].systemId).to.equal('sys-remote');
    });
});
