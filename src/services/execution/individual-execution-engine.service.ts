// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import {
    IIndividualExecutionEngine,
    IndividualExecutionState,
    IndividualExecutionResult,
    IndividualProgressCallback,
    IndividualExecutionEngineDependencies
} from './individual-execution-engine.interface';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';
import { readRunFileIfExists } from '../run-content/run-content-store';


/**
 * IndividualExecutionEngine Service
 *
 * Handles individual execution processing with priority support.
 * Key features:
 * - Non-interruptible execution (high priority)
 * - Real-time progress tracking
 * - Fast execution for user responsiveness
 *
 * Architecture:
 * - Works with ExecutionCoordinator for priority management
 * - Uses ExecutionService for actual execution
 * - Maintains execution state for monitoring
 */
export class IndividualExecutionEngine implements IIndividualExecutionEngine {
    private dependencies: IndividualExecutionEngineDependencies;
    private runningExecutions: Map<string, IndividualExecutionState> = new Map();

    constructor(
        dependencies: IndividualExecutionEngineDependencies,
        private logger: IExtensionDiagnosticLogger
    ) {
        this.dependencies = dependencies;
    }

    /**
     * Execute an individual execution with high priority
     */
    async executeIndividual(executionId: string, progressCallback?: IndividualProgressCallback): Promise<IndividualExecutionResult> {
        try {
            this.logger.debug(`[IndividualExecutionEngine] Starting individual execution ${executionId}`, { executionId });

            // Get execution metadata
            const executionMetadata = await this.dependencies.executionMetadataService.getExecution(executionId);
            if (!executionMetadata) {
                throw new Error(`Individual execution ${executionId} not found`);
            }


            if (executionMetadata.executionType !== 'individual') {
                throw new Error(`Execution ${executionId} is not an individual execution`);
            }

            // Initialize execution state
            const executionState: IndividualExecutionState = {
                executionId,
                status: 'running',
                startedAt: new Date(),
                priority: 'HIGH' // Individual executions always have high priority
            };

            this.runningExecutions.set(executionId, executionState);

            // Auto-open report for individual execution (similar to batch behavior)
            try {
                await this.dependencies.progressSink.openConsole(executionId, { isBatch: false });

                // Give the report a moment to register before sending status update
                await new Promise(resolve => setTimeout(resolve, 100));

                // Send initial preparing status update to the newly opened report
                await this.sendStatusUpdateToReport(executionId, 'preparing');

            } catch (reportError) {
                this.logger.error('[IndividualExecutionEngine] Failed to open report:', reportError instanceof Error ? reportError : undefined);
                // Continue execution even if report opening fails
            }

            // Note: ExecutionService handles status transition from 'pending' to 'running'
            // IndividualExecutionEngine doesn't update status to avoid race conditions

            // Notify progress callback
            if (progressCallback?.onExecutionStarted) {
                await progressCallback.onExecutionStarted(executionId, executionState.priority);
            }

            // Send status update to any open report (execution started)
            await this.sendStatusUpdateToReport(executionId, 'running');

            // Execute using ExecutionService
            const startTime = Date.now();
            let executionResult = await this.dependencies.executionService.executeRecord(executionId);
            // #359: a 401 with credentials that can be refreshed without asking (an OAuth refresh
            // token): refreshed, and sent once more
            const environmentId = (executionMetadata.environmentId ?? executionMetadata.environment) as string | undefined;
            if (!executionResult.success && executionResult.httpStatus === 401 && environmentId && this.dependencies.refreshCredentials) {
                const refreshed = await this.dependencies.refreshCredentials(environmentId).catch(() => false);
                if (refreshed) {
                    this.logger.info(`[IndividualExecutionEngine] credentials refreshed after 401, sending ${executionId} again`);
                    await this.dependencies.executionMetadataService.updateExecution(executionId, { status: 'pending' });
                    executionResult = await this.dependencies.executionService.executeRecord(executionId);
                }
            }
            const duration = Date.now() - startTime;

            const result: IndividualExecutionResult = {
                success: executionResult.success,
                executionId,
                duration,
                httpStatus: executionResult.httpStatus,
                httpStatusText: executionResult.httpStatusText,
                errorMessage: executionResult.errorMessage
            };

            // Update final state
            // #335: Cancel aborted it in flight: cancelled, not an error
            executionState.status = result.success ? 'completed' : executionResult.cancelled ? 'cancelled' : 'error';
            executionState.completedAt = new Date();
            executionState.errorMessage = result.errorMessage;

            // Update metadata with final result (handle errors gracefully)
            try {
                await this.updateExecutionMetadata(executionId, {
                    status: executionState.status,
                    completedAt: executionState.completedAt,
                    errorMessage: result.errorMessage
                });
            } catch (metadataError) {
                this.logger.warn(`[IndividualExecutionEngine] Failed to update completion metadata for ${executionId}`, metadataError, { executionId });
            }

            this.logger.debug(`[IndividualExecutionEngine] Individual execution ${executionId} ${executionState.status}: ${result.success ? 'success' : result.errorMessage}`, {
                executionId,
                status: executionState.status,
                success: result.success,
                errorMessage: result.errorMessage
            });

            // Notify progress callback
            if (progressCallback?.onExecutionCompleted) {
                await progressCallback.onExecutionCompleted(executionId, result);
            }

            // Send status update to any open report (execution completed)
            await this.sendStatusUpdateToReport(executionId, executionState.status, result.errorMessage);

            // Focus/open the report when execution completes (instead of showing VS Code message)
            try {
                await this.dependencies.progressSink.openConsole(executionId, { isBatch: false, focus: true });
            } catch (focusError) {
                this.logger.error('[IndividualExecutionEngine] Failed to focus report on completion:', focusError instanceof Error ? focusError : undefined);
                // Fallback to simple info message if focus fails
            }


            // Note: Execution completion is handled by ExecutionCoordinator
            // No need to notify coordinator here to avoid circular dependency

            // Clean up running state
            this.runningExecutions.delete(executionId);

            return result;

        } catch (error) {
            this.logger.error(`[IndividualExecutionEngine] Individual execution ${executionId} failed`, error instanceof Error ? error : undefined, { executionId });

            // Update execution state with error
            const executionState = this.runningExecutions.get(executionId);
            if (executionState) {
                executionState.status = 'error';
                executionState.completedAt = new Date();
                executionState.errorMessage = error instanceof Error ? error.message : 'Unknown error';
            }

            try {
                await this.updateExecutionMetadata(executionId, {
                    status: 'error',
                    completedAt: new Date(),
                    errorMessage: error instanceof Error ? error.message : 'Unknown error'
                });
            } catch (metadataError) {
                this.logger.warn(`[IndividualExecutionEngine] Failed to update error metadata for ${executionId}`, metadataError, { executionId });
            }

            // Send status update to any open report (execution failed)
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await this.sendStatusUpdateToReport(executionId, 'error', errorMessage);

            // Focus/open the report when execution fails (to show error details)
            try {
                await this.dependencies.progressSink.openConsole(executionId, { isBatch: false, focus: true });
            } catch (focusError) {
                this.logger.error('[IndividualExecutionEngine] Failed to focus report on error:', focusError instanceof Error ? focusError : undefined);
            }

            // Clean up running state
            this.runningExecutions.delete(executionId);

            // For validation errors, re-throw
            if (error instanceof Error && (
                error.message.includes('not found') ||
                error.message.includes('not an individual execution')
            )) {
                throw error;
            }

            // Return failed result for execution errors
            return {
                success: false,
                executionId,
                duration: 0,
                errorMessage: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    /**
     * Get current state of an individual execution
     */
    async getExecutionState(executionId: string): Promise<IndividualExecutionState | null> {
        return this.runningExecutions.get(executionId) || null;
    }

    /**
     * Check if an execution is currently running
     */
    async isExecutionRunning(executionId: string): Promise<boolean> {
        return this.runningExecutions.has(executionId);
    }

    /**
     * Get all currently running individual executions
     */
    async getRunningExecutions(): Promise<string[]> {
        return Array.from(this.runningExecutions.keys());
    }

    /**
     * Execute record method for consistency with ExecutionService interface
     * Delegates to executeIndividual method
     */
    async executeRecord(executionId: string): Promise<IndividualExecutionResult> {
        return await this.executeIndividual(executionId);
    }

    /**
     * Update execution metadata through the metadata service
     */
    private async updateExecutionMetadata(executionId: string, updates: any): Promise<void> {
        if (this.dependencies.executionMetadataService?.updateExecution) {
            await this.dependencies.executionMetadataService.updateExecution(executionId, updates);
        }
    }


    /**
     * Send live status update to any open report webview
     */
    private async sendStatusUpdateToReport(executionId: string, status: string, errorMessage?: string): Promise<void> {
        try {

            // Get latest execution metadata for response data
            const executionMetadata = await this.dependencies.executionMetadataService?.getExecution(executionId);
            if (!executionMetadata) {
                return;
            }

            // Create status display
            let statusDisplay = '';
            const duration = '';

            switch (status) {
                case 'preparing':
                    statusDisplay = '🔄 Preparing';
                    break;
                case 'running':
                    statusDisplay = '🔄 Running';
                    break;
                case 'completed':
                    statusDisplay = '✅ Completed';
                    break;
                case 'error':
                    statusDisplay = '❌ Failed';
                    break;
                default:
                    statusDisplay = status;
            }

            // Calculate duration for ALL states (not just completed)
            // For individual: Use startedAt (execution time only, NO prep time)
            let durationSeconds;
            if (executionMetadata.startedAt) {
                const startTime = new Date(executionMetadata.startedAt);
                const endTime = executionMetadata.completedAt
                    ? new Date(executionMetadata.completedAt)  // Completed: use actual end time
                    : new Date();  // Running: use current time

                const durationMs = endTime.getTime() - startTime.getTime();
                durationSeconds = durationMs / 1000; // Keep as decimal for frontend formatting
            }

            // Load response data for completed executions
            let responseData = undefined;
            if ((status === 'completed' || status === 'error') && executionMetadata.responseFile) {
                try {
                    const responseContent = readRunFileIfExists(executionMetadata.responseFile);
                    if (responseContent !== undefined) responseData = JSON.parse(responseContent);
                } catch (parseError) {
                    this.logger.warn(`[IndividualExecutionEngine] Failed to load response data for ${executionId}`, parseError instanceof Error ? parseError : undefined);
                }
            }

            // Send update to any open report

            // For individual executions, progress is always simple: 0/1 -> 1/1
            const progress = {
                completed: status === 'completed' || status === 'error' ? 1 : 0,
                total: 1,
                percentage: status === 'completed' || status === 'error' ? 100 : (status === 'running' ? 50 : 0)
            };

            // For running status, if startedAt isn't set yet, use current time
            let startTimeMs;
            if (executionMetadata.startedAt) {
                startTimeMs = new Date(executionMetadata.startedAt).getTime();
            } else if (status === 'running') {
                startTimeMs = Date.now(); // Starting right now
            }

            // GitHub Issue #121: Include file paths for dynamic link updates
            await this.dependencies.progressSink.status(executionId, {
                status,
                statusDisplay,
                errorMessage,
                durationSeconds,
                startTime: startTimeMs,
                responseData,
                progress,
                responseFile: executionMetadata.responseFile,
                requestFile: executionMetadata.requestFile
            });

        } catch (error) {
            this.logger.warn(`[IndividualExecutionEngine] Failed to send status update to report for ${executionId}`, error instanceof Error ? error : undefined, { executionId });
        }
    }
}