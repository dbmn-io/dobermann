// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A lookup table's screen (src/screens/lookup): the table to the page, the page's edits kept
 * (or why not), a rename from the Hub's list, and a delete or a change made elsewhere told to
 * the page.
 *   npm run test:core
 */
import { expect } from 'chai';
import { ScreenSession } from '../../../screens/screen-session';
import { LookupController } from '../../../screens/lookup/lookup.controller';
import { LookupTablesStore } from '../../../services/lookup-tables/lookup-tables';
import { MemoryKeyValueStore } from '../../../platform/memory/memory-key-value-store';

type Message = Record<string, unknown>;

async function setUp() {
    const state = new MemoryKeyValueStore();
    const store = new LookupTablesStore(state);
    const table = await store.create('Units');
    const posted: Message[] = [];
    const renamed: string[] = [];
    const toasts: string[] = [];
    const session = new ScreenSession({ post: m => posted.push(m) }, { openExternal: () => undefined });
    const controller = new LookupController(session, {
        store,
        toast: { info: m => toasts.push(m), warn: m => toasts.push(m), error: m => toasts.push(m) },
        host: { renamed: name => renamed.push(name) }
    }, { id: table.id });
    const last = (type: string) => [...posted].reverse().find(m => m.type === type);
    return { state, store, table, posted, renamed, toasts, controller, last };
}

describe('Lookup table screen (controller)', () => {
    it('ready: the table and the limits go to the page', async () => {
        const { controller, last, table } = await setUp();
        await controller.handleMessage({ type: 'lookup.ready' });
        const load = last('lookup.load') as { table: { id: string; columns: unknown[] }; limits: { columns: number; rows: number } };
        expect(load.table.id).to.equal(table.id);
        expect(load.table.columns).to.have.length(2);
        expect(load.limits).to.deep.equal({ columns: 50, rows: 100000 });
    });

    it('the page\'s columns and rows are kept under the table\'s own name; the page hears it', async () => {
        const { controller, store, table, last } = await setUp();
        const columns = [{ id: 'erp', name: 'ERP unit', key: true }, { id: 'wms', name: 'WMS unit' }, { id: 'fin', name: 'Finance unit' }];
        await controller.handleMessage({ type: 'lookup.save', seq: 3, table: { columns, rows: [{ erp: 'EA', wms: 'EACH', fin: 'UNIT' }, { erp: 'CS', wms: 'CASE', fin: 12 }] } });
        expect(last('lookup.saved')).to.include({ seq: 3, rows: 2 });
        const kept = await store.get(table.id);
        expect(kept?.name).to.equal('Units');
        expect(kept?.rows[1]).to.deep.equal({ erp: 'CS', wms: 'CASE', fin: '12' });
    });

    it('what can\'t be kept is not, and the page hears why', async () => {
        const { controller, store, table, last } = await setUp();
        await controller.handleMessage({ type: 'lookup.save', seq: 4, table: { columns: [{ id: 'k', name: 'code', key: true }], rows: [{ k: 'A' }, { k: 'A' }] } });
        expect(String(last('lookup.notSaved')?.reason)).to.match(/a key is in one row only/);
        expect((await store.get(table.id))?.rows).to.deep.equal([]);
    });

    it('renamed from the Hub\'s list while open: kept, and the tab follows; a taken name is refused', async () => {
        const { controller, store, table, renamed, toasts } = await setUp();
        await controller.handleMessage({ type: 'lookup.rename', name: 'Unit codes' });
        expect((await store.get(table.id))?.name).to.equal('Unit codes');
        expect(renamed).to.deep.equal(['Unit codes']);
        await store.create('Other');
        await controller.handleMessage({ type: 'lookup.rename', name: 'other' });
        expect(toasts.join(' ')).to.match(/already called other/);
    });

    it('changed elsewhere: the page gets it again; deleted: the page hears it is gone (and a save says so)', async () => {
        const { controller, store, table, posted, last } = await setUp();
        await store.save({ ...table, rows: [{ c1: 'EA', c2: 'each' }] });
        await new Promise(resolve => setImmediate(resolve));   // (the screen reads it again)
        expect((last('lookup.load') as { table: { rows: unknown[] } }).table.rows).to.have.length(1);
        await store.remove(table.id);
        expect(last('lookup.missing')).to.not.equal(undefined);
        posted.length = 0;
        await controller.handleMessage({ type: 'lookup.save', seq: 5, table: { columns: [], rows: [] } });
        expect(posted.map(m => m.type)).to.deep.equal(['lookup.missing']);
        controller.dispose();
    });

    it('its own save is not news: the page is not sent the table back', async () => {
        const { controller, posted } = await setUp();
        await controller.handleMessage({ type: 'lookup.save', seq: 6, table: { columns: [{ id: 'c1', name: 'code', key: true }, { id: 'c2', name: 'value' }], rows: [{ c1: 'EA', c2: 'each' }] } });
        expect(posted.map(m => m.type)).to.deep.equal(['lookup.saved']);
    });
});
