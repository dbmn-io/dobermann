// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The run history as the Logs screen (Dobermann issue 7) reads it, from the execution metadata
 * service every app has: its runs (batches and single runs), and a batch's requests.
 */
import type { IExecutionMetadataService } from '../../services/execution/execution-metadata.interface';
import type { RunHistory, RunRecord } from '../../services/logging/log-reader';

type Metadata = Pick<IExecutionMetadataService, 'getAllTransactions' | 'getBatchMemberExecutions' | 'getBatchMemberLogRows'>;

export function runHistory(metadata: Metadata | undefined): RunHistory | undefined {
    if (!metadata) return undefined;
    return {
        runs: async () => (await metadata.getAllTransactions()) as unknown as RunRecord[],
        members: async id => (await metadata.getBatchMemberExecutions(id)) as unknown as RunRecord[],
        // Only what a line needs, a slice at a time: a big batch never holds the page up
        memberPage: metadata.getBatchMemberLogRows
            ? async (id, offset, limit) => ((await metadata.getBatchMemberLogRows!(id, offset, limit)) as RunRecord[]).map(m => ({ ...m, batchId: id, executionType: 'batch_member' }))
            : undefined
    };
}
