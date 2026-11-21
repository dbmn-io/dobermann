/**
 * Query engine's compare step judged against the old Compare (compare-across.ts), by the tester,
 * on the tester's own data (generator.ts), not the engine's test data: a Baseline and up to
 * three runs made from it by a seed (rows dropped, added, repeated, reordered; values changed,
 * blanked, or turned from a number into the same number written as text). Each row's records,
 * its kind and which columns differ must be the old Compare's, in its order.
 *
 * Both sides get the same values, as Query loads them (yes/no as the text "true"/"false").
 * Blank keys: the old Compare pairs a blank key with the same blank (null with null, "" with "");
 * the engine follows it, under the manager's ruling, pending James.
 */
import * as assert from 'assert';
import { compareAcross } from '../../../services/compare/compare-across';
import { QueryEngine } from '../../../services/engine/engine';
import type { CompareStats, Expr, Value as EngineValue } from '../../../services/engine/engine-types';
import { makePair, PRESETS, random, type Value } from './generator';

const toEngine = (v: Value): EngineValue => (typeof v === 'boolean' ? (v ? 'true' : 'false') : v);

interface Input { columns: string[]; rows: EngineValue[][] }

/** A run made from the Baseline: the same records mostly, with the changes a real later run has. */
function laterRun(base: Input, seed: number, keyParts: number): Input {
    const r = random(seed);
    const id = base.columns.indexOf('id');
    const out: EngineValue[][] = [];
    for (const row of base.rows) {
        if (r() < 0.08) continue;                                   // dropped
        const copy = row.slice();
        for (let c = keyParts; c < copy.length; c++) {
            if (c === id) continue;
            const v = copy[c], x = r();
            if (x < 0.06) copy[c] = typeof v === 'number' ? v + 1 : `${v ?? ''}x`;      // changed
            else if (x < 0.09) copy[c] = null;                                          // blanked
            else if (x < 0.11) copy[c] = '';
            else if (x < 0.13 && typeof v === 'number') copy[c] = String(v);           // same number, as text
        }
        out.push(copy);
        if (r() < 0.05) { const again = copy.slice(); if (r() < 0.5) again[keyParts] = typeof again[keyParts] === 'number' ? (again[keyParts] as number) + 1 : 'z'; out.push(again); }   // repeated key
    }
    for (let i = 0; i < Math.max(1, Math.round(base.rows.length * 0.05)); i++) {             // keys the Baseline lacks
        const row = base.rows[Math.floor(r() * base.rows.length)].slice();
        row[0] = `NEW${seed}-${i}`;
        out.push(row);
    }
    for (let i = out.length - 1; i > 0; i--) { if (r() < 0.1) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } }   // some reordering
    return { columns: base.columns, rows: out.map((row, i) => { const c = row.slice(); c[id] = `${seed}:${i}`; return c; }) };
}

const col = (name: string, of: string): Expr => ({ column: name, of });
const KIND = { changed: 'diff', missing: 'missing', notInBaseline: 'notInBaseline', duplicate: 'duplicate', same: 'same' } as const;

describe('Query engine compare against the old Compare (reference, the tester\'s)', () => {
    const cases = [
        ['plain', 2], ['plain', 4], ['repeated', 3], ['blanks', 3], ['mixed', 4], ['twoColumnKey', 3], ['everything', 4],
    ] as const;
    for (const [preset, places] of cases) {
        it(`${places} inputs, preset ${preset}: the old Compare's rows, records, kinds and differing columns`, async () => {
            const pair = makePair({ seed: 41, rows: 300, ...PRESETS[preset] });
            const keys = pair.leftKey;
            const columns = [...pair.left.columns, 'id'];
            const base: Input = { columns, rows: pair.left.rows.map((row, i) => [...row.map(toEngine), `base:${i}`]) };
            const inputs = [base, ...Array.from({ length: places - 1 }, (_, p) => laterRun(base, 100 + p, keys.length))];
            const names = inputs.map((_, p) => (p === 0 ? 'BL' : `C${p}`));
            const compared = columns.filter(c => !keys.includes(c) && c !== 'id');

            const sides = inputs.map(t => t.rows.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]]))));
            const old = await compareAcross(sides, { keyColumns: keys, compareColumns: compared }, 0);

            const e = new QueryEngine();
            names.forEach((n, p) => e.load(n, inputs[p]));
            const out = await e.run({ steps: [{
                compare: names,
                on: names.map(n => keys.map(k => col(k, n))),
                columns: compared.map(c => ({ name: c, values: names.map(n => col(c, n)) })),
            }] });
            assert.ok('result' in out, JSON.stringify(out));
            const got = e.read(out.result, 0, out.total);
            const idAt = names.map(n => got.columns.indexOf(`${n}.id`));
            const statusAt = got.columns.indexOf('status');

            const wrong: string[] = [];
            if (out.total !== old.length) wrong.push(`rows: engine ${out.total}, old ${old.length}`);
            for (let row = 0; row < Math.min(old.length, out.total); row++) {
                const want = old.rowNumbers(row).map((list, p) => (list.length ? inputs[p].rows[list[0]][columns.indexOf('id')] : null));
                const has = idAt.map(i => got.rows[row][i]);
                if (JSON.stringify(want) !== JSON.stringify(has)) wrong.push(`row ${row}: records ${JSON.stringify(has)}, old ${JSON.stringify(want)}`);
                if (got.rows[row][statusAt] !== KIND[old.kindOf(row)]) wrong.push(`row ${row}: ${got.rows[row][statusAt]}, old ${old.kindOf(row)}`);
                if (old.kindOf(row) === 'changed') {
                    const diffs = new Set(old.row(row).diffs.flat());
                    for (const c of compared) {
                        const d = got.rows[row][got.columns.indexOf(`differs:${c}`)];
                        if (d !== (diffs.has(c) ? 1 : 0)) wrong.push(`row ${row}: differs:${c} ${d}, old ${diffs.has(c) ? 1 : 0}`);
                    }
                }
            }
            assert.deepStrictEqual(wrong.slice(0, 6), [], `${wrong.length} differences from the old Compare`);
            const stats = e.stats(out.result, 'step 1') as CompareStats;
            assert.deepStrictEqual(stats.status, { same: old.counts.same, diff: old.counts.changed, missing: old.counts.missing, notInBaseline: old.counts.notInBaseline, duplicate: old.counts.duplicate });
            // The data has every kind in it, so the passes above mean something
            if (preset === 'everything') for (const k of ['same', 'changed', 'missing', 'notInBaseline', 'duplicate'] as const) assert.ok(old.counts[k] > 0, `the data holds ${k} rows`);
            e.release(out.result);
        });
    }

    it('blank keys (manager\'s ruling, pending James): null pairs with null and "" with "", never with each other', async () => {
        const e = new QueryEngine();
        e.load('BL', { columns: ['k', 'v'], rows: [[null, 1], ['', 2], ['a', 3]] });
        e.load('C1', { columns: ['k', 'v'], rows: [[null, 1], ['', 2], ['a', 3]] });
        const out = await e.run({ steps: [{ compare: ['BL', 'C1'], on: [[col('k', 'BL')], [col('k', 'C1')]], columns: [{ name: 'v', values: [col('v', 'BL'), col('v', 'C1')] }] }] });
        assert.ok('result' in out);
        const got = e.read(out.result, 0, 9);
        assert.deepStrictEqual(got.rows.map(r => r[got.columns.indexOf('status')]), ['same', 'same', 'same']);
    });
});
