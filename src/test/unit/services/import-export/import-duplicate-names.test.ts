// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import { ImportExportService } from '../../../../services/import-export/import-export.service';
import { ImportItem, ImportPackage } from '../../../../services/import-export/import-export.service.interface';
import { APIEndpointManager } from '../../../../apiEndpointManager';
import { EnvironmentManager, createDefaultEnvironment } from '../../../../environmentManager';
import { APIEndpointConfig, createDefaultEndpoint } from '../../../../apiConfigManager';

/**
 * Endpoint names are unique across the whole install (APIEndpointManager.addEndpoint),
 * but a package can hold two endpoints with the same name in different folders.
 * The import used to throw on the second one and abandon everything after it —
 * including every environment. Duplicates are now renamed "<name> (<folder>)"
 * in the preview, and one failing item no longer stops the rest.
 */

function endpoint(name: string, folder?: string): APIEndpointConfig {
    return { ...createDefaultEndpoint(name, `/api/${name}`), folder };
}

function importPackage(endpoints: APIEndpointConfig[]): ImportPackage {
    return {
        metadata: { version: '1.0.0' },
        endpoints: { version: '1.2.0', folders: [], endpoints },
        environments: {
            version: '1.3.0',
            folders: [],
            environments: [
                { ...createDefaultEnvironment('Staging'), baseUrl: 'https://staging.example.com' },
                { ...createDefaultEnvironment('UAT'), baseUrl: 'https://uat.example.com', folder: 'ACM' }
            ]
        },
        folders: { version: '1.0.0', endpoints: { folders: [] }, environments: { folders: [] } }
    } as unknown as ImportPackage;
}

describe('ImportExportService — duplicate endpoint names', () => {
    let endpointManager: APIEndpointManager;
    let environmentManager: EnvironmentManager;
    let service: ImportExportService;

    beforeEach(() => {
        const state = new Map<string, unknown>();
        const context = {
            globalState: {
                get: (key: string) => state.get(key),
                update: (key: string, value: unknown) => { state.set(key, value); return Promise.resolve(); }
            },
            secrets: { get: () => Promise.resolve(undefined), store: () => Promise.resolve(), delete: () => Promise.resolve() },
            extension: { packageJSON: { version: '0.0.0-test' } }
        };
        const logger = { info() {}, error() {}, debug() {}, warn() {} };
        endpointManager = new APIEndpointManager(context as never);
        environmentManager = new EnvironmentManager(context as never);
        service = new ImportExportService(endpointManager, environmentManager, undefined, context as never, logger as never);
    });

    async function importAll(pkg: ImportPackage) {
        const preview = await service.prepareImport(pkg);
        return { preview, result: await service.executeImportWithSelection(preview.items) };
    }

    it('imports every endpoint and environment when two endpoints share a name across folders', async () => {
        const { result } = await importAll(importPackage([
            endpoint('InventoryAdjustment', 'migrate2'),
            endpoint('InventoryAdjustment', 'migrate'),
            endpoint('withVariables', 'migrate'),
            endpoint('withVariables')
        ]));

        expect(result.errors).to.deep.equal([]);
        expect(result.success).to.equal(true);
        const names = (await endpointManager.getAllEndpoints()).map(e => e.name);
        expect(names).to.have.members([
            'InventoryAdjustment', 'InventoryAdjustment (migrate)', 'withVariables', 'withVariables (Root)'
        ]);
        expect((await environmentManager.getAllEnvironments()).map(e => e.name)).to.have.members(['Staging', 'UAT']);
    });

    it('previews the renamed endpoint as a create, remembering its original name', async () => {
        const { items } = await service.prepareImport(importPackage([
            endpoint('InventoryAdjustment', 'migrate2'),
            endpoint('InventoryAdjustment', 'migrate')
        ]));

        const renamed = items.find(i => i.type === 'endpoint' && i.importItem.folder === 'migrate')!;
        expect(renamed.action).to.equal('create');
        expect(renamed.importItem.name).to.equal('InventoryAdjustment (migrate)');
        expect(renamed.renamedFrom).to.equal('InventoryAdjustment');
    });

    it('renames an endpoint whose name is already used by an existing endpoint in another folder', async () => {
        await endpointManager.addEndpoint(endpoint('InventoryAdjustment', 'migrate2'));

        const { items } = await service.prepareImport(importPackage([endpoint('InventoryAdjustment', 'migrate')]));

        const item = items.find(i => i.type === 'endpoint')!;
        expect(item.action).to.equal('create');
        expect(item.importItem.name).to.equal('InventoryAdjustment (migrate)');
    });

    it('updates rather than duplicates when the same package is imported twice', async () => {
        const pkg = importPackage([endpoint('InventoryAdjustment', 'migrate2'), endpoint('InventoryAdjustment', 'migrate')]);
        await importAll(pkg);

        const { preview, result } = await importAll(pkg);

        expect(preview.items.filter(i => i.type === 'endpoint').map(i => i.action)).to.deep.equal(['update', 'update']);
        expect(result.errors).to.deep.equal([]);
        expect(await endpointManager.getAllEndpoints()).to.have.length(2);
    });

    it('carries on past an item that fails and reports it by name', async () => {
        await endpointManager.addEndpoint(endpoint('Taken', 'other'));
        const items: ImportItem[] = [
            // e.g. the user edited the name in the preview to one already in use
            { type: 'endpoint', action: 'create', selected: true, importItem: endpoint('Taken', 'mine') },
            { type: 'endpoint', action: 'create', selected: true, importItem: endpoint('Fresh', 'mine') },
            { type: 'environment', action: 'create', selected: true, importItem: createDefaultEnvironment('Staging') }
        ];

        const result = await service.executeImportWithSelection(items);

        expect(result.success).to.equal(false);
        expect(result.errors).to.have.length(1);
        expect(result.errors[0]).to.contain('Taken');
        expect(result.imported).to.have.length(2);
        expect(result.details!.endpoints.created).to.equal(1);
        expect(result.details!.environments.created).to.equal(1);
        expect((await endpointManager.getAllEndpoints()).map(e => e.name)).to.have.members(['Taken', 'Fresh']);
    });
});
