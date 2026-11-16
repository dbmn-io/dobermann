// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #325: the batch pipeline wired the way ServiceBootstrap wires it, with the in-memory /
 * Node implementations of every port. Preparation, the engine, execution and storage are the
 * real classes; only the host is swapped. Loads no VS Code.
 */
import * as path from 'path';
import type { APIEndpointConfig } from '../../../apiConfigManager';
import { JsonGenerator } from '../../../data-loading/json-generator';
import { TemplateParser } from '../../../data-loading/template-parser';
import { MemoryConfiguration } from '../../../platform/memory/memory-configuration';
import { RecordingProgressSink } from '../../../platform/memory/recording-progress-sink';
import { BatchExecutionEngine } from '../../../services/execution/batch-execution-engine.service';
import { ExecutionFileService } from '../../../services/execution/execution-file.service';
import { ExecutionMetadataService } from '../../../services/execution/execution-metadata.service';
import { ExecutionService } from '../../../services/execution/execution.service';
import { FetchRequestExecutor } from '../../../services/execution/fetch-request-executor';
import { RequestEnvironment, RequestEnvironmentLookup } from '../../../services/execution/request-executor.interface';
import { DatabaseAdapter } from '../../../services/storage/database-adapter';
import { SqlJsExecutionStorage } from '../../../services/storage/sqljs-execution-storage.service';
import { TransactionCreator } from '../../../services/transaction-creator/transaction-creator.service';
import { BatchMemberTransactionHandler } from '../../../services/transaction-preparation/handlers/batch-member-transaction.handler';
import { BatchTransactionHandler } from '../../../services/transaction-preparation/handlers/batch-transaction.handler';
import { IndividualTransactionHandler } from '../../../services/transaction-preparation/handlers/individual-transaction.handler';
import { ArrayRepetitionHelper } from '../../../services/transaction-preparation/helpers/array-repetition.helper';
import { PathGeneratorHelper } from '../../../services/transaction-preparation/helpers/path-generator.helper';
import { TransactionPreparationService } from '../../../services/transaction-preparation/transaction-preparation.service';
import { ResponseTestingService } from '../../../services/testing/response-testing.service';
import { ExecutionLoggingService } from '../../../services/logging/execution-logging.service';
import { createMockLogger } from '../../helpers/logging/mock-logger';
import { tempStorageOptions } from './temp-storage';

export interface CorePipeline {
    storage: SqlJsExecutionStorage;
    executionMetadataService: ExecutionMetadataService;
    preparation: TransactionPreparationService;
    engine: BatchExecutionEngine;
    executionService: ExecutionService;
    progress: RecordingProgressSink;
    workspaceRoot: string;
    close(): void;
}

export interface CorePipelineOptions {
    /** `dbmn.execution.*` settings, keyed `section.key`. */
    settings?: Record<string, unknown>;
    /** The bearer token every request gets (none when undefined). */
    token?: string;
    /** Or the token as it is at each request (it can change mid-batch). */
    currentToken?: () => string | undefined;
    /** #359: the host's refresh after a 401. */
    refreshCredentials?: (environmentId: string) => Promise<boolean>;
    /** #428: run the endpoint's response tests and write each run's log, as the extension does. */
    responseTests?: boolean;
}

export async function buildCorePipeline(tempDir: string, environment: RequestEnvironment, options: CorePipelineOptions = {}): Promise<CorePipeline> {
    const logger = createMockLogger();
    const workspaceRoot = path.join(tempDir, 'workspace');

    const storage = new SqlJsExecutionStorage(tempStorageOptions(workspaceRoot));
    const executionMetadataManager = new DatabaseAdapter(storage);
    await executionMetadataManager.initialize();

    const executionMetadataService = new ExecutionMetadataService({ executionMetadataManager, dobermannInstance: {} }, logger);
    const executionFileService = new ExecutionFileService({ logger, dobermannInstance: undefined, vscodeAPI: undefined });
    // #428: with responseTests, each run writes its log, as in the extension
    const executionLoggingService = options.responseTests ? new ExecutionLoggingService({ executionMetadataService }, logger) : undefined;
    const transactionCreator = new TransactionCreator(executionMetadataService, executionFileService, logger, undefined, executionLoggingService);

    const pathGenerator = new PathGeneratorHelper();
    const jsonGenerator = new JsonGenerator();
    const progress = new RecordingProgressSink();

    const preparation = new TransactionPreparationService({
        individualHandler: new IndividualTransactionHandler(transactionCreator, pathGenerator, jsonGenerator),
        batchHandler: new BatchTransactionHandler(transactionCreator, pathGenerator),
        batchMemberHandler: new BatchMemberTransactionHandler(transactionCreator, pathGenerator, new TemplateParser(), jsonGenerator),
        arrayRepetitionHelper: new ArrayRepetitionHelper(),
        executionMetadataService,
        transactionCreator,
        jsonGenerator,
        progressSink: progress
    }, logger);

    const environments: RequestEnvironmentLookup = {
        getEnvironment: async id => (id === environment.id ? environment : undefined),
        getActiveEnvironment: async () => environment
    };
    const requestExecutor = new FetchRequestExecutor({
        environments,
        getToken: async () => (options.currentToken ? options.currentToken() : options.token),
        logger
    });

    const executionService = new ExecutionService({
        executionValidationService: {},
        executionMetadataService,
        executionFileService,
        dobermannInstance: undefined,
        requestExecutor,
        environments,
        progressSink: progress,
        ...(options.responseTests ? {
            responseTestingService: new ResponseTestingService(logger),
            executionLoggingService
        } : {})
    }, logger);

    const engine = new BatchExecutionEngine({
        executionMetadataService,
        executionService,
        transactionCreator,
        transactionPreparationService: preparation,
        progressSink: progress,
        configuration: new MemoryConfiguration(options.settings),
        refreshCredentials: options.refreshCredentials
    }, logger);

    return { storage, executionMetadataService, preparation, engine, executionService, progress, workspaceRoot, close: () => storage.close() };
}

/** POST one inventory row per request, the shape of the Puppy School bulk upload. */
export function inventoryEndpoint(): APIEndpointConfig {
    return {
        id: 'endpoint-inventory',
        name: 'Bulk Inventory Upload',
        path: '/inventory',
        method: 'POST',
        headers: {},
        queryParams: {},
        body: '{\n  "sku": "{{sku}}",\n  "quantityOnHand": "{{qty}}"\n}'
    } as APIEndpointConfig;
}
