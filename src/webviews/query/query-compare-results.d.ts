// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/** Types for query-compare-results.js: the pure part the core tests call. */
export function compactTotals(totals: Record<string, string>, tableIds: string[], resultCols: { view: string; column: string; group?: string }[], baseline: string | undefined, colId: (c: { view: string; column: string; group?: string }) => string): Record<string, string>;
