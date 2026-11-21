// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * How the engine keeps a table: a column at a time, not a row at a time (the proof of concept's
 * idea, ~/Projects/dbmn/engine-poc/owncolumnar.mjs). Each column holds, per row, a one-byte tag
 * (blank, integer, real or text) and, only where it has them, its numbers in a Float64Array and its
 * text as codes into a list of the column's distinct texts, each kept once. A column of repeated
 * text ("ACTIVE", a store code) costs four bytes a row, not a string a row.
 */
import { Real, type V } from './engine-values';

const BLANK = 0, INT = 1, REAL = 2, TEXT = 3;

export class Column {
    private tags: Uint8Array;
    private nums: Float64Array | null = null;
    private codes: Int32Array | null = null;
    private readonly dict: string[] = [];
    private readonly dictIndex = new Map<string, number>();
    length = 0;

    constructor(capacity = 1024) {
        this.tags = new Uint8Array(Math.max(16, capacity));
    }

    private grow(min: number): void {
        let cap = this.tags.length;
        while (cap < min) cap *= 2;
        if (cap === this.tags.length) return;
        const tags = new Uint8Array(cap); tags.set(this.tags); this.tags = tags;
        if (this.nums) { const n = new Float64Array(cap); n.set(this.nums); this.nums = n; }
        if (this.codes) { const c = new Int32Array(cap); c.set(this.codes); this.codes = c; }
    }

    push(v: V): void {
        if (this.length >= this.tags.length) this.grow(this.length + 1);
        const i = this.length++;
        if (v === null) { this.tags[i] = BLANK; return; }
        if (typeof v === 'string') {
            if (!this.codes) this.codes = new Int32Array(this.tags.length);
            let code = this.dictIndex.get(v);
            if (code === undefined) { code = this.dict.length; this.dict.push(v); this.dictIndex.set(v, code); }
            this.tags[i] = TEXT;
            this.codes[i] = code;
            return;
        }
        if (!this.nums) this.nums = new Float64Array(this.tags.length);
        if (v instanceof Real) { this.tags[i] = REAL; this.nums[i] = v.r; return; }
        this.tags[i] = INT;
        this.nums[i] = v;
    }

    get(i: number): V {
        switch (this.tags[i]) {
            case INT: return this.nums![i];
            case REAL: return new Real(this.nums![i]);
            case TEXT: return this.dict[this.codes![i]];
            default: return null;
        }
    }

    /** Roughly what the column holds in memory, in bytes (for the memory checks). */
    bytes(): number {
        const text = this.dict.reduce((n, s) => n + 2 * s.length + 40, 0);
        return this.tags.byteLength + (this.nums?.byteLength ?? 0) + (this.codes?.byteLength ?? 0) + text;
    }
}

/** A loaded table: its columns, and whether every piece of it has come in. */
export class StoredTable {
    readonly cols: Column[];
    rowCount = 0;
    complete = true;

    constructor(readonly name: string, readonly columns: string[]) {
        this.cols = columns.map(() => new Column());
    }

    value(row: number, column: number): V {
        return this.cols[column].get(row);
    }
}
