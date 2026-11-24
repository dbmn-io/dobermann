// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #247: types shared by the Console (where a chain starts), the Hub and Run Batch
 * (where its rows land) and execution storage (where the link is kept).
 */

/** What Run Batch is handed: the rows, and enough about where they came from to link back. */
export interface ChainHandoff {
    /** CSV text, header row first: the View's columns and its filtered rows. */
    csv: string;
    rowCount: number;
    sourceExecutionId: string;
    /** So "Chained from …" in Run Batch can open the source run's Console. */
    sourceIsBatch?: boolean;
    sourceLabel: string;           // "GET Purchase Orders · DEV"
    viewName?: string;
}

/** Recorded once the chained batch exists. */
export interface ExecutionLinkInput {
    sourceExecutionId: string;
    targetExecutionId: string;
    kind?: 'chain';
    viewName?: string;
    rowCount?: number;
}

/** One side of a link, as the Links tab shows it. */
export interface ExecutionLinkEnd {
    linkId: string;
    executionId: string;
    isBatch: boolean;
    endpointId: string;
    endpointName: string;
    endpointMethod: string;
    environment: string;
    status: string;
    executionCreatedAt: number;    // ms
    linkedAt: number;              // ms
    viewName?: string;
    rowCount?: number;
    organization?: string;
    /** The values the run kept for its environment's variables (a single run its header ones', a batch every one's). */
    environmentVariables?: Record<string, string>;
    /** Request headers the run sent (an individual run's, or a batch's first member's). */
    headers?: Record<string, string>;
    /** Filled by the Console: how this run differs from the one being viewed. */
    differences?: Array<{ field: string; from: string; to: string }>;
}

export interface ExecutionLinks {
    upstream: ExecutionLinkEnd[];
    downstream: ExecutionLinkEnd[];
    /** The run being viewed, for comparing against each end. */
    self?: { environment?: string; organization?: string; environmentVariables?: Record<string, string>; headers?: Record<string, string> };
}
