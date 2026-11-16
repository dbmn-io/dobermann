// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * What the Console needs from its host. The run history, engines and catalogue are core
 * services; the host supplies them, and what only it can do: save and open files, open other
 * screens, sign in.
 */
import type { APIEndpointConfig } from '../../apiConfigManager';
import type { APIEndpointManager } from '../../apiEndpointManager';
import type { EnvironmentManager } from '../../environmentManager';
import type { IKeyValueStore } from '../../platform/interfaces/key-value-store.interface';
import type { ChainHandoff } from '../../services/chain/chain-types';
import type { IDbmnAuthService } from '../../services/dbmn-auth/dbmn-auth.interface';
import type { IBatchExecutionEngine } from '../../services/execution/batch-execution-engine.interface';
import type { IExecutionMetadataService } from '../../services/execution/execution-metadata.interface';
import type { IIndividualExecutionEngine } from '../../services/execution/individual-execution-engine.interface';
import type { IExecutionLoggingService } from '../../services/logging/execution-logging.interface';
import type { ITransactionCreator } from '../../services/transaction-creator/transaction-creator.interface';
import type { TextClipboard } from '../../services/ui/clipboard-bridge';
import type { HubSettings } from '../hub/hub.ports';

/** What a delete confirmation shows (VS Code's own confirmation panel, or a DbmnModal). */
export interface DeleteConfirmation {
    message: string;
    executionLabel: string;
    executionType: string;
    executionId: string;
    filesToDelete: string[];
}

export interface ConsoleFiles {
    /** Where to write an export (a path), or undefined when the user cancelled. */
    chooseSaveTarget(defaultName: string, filters: Record<string, string[]>, title: string): Promise<string | undefined>;
    /** The export is written at `path`: the browser hands it over as a download. */
    exported?(path: string): Promise<void>;
    /** Open a file, or show a folder, where the host can. */
    open?(path: string): Promise<void>;
    /** Show a run file's content (#358: it lives in the run's archive, not a file of its own). */
    openContent?(name: string, content: string): Promise<void>;
    reveal?(path: string): Promise<void>;
}

export interface ConsoleHost {
    /** The Console's tab closes (its run was deleted). */
    close(): void;
    openEndpoint(endpointId: string): Promise<void>;
    openEnvironment(environmentId: string): Promise<void>;
    openConsole(executionId: string, isBatch: boolean): Promise<void>;
    openRunBatch(endpoint: APIEndpointConfig, chain: ChainHandoff): Promise<void>;
    /** #298: a compare started from the Completed tab (saved already): its tab opens on Match. */
    openCompare?(compareId: string): Promise<void>;
    runApi(endpoint: APIEndpointConfig): Promise<void>;
    /** A host's own delete confirmation; without one the Console asks in a DbmnModal. */
    confirmDelete?(data: DeleteConfirmation): Promise<{ confirmed: boolean; dontAskAgain: boolean }>;
}

export interface ConsolePorts {
    metadata: IExecutionMetadataService;
    /** The links between runs (#247), from the execution store. */
    links?: { getExecution?(id: string): Promise<unknown>; getExecutionLinks?(id: string): Promise<unknown> };
    batchEngine?: IBatchExecutionEngine;
    individualEngine?: IIndividualExecutionEngine;
    /** Cancel a single (non-batch) run. */
    cancelExecution?(executionId: string): Promise<void>;
    executionLogging?: IExecutionLoggingService;
    /** Builds the next page's transaction (pagination). */
    transactionCreator?: ITransactionCreator;
    endpoints: APIEndpointManager;
    environments: EnvironmentManager;
    /** Issue #311: the environment's sign-in before a batch resumes or reprocesses. */
    authGate?: { ensureAuthenticatedForBatch(batch: { environmentId?: string; environment?: string }): Promise<boolean> };
    /** The DBMN account, when the host has one (#418: nothing is gated on it). */
    dbmnAuth?: Pick<IDbmnAuthService, 'isAuthenticated'>;
    /** Small persistent state (the views registry). */
    state: Pick<IKeyValueStore, 'get' | 'update'>;
    settings: HubSettings;
    clipboard: TextClipboard;
    logger: { log(message: string): void; error(message: string, error?: Error): void };
    toast: { info(message: string): void; warn(message: string): void; error(message: string): void };
    files: ConsoleFiles;
    host: ConsoleHost;
}
