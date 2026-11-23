// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/** Types for lookup-value.js: one rule for looking a value up in a lookup table. */
export interface LookupValueColumn { id: string; name: string }
export interface LookupValueTable { columns: LookupValueColumn[]; rows: Record<string, string>[] }
/** Found (the first matching row's `to` value; `rows` when more than one row matched), or missing. */
export type LookupAnswer = { kind: 'found'; value: string; rows?: number } | { kind: 'missing' };
export function lookupColumn(table: Pick<LookupValueTable, 'columns'>, ref: string): LookupValueColumn | undefined;
export function lookupValue(table: Pick<LookupValueTable, 'columns' | 'rows'>, from: string, value: string, to?: string): LookupAnswer;
