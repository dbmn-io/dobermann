// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * How the engine keeps a table: a column at a time, not a row at a time (the proof of concept's
 * idea, ~/Projects/dbmn/engine-poc/owncolumnar.mjs). Each column holds, per row, a one-byte tag
 * (blank, integer, real or text) and, only where it has them, its numbers in a Float64Array and its
 * text as codes into one dictionary of texts shared by every table, each text kept once. A column
 * of repeated text ("ACTIVE", a store code) costs four bytes a row, and the same keys in four runs
 * of one endpoint are held once, not four times.
 */
import { Real, type V } from './engine-values';

const BLANK = 0, INT = 1, REAL = 2, TEXT = 3;

/**
 * Every text the loaded tables hold, once, by code. Its lookup (text → code) is only needed while
 * a table is coming in: it is let go when none is (`seal`) and made again from the list when one
 * starts. Texts no table uses any more are cleared out by `compact`.
 */
export class TextDictionary {
    private texts: string[] = [];
    private index: Map<string, number> | null = new Map();
    /** How many texts there were after the last compact: past half as many again, compact is worth it. */
    private settled = 0;

    get size(): number {
        return this.texts.length;
    }

    code(text: string): number {
        if (!this.index) this.index = new Map(this.texts.map((t, i) => [t, i]));
        let code = this.index.get(text);
        if (code === undefined) { code = this.texts.length; this.texts.push(text); this.index.set(text, code); }
        return code;
    }

    text(code: number): string {
        return this.texts[code];
    }

    /** No table is coming in: let the lookup go. */
    seal(): void {
        this.index = null;
    }

    get worthCompacting(): boolean {
        return this.texts.length > 1024 && this.texts.length > this.settled * 1.5;
    }

    /** Keep only the texts the given columns use; their codes change to match. */
    compact(columns: Column[]): void {
        const used = new Int32Array(this.texts.length).fill(-1);
        const kept: string[] = [];
        for (const c of columns) c.eachCode(code => { if (used[code] < 0) { used[code] = kept.length; kept.push(this.texts[code]); } });
        for (const c of columns) c.recode(used);
        this.texts = kept;
        this.settled = kept.length;
        if (this.index) this.index = new Map(kept.map((t, i) => [t, i]));
    }

    /** Roughly what the texts hold, in bytes. */
    bytes(): number {
        return this.texts.reduce((n, s) => n + 2 * s.length + 40, 0) + (this.index ? this.texts.length * 60 : 0);
    }
}

export class Column {
    private tags: Uint8Array;
    private nums: Float64Array | null = null;
    private codes: Int32Array | null = null;
    length = 0;

    constructor(private readonly dict: TextDictionary, capacity = 1024) {
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
            this.tags[i] = TEXT;
            this.codes[i] = this.dict.code(v);
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
            case TEXT: return this.dict.text(this.codes![i]);
            default: return null;
        }
    }

    /** Complete: the spare room the doubling left is given back. */
    trim(): void {
        if (this.tags.length === this.length) return;
        this.tags = this.tags.slice(0, this.length);
        if (this.nums) this.nums = this.nums.slice(0, this.length);
        if (this.codes) this.codes = this.codes.slice(0, this.length);
    }

    eachCode(fn: (code: number) => void): void {
        if (!this.codes) return;
        for (let i = 0; i < this.length; i++) if (this.tags[i] === TEXT) fn(this.codes[i]);
    }

    recode(to: Int32Array): void {
        if (!this.codes) return;
        for (let i = 0; i < this.length; i++) if (this.tags[i] === TEXT) this.codes[i] = to[this.codes[i]];
    }

    /** Roughly what the column holds in memory, in bytes (its texts are the dictionary's). */
    bytes(): number {
        return this.tags.byteLength + (this.nums?.byteLength ?? 0) + (this.codes?.byteLength ?? 0);
    }
}

/** A loaded table: its columns, and whether every piece of it has come in. */
export class StoredTable {
    readonly cols: Column[];
    rowCount = 0;
    complete = true;

    constructor(readonly name: string, readonly columns: string[], dict: TextDictionary) {
        this.cols = columns.map(() => new Column(dict));
    }

    value(row: number, column: number): V {
        return this.cols[column].get(row);
    }
}
