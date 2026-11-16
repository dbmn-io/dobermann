// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import { SystemOperationsService } from '../../../../services/systems/system-operations.service';
import { SystemManager } from '../../../../systemManager';
import { APIEndpointManager } from '../../../../apiEndpointManager';
import { EnvironmentManager } from '../../../../environmentManager';

/**
 * API Catalogue Select mode → Update: set a System, add tags and remove tags on a selection,
 * in ONE storage write (updateEndpoints, #310). An endpoint with nothing to change is not
 * written; tags are normalised (trim, lower-case, no duplicates).
 */
describe('SystemOperationsService.updateSelection — Select mode Update', () => {
    interface Endpoint { id: string; name: string; systemId?: string; tags?: string[] }
    let endpoints: Endpoint[];
    let writes: Array<Array<{ id: string; updates: Partial<Endpoint> }>>;
    let service: SystemOperationsService;

    beforeEach(() => {
        endpoints = [
            { id: 'e1', name: 'e1', systemId: 'sysA', tags: ['training', 'legacy'] },
            { id: 'e2', name: 'e2', tags: ['training'] },
            { id: 'e3', name: 'e3', systemId: 'sysB' }
        ];
        writes = [];
        const systemManager = {
            getSystem: async (id: string) => [{ id: 'sysA', name: 'a' }, { id: 'sysB', name: 'b' }].find(s => s.id === id)
        } as unknown as SystemManager;
        const endpointManager = {
            getAllEndpoints: async () => endpoints,
            updateEndpoints: async (changes: Array<{ id: string; updates: Partial<Endpoint> }>) => {
                writes.push(changes);
                changes.forEach(({ id, updates }) => Object.assign(endpoints.find(e => e.id === id)!, updates));
                return { updated: [], skipped: [] };
            },
            updateEndpoint: async () => { throw new Error('#310: per-endpoint writes are not allowed here'); }
        } as unknown as APIEndpointManager;
        service = new SystemOperationsService(systemManager, endpointManager, {} as EnvironmentManager);
    });

    it('sets the System, adds and removes tags, in one write', async () => {
        const result = await service.updateSelection(['e1', 'e2'], { systemId: 'sysB', addTags: [' Puppy-School ', 'puppy-school'], removeTags: ['Training'] });
        expect(writes).to.have.length(1);
        expect(endpoints[0]).to.deep.include({ systemId: 'sysB', tags: ['legacy', 'puppy-school'] });
        expect(endpoints[1]).to.deep.include({ systemId: 'sysB', tags: ['puppy-school'] });
        expect(endpoints[2], 'not selected').to.deep.equal({ id: 'e3', name: 'e3', systemId: 'sysB' });
        expect(result).to.deep.equal({ touched: 2, skipped: [] });
    });

    it('leaves the System alone when it is not given, and clears it on null', async () => {
        await service.updateSelection(['e1'], { addTags: ['x'] });
        expect(endpoints[0].systemId).to.equal('sysA');
        await service.updateSelection(['e1', 'e3'], { systemId: null });
        expect(endpoints[0].systemId).to.equal(undefined);
        expect(endpoints[2].systemId).to.equal(undefined);
    });

    it('writes nothing when nothing would change, and refuses a System that no longer exists', async () => {
        const none = await service.updateSelection(['e2'], { addTags: ['training'], removeTags: ['absent'] });
        expect(none.touched).to.equal(0);
        expect(writes).to.have.length(0);
        let error = '';
        try { await service.updateSelection(['e1'], { systemId: 'gone' }); } catch (e) { error = (e as Error).message; }
        expect(error).to.match(/no longer exists/);
    });
});
