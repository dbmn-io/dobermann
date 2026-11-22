// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Hidden characters come on by themselves when a compare's only differences are ones you can't see
 * (piece 6): Results' first page carries `quiet`, how many DIFF cells are only spaces, tabs, line
 * breaks, unseen characters or blank against null. The demo files' kennels (demo-files/query/a-kennel-*).
 *   npm run test:core
 */
import * as assert from 'assert';
import { QueryController } from '../../../screens/query/query.controller';
import { ScreenSession } from '../../../screens/screen-session';
import type { SavedQuery } from '../../../services/query/query-store';

type Msg = Record<string, unknown> & { type: string };

const A = [
    ['WOOF-001', 'Biscuit', 'Beagle', 'calm'], ['WOOF-002', 'Pepper', 'Pug', 'calm'], ['WOOF-003', 'Rex', 'Boxer', 'loves walks'],
    ['WOOF-004', 'Milo', 'Collie', 'loves swims'], ['WOOF-005', 'Bella', 'Maltese', 'calm'], ['WOOF-006', 'Daisy', 'Poodle', 'calm'],
    ['WOOF-007', 'Max', 'Husky', 'bouncy'], ['WOOF-008', 'Luna', 'Corgi', null], ['WOOF-009', 'Coco', 'Shih Tzu', 'calm'], ['WOOF-010', 'Rocky', 'Akita', 'calm']
];
const B = A.map(r => [...r]);
B[0][1] = 'Biscuit ';
B[1][1] = ' Pepper';
B[2][3] = 'loves  walks';
B[3][3] = 'loves\tswims';
B[4][2] = 'Maltese ';
B[5][1] = 'Dai​sy';
B[6][3] = 'bouncy\n';
B[7][3] = '';
const COLUMNS = ['sku', 'name', 'breed', 'note'];
const asRows = (rows: unknown[][]) => rows.map(r => Object.fromEntries(COLUMNS.map((c, i) => [c, r[i]])));
const FILES: Record<string, { columns: string[]; rows: Record<string, unknown>[] }> = { vA: { columns: COLUMNS, rows: asRows(A) }, vB: { columns: COLUMNS, rows: asRows(B) } };

const src = (id: string) => ({ id, name: id === 'vA' ? 'KennelA' : 'KennelB', endpointId: '', endpointName: 'kennel.xlsx', view: '', executionId: '', isBatch: false, environment: '', executedAt: '2026-11-23T00:00:00Z', file: { name: `${id}.xlsx`, sheet: 'Sheet1' } });
const compared = (column: string) => [{ view: 'vA', column, group: column }, { view: 'vB', column, group: column }];

describe('Query: hidden characters come on by themselves (a compare whose DIFFs are all unseen)', function () {
    this.timeout(20000);

    // (8 here: the demo's seven, and WOOF-008's blank against empty text, which this test keeps apart as null and ''; read from
    // the spreadsheet both are blank, so the demo shows 7)
    it('Results\' first page says 8 quiet differences: trailing, leading and double spaces, a tab, NBSP, ZWSP, a line break, blank against ""', async () => {
        const query = {
            id: 'qry-kennel', name: 'Kennels', reached: 4, createdAt: '2026-11-23T00:00:00Z', updatedAt: '2026-11-23T00:00:00Z',
            sources: [src('vA'), src('vB')],
            joins: [{ view: 'vB', kind: 'compare', on: [{ left: { parts: [{ view: 'vA', column: 'sku' }] }, right: { parts: [{ view: 'vB', column: 'sku' }] } }] }],
            select: [{ view: 'vA', column: 'sku' }, ...compared('name'), ...compared('breed'), ...compared('note')]
        } as unknown as SavedQuery;
        const store = new Map<string, unknown>([['queries', [query]]]);
        const seen: Msg[] = [];
        const session = new ScreenSession({ post: (m: Msg) => { seen.push(m); } } as never, { openExternal() { /* */ } } as never);
        const ports = {
            metadata: { getUnifiedExecutionHistory: async () => [] },
            environments: { getEnvironment: async () => undefined, getEnvironments: async () => [], listEnvironments: async () => [] },
            endpoints: { getEndpoint: async () => undefined, updateEndpoint: async () => undefined },
            state: { get: (k: string) => store.get(k), update: async (k: string, v: unknown) => { store.set(k, v); } },
            toast: { info() { /* */ }, warn() { /* */ }, error() { /* */ } },
            logger: { log() { /* */ }, error() { /* */ } },
            host: { close() { /* */ }, openConsole: async () => { /* */ } },
            queryFiles: { read: async (_q: string, view: string) => FILES[view], save: async () => { /* */ }, remove: async () => { /* */ } }
        };
        const controller = new QueryController(session, ports as never, { queryId: query.id, start: 'results' });
        await controller.handleMessage({ type: 'query.ready' } as never);
        await controller.handleMessage({ type: 'query.rows', seq: 1, offset: 0, limit: 50, search: '', sort: null, filter: {} } as never);
        const data = [...seen].reverse().find(m => m.type === 'query.rowsData') as Msg & { counts?: { kinds?: Record<string, number> }; quiet?: number };
        assert.ok(data, 'Results\' rows came');
        assert.strictEqual(data.quiet, 8, `quiet: ${JSON.stringify({ quiet: data.quiet, counts: data.counts })}`);
        controller.dispose();
    });
});
