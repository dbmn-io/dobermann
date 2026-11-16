// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import { SystemOperationsService } from '../../../../services/systems/system-operations.service';
import { SystemManager } from '../../../../systemManager';
import { APIEndpointManager } from '../../../../apiEndpointManager';
import { EnvironmentManager } from '../../../../environmentManager';

/**
 * GitHub Issue #275: bulk Set System + merge Systems.
 * Pure-logic tests over lightweight in-memory fakes of the three managers —
 * only the methods the service actually calls are stubbed.
 */
describe('SystemOperationsService - GitHub Issue #275', () => {
    interface Endpoint { id: string; name: string; systemId?: string }
    interface Env { id: string; name: string; systemId?: string }

    let endpoints: Endpoint[];
    let environments: Env[];
    let systems: Array<{ id: string; name: string }>;
    let batchDepth: number;
    let bulkWrites: number;
    let service: SystemOperationsService;

    function makeService(): SystemOperationsService {
        const systemManager = {
            getSystem: async (id: string) => systems.find(s => s.id === id),
            deleteSystem: async (id: string) => {
                const before = systems.length;
                systems = systems.filter(s => s.id !== id);
                return systems.length < before;
            }
        } as unknown as SystemManager;

        const endpointManager = {
            getAllEndpoints: async () => endpoints,
            enableBatchMode: () => { batchDepth++; },
            disableBatchMode: () => { batchDepth--; },
            // #310: one call, one storage write, for the whole selection
            updateEndpoints: async (changes: Array<{ id: string; updates: Partial<Endpoint> }>) => {
                bulkWrites++;
                const updated: Endpoint[] = [];
                const skipped: Array<{ id: string; name?: string; reason: string }> = [];
                for (const { id, updates } of changes) {
                    const ep = endpoints.find(e => e.id === id);
                    if (!ep) { skipped.push({ id, reason: 'not found' }); continue; }
                    Object.assign(ep, updates);
                    updated.push(ep);
                }
                return { updated, skipped };
            },
            updateEndpoint: async () => { throw new Error('#310: per-endpoint writes are not allowed here'); }
        } as unknown as APIEndpointManager;

        const environmentManager = {
            getAllEnvironments: async () => environments,
            updateEnvironment: async (id: string, updates: Partial<Env>) => {
                const env = environments.find(e => e.id === id);
                if (!env) throw new Error('not found');
                Object.assign(env, updates);
                return env;
            }
        } as unknown as EnvironmentManager;

        return new SystemOperationsService(systemManager, endpointManager, environmentManager);
    }

    beforeEach(() => {
        systems = [{ id: 'sysA', name: 'a' }, { id: 'sysB', name: 'b' }];
        endpoints = [
            { id: 'e1', name: 'e1', systemId: 'sysA' },
            { id: 'e2', name: 'e2', systemId: 'sysA' },
            { id: 'e3', name: 'e3', systemId: 'sysB' },
            { id: 'e4', name: 'e4' } // unassigned
        ];
        environments = [
            { id: 'env1', name: 'env1', systemId: 'sysA' },
            { id: 'env2', name: 'env2', systemId: 'sysB' }
        ];
        batchDepth = 0;
        bulkWrites = 0;
        service = makeService();
    });

    describe('setEndpointsSystem', () => {
        it('assigns the target System to the selected endpoints', async () => {
            const { touched } = await service.setEndpointsSystem(['e3', 'e4'], 'sysA');
            expect(touched).to.equal(2);
            expect(endpoints.find(e => e.id === 'e3')!.systemId).to.equal('sysA');
            expect(endpoints.find(e => e.id === 'e4')!.systemId).to.equal('sysA');
            // Untouched endpoints keep their assignment.
            expect(endpoints.find(e => e.id === 'e1')!.systemId).to.equal('sysA');
        });

        it('reports the full selection but only writes those that change', async () => {
            const written: string[] = [];
            const svc = new SystemOperationsService(
                { getSystem: async (id: string) => systems.find(s => s.id === id) } as unknown as SystemManager,
                {
                    getAllEndpoints: async () => endpoints,
                    updateEndpoints: async (changes: Array<{ id: string; updates: Partial<Endpoint> }>) => {
                        for (const { id, updates } of changes) {
                            written.push(id);
                            Object.assign(endpoints.find(e => e.id === id)!, updates);
                        }
                        return { updated: changes, skipped: [] };
                    }
                } as unknown as APIEndpointManager,
                { getAllEnvironments: async () => environments } as unknown as EnvironmentManager
            );
            // e1 already sysA (no write), e3 sysB (one write) — count = 2 selected.
            const { touched } = await svc.setEndpointsSystem(['e1', 'e3'], 'sysA');
            expect(touched).to.equal(2);
            expect(written).to.deep.equal(['e3']);
        });

        it('#310: thirty endpoints are one storage write, not thirty', async () => {
            endpoints = Array.from({ length: 30 }, (_, i) => ({ id: `ep${i}`, name: `ep${i}`, systemId: 'sysB' }));
            service = makeService();
            const { touched } = await service.setEndpointsSystem(endpoints.map(e => e.id), 'sysA');
            expect(touched).to.equal(30);
            expect(bulkWrites).to.equal(1);
            expect(endpoints.every(e => e.systemId === 'sysA')).to.equal(true);
        });

        it('#310: an endpoint the manager refuses to write is reported, not fatal', async () => {
            const svc = new SystemOperationsService(
                { getSystem: async (id: string) => systems.find(s => s.id === id) } as unknown as SystemManager,
                {
                    getAllEndpoints: async () => endpoints,
                    updateEndpoints: async (changes: Array<{ id: string; updates: Partial<Endpoint> }>) => ({
                        updated: changes.filter(c => c.id !== 'e3'),
                        skipped: [{ id: 'e3', name: 'e3', reason: 'Invalid endpoint configuration: path is required' }]
                    })
                } as unknown as APIEndpointManager,
                { getAllEnvironments: async () => environments } as unknown as EnvironmentManager
            );
            const result = await svc.setEndpointsSystem(['e3', 'e4'], 'sysA');
            expect(result.touched).to.equal(1);
            expect(result.skipped).to.have.length(1);
            expect(result.skipped[0].name).to.equal('e3');
        });

        it('skips the write entirely when every selected endpoint already has the target', async () => {
            const { touched, skipped } = await service.setEndpointsSystem(['e1', 'e2'], 'sysA');
            expect(touched).to.equal(2);
            expect(skipped).to.deep.equal([]);
            expect(bulkWrites).to.equal(0);
        });

        it('clears the System when target is empty', async () => {
            const { touched } = await service.setEndpointsSystem(['e1'], '');
            expect(touched).to.equal(1);
            expect(endpoints.find(e => e.id === 'e1')!.systemId).to.equal(undefined);
        });

        it('clears the System when target is null', async () => {
            const { touched } = await service.setEndpointsSystem(['e2'], null);
            expect(touched).to.equal(1);
            expect(endpoints.find(e => e.id === 'e2')!.systemId).to.equal(undefined);
        });

        it('throws when the target System does not exist', async () => {
            let threw = false;
            try {
                await service.setEndpointsSystem(['e1'], 'ghost');
            } catch { threw = true; }
            expect(threw).to.equal(true);
        });

        it('returns 0 for an empty id list', async () => {
            expect((await service.setEndpointsSystem([], 'sysA')).touched).to.equal(0);
        });

        it('#310: never enters the manager\'s batch mode — one write needs no event suppression', async () => {
            await service.setEndpointsSystem(['e3'], 'sysA');
            expect(batchDepth).to.equal(0);
        });
    });

    describe('mergeSystems', () => {
        it('moves endpoints + environments onto the target and deletes the source', async () => {
            const summary = await service.mergeSystems(['sysA'], 'sysB');
            expect(summary.endpointsTouched).to.equal(2);
            expect(bulkWrites, '#310: the endpoint moves are one write').to.equal(1);
            expect(summary.environmentsTouched).to.equal(1);
            expect(summary.deletedSystemIds).to.deep.equal(['sysA']);
            expect(endpoints.filter(e => e.systemId === 'sysB').map(e => e.id).sort())
                .to.deep.equal(['e1', 'e2', 'e3']);
            expect(environments.find(e => e.id === 'env1')!.systemId).to.equal('sysB');
            expect(systems.find(s => s.id === 'sysA')).to.equal(undefined);
        });

        it('never merges a System into itself', async () => {
            const summary = await service.mergeSystems(['sysA'], 'sysA');
            expect(summary.endpointsTouched).to.equal(0);
            expect(summary.deletedSystemIds).to.deep.equal([]);
            expect(systems.find(s => s.id === 'sysA')).to.not.equal(undefined);
        });

        it('throws when the target System is missing', async () => {
            let threw = false;
            try {
                await service.mergeSystems(['sysA'], 'ghost');
            } catch { threw = true; }
            expect(threw).to.equal(true);
        });

        it('merges multiple sources at once', async () => {
            systems.push({ id: 'sysC', name: 'c' });
            endpoints.push({ id: 'e5', name: 'e5', systemId: 'sysC' });
            const summary = await service.mergeSystems(['sysA', 'sysC'], 'sysB');
            expect(summary.endpointsTouched).to.equal(3); // e1, e2, e5
            expect(summary.deletedSystemIds.sort()).to.deep.equal(['sysA', 'sysC']);
            expect(endpoints.find(e => e.id === 'e5')!.systemId).to.equal('sysB');
        });
    });
});
