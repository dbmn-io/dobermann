// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Builds a ConsoleWebviewConfig from a transaction id. Shared between the
 * legacy `dbmn.viewTransactionReport` command and the Hub's
 * `openConsoleAsTab` path so both surfaces render the same Console state.
 *
 * Extracted from extension.ts's viewTransactionReport handler (R3). The
 * legacy command will be slimmed down in a follow-up; for now both paths
 * call this builder.
 */
import type { EnvironmentConfig } from '../../environmentManager';
import { runFileExists } from '../../services/run-content/run-content-store';
import * as path from 'path';
import { IExecutionMetadataService } from '../../services/execution/execution-metadata.interface';
import type { EnvironmentManager } from '../../environmentManager';
import { fillBaseUrl } from '../../utils/environment-url';

export interface BuildConsoleReportConfigOptions {
    executionId: string;
    isBatch: boolean;
    executionMetadataService: IExecutionMetadataService | undefined;
    /** For the run's environment's base URL and thread limit. */
    environments: Pick<EnvironmentManager, 'getEnvironment'> & Partial<Pick<EnvironmentManager, 'getAllEnvironments'>>;
}

interface ConsoleReportConfigLike {
    type: 'individual' | 'batch';
    executionId: string;
    batchId?: string;
    endpointId?: string;
    responseFiles: string[];
    responseFileStatusMap: Record<string, string>;
    /** #428: why each response is an error (its message, and a failed test) */
    responseFileDetails: Record<string, { errorMessage?: string; testStatus?: string }>;
    inputFile?: string;
    requestFile?: string;
    logFile?: string;
    title: string;
    executionSummary: Record<string, unknown>;
}

/** The run's environment: by id, or by name for records that kept only the name. */
async function environmentOf(environments: BuildConsoleReportConfigOptions['environments'], id: unknown, name: unknown): Promise<EnvironmentConfig | undefined> {
    const byId = id ? await environments.getEnvironment(id as string).catch(() => undefined) : undefined;
    if (byId) return byId;
    const wanted = (id || name) as string | undefined;
    if (!wanted || !environments.getAllEnvironments) return undefined;
    const all = await environments.getAllEnvironments().catch(() => [] as EnvironmentConfig[]);
    return all.find(e => e.id === wanted || e.name === wanted);
}

export async function buildConsoleReportConfig(
    opts: BuildConsoleReportConfigOptions
): Promise<ConsoleReportConfigLike> {
    const { executionId, isBatch, executionMetadataService, environments } = opts;

    let responseFiles: string[] = [];
    let inputFile: string | undefined;
    let requestFile: string | undefined;
    let logFile: string | undefined;
    let filteredMembers: Array<Record<string, unknown>> = [];
    let responseFileStatusMap: Record<string, string> = {};
    const responseFileDetails: Record<string, { errorMessage?: string; testStatus?: string }> = {};
    const noteDetail = (file: string, errorMessage: unknown, testStatus: unknown) => {
        if (!errorMessage && !testStatus) return;
        responseFileDetails[file] = {
            ...(errorMessage ? { errorMessage: String(errorMessage) } : {}),
            ...(testStatus ? { testStatus: String(testStatus) } : {})
        };
    };

    if (isBatch) {
        try {
            // Issue #312: only id/status/file/created — not 50,000 whole rows
            const batchMembers = await executionMetadataService?.getBatchMemberFiles(executionId);
            filteredMembers = (batchMembers as unknown as Array<Record<string, unknown>>) || [];
            responseFiles = filteredMembers
                .map(m => m.responseFile as string | undefined)
                .filter((f): f is string => !!f);

            for (const m of filteredMembers) {
                const rf = m.responseFile as string | undefined;
                const st = m.status as string | undefined;
                if (rf && st) responseFileStatusMap[rf] = st;
                if (rf) noteDetail(rf, m.errorMessage, m.testStatus);
            }

            const batchExecution = await executionMetadataService?.getExecution(executionId);
            if (batchExecution?.requestFile) inputFile = batchExecution.requestFile;
            if (batchExecution?.requestFile) {
                const candidate = batchExecution.requestFile.replace(/\.csv$/, '.log');
                logFile = runFileExists(candidate) ? candidate : undefined;
            }
        } catch {
            responseFiles = [];
        }
    } else {
        try {
            const execution = await executionMetadataService?.getExecution(executionId);
            if (execution?.responseFile) {
                responseFiles = [execution.responseFile];
                if (execution.status) responseFileStatusMap[execution.responseFile] = execution.status;
                noteDetail(execution.responseFile, execution.errorMessage, execution.testStatus);
                requestFile = execution.requestFile;

                if (execution.requestFile) {
                    const requestBasedLogFile = execution.requestFile.replace(/\.[^.]+$/, '.log');
                    if (runFileExists(requestBasedLogFile)) {
                        logFile = requestBasedLogFile;
                    } else {
                        const responseDir = path.dirname(execution.responseFile);
                        const candidates = [
                            path.join(responseDir, 'execution.log'),
                            path.join(responseDir, `${executionId}.log`),
                            execution.responseFile.replace(/\.[^.]+$/, '.log')
                        ];
                        for (const c of candidates) {
                            if (runFileExists(c)) { logFile = c; break; }
                        }
                    }
                }
            }
        } catch {
            responseFiles = [];
        }
    }

    let executionSummary: Record<string, unknown> = {};
    let endpointId: string | undefined;
    try {
        if (isBatch) {
            const batchExecution = await executionMetadataService?.getExecution(executionId);
            endpointId = batchExecution?.endpointId;
            if (batchExecution) {
                const requestFileName = batchExecution.requestFile ? path.basename(batchExecution.requestFile) : undefined;

                let recordsCount: number | undefined;
                let expectedTransactions: number | undefined;
                if (batchExecution.rows) {
                    const rowsText = batchExecution.rows.toString();
                    const match = rowsText.match(/(\d+)\((\d+)\)/);
                    if (match) {
                        expectedTransactions = parseInt(match[1]);
                        recordsCount = parseInt(match[2]);
                    } else {
                        const n = parseInt(rowsText);
                        expectedTransactions = n;
                        recordsCount = n;
                    }
                }

                let batchDuration: number | undefined;
                if (batchExecution.startedAt && batchExecution.completedAt) {
                    batchDuration = new Date(batchExecution.completedAt).getTime() - new Date(batchExecution.startedAt).getTime();
                }

                let baseUrl: string | undefined;
                let environmentMaxConcurrency: number | undefined;
                let runsInVsCode = false;
                let resolvedEnvironmentId: string | undefined;
                if (batchExecution.environmentId || batchExecution.environment) {
                    try {
                        const environment = await environmentOf(environments, batchExecution.environmentId, batchExecution.environment);
                        resolvedEnvironmentId = environment?.id;
                        // #424: the base URL the batch went to, kept when it started (an older batch: the environment's)
                        baseUrl = batchExecution.baseUrl || (environment?.baseUrl ? fillBaseUrl(environment.baseUrl, environment.variables) : undefined);
                        environmentMaxConcurrency = environment?.parallelProcessing?.maxConcurrency;
                        runsInVsCode = environment?.runOn === 'local-agent';
                    } catch { /* swallow */ }
                }

                const firstMember = filteredMembers[0] as Record<string, unknown> | undefined;
                const resolvedEndpointPath = (firstMember?.endpointPath as string | undefined) || batchExecution.endpointPath;

                executionSummary = {
                    environment: batchExecution.environment || undefined,
                    organization: batchExecution.organization || undefined,
                    endpointName: batchExecution.endpointName || undefined,
                    // #445: the batch's own name (Run Batch → Name), shown as the Console's title and Name
                    batchName: batchExecution.batchConfiguration?.name || undefined,
                    endpointMethod: batchExecution.endpointMethod || undefined,
                    endpointPath: resolvedEndpointPath || undefined,
                    baseUrl,
                    transactionCount: filteredMembers.length || undefined,
                    // ISO, never a locale string: "1/11/2026" read back as 11 January (the Console's Started stat, 2026-11-01)
                    executedAt: batchExecution.createdAt ? new Date(batchExecution.createdAt).toISOString() : undefined,
                    requestFile: requestFileName,
                    records: recordsCount,
                    status: batchExecution.status || undefined,
                    statusText: batchExecution.httpStatusText || undefined,
                    httpStatus: batchExecution.httpStatus || undefined,
                    duration: batchDuration,
                    completedAt: batchExecution.completedAt ? new Date(batchExecution.completedAt).toLocaleString() : undefined,
                    startedAt: batchExecution.startedAt ? new Date(batchExecution.startedAt).toISOString() : undefined,
                    hasErrors: batchExecution.status === 'failed' || batchExecution.status === 'error',
                    errorMessage: batchExecution.errorMessage || undefined,
                    requestHeaders: firstMember?.requestHeaders,
                    requestQueryParams: firstMember?.requestQueryParams,
                    expectedTransactions,
                    actualTransactions: filteredMembers.length,
                    concurrency: batchExecution.batchConfiguration?.parallelProcessing?.maxConcurrency || undefined,
                    environmentMaxConcurrency,
                    environmentId: resolvedEnvironmentId ?? batchExecution.environmentId,
                    runsInVsCode,
                    reprocessedFromBatchId: (batchExecution as Record<string, unknown>).reprocessedFromBatchId || undefined,
                    reprocessedToBatchId: (batchExecution as Record<string, unknown>).reprocessedToBatchId || undefined,
                    reprocessType: (batchExecution as Record<string, unknown>).reprocessType || undefined,
                    copiedFromBatchId: batchExecution.copiedFromBatchId || undefined,
                    copiedFromEnvironment: batchExecution.copiedFromEnvironment || undefined,
                    copiedFromOrganization: batchExecution.copiedFromOrganization || undefined,
                    copiedAt: batchExecution.copiedAt ? new Date(batchExecution.copiedAt).toLocaleString() : undefined,
                    environmentVariables: batchExecution.environmentVariables
                };
            }
        } else {
            const execution = await executionMetadataService?.getExecution(executionId);
            endpointId = execution?.endpointId;
            if (execution) {
                const requestFileName = execution.requestFile ? path.basename(execution.requestFile) : undefined;
                let recordsCount: number | undefined;
                if (execution.rows) {
                    const rowsText = execution.rows.toString();
                    const match = rowsText.match(/\((\d+)\)/);
                    recordsCount = match ? parseInt(match[1]) : parseInt(rowsText);
                } else {
                    recordsCount = 1;
                }

                let duration: number | undefined;
                if (execution.startedAt && execution.completedAt) {
                    duration = new Date(execution.completedAt).getTime() - new Date(execution.startedAt).getTime();
                }

                let baseUrl: string | undefined;
                let runsInVsCode = false;
                let resolvedEnvironmentId: string | undefined;
                if (execution.environmentId || execution.environment) {
                    try {
                        const environment = await environmentOf(environments, execution.environmentId, execution.environment);
                        resolvedEnvironmentId = environment?.id;
                        baseUrl = environment?.baseUrl ? fillBaseUrl(environment.baseUrl, environment.variables) : undefined;
                        runsInVsCode = environment?.runOn === 'local-agent';
                    } catch { /* swallow */ }
                }

                executionSummary = {
                    environment: execution.environment || undefined,
                    organization: execution.organization || undefined,
                    endpointName: execution.endpointName || undefined,
                    endpointMethod: execution.endpointMethod || undefined,
                    endpointPath: execution.endpointPath || undefined,
                    baseUrl,
                    transactionCount: 1,
                    executedAt: execution.createdAt ? new Date(execution.createdAt).toISOString() : undefined,
                    requestFile: requestFileName,
                    records: recordsCount,
                    status: execution.status || undefined,
                    statusText: execution.httpStatusText || undefined,
                    httpStatus: execution.httpStatus || undefined,
                    duration,
                    completedAt: execution.completedAt ? new Date(execution.completedAt).toLocaleString() : undefined,
                    startedAt: execution.startedAt ? new Date(execution.startedAt).toISOString() : undefined,
                    hasErrors: execution.status === 'failed' || execution.status === 'error',
                    errorMessage: execution.errorMessage || undefined,
                    requestHeaders: execution.requestHeaders,
                    requestQueryParams: execution.requestQueryParams,
                    environmentId: resolvedEnvironmentId ?? execution.environmentId,
                    runsInVsCode,
                    environmentVariables: execution.environmentVariables
                };
            }
        }
    } catch (err) {
        console.warn('[buildConsoleReportConfig] failed to gather execution metadata:', err);
    }

    return {
        type: isBatch ? 'batch' : 'individual',
        executionId,
        batchId: isBatch ? executionId : undefined,
        endpointId,
        responseFiles,
        responseFileStatusMap,
        responseFileDetails,
        inputFile,
        requestFile,
        logFile,
        title: `${isBatch ? 'Batch Console' : 'Transaction Console'} - ${executionId || 'Unknown'}`,
        executionSummary
    };
}
