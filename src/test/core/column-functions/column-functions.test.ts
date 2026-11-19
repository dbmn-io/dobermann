// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Functions on a column (src/services/column-functions): run in memory, each gives exactly what
 * SQLite gives for the same value, so a function means the same in Query (SQL) as in Compare and
 * Run Batch (in memory).
 *   npm run test:core
 */
import * as assert from 'assert';
import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic } from 'sql.js';
import { applyColumnFns, columnFnSql, ColumnFn } from '../../../services/column-functions/column-functions';
import { SQL_WASM_PATH } from '../fixtures/temp-storage';

/** Values from results and files: text of every shape, numbers, yes/no, blanks. */
const VALUES: unknown[] = [
    'WOOF-033', '  WOOF-033  ', '\tpadded\t', '0WOOF-033', '000123', '0', '', 'each', 'Kibble 10kg',
    'café', 'ÉCLAIR', 'naïve 😀 dog', '12abc', ' 42 ', '1.50', '2.0', '1e3', '-0.5', '.5', 'abc',
    54, 0, -7, 1.5, 2.25, 0.1, 1e21, 123456789012, true, false, null
];

const FNS: ColumnFn[][] = [
    [{ fn: 'trim' }], [{ fn: 'upper' }], [{ fn: 'lower' }], [{ fn: 'ltrimZeros' }],
    [{ fn: 'text' }], [{ fn: 'number' }],
    [{ fn: 'first', n: 4 }], [{ fn: 'first', n: 1 }], [{ fn: 'last', n: 3 }], [{ fn: 'last', n: 50 }],
    [{ fn: 'replace', from: '-', to: '' }], [{ fn: 'replace', from: '10kg', to: '10 kg' }], [{ fn: 'replace', from: '', to: 'x' }],
    [{ fn: 'trim' }, { fn: 'upper' }], [{ fn: 'ltrimZeros' }, { fn: 'number' }], [{ fn: 'number' }, { fn: 'text' }],
    [{ fn: 'upper' }, { fn: 'replace', from: 'WOOF', to: 'DOG' }, { fn: 'first', n: 6 }]
];

describe('Functions on a column', () => {
    let SQL: SqlJsStatic;
    let db: Database;
    before(async () => {
        SQL = await initSqlJs({ locateFile: () => SQL_WASM_PATH });
        db = new SQL.Database();
    });
    after(() => db.close());

    /** What SQLite makes of a value (bound with the type SQLite would hold it as). */
    function sqlite(value: unknown, fns: ColumnFn[]): unknown {
        const bound = typeof value === 'boolean' ? (value ? 1 : 0) : value === undefined ? null : value;
        const stmt = db.prepare(`SELECT ${columnFnSql('?', fns)}`);
        try {
            stmt.bind([bound as number | string | null]);
            stmt.step();
            return stmt.get()[0];
        } finally {
            stmt.free();
        }
    }

    it('each function, and functions in a row, give what SQLite gives', () => {
        const wrong: string[] = [];
        for (const fns of FNS) {
            for (const value of VALUES) {
                const want = sqlite(value, fns);
                const got = applyColumnFns(value, fns);
                if (!Object.is(got, want) && !(typeof got === 'number' && got === want)) {
                    wrong.push(`${JSON.stringify(fns)} on ${JSON.stringify(value)}: SQLite ${JSON.stringify(want)} (${typeof want}), here ${JSON.stringify(got)} (${typeof got})`);
                }
            }
        }
        assert.deepStrictEqual(wrong, []);
    });

    it('a blank stays blank, and no functions leave a value as it is', () => {
        assert.strictEqual(applyColumnFns(null, [{ fn: 'upper' }, { fn: 'number' }]), null);
        assert.strictEqual(applyColumnFns(undefined, [{ fn: 'trim' }]), null);
        assert.strictEqual(applyColumnFns('as is', []), 'as is');
        assert.strictEqual(applyColumnFns(54, undefined), 54);
    });

    it('writes the SQL the first innermost, with values quoted', () => {
        assert.strictEqual(
            columnFnSql('"inv"."sku"', [{ fn: 'trim' }, { fn: 'replace', from: "O'", to: '' }, { fn: 'first', n: 0 }]),
            `SUBSTR(REPLACE(TRIM("inv"."sku"), 'O''', ''), 1, 1)`
        );
    });
});
