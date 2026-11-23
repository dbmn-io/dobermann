// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/** Types for query-search-adds.js (a search naming a view's column not in the report adds it). */
export interface SearchAddColumn {
    view: string;
    column: string;
    group?: string;
}

export interface SearchAddView {
    id: string;
    alias: string;
    columns: string[];
}

export interface SearchColumnSpec {
    id: string;
    name: string;
    aliases?: string[];
}

export function searchAfterRemoval(search: string, removed: SearchColumnSpec[], remaining: SearchColumnSpec[], withoutColumns: (text: string, gone: SearchColumnSpec[], keep?: SearchColumnSpec[]) => string): string;

export function columnsToAdd(names: string[], report: SearchAddColumn[], views: SearchAddView[], compareViews: string[]): SearchAddColumn[];
