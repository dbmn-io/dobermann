// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import * as vscode from 'vscode';
import { APIEndpointManager } from '../../../apiEndpointManager';
import { APIEndpointConfig } from '../../../apiConfigManager';

/**
 * GitHub Issue #310: "Set System" on a selection of endpoints crawled —
 * about one endpoint per second — because each one was a full load + full
 * rewrite of the endpoint collection through globalState.update(). The
 * manager now takes the whole selection in one call and writes once.
 *
 * The context fake counts storage writes and change events, which is the
 * whole point of the test: N endpoints must cost one write and one event.
 */
describe('APIEndpointManager.updateEndpoints — GitHub Issue #310', () => {
    let writes: number;
    let stored: unknown;
    let manager: APIEndpointManager;

    function endpoint(i: number): Partial<APIEndpointConfig> {
        return { id: `ep${i}`, name: `Endpoint ${i}`, path: `/things/${i}`, method: 'GET', systemId: 'sys-old' };
    }

    beforeEach(async () => {
        writes = 0;
        stored = undefined;
        const context = {
            globalState: {
                get: () => stored,
                update: async (_key: string, value: unknown) => { writes++; stored = value; }
            }
        } as unknown as vscode.ExtensionContext;
        manager = new APIEndpointManager(context);
        for (let i = 0; i < 30; i++) {
            await manager.addEndpoint(endpoint(i));
        }
        writes = 0; // only count what updateEndpoints does
    });

    it('writes thirty changes to storage once and fires one change event', async () => {
        let events = 0;
        manager.onEndpointsChanged(() => { events++; });

        const changes = Array.from({ length: 30 }, (_, i) => ({ id: `ep${i}`, updates: { systemId: 'sys-new' } }));
        const result = await manager.updateEndpoints(changes);

        expect(result.updated).to.have.length(30);
        expect(result.skipped).to.deep.equal([]);
        expect(writes).to.equal(1);
        expect(events).to.equal(1);
        const all = await manager.getAllEndpoints();
        expect(all.every(e => e.systemId === 'sys-new')).to.equal(true);
    });

    it('skips an unknown id and a change that would fail validation, and still writes the rest', async () => {
        const result = await manager.updateEndpoints([
            { id: 'ep1', updates: { systemId: 'sys-new' } },
            { id: 'ghost', updates: { systemId: 'sys-new' } },
            { id: 'ep2', updates: { name: '' } } // name is required
        ]);

        expect(result.updated.map(e => e.id)).to.deep.equal(['ep1']);
        expect(result.skipped.map(s => s.id).sort()).to.deep.equal(['ep2', 'ghost']);
        expect(result.skipped.find(s => s.id === 'ep2')?.name).to.equal('Endpoint 2');
        expect(writes).to.equal(1);
        const all = await manager.getAllEndpoints();
        expect(all.find(e => e.id === 'ep1')?.systemId).to.equal('sys-new');
        expect(all.find(e => e.id === 'ep2')?.name).to.equal('Endpoint 2');
    });

    it('refuses a rename that collides with another endpoint', async () => {
        const result = await manager.updateEndpoints([{ id: 'ep1', updates: { name: 'Endpoint 2' } }]);
        expect(result.updated).to.deep.equal([]);
        expect(result.skipped[0].reason).to.include('already exists');
        expect(writes).to.equal(0);
    });

    it('does nothing at all for an empty change list', async () => {
        const result = await manager.updateEndpoints([]);
        expect(result).to.deep.equal({ updated: [], skipped: [] });
        expect(writes).to.equal(0);
    });
});
