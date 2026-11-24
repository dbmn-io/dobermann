// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * An export from a Console tab writes what the tab shows: the rows its search box leaves, in the
 * columns it shows (2026-11-24, after the Input tab's export wrote 1,000 rows while the tab showed
 * 4). The Input tab's own case is in excel-export-sheets.test.ts; here, Completed and Error, through
 * the host's extractTabData, which CSV, Excel, JSON and SQL all export from.
 *
 * The Error tab shows a Reason column first, whatever its View (#428), and its search reads it,
 * so its export carries Reason too.
 */
import * as assert from 'assert';
import { ConsoleController } from '../../../screens/console/console.controller';
import { ScreenSession } from '../../../screens/screen-session';

type Row = Record<string, unknown>;
type TabData = { data: Row[]; columns: Array<{ id: string; name?: string }> } | null;

const completed = (sku: string, city: string) => ({ httpStatus: 200, status: 'completed', data: { sku, city }, metadata: { status: 'completed' } });
const failed = (sku: string, errorMessage: string, httpStatus = 400) => ({ httpStatus, status: 'error', data: { sku, city: 'Dallas' }, metadata: { status: 'error', errorMessage } });

function controller(responses: unknown[]): ConsoleController {
    const ports = {
        state: { get: () => undefined, update: async () => undefined },
        logger: { log: () => undefined, error: () => undefined },
        toast: { info: () => undefined, warn: () => undefined, error: () => undefined }
    };
    const session = new ScreenSession({ post: () => undefined }, { openExternal: () => undefined });
    const c = new ConsoleController(session, ports as never, { type: 'batch', batchId: 'b1', responseFiles: [] } as never);
    const host = c as unknown as { loadedRawData: unknown; currentConfig: unknown };
    host.loadedRawData = { inputData: [], responses };
    host.currentConfig = { batchId: 'b1', endpointId: 'ep-1' };
    return c;
}

/** The View both tabs show: each response's data.sku and data.city. */
const view = { name: 'Items', rowBasis: 'root', columns: [{ id: 'data.sku', source: 'current' }, { id: 'data.city', source: 'current' }] };

async function exported(c: ConsoleController, tab: 'success' | 'errors', search?: string, visible: string[] | null = null): Promise<TabData> {
    return (c as unknown as { extractTabData(...a: unknown[]): Promise<TabData> }).extractTabData(tab, visible, undefined, search, view);
}
const skus = (t: TabData) => (t ? t.data.map(r => r['data.sku']) : []);

describe('A Console export writes what the tab shows', () => {
    const c = () => controller([
        completed('A1', 'Dallas'), completed('A2', 'Boston'), completed('A3', 'Dallas'),
        failed('E1', 'HTTP 400: Bad Request'), failed('E2', 'Test "Has id" failed: Expected undefined to be true', 200)
    ]);

    it('Completed: the rows the search leaves', async () => {
        assert.deepStrictEqual(skus(await exported(c(), 'success', 'Dallas')), ['A1', 'A3']);
        assert.deepStrictEqual(skus(await exported(c(), 'success', '@city=Boston')), ['A2']);
    });

    it('Completed: in the columns shown; a word in a column not shown finds nothing, as on screen', async () => {
        const t = await exported(c(), 'success', undefined, ['data.sku']);
        assert.deepStrictEqual(t!.columns.map(col => col.id), ['data.sku']);
        assert.deepStrictEqual(t!.data, [{ 'data.sku': 'A1' }, { 'data.sku': 'A2' }, { 'data.sku': 'A3' }]);
        assert.strictEqual(await exported(c(), 'success', 'Dallas', ['data.sku']), null);
    });

    it('Error: the Reason column first, as the tab shows it', async () => {
        const t = await exported(c(), 'errors');
        assert.deepStrictEqual(t!.columns.map(col => col.id), ['__reason', 'data.sku', 'data.city']);
        assert.strictEqual(t!.columns[0].name, 'Reason');
        assert.deepStrictEqual(t!.data.map(r => r.__reason), ['HTTP 400: Bad Request', 'Test "Has id" failed: Expected undefined to be true']);
    });

    it('Error: a search the Reason column answers leaves the same rows as on screen', async () => {
        assert.deepStrictEqual(skus(await exported(c(), 'errors', 'Has id')), ['E2']);
        assert.deepStrictEqual(skus(await exported(c(), 'errors', '@reason="HTTP 400: Bad Request"')), ['E1']);
    });

    it('Error: Reason stays when the page lists only the View\'s columns as visible', async () => {
        const t = await exported(c(), 'errors', 'Has id', ['data.sku', 'data.city']);
        assert.deepStrictEqual(t!.columns.map(col => col.id), ['__reason', 'data.sku', 'data.city']);
        assert.deepStrictEqual(skus(t), ['E2']);
    });
});
