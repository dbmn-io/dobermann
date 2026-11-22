// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query's engine: its interface. A library with no dependencies and no knowledge of screens, SQL,
 * files, workers or storage (~/Projects/dbmn/engine-poc/DESIGN.md, "Final shape"). A Table in, a
 * Query as plain data, a Table out.
 *
 * Built in pieces, each tested against SQLite (sql.js, as the app runs today) by the tester's
 * reference harness. **Pieces 1 to 6** implement: `load`, `append`, `drop`, `check`, `run` (with
 * progress) / `cancel` / `read` / `release` for a query of every step (`from`, `join`, `compare`,
 * `select`, `filter`, `group`, `sort`), `stats` for a compare or join step, and every function in FUNCTIONS
 * with its operators.
 */

/*
 * Differences from SQLite (intended; everything not listed here gives what SQLite gives today, and
 * the reference tests expect the engine's rule for these):
 *
 * 1. Equality (=, <>, join, compare and group keys, compared values) is by sameValue (James,
 *    2026-11-21, "loose is good"): a number equals text that reads the same characters as the
 *    number is shown, 42 = "42" and 12.5 = "12.5", but "12.50", "007" and " 42" are not 42. SQLite
 *    goes by "affinity": a number never equals text from a column without one (42 = "42" false),
 *    and with one the text is read as a number first ("007" = 7 true).
 * 2. Text is read as a number by one rule everywhere (engine-values.ts readNumber; James,
 *    2026-11-21): text that is a plain number, spaces round it allowed, is that number; any other
 *    text is blank. So "abc" + 1, "12abc" * 2, ROUND("x"), ABS("x"), FLOOR / CEIL("12abc"),
 *    NUMBER("1.2.3") and "As a number" ("abc") are blank, Sum leaves such text out, and a filter or
 *    IF on such text is not true. The blanks and Sum's left-out values are counted, so the screen can
 *    say so (James, 2026-11-21: "blank, plus a count"; RunOptions.countNotNumbers, RunOutcome's
 *    notNumbers); a yes/no test (a filter, IF, AND, OR, NOT) is not counted. SQLite reads the text's
 *    leading number instead ("12abc" is 12, "abc" is 0, "1.2.3" is 1.2), and FLOOR("1e3") there is
 *    1, here 1000.
 * 3. "As a number" (NUMERIC) is NUMBER (the same rule).
 * 4. Upper case / Lower case change every letter, accented ones included ("é" → "É"; James,
 *    2026-11-21). SQLite changes a–z only.
 */

/** A value in a table: text, a number, or blank (null). Yes/no comes in as the text "true" / "false". */
export type Value = string | number | null;

/** The one data shape, in and out: column names, and one array per row in column order. */
export interface Table {
    columns: string[];
    rows: Value[][];
}

/** A window of a result: its rows from `from`, and how many rows the whole result has. */
export interface TableWindow extends Table {
    total: number;
}

/* ---------- Expressions ---------- */

/**
 * A value worked out for each row: a column (of an input, after a join), a constant, or a
 * function of other expressions. Operators are functions by their sign (`+`, `=`, …): FUNCTIONS.
 */
export type Expr =
    | { column: string; of?: string }
    | { value: Value }
    | { fn: FunctionName; args: Expr[] };

/**
 * Every function the engine carries, each as SQLite gives it today (DESIGN-review.md §3).
 * The column functions of the ƒ dialog and the formula language's functions both end up here:
 *
 *   Operators      +  -  *  /  NEG  =  <>  >  <  >=  <=
 *   Logic          IF  IFBLANK  AND  OR  NOT
 *   Numbers        ROUND  ABS  FLOOR  CEIL  MIN  MAX
 *   Text           CONCAT  UPPER  LOWER  TRIM  LTRIM  LEFT  RIGHT  SUBSTR  REPLACE  LENGTH
 *   Convert        TEXT (CAST AS TEXT: "As text" and the formula's TEXT)
 *                  NUMERIC (the ƒ dialog's "As a number": the same rule as NUMBER)
 *                  NUMBER (the formula's NUMBER: a plain number, else blank)
 *   Lookup         TRANSLATE(value, table, fromColumn, toColumn): reads a loaded table
 *
 * The ƒ dialog's functions as expressions: Trim spaces TRIM(x); Upper case UPPER(x); Lower case
 * LOWER(x); As text TEXT(x); As a number NUMERIC(x); Drop leading zeros LTRIM(x, '0'); First
 * characters SUBSTR(x, 1, n); Last characters SUBSTR(x, -n); Replace text REPLACE(x, from, to);
 * Translate values TRANSLATE(x, table, from, to).
 */
export const FUNCTIONS = [
    '+', '-', '*', '/', 'NEG', '=', '<>', '>', '<', '>=', '<=',
    'IF', 'IFBLANK', 'AND', 'OR', 'NOT',
    'ROUND', 'ABS', 'FLOOR', 'CEIL', 'MIN', 'MAX',
    'CONCAT', 'UPPER', 'LOWER', 'TRIM', 'LTRIM', 'LEFT', 'RIGHT', 'SUBSTR', 'REPLACE', 'LENGTH',
    'TEXT', 'NUMERIC', 'NUMBER',
    'TRANSLATE'
] as const;
export type FunctionName = typeof FUNCTIONS[number];

/* ---------- Queries ---------- */

export type JoinKind = 'inner' | 'left' | 'right' | 'outer';
export type Aggregate = 'count' | 'countValues' | 'sum' | 'min' | 'max';

/** One step of a query. `as` names it, when a later step reads it. */
export type Step =
    /** `first`: only its first rows (a sample to pick from, never the whole of a large table). */
    | { as?: string; from: string; first?: number }
    /**
     * Rows of two inputs matched on keys. A key with a blank in it matches nothing; keys match
     * by sameValue (42 and "42" match, "042" and 42 don't). Rows come out in the left input's order, each with its matches in the right
     * input's order; then (right, outer) the right input's rows that matched nothing, in its order.
     * The columns: the left's, then the right's; `{ column, of }` names one by the input it came from.
     */
    | { as?: string; join: JoinKind; left: string; right: string; on: { left: Expr; right: Expr }[] }
    /**
     * Inputs compared on a key, the first the Baseline. The rule for repeated and blank keys is at
     * the top of engine-compare.ts (James, 2026-11-21): a row per repeat in any input, the Baseline
     * included; an input with the key once shown and compared on each; several paired in order of
     * appearance; a blank key matches nothing.
     *
     * `on[i]`: input i's key, one Expr per key part. `columns[c].values[i]`: input i's value for
     * compared column c. `notCompared`: inputs kept in the rows but left out of status, relation and
     * differs (Results' Hide); never the Baseline.
     *
     * Columns out: every input's columns (named by `of`), then `status` ("noKey", "diff",
     * "notInBaseline", "missing", "same": the first that applies; engine-compare.ts), `relation`
     * ("oneToOne", "oneToMany", "onlyBase", "onlyOther"), a `missing:<input>` per input and a
     * `differs:<column>` per compared column, then a `diff:<input>` per input (one of its values
     * differs from its column's first) and a `repeated:<input>` per input (it holds the row's key on
     * more than one record), each 1 (yes) or 0; last `duplicate`, 1 on a key's second and later rows (the rows
     * its repeats add). A compared column's `values[i]` may be null: input
     * i has no cell in it, and is not measured there. A value differs from the
     * first present, compared input's (the Baseline's unless it lacks the record) when they aren't alike (sameValue; two blanks alike).
     */
    /**
     * `sample`: only the Baseline's first rows, and of each other input only the rows holding one of
     * their keys (found through a key index kept for that input and key: QueryEngine's keyIndex). What
     * Join and Columns show while the user builds a query: never a pass over every row.
     */
    | { as?: string; compare: string[]; on: Expr[][]; columns: { name: string; values: (Expr | null)[] }[]; notCompared?: string[]; sample?: number }
    | { as?: string; select: string; columns: { name: string; value: Expr }[] }
    | { as?: string; filter: string; where: Expr }
    /**
     * A filter by a row test the host gives the engine by name (RowTests): `arg` says what to test
     * (Results' search box: its text and columns). The rules live with the host, once
     * (search-matcher.js), not copied into expressions.
     */
    | { as?: string; filter: string; test: { name: string; arg: unknown; columns?: string[] } }
    /**
     * Rows grouped by the `by` values (blank is a value; 1 and 1.0 one group), a row per group in
     * the order each first appears, as SQLite's GROUP BY would give them sorted. With no `by`, one
     * row for all of them (even none). Aggregates as SQLite's: count (rows), countValues (values
     * not blank), sum (blank when there are none; an integer when every value is one, else a real;
     * text read as a number), min and max (blank left out; numbers before text).
     */
    | { as?: string; group: string; by: { name: string; value: Expr }[]; aggregates: { name: string; fn: Aggregate; value?: Expr }[] }
    /**
     * Blank first, then numbers, then text by code points; descending reverses (blanks last); ties
     * keep their order. `order: 'shown'`: Results' own order instead (a table people read): numbers
     * by size, text by its letters with numbers inside it by size (a natural, locale order), blank
     * and empty text last; descending reverses it (blanks first).
     */
    | { as?: string; sort: string; by: { value: Expr; descending?: boolean; order?: 'values' | 'shown' }[] };

/** A query: its steps in order, and which step's table is the answer (its `as`, or the last step when left out). */
export interface Query {
    steps: Step[];
    result?: string;
}

/** Why a query can't run, in words a user can read; `step` is the step's `as`, or its place ("step 3"). */
export interface Problem {
    step: string;
    message: string;
}

export type ResultId = string;

/* ---------- Statistics (later pieces) ---------- */

export interface KindCounts { oneToOne: number; oneToMany: number; manyToOne: number; manyToMany: number }

/**
 * A join step's statistics: today's QueryJoinStats fields (src/services/query/query-types.ts),
 * counted from the same keys the join matched on (blank keys left out, as they match nothing).
 * keys: matched key values of each kind; rows: the left's rows with them; records: the right's.
 * leftValues / rightValues: different key values on each side; valuesTotal: every key value of
 * either side. (Numbers and text meet by sameValue, so there is no "one side numbers, the other
 * text" to say.)
 */
export interface JoinStats {
    leftRows: number;
    leftMatched: number;
    rightRows: number;
    rightMatched: number;
    rowsAfter: number;
    relationship: 'none' | 'oneToOne' | 'oneToMany' | 'manyToOne' | 'manyToMany';
    keys: KindCounts;
    rows: KindCounts;
    records: KindCounts;
    leftBlank: number;
    leftValues: number;
    rightValues: number;
    valuesTotal: number;
}

/**
 * A compare step's statistics, per input (records: the input's rows).
 * A blank key matches nothing: its records are "only" and "onlyHere".
 * againstBaseline (for the Baseline: its own keys)
 *   matched          records whose key the Baseline has
 *   oneToOne         records whose key is once here and once in the Baseline
 *   repeatedKeys     keys the Baseline has that are on more than one row here or there
 *   repeatedRecords  this input's records with those keys
 *   only             records whose key the Baseline lacks
 * againstAll (the other compared inputs, notCompared left out)
 *   matched          records whose key another input has
 *   repeatedKeys     keys on more than one row of this input
 *   repeatedRecords  its records with those keys
 *   onlyHere         records whose key no other input has
 * rows: the compare's rows; and each status's rows.
 */
export interface CompareStats {
    perInput: {
        name: string;
        rows: number;
        againstBaseline: { matched: number; oneToOne: number; repeatedKeys: number; repeatedRecords: number; only: number };
        againstAll: { matched: number; repeatedKeys: number; repeatedRecords: number; onlyHere: number };
        /** Its records whose key is blank (counted in `only` and `onlyHere` too): No key. */
        noKey: number;
    }[];
    rows: number;
    status: { same: number; diff: number; missing: number; notInBaseline: number; noKey: number };
    /**
     * A sample compare's (the step's `sample`): the Baseline's records in it, how many of them have their
     * key in every other input, and in each input (the Baseline's own count first); its whole rows.
     */
    sample?: { rows: number; of: number; inEvery: number; byInput: number[] };
}

/**
 * With a window, `stats` gives the values behind one count of a join step, a page at a time: a
 * Table of the key's parts ("key", or "key 1", "key 2"…), then "left" and "right", how many rows
 * each side holds with that key. `kind`: the matched keys of one kind, or the keys only the left
 * (`onlyLeft`, no match) or only the right (`onlyRight`, not used) holds. Blank keys are not values
 * (JoinStats.leftBlank counts them). Order, as today's Join step: rows they make first (left × the
 * right's, at least 1), then the right's, then the key. `side` is the caller's; both counts are given.
 */
export interface StatsWindow {
    kind: keyof KindCounts | 'onlyLeft' | 'onlyRight';
    side: 'left' | 'right';
    from: number;
    count: number;
}

/**
 * Row tests a host gives the engine, by name: each makes, from its `arg` and the input's column
 * names, a test of one row (its values in column order). The engine stays free of them.
 */
export type RowTests = Record<string, (arg: unknown, columns: string[]) => (row: Value[]) => boolean>;

/* ---------- Running ---------- */

/** How far a run has got: what it is doing ("Joining products"), rows done of rows to do in it. */
export interface Progress {
    result: ResultId;
    stage: string;
    done: number;
    total: number;
}

export interface RunOptions {
    onProgress?: (progress: Progress) => void;
    /**
     * Columns of the result whose rows with text read as a number that isn't one are counted
     * (arithmetic, Round, Abs, Floor, Ceil, NUMBER, "As a number": James, 2026-11-21, "blank, plus a
     * count"): RunOutcome's `notNumbers`, under the result step's name.
     */
    countNotNumbers?: string[];
    /**
     * Hold the result as plain stored values, each worked out once (a compare's status columns are
     * long expressions): reading it, and later runs that start from it (a step `{ from: <its
     * ResultId> }`), never work them out again.
     */
    hold?: boolean;
    /** Steps whose rows are kept too, each a result of its own (RunOutcome's `kept`): a later run can start from one. */
    keepSteps?: string[];
}

/**
 * How a run ended: its result; or why not (`stats`, when a join passed the row limit: the join and
 * compare steps' statistics counted until then, the failing join's included, by step name); or stopped.
 */
export type RunOutcome =
    /**
     * `steps`: how many rows each step made (a count read from the same run, as Distinct's rows alike).
     * `notNumbers`: by step, by column, the rows where text read as a number wasn't one: a group's
     * Sum (its values left out), and the result's columns asked for (RunOptions.countNotNumbers).
     * Only counts above 0.
     */
    | { result: ResultId; total: number; steps?: Record<string, number>; notNumbers?: Record<string, Record<string, number>>; kept?: Record<string, ResultId> }
    | { problems: Problem[]; stats?: Record<string, JoinStats | CompareStats> }
    | { cancelled: true };

/** The most rows a join may make (James, 2026-11-21: two million for the beta). */
export const ROW_LIMIT = 2_000_000;

/* ---------- The engine ---------- */

export interface Engine {
    /** Start a table (replaces one of the same name). `more`: pieces follow by `append`; it is loading until one says `last`. */
    load(name: string, table: Table, options?: { more?: boolean }): void;
    /** More rows of a table; `last`: it is complete (a query on a table still loading is refused). */
    append(name: string, table: Table, options?: { last?: boolean }): void;
    drop(name: string): void;
    /** Why a query can't run, before any work: unknown table, column, function or step; a table still loading. */
    check(query: Query): Problem[];
    /**
     * Run a query; its result stays inside the engine until released. It works in slices, giving
     * way between them: `onProgress` hears each stage and how far it has got (the first call
     * carries the result's id, for `cancel`). A join that would make more than the row limit is
     * refused before any row is made.
     */
    run(query: Query, options?: RunOptions): Promise<RunOutcome>;
    /** Stop a run between slices: it ends `{ cancelled: true }`. */
    cancel(result: ResultId): void;
    /** A window of a result. */
    read(result: ResultId, from: number, count: number): TableWindow;
    /** Rows of a result by their numbers, in the order given (a filtered page of rows kept elsewhere: Results' status filter). */
    readRows(result: ResultId, rows: number[]): TableWindow;
    /** How a join or compare step's rows met (a later piece). */
    stats(result: ResultId, step: string, window?: StatsWindow): JoinStats | CompareStats | Table;
    release(result: ResultId): void;
}
