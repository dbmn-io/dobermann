// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * What Compare needs from its host (#298). Compare only reads what DBMN already holds: the
 * endpoint's past runs and their saved responses, and the endpoint's Console Views. It never
 * sends a request.
 */
import type { IExecutionMetadataService } from '../../services/execution/execution-metadata.interface';
import type { IKeyValueStore } from '../../platform/interfaces/key-value-store.interface';
import type { APIEndpointConfig } from '../../apiConfigManager';
import type { BuildConsoleReportConfigOptions } from '../console/console-report-config';
import type { ConsoleFiles } from '../console/console.ports';

export interface ComparePorts {
    metadata: IExecutionMetadataService;
    environments: BuildConsoleReportConfigOptions['environments'];
    endpoints: {
        getEndpoint(id: string): Promise<APIEndpointConfig | undefined>;
        updateEndpoint(id: string, updates: Partial<APIEndpointConfig>, suppressEvents?: boolean): Promise<unknown>;
    };
    /** Small persistent state: the Console Views registry and the saved compare setups. */
    state: Pick<IKeyValueStore, 'get' | 'update'>;
    /** Make a run's files readable first (the web app reads them from the workspace folder). */
    preloadRun?(executionId: string): Promise<void>;
    /** Where an export is saved: the Console's file port (a save dialog, or a browser download). */
    files?: Pick<ConsoleFiles, 'chooseSaveTarget' | 'exported'>;
    toast: { info(message: string): void; warn(message: string): void; error(message: string): void };
    logger?: { log(message: string): void; error(message: string, error?: unknown): void };
    host: {
        close(): void;
        openConsole(executionId: string, isBatch: boolean): Promise<void>;
        /** A compare has run: the Hub's Compare list refreshes. */
        compared?(): void;
    };
}
