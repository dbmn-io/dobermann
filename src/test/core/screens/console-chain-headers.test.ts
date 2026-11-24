// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Chain dialog's warning and the Links tab compare runs by their header values, each by its
 * own name, never a fixed Organization (James, 2026-11-24: "it should just be whatever headings
 * exist on the environment that we've run against").
 */
import * as assert from 'assert';
import { ConsoleChainHandler } from '../../../screens/console/console-chain-handler';

/** An environment whose header shows org and version, and keeps one other variable. */
const environment = (id: string, variables: Record<string, string>) => ({
    id, name: id.toUpperCase(), variables,
    variableSettings: { org: { showInHeader: true }, version: { showInHeader: true }, skuPrefix: {} }
});

function handler(source: Record<string, unknown>, active: ReturnType<typeof environment>, links?: unknown) {
    const posted: Array<Record<string, any>> = [];
    const h = new ConsoleChainHandler({
        getTabRowsForChain: async () => ({ data: [{ sku: 'A1' }], columns: [{ id: 'sku', name: 'sku' }] as never }),
        getChainSourceRef: () => ({ executionId: 'run-1', endpointId: 'ep-1' }),
        toCsv: async () => 'sku\nA1\n',
        post: async m => { posted.push(m); },
        notify: () => undefined,
        store: {
            getExecution: async () => ({ status: 'completed', executionType: 'batch', environmentId: 'dev', environment: 'DEV', ...source }),
            getExecutionLinks: async () => links ?? { upstream: [], downstream: [] }
        },
        // (another endpoint to chain to: without one, the dialog never opens)
        endpoints: { getAllEndpoints: async () => [{ id: 'ep-2', name: 'Put stock', method: 'POST', path: '/stock', body: '{"s":"{{sku}}"}' }], getEndpoint: async () => undefined } as never,
        environments: { getActiveEnvironment: async () => active, getAllEnvironments: async () => [environment('dev', {}), active] } as never,
        openConsole: async () => undefined,
        openRunBatch: async () => undefined
    });
    return { h, posted };
}

async function warnings(source: Record<string, unknown>, active: ReturnType<typeof environment>): Promise<string[]> {
    const { h, posted } = handler(source, active);
    await h.handle({ type: 'console.chain', payload: { tab: 'success' } });
    return posted.find(m => m.type === 'console.chainOptions')!.payload.warnings;
}

describe('Chain and Links: header values by name', () => {
    const dev = (variables: Record<string, string>) => environment('dev', variables);

    it('the same headers: no warning', async () => {
        assert.deepStrictEqual(await warnings({ environmentVariables: { org: 'vic', version: 'v2', skuPrefix: 'XY' } }, dev({ org: 'vic', version: 'v2', skuPrefix: 'AB' })), []);
    });

    it('one differs: named by its own name', async () => {
        assert.deepStrictEqual(await warnings({ environmentVariables: { org: 'vic', version: 'v2' } }, dev({ org: 'nz', version: 'v2' })),
            ['Rows came from org vic. The active environment sends org nz.']);
    });

    it('one missing on a side: said in words', async () => {
        assert.deepStrictEqual(await warnings({ environmentVariables: { org: 'vic', version: 'v2' } }, dev({ org: 'vic' })),
            ['Rows came from version v2. The active environment sends no version.']);
    });

    it('an old run\'s organization reads as org', async () => {
        assert.deepStrictEqual(await warnings({ organization: 'vic' }, dev({ org: 'nz' })), ['Rows came from org vic. The active environment sends org nz.']);
        assert.deepStrictEqual(await warnings({ organization: 'vic' }, dev({ org: 'vic' })), []);
    });

    it('never a fixed Organization', async () => {
        const said = await warnings({ organization: 'vic' }, dev({ org: 'nz' }));
        assert.ok(said.every(w => !/organization/i.test(w)), said.join(' | '));
    });

    it('the Links tab: a linked run that differs by org says org, and its values stay on the host', async () => {
        const end = { linkId: 'l1', executionId: 'run-0', isBatch: true, endpointId: 'ep-0', endpointName: 'Stock', endpointMethod: 'GET', environment: 'DEV', status: 'completed', executionCreatedAt: 0, linkedAt: 0, organization: 'vic', environmentVariables: { org: 'vic', version: 'v2' }, headers: {} };
        const links = { upstream: [end], downstream: [], self: { environment: 'DEV', environmentVariables: { org: 'nz', version: 'v2' }, headers: {} } };
        const { h, posted } = handler({}, dev({}), links);
        await h.handle({ type: 'console.getLinks' });
        const [sent] = posted.find(m => m.type === 'console.links')!.payload.upstream;
        assert.deepStrictEqual(sent.differences, [{ field: 'org', from: 'vic', to: 'nz' }]);
        assert.strictEqual(sent.organization, undefined);
        assert.strictEqual(sent.environmentVariables, undefined);
    });
});
