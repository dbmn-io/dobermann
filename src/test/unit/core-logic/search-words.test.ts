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

    describe('the query', () => {
        it('reads the signs: methods, #tag, @System, !status, ~environment, dates; the rest is words', () => {
            expect(W.parseQuery('@ get #"puppy school" bulk -report ~ !error 7d 2026-11-01..2026-11-12 "get" @dbmn ~prod #')).to.deep.equal({
                methods: ['GET'], tags: ['puppy school'], systems: ['', 'dbmn'], statuses: ['error'], envs: ['', 'prod'],
                dates: ['7d', '2026-11-01..2026-11-12'], text: 'bulk -report "get"'
            });
        });

        it('is written back in one order, quoting a name with a space', () => {
            expect(W.buildQuery(W.parseQuery('bulk #inv @ get !error ~prod 7d'))).to.equal('@ ~prod !error get #inv 7d bulk');
            expect(W.buildQuery({ systems: [], envs: [], statuses: [], methods: ['POST'], tags: ['puppy school'], dates: [], text: '' })).to.equal('post #"puppy school"');
        });

        it('dates: 24h, 7d, 2w since then; a..b between', () => {
            expect(W.sinceMs('24h')).to.equal(86400e3);
            expect(W.sinceMs('2w')).to.equal(14 * 86400e3);
            expect(W.sinceMs('7x')).to.equal(null);
            expect(W.between('2026-11-01..')).to.deep.equal({ from: '2026-11-01', to: '' });
        });
    });

    describe('suggestions', () => {
        const candidates = [
            { sign: '#', value: 'bulk-upload', count: 4 },
            { sign: '#', value: 'dbmn', count: 2 },
            { sign: '#', value: 'puppy school', count: 1 },
            { sign: '@', value: 'dbmn', count: 9 },
            { sign: '@', value: '', label: 'current System: Training' },
            { sign: 'method', value: 'POST', count: 3 },
            { sign: 'method', value: 'GET', count: 5 },
            { sign: '!', value: 'error', count: 2 },
            { sign: '!', value: 'completed', count: 8 }
        ];
        const say = (typed: string) => W.suggestionsFor(typed, candidates).map((s: { text: string; start: number }) => `${s.text}@${s.start}`);

        it('a sign alone lists its values, the current one first, then the most used', () => {
            expect(say('#')).to.deep.equal(['#bulk-upload@0', '#dbmn@0', '#"puppy school"@0']);
            expect(say('@')).to.deep.equal(['@@0', '@dbmn@0']);
            expect(say('!')).to.deep.equal(['!completed@0', '!error@0']);
            expect(say('#"pup')).to.deep.equal(['#"puppy school"@0']);
        });

        it('a word: every kind that holds it', () => {
            expect(say('db')).to.deep.equal(['@dbmn@0', '#dbmn@0']);
            expect(say('po')).to.deep.equal(['post@0']);
        });

        it('several words can be one name: `bulk up` is #bulk-upload, replacing both', () => {
            expect(say('post bulk up')).to.deep.equal(['#bulk-upload@5']);
        });

        it('nothing after a space, nor for what is already in the query', () => {
            expect(say('post ')).to.deep.equal([]);
            expect(say('#dbmn db')).to.deep.equal(['@dbmn@6']);
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
