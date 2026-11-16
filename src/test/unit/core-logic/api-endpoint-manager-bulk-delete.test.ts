// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import * as vscode from 'vscode';
import { APIEndpointManager } from '../../../apiEndpointManager';

/**
 * API Catalogue Select mode → Delete: a selection of endpoints is deleted in ONE storage write
 * (globalState.update replaces the whole collection; one write per endpoint is what made
 * Set System crawl in #310). Unknown ids are reported, not thrown.
 */
describe('APIEndpointManager.deleteEndpoints — bulk delete from Select mode', () => {
    let writes: number;
    let stored: unknown;
    let manager: APIEndpointManager;

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
        for (let i = 0; i < 10; i++) {
            await manager.addEndpoint({ id: `ep${i}`, name: `Endpoint ${i}`, path: `/things/${i}`, method: 'GET' });
        }
        writes = 0;
    });

    it('deletes the selection with one write and one change event, and keeps the rest', async () => {
        let events = 0;
        manager.onEndpointsChanged(() => { events++; });

        const result = await manager.deleteEndpoints(['ep1', 'ep3', 'ep5']);

        expect(result.deleted.map(e => e.name)).to.deep.equal(['Endpoint 1', 'Endpoint 3', 'Endpoint 5']);
        expect(result.missing).to.deep.equal([]);
        expect(writes).to.equal(1);
        expect(events).to.equal(1);
        expect((await manager.getAllEndpoints()).map(e => e.id)).to.deep.equal(['ep0', 'ep2', 'ep4', 'ep6', 'ep7', 'ep8', 'ep9']);
    });

    it('reports an unknown id and does not write when nothing matched', async () => {
        const partly = await manager.deleteEndpoints(['ep2', 'ghost']);
        expect(partly.deleted.map(e => e.id)).to.deep.equal(['ep2']);
        expect(partly.missing).to.deep.equal(['ghost']);
        expect(writes).to.equal(1);

        const none = await manager.deleteEndpoints(['ghost']);
        expect(none.deleted).to.deep.equal([]);
        expect(writes, 'nothing to delete, nothing written').to.equal(1);
    });
});
