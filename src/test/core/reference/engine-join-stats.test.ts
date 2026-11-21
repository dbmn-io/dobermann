/**
 * The Join step's counts from Query's engine, judged by the tester against a plain count written
 * here from what each number means (engine-types.ts JoinStats; today's joinStats SQL in
 * query-engine.ts): neither the engine's code nor the SQL, so a shared mistake shows.
 *
 * A key with a blank part (null) is left out of the matching, as in a join; "" is a value.
 */
import * as assert from 'assert';
import { QueryEngine } from '../../../services/engine/engine';
import type { JoinKind, JoinStats, Table as EngineTable, Value as EngineValue } from '../../../services/engine/engine-types';
import { makePair, PRESETS, type Value } from './generator';

const toEngine = (v: Value): EngineValue => (typeof v === 'boolean' ? (v ? 'true' : 'false') : v);
type Kind = 'oneToOne' | 'oneToMany' | 'manyToOne' | 'manyToMany';
const kindOf = (l: number, r: number): Kind => (l === 1 ? (r === 1 ? 'oneToOne' : 'oneToMany') : (r === 1 ? 'manyToOne' : 'manyToMany'));

/** Rows per key value on one side (keys with a blank part left out), and the key parts kept apart. */
function groups(rows: EngineValue[][], at: number[]): Map<string, { key: EngineValue[]; n: number }> {
    const m = new Map<string, { key: EngineValue[]; n: number }>();
    for (const row of rows) {
        const key = at.map(i => row[i]);
        if (key.some(v => v === null)) continue;
        const id = JSON.stringify(key.map(v => (typeof v === 'number' ? { n: v } : v)));
        const g = m.get(id); if (g) g.n++; else m.set(id, { key, n: 1 });
    }
    return m;
}

/** What each count means, counted by hand. */
function expected(L: EngineValue[][], R: EngineValue[][], lAt: number[], rAt: number[], kind: JoinKind) {
    const lg = groups(L, lAt), rg = groups(R, rAt);
    const keys = { oneToOne: 0, oneToMany: 0, manyToOne: 0, manyToMany: 0 }, rows = { ...keys }, records = { ...keys };
    let leftMatched = 0, rightMatched = 0, pairs = 0;
    for (const [id, l] of lg) {
        const r = rg.get(id); if (!r) continue;
        const k = kindOf(l.n, r.n);
        keys[k]++; rows[k] += l.n; records[k] += r.n;
        leftMatched += l.n; rightMatched += r.n; pairs += l.n * r.n;
    }
    const keepsLeft = kind === 'left' || kind === 'outer', keepsRight = kind === 'right' || kind === 'outer';
    const relationship = keys.manyToMany || (keys.oneToMany && keys.manyToOne) ? 'manyToMany' : keys.oneToMany ? 'oneToMany' : keys.manyToOne ? 'manyToOne' : keys.oneToOne ? 'oneToOne' : 'none';
    const all = new Set([...lg.keys(), ...rg.keys()]);
    const leftBlank = L.filter(row => lAt.some(i => row[i] === null)).length;
    return {
        stats: { leftRows: L.length, leftMatched, rightRows: R.length, rightMatched, rowsAfter: pairs + (keepsLeft ? L.length - leftMatched : 0) + (keepsRight ? R.length - rightMatched : 0), relationship, keys, rows, records, leftBlank, leftValues: lg.size, rightValues: rg.size, valuesTotal: all.size },
        lg, rg,
    };
}

/** The order the windows promise: rows made (left × max(right, 1)) descending, then right descending, then the key. */
function ordered(list: { key: EngineValue[]; l: number; r: number }[]) {
    const cmp = (a: EngineValue, b: EngineValue) => (typeof a === typeof b ? (a! < b! ? -1 : a! > b! ? 1 : 0) : typeof a === 'number' ? -1 : 1);
    return list.sort((a, b) => (b.l * Math.max(b.r, 1)) - (a.l * Math.max(a.r, 1)) || b.r - a.r || a.key.reduce<number>((d, v, i) => d || cmp(v, b.key[i]), 0));
}

describe('Query engine join statistics against a hand count (reference, the tester\'s)', () => {
    for (const preset of ['plain', 'repeated', 'blanks', 'mixed', 'twoColumnKey', 'everything'] as const) {
        it(`every count, and the values behind each, for each kind of join: preset ${preset}`, async () => {
            const pair = makePair({ seed: 51, rows: 400, ...{ ...PRESETS[preset], repeats: Math.max(PRESETS[preset].repeats ?? 0, 0.25) } });
            const L = pair.left.rows.map(r => r.map(toEngine)), R = pair.right.rows.map(r => r.map(toEngine));
            const lAt = pair.leftKey.map(k => pair.left.columns.indexOf(k)), rAt = pair.rightKey.map(k => pair.right.columns.indexOf(k));
            for (const kind of ['inner', 'left', 'right', 'outer'] as const) {
                const want = expected(L, R, lAt, rAt, kind);
                const e = new QueryEngine();
                e.load('L', { columns: pair.left.columns, rows: L });
                e.load('R', { columns: pair.right.columns, rows: R });
                const out = await e.run({ steps: [{ as: 'l', from: 'L' }, { as: 'r', from: 'R' }, { as: 'j', join: kind, left: 'l', right: 'r', on: pair.leftKey.map((k, i) => ({ left: { column: k, of: 'l' }, right: { column: pair.rightKey[i], of: 'r' } })) }] });
                assert.ok('result' in out, JSON.stringify(out));
                const st = e.stats(out.result, 'j') as JoinStats;
                const { typeMismatch, ...rest } = st;
                assert.deepStrictEqual(rest, want.stats, kind);
                assert.strictEqual(typeMismatch, false, `${kind}: text keys on both sides`);
                assert.strictEqual(out.total, want.stats.rowsAfter, `${kind}: the rows made are the count said`);
                // The values behind each count, all of them in one window, then in pages of 7
                const lists: Record<string, { key: EngineValue[]; l: number; r: number }[]> = { oneToOne: [], oneToMany: [], manyToOne: [], manyToMany: [], onlyLeft: [], onlyRight: [] };
                for (const [id, g] of want.lg) { const r = want.rg.get(id)?.n ?? 0; lists[r ? kindOf(g.n, r) : 'onlyLeft'].push({ key: g.key, l: g.n, r }); }
                for (const [id, g] of want.rg) if (!want.lg.has(id)) lists.onlyRight.push({ key: g.key, l: 0, r: g.n });
                for (const [k, list] of Object.entries(lists)) {
                    const rows = ordered(list).map(v => [...v.key, v.l, v.r]);
                    const one = e.stats(out.result, 'j', { kind: k as never, side: 'left', from: 0, count: rows.length + 5 }) as EngineTable;
                    assert.deepStrictEqual(one.rows, rows, `${kind} ${k}`);
                    const paged: EngineValue[][] = [];
                    for (let from = 0; from < rows.length; from += 7) paged.push(...(e.stats(out.result, 'j', { kind: k as never, side: 'left', from, count: 7 }) as EngineTable).rows);
                    assert.deepStrictEqual(paged, rows, `${kind} ${k} paged`);
                }
                e.release(out.result);
            }
        });
    }

    it('a key that is a number on one side and text on the other is said (typeMismatch)', async () => {
        const e = new QueryEngine();
        e.load('L', { columns: ['k'], rows: [['1'], ['2'], [null]] });
        e.load('R', { columns: ['k'], rows: [[1], [2]] });
        const out = await e.run({ steps: [{ as: 'j', join: 'outer', left: 'L', right: 'R', on: [{ left: { column: 'k' }, right: { column: 'k' } }] }] });
        assert.ok('result' in out);
        const st = e.stats(out.result, 'j') as JoinStats;
        assert.strictEqual(st.typeMismatch, true);
        assert.strictEqual(st.leftMatched, 0);
        assert.strictEqual(st.leftBlank, 1);
    });
});
