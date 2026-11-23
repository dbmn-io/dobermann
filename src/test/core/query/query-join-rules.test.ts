// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Join step's rules (src/webviews/query/query-join-rules.js), as the page uses them. James, 2026-11-23: "I enjoyed
 * blocks but I must be able to delete it and play around with it. So unjoined or unselected columns should block":
 * Next waits while a view on show isn't joined, saying which; any join can be deleted; Reset joins whenever a join has a
 * column picked (it keeps each join's kind); a view not joined can be hidden from its own menu (a hidden view holds nothing up).
 *   npm run test:core
 */
import * as assert from 'assert';
import * as rulesScript from '../../../webviews/query/query-join-rules.js';
import { sharedScript } from '../../../utils/shared-script';

type Side = { view?: string; column: string };
type Join = { view: string; kind: string; on: { left: Side; right: Side }[] };
type State = { views: { id: string; name: string; off?: boolean }[]; joins: Join[] };
type Item = { disabled: boolean; detail: string };
type RemoveItem = Item & { line?: boolean };
const { notJoined, menu, joinLines } = sharedScript<{
    notJoined(state: State): string;
    menu(state: State, join: Join): { remove: RemoveItem; reset: Item; hide: boolean };
    joinLines(state: State, shown: Set<string>, touched: boolean): { lines: string[]; next: string };
}>(rulesScript, 'QueryJoinRules');

const VIEWS = [{ id: 'vBL', name: 'c-pack-BL' }, { id: 'vC1', name: 'c-pack-C1' }, { id: 'vC2', name: 'c-pack-C2' }];
const on = (left: string, l: string, r: string) => [{ left: { view: left, column: l }, right: { column: r } }];
const empty = (view: string): Join => ({ view, kind: 'left', on: [] });

describe('Query: the Join step\'s rules (Next, Delete join, Reset joins, Hide)', () => {
    it('Next waits while a view on show isn\'t joined, naming it; a hidden one holds nothing up', () => {
        const state: State = { views: VIEWS, joins: [{ view: 'vC1', kind: 'compare', on: on('vBL', 'sku', 'sku') }, empty('vC2')] };
        assert.strictEqual(notJoined(state), 'c-pack-C2 isn\'t joined: add a join for it, or hide it.');
        assert.strictEqual(notJoined({ ...state, views: VIEWS.map(v => (v.id === 'vC2' ? { ...v, off: true } : v)) }), '');
    });

    it('a join with a column picked on one side only, or a + AND line left empty, still waits', () => {
        assert.match(notJoined({ views: VIEWS.slice(0, 2), joins: [{ view: 'vC1', kind: 'left', on: [{ left: { view: 'vBL', column: 'sku' }, right: { column: '' } }] }] }), /c-pack-C1 isn't joined/);
        assert.match(notJoined({ views: VIEWS.slice(0, 2), joins: [{ view: 'vC1', kind: 'left', on: [...on('vBL', 'sku', 'sku'), { left: { view: 'vBL', column: '' }, right: { column: '' } }] }] }), /c-pack-C1 isn't joined/);
    });

    it('every view joined: nothing waits; one view alone: nothing to join', () => {
        assert.strictEqual(notJoined({ views: VIEWS, joins: [{ view: 'vC1', kind: 'left', on: on('vBL', 'sku', 'sku') }, { view: 'vC2', kind: 'left', on: on('vC1', 'sku', 'sku') }] }), '');
        assert.strictEqual(notJoined({ views: VIEWS.slice(0, 1), joins: [] }), '');
    });

    it('an empty line (C2 not joined): Delete join takes the line away, Hide this view offered; Reset joins on', () => {
        // (the manager for James, 2026-11-23: a line + Add join brought up can be taken away again)
        const state: State = { views: VIEWS, joins: [{ view: 'vC1', kind: 'compare', on: on('vBL', 'sku', 'sku') }, empty('vC2')] };
        const m = menu(state, state.joins[1]);
        assert.deepStrictEqual(m.remove, { disabled: false, detail: 'Takes this line away', line: true });
        assert.strictEqual(m.hide, true);
        assert.deepStrictEqual(m.reset, { disabled: false, detail: 'Every join back to "Pick a column"' });
    });

    it('a join with a column, or a compare with no key yet: Delete join on; a joined view\'s menu has no Hide', () => {
        const joined: State = { views: VIEWS.slice(0, 2), joins: [{ view: 'vC1', kind: 'left', on: on('vBL', 'sku', 'sku') }] };
        assert.deepStrictEqual(menu(joined, joined.joins[0]).remove, { disabled: false, detail: '', line: false });
        assert.strictEqual(menu(joined, joined.joins[0]).hide, false);
        const keyless: State = { views: VIEWS.slice(0, 2), joins: [{ view: 'vC1', kind: 'compare', on: [] }] };
        assert.strictEqual(menu(keyless, keyless.joins[0]).remove.disabled, false);
        // (Reset joins keeps each join's kind, so a compare with no key has nothing to reset: Delete join takes it back)
        assert.strictEqual(menu(keyless, keyless.joins[0]).reset.disabled, true);
    });

    it('which lines show: nothing appears by itself (James, 2026-11-23: "an add join button… stop flipping and adding and removing")', () => {
        const none = new Set<string>();
        // Nothing joined: the first view not joined has its line, there being nothing else to do; + Add join brings C2
        const fresh: State = { views: VIEWS, joins: [empty('vC1'), empty('vC2')] };
        assert.deepStrictEqual(joinLines(fresh, none, false), { lines: ['vC1'], next: 'vC2' });
        // BL = C1 made: C2's line doesn't appear by itself
        const one: State = { views: VIEWS, joins: [{ view: 'vC1', kind: 'left', on: on('vBL', 'sku', 'sku') }, empty('vC2')] };
        assert.deepStrictEqual(joinLines(one, none, false), { lines: ['vC1'], next: 'vC2' });
        // + Add join: C2's line, and nothing left to add
        assert.deepStrictEqual(joinLines(one, new Set(['vC2']), true), { lines: ['vC1', 'vC2'], next: '' });
        // A line he took away doesn't come back by itself, even with nothing joined
        assert.deepStrictEqual(joinLines(fresh, none, true), { lines: [], next: 'vC1' });
        // In a compare: no line by itself; a hidden view needs none
        const compared: State = { views: [...VIEWS.slice(0, 2), { ...VIEWS[2], off: true }], joins: [{ view: 'vC1', kind: 'compare', on: on('vBL', 'sku', 'sku') }, empty('vC2')] };
        assert.deepStrictEqual(joinLines(compared, none, false), { lines: [], next: '' });
    });

    it('nothing joined anywhere, every join plain: Reset joins greyed, saying why', () => {
        const state: State = { views: VIEWS, joins: [empty('vC1'), empty('vC2')] };
        assert.deepStrictEqual(menu(state, state.joins[0]).reset, { disabled: true, detail: 'No join has a column picked yet' });
    });
});
