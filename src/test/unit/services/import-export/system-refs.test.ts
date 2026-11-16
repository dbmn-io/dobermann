// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';
import { APIEndpointConfig } from '../../../../apiConfigManager';
import { EnvironmentConfig } from '../../../../environmentManager';
import { SystemConfig } from '../../../../data-loading/system-schema';
import {
    SystemRef,
    toExportedSystemRef,
    planImportedSystems
} from '../../../../services/import-export/system-refs';

/**
 * GitHub Issue #290 — Systems travel by name in .dbmn.zip exports.
 * IDs are generated per install, so export writes `systemName` and import
 * matches or creates Systems by name. Legacy exports (systemId only) get a
 * System per unknown ID, reusing that ID.
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

function system(id: string, name: string): SystemConfig {
    return { id, name, createdAt: 0 };
}

describe('System refs — export (#290)', () => {
    const systems = [system('sys-local-1', 'acmewms')];

    it('replaces systemId with the System name', () => {
        const exported = toExportedSystemRef(endpoint({ systemId: 'sys-local-1' }), systems);

        expect(exported.systemName).to.equal('acmewms');
        expect(exported).to.not.have.property('systemId');
    });

    it('drops a systemId that points at no System', () => {
        const exported = toExportedSystemRef(environment({ systemId: 'sys-gone' }), systems);

        expect(exported).to.not.have.property('systemId');
        expect(exported).to.not.have.property('systemName');
    });

    it('leaves an item with no System without any System fields', () => {
        const exported = toExportedSystemRef(endpoint(), systems);

        expect(exported).to.not.have.property('systemId');
        expect(exported).to.not.have.property('systemName');
    });
});

describe('System refs — import by systemName (#290)', () => {
    it('matches an existing System by name, ignoring case, and creates nothing', () => {
        const plan = planImportedSystems(
            [endpoint({ systemName: 'ACMEWMS' })],
            [],
            [system('sys-local-1', 'acmewms')]
        );

        expect(plan.systemsToCreate).to.deep.equal([]);
        expect(plan.resolve(endpoint({ systemName: 'ACMEWMS' })).systemId).to.equal('sys-local-1');
    });

    it('creates one System for an unknown name shared by an endpoint and an environment', () => {
        const ep = endpoint({ systemName: 'wms' });
        const env = environment({ systemName: 'wms' });

        const plan = planImportedSystems([ep], [env], []);

        expect(plan.systemsToCreate).to.have.length(1);
        expect(plan.systemsToCreate[0].name).to.equal('wms');
        const createdId = plan.systemsToCreate[0].id;
        expect(plan.resolve(ep).systemId).to.equal(createdId);
        expect(plan.resolve(env).systemId).to.equal(createdId);
    });

    it('removes systemName from resolved items', () => {
        const ep = endpoint({ systemName: 'wms' });
        const plan = planImportedSystems([ep], [], []);

        expect(plan.resolve(ep)).to.not.have.property('systemName');
    });
});

describe('System refs — legacy import by systemId (#290)', () => {
    it('keeps a systemId that exists locally and creates nothing', () => {
        const ep = endpoint({ systemId: 'sys-local-1' });
        const plan = planImportedSystems([ep], [], [system('sys-local-1', 'acmewms')]);

        expect(plan.systemsToCreate).to.deep.equal([]);
        expect(plan.resolve(ep).systemId).to.equal('sys-local-1');
    });

    it('creates a System that reuses an unknown incoming ID, named from its environment host', () => {
        const ep = endpoint({ systemId: 'sys-remote-9' });
        const env = environment({ systemId: 'sys-remote-9', baseUrl: 'https://orders.acme.com' });

        const plan = planImportedSystems([ep], [env], []);

        expect(plan.systemsToCreate).to.deep.equal([{ id: 'sys-remote-9', name: 'acme' }]);
        expect(plan.resolve(ep).systemId).to.equal('sys-remote-9');
        expect(plan.resolve(env).systemId).to.equal('sys-remote-9');
    });

    it('makes the derived name unique when a local System already uses it', () => {
        const env = environment({ systemId: 'sys-remote-9', baseUrl: 'https://orders.acme.com' });

        const plan = planImportedSystems([], [env], [system('sys-local-1', 'acme')]);

        expect(plan.systemsToCreate).to.deep.equal([{ id: 'sys-remote-9', name: 'acme2' }]);
    });

    it('gives an item with no System reference no systemId', () => {
        const ep = endpoint();
        const plan = planImportedSystems([ep], [], []);

        expect(plan.systemsToCreate).to.deep.equal([]);
        expect(plan.resolve(ep)).to.not.have.property('systemId');
    });
});
