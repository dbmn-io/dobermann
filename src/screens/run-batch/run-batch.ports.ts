// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * What Run Batch needs from its host: the catalogue, file conversion, settings, and the run
 * itself (RunOrchestrator.executeBulkLoad in both hosts).
 */
import type { APIEndpointManager } from '../../apiEndpointManager';
import type { EnvironmentManager } from '../../environmentManager';
import type { IConfiguration } from '../../platform/interfaces/configuration.interface';
import type { IKeyValueStore } from '../../platform/interfaces/key-value-store.interface';
import type { FormatConverterService } from '../../services/format-converter/format-converter.service';
import type { BulkLoadRequest } from '../../services/execution/run-orchestrator';
import type { BulkLoadResult } from '../../webviews/run-batch/bulk-load-result';

export interface RunBatchPorts {
    endpoints: APIEndpointManager;
    environments: EnvironmentManager;
    formatConverter: FormatConverterService;
    /** `dbmn.execution.maxCsvRows`. */
    settings: IConfiguration;
    /** Where the Console keeps an endpoint's Views: Validate's ★ keeps the Input tab's saved searches there (slice 5). */
    state?: Pick<IKeyValueStore, 'get' | 'update'>;
    toast: { info(message: string): void; warn(message: string, opts?: { forceNative?: boolean }): void; error(message: string): void };
    /** Prepare and run the batch; its Console opens from the engine. */
    executeBulkLoad(request: BulkLoadRequest): Promise<BulkLoadResult>;
    /** GitHub Issue #396: open the DBMN sign-in, when that is why a batch did not start. */
    promptSignIn?(): Promise<void>;
    /**
     * GitHub Issue #396: this machine has signed in to DBMN before, so a missing sign-in is
     * an expired one ("sign in again"), not a first registration. Assumed when absent.
     */
    host: {
        close(): void;
        openConsole(executionId: string, isBatch: boolean): Promise<void>;
    };
}
