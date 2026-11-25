// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A calculated column as steps (James, 2026-11-25: "Steps only", no typed formulas): a start (a column
 * or a value), then functions in order, each one the shared Functions window's (Map, the Join's fx and
 * calculated columns use one list, column-functions.ts). A step may name another column, and the same
 * function may come more than once. The engine runs it as one expression: each step is the engine call
 * its function is (columnFnCall), with 'x' the value so far.
 *
 * A calculated column may start from or use another: they are compiled in order of use, and one that
 * comes back to itself is refused, with words.
 */
import { callExpr, columnFnCall, type ColumnFn, type OtherValue } from '../column-functions/column-functions';
import type { Expr } from '../engine/engine-types';

/** A step: one of the shared list's functions (column-functions.ts), the same as Map's and the Join's. */
export type Step = ColumnFn;

/** A calculated column as steps: its name, where it starts (a column, or a value), then its steps in order. */
export type StepStart = OtherValue;
export interface StepsCalc {
    name: string;
    start: StepStart;
    steps: Step[];
}

/** Calculated columns that come back to themselves: `loop` is the path, the first name again at its end. */
export class CalcLoopError extends Error {
    constructor(readonly loop: string[]) {
        super(`A calculated column can't use itself: ${loop.join(' → ')}.`);
        this.name = 'CalcLoopError';
    }
}

/** A column id that names a calculated column (any other id is the caller's own). */
export const CALC_ID = (name: string): string => `calc:${name}`;

/** A start and its steps: the value at the start, then after each step in turn (the window's sample, step by step). */
export function stepExprs(start: StepStart, steps: Step[], col: (id: string) => Expr, lookup: (id: string) => Expr = id => ({ value: id })): Expr[] {
    const first: Expr = start.col !== undefined ? col(start.col) : { value: start.value as number | string };
    const out = [first];
    steps.forEach(s => out.push(callExpr(columnFnCall(s), out[out.length - 1], col, lookup)));
    return out;
}

/**
 * Every calculated column's Expr, by name. `column(id)` gives any other column's Expr. A calc that starts from or uses
 * another is built on that one's Expr; one that comes back to itself throws, naming the loop.
 */
export function calcExprs(calcs: StepsCalc[], column: (id: string) => Expr, lookup: (id: string) => Expr = id => ({ value: id })): Map<string, Expr> {
    const byName = new Map(calcs.map(c => [c.name, c]));
    const done = new Map<string, Expr>();
    const making: string[] = [];
    const exprOf = (name: string): Expr => {
        const got = done.get(name);
        if (got) return got;
        if (making.includes(name)) throw new CalcLoopError([...making.slice(making.indexOf(name)), name]);
        const calc = byName.get(name);
        if (!calc) throw new Error(`No calculated column "${name}".`);
        making.push(name);
        const col = (id: string): Expr => (id.startsWith('calc:') ? exprOf(id.slice(5)) : column(id));
        const all = stepExprs(calc.start, calc.steps, col, lookup);
        const expr = all[all.length - 1];
        making.pop();
        done.set(name, expr);
        return expr;
    };
    calcs.forEach(c => exprOf(c.name));
    return done;
}
