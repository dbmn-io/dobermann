// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Hub's search rules (#444): shared/search-words.js, used by the API Catalogue, History and
 * the catalogue service.
 *
 * James, 2026-11-12: "I need to be able to go search for post space endpoint name or anything that
 * is in that endpoint... I can't do multiple searches", and the query is just the text in the box.
 */
import { expect } from 'chai';
import { filterEndpoints } from '../../../services/catalogue/catalogue.service';
import type { APIEndpointConfig } from '../../../apiConfigManager';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const W = require('../../../webviews/shared/search-words.js');

describe('Hub search (#444)', () => {
    describe('words', () => {
        it('every word, in any order, anywhere', () => {
            const hay = 'Bulk Inventory Upload\nPOST\n/inventory';
            expect(W.matches(W.parseWords('post bulk'), hay)).to.equal(true);
            expect(W.matches(W.parseWords('BULK post'), hay)).to.equal(true);
            expect(W.matches(W.parseWords('post carriers'), hay)).to.equal(false);
        });

        it('"a phrase" is one word, -word leaves out', () => {
            expect(W.parseWords('post "bulk inventory" -paused')).to.deep.equal({ include: ['post', 'bulk inventory'], exclude: ['paused'] });
            expect(W.matches(W.parseWords('"inventory bulk"'), 'Bulk Inventory Upload')).to.equal(false);
            expect(W.matches(W.parseWords('bulk -upload'), 'Bulk Inventory Upload')).to.equal(false);
            expect(W.matches(W.parseWords('-'), 'anything')).to.equal(true);
        });

        it('nothing typed matches everything', () => {
            expect(W.matches(W.parseWords('   '), '')).to.equal(true);
        });

        it('a word may be found elsewhere (History: in the bodies)', () => {
            const parsed = W.parseWords('carriers SKU-1');
            expect(W.matches(parsed, 'Get Carriers', (w: string) => w === 'sku-1')).to.equal(true);
            expect(W.matches(parsed, 'Get Carriers', () => false)).to.equal(false);
        });

        it('marks the words, escaping the rest', () => {
            expect(W.highlight('Bulk <Inventory>', W.parseWords('inv bulk')))
                .to.equal('<mark class="search-hit">Bulk</mark> &lt;<mark class="search-hit">Inv</mark>entory&gt;');
        });
    });

    describe('the query (the tables\' search: James, 2026-11-21)', () => {
        it('reads the fields the dialogs write: @system (current is \'\'), @env, @status, @method, @tag groups, @ran; the rest is kept as typed', () => {
            const q = W.parseQuery('@system=current|dbmn @method=get @tag="puppy school" @tag=inv|items bulk -report @@body @env=prod @status=error @ran>7d @ran=2026-11-01..2026-11-12 @path~orders');
            expect(q.systems).to.deep.equal(['', 'dbmn']);
            expect(q.methods).to.deep.equal(['GET']);
            expect(q.tagGroups).to.deep.equal([['puppy school'], ['inv', 'items']]);
            expect(q.tags).to.deep.equal(['puppy school', 'inv', 'items']);
            expect(q.envs).to.deep.equal(['prod']);
            expect(q.statuses).to.deep.equal(['error']);
            expect(q.dates).to.deep.equal(['7d', '2026-11-01..2026-11-12']);
            expect(q.text).to.equal('bulk -report @@body @path~orders');
            expect(q.words).to.equal('bulk -report');
        });

        it('is written back in one order, quoting a value with a space; current for \'\'', () => {
            expect(W.buildQuery(W.parseQuery('bulk @tag=inv @system=current @method=get @status=error @env=prod @ran>7d'))).to.equal('@system=current @env=prod @status=error @method=get @tag=inv @ran>7d bulk');
            expect(W.buildQuery({ systems: [], envs: [], statuses: [], methods: ['POST', 'GET'], tags: ['puppy school', 'x'], dates: ['2026-11-01..'], text: '' })).to.equal('@method=post|get @tag="puppy school"|x @ran=2026-11-01..');
        });

        it('dates: 24h, 7d, 2w since then; a..b between', () => {
            expect(W.sinceMs('24h')).to.equal(86400e3);
            expect(W.sinceMs('2w')).to.equal(14 * 86400e3);
            expect(W.sinceMs('7x')).to.equal(null);
            expect(W.between('2026-11-01..')).to.deep.equal({ from: '2026-11-01', to: '' });
        });

        it('@@ words, for a host that searches bodies itself', () => {
            expect(W.deepWords('get @@urgent -@@draft @@"out of stock" urgent')).to.deep.equal(['urgent', 'draft', 'out of stock']);
        });
    });

    describe('a row test over a list\'s fields (SearchMatcher)', () => {
        const fields = [
            { id: 'name', get: (r: Row) => r.name },
            { id: 'method', get: (r: Row) => r.method },
            { id: 'tag', hidden: true, get: (r: Row) => r.tags },
            { id: 'system', hidden: true, get: (r: Row) => r.system },
            { id: 'body', hidden: true, get: (r: Row) => r.body }
        ];
        interface Row { name: string; method: string; tags: string[]; system: string; body: string }
        const rows: Row[] = [
            { name: 'Bulk inventory upload', method: 'POST', tags: ['inventory', 'bulk'], system: 'WMS', body: '{"urgent":true}' },
            { name: 'Get items', method: 'GET', tags: ['items'], system: 'ERP', body: '' }
        ];
        const find = (query: string, current?: { system?: string; env?: string }) => rows.filter(W.rowTest(query, fields, current)).map(r => r.name);

        it('plain words: what the list shows only; @@: every field', () => {
            expect(find('bulk')).to.deep.equal(['Bulk inventory upload']);
            expect(find('urgent')).to.deep.equal([]);
            expect(find('@@urgent')).to.deep.equal(['Bulk inventory upload']);
            expect(find('wms')).to.deep.equal([]);
        });

        it('@tag= is any of a row\'s tags; a|b either; @tag twice, both', () => {
            expect(find('@tag=items')).to.deep.equal(['Get items']);
            expect(find('@tag=items|bulk')).to.deep.equal(['Bulk inventory upload', 'Get items']);
            expect(find('@tag=inventory @tag=bulk')).to.deep.equal(['Bulk inventory upload']);
            expect(find('@tag=inventory @tag=items')).to.deep.equal([]);
        });

        it('@system=current is the current System by name; with none current, nothing', () => {
            expect(find('@system=current', { system: 'ERP' })).to.deep.equal(['Get items']);
            expect(find('@system=current|wms', { system: 'ERP' })).to.deep.equal(['Bulk inventory upload', 'Get items']);
            expect(find('@system=current')).to.deep.equal([]);
        });

        it('an empty query passes every row', () => {
            expect(find('  ')).to.have.length(2);
        });
    });

    describe('the API Catalogue', () => {
        const ep = (id: string, name: string, method: string, path: string, tags: string[] = []): APIEndpointConfig =>
            ({ id, name, method, path, tags } as unknown as APIEndpointConfig);
        const endpoints = [
            ep('a', 'Bulk Inventory Upload', 'POST', '/inventory', ['inventory', 'load']),
            ep('b', 'Get Carriers', 'GET', '/reference/carriers', ['reference']),
            ep('c', 'Inventory Report', 'GET', '/inventory/report', ['inventory'])
        ];
        const ids = (out: APIEndpointConfig[]) => out.map(e => e.id);

        it('finds by several words across name, method and path', () => {
            expect(ids(filterEndpoints(endpoints, { search: 'post inventory' }))).to.deep.equal(['a']);
            expect(ids(filterEndpoints(endpoints, { search: 'inventory -report' }))).to.deep.equal(['a']);
        });

        it('tags: any of them', () => {
            expect(ids(filterEndpoints(endpoints, { tags: ['load'] }))).to.deep.equal(['a']);
            expect(ids(filterEndpoints(endpoints, { tags: ['load', 'reference'] }))).to.deep.equal(['a', 'b']);
        });
    });
});
