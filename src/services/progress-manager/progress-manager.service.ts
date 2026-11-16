// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import { getToast } from '../notifications/get-toast';
import { IProgressManager } from './progress-manager.interface';
import { IExecutionMetadataService } from '../execution/execution-metadata.interface';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';


/**
 * Progress Manager Service
 * 
 * Manages VS Code progress notifications for batch execution.
 * Tracks active batch to allow status bar interaction.
 */
export class ProgressManagerService implements IProgressManager {
    private activeBatchId: string | null = null;
    private progressIsActive: boolean = false;

    constructor(
        private context: vscode.ExtensionContext,
        private logger: IExtensionDiagnosticLogger,
        private executionMetadataService?: IExecutionMetadataService
    ) { }

    hasActiveProgress(batchId: string): boolean {
        return this.activeBatchId === batchId && this.progressIsActive;
    }

    setActiveBatch(batchId: string): void {
        this.activeBatchId = batchId;
        this.progressIsActive = true;
    }

    getActiveBatchId(): string | null {
        return this.activeBatchId;
    }

    clearActiveBatch(): void {
        this.activeBatchId = null;
        this.progressIsActive = false;
    }

    showProgressClosedMessage(): void {
        getToast()?.info('Batch execution progress is running in the background. The progress bar has been closed.');
    }

    showBatchCompletionMessage(batchId: string, summary: {
        completionText: string;
        hasErrors: boolean;
        total: number;
    }): void {
        const message = `Batch execution completed: ${summary.completionText} (${summary.total} total)`;

        // Store batch result for later "View Logs" access
        this.storeBatchResult(batchId, summary);

        // Surface completion via the portable toast (warn on errors).
        if (summary.hasErrors) {
            getToast()?.warn(message);
        } else {
            getToast()?.info(message);
        }
    }

    async showBatchLogs(batchId: string, summary: {
        completionText: string;
        total: number;
    }): Promise<void> {
        try {
            // Create batch-specific output channel
            const outputChannel = vscode.window.createOutputChannel(`DBMN Batch ${batchId.substring(0, 8)}`);

            // Header
            outputChannel.appendLine(`${'='.repeat(70)}`);
            outputChannel.appendLine(`BATCH EXECUTION LOGS - ${batchId}`);
            outputChannel.appendLine(`Generated: ${new Date().toLocaleString()}`);
            outputChannel.appendLine(`${summary.completionText} (${summary.total} total)`);
            outputChannel.appendLine(`${'='.repeat(70)}\n`);

            if (this.executionMetadataService) {
                // Get batch execution details
                const batchExecution = await this.executionMetadataService.getExecution(batchId);
                if (batchExecution) {
                    outputChannel.appendLine(`📊 BATCH SUMMARY:`);
                    outputChannel.appendLine(`   Status: ${batchExecution.status}`);
                    outputChannel.appendLine(`   Environment: ${batchExecution.environment}`);
                    outputChannel.appendLine(`   Endpoint: ${batchExecution.endpointName}`);
                    outputChannel.appendLine(`   Created: ${batchExecution.createdAt}`);
                    if (batchExecution.completedAt) {
                        outputChannel.appendLine(`   Completed: ${batchExecution.completedAt}`);
                    }
                    if (batchExecution.runTime) {
                        outputChannel.appendLine(`   Duration: ${batchExecution.runTime}ms`);
                    }
                    outputChannel.appendLine('');
                }

                // Get batch member executions with detailed logs
                const batchMembers = await this.executionMetadataService.getBatchMemberExecutions(batchId);
                if (batchMembers && batchMembers.length > 0) {
                    outputChannel.appendLine(`🔍 BATCH MEMBER DETAILS (${batchMembers.length} transactions):`);
                    outputChannel.appendLine('');

                    // Group by status for better organization
                    const successfulMembers = batchMembers.filter(m => m.status === 'completed');
                    const failedMembers = batchMembers.filter(m => m.status === 'failed');
                    const runningMembers = batchMembers.filter(m => m.status === 'running');
                    const pendingMembers = batchMembers.filter(m => m.status === 'pending');

                    if (successfulMembers.length > 0) {
                        outputChannel.appendLine(`✅ SUCCESSFUL (${successfulMembers.length}):`);
                        successfulMembers.forEach((member, index) => {
                            outputChannel.appendLine(`   ${index + 1}. ${member.id.substring(0, 8)} - Status: ${member.httpStatus || 'N/A'} - Duration: ${member.runTime || 'N/A'}ms`);
                            if (member.responseFile) {
                                outputChannel.appendLine(`      Response File: ${member.responseFile}`);
                            }
                        });
                        outputChannel.appendLine('');
                    }

                    if (failedMembers.length > 0) {
                        outputChannel.appendLine(`❌ FAILED (${failedMembers.length}):`);
                        failedMembers.forEach((member, index) => {
                            outputChannel.appendLine(`   ${index + 1}. ${member.id.substring(0, 8)} - Status: ${member.httpStatus || 'Error'}`);
                            if (member.errorMessage) {
                                outputChannel.appendLine(`      Error: ${member.errorMessage}`);
                            }
                            if (member.responseFile) {
                                outputChannel.appendLine(`      Response File: ${member.responseFile}`);
                            }
                        });
                        outputChannel.appendLine('');
                    }

                    if (runningMembers.length > 0) {
                        outputChannel.appendLine(`⏳ RUNNING (${runningMembers.length}):`);
                        runningMembers.forEach((member, index) => {
                            outputChannel.appendLine(`   ${index + 1}. ${member.id.substring(0, 8)} - Started: ${member.createdAt}`);
                        });
                        outputChannel.appendLine('');
                    }

                    if (pendingMembers.length > 0) {
                        outputChannel.appendLine(`⏸️ PENDING (${pendingMembers.length}):`);
                        pendingMembers.forEach((member, index) => {
                            outputChannel.appendLine(`   ${index + 1}. ${member.id.substring(0, 8)}`);
                        });
                        outputChannel.appendLine('');
                    }

                    // Execution timeline
                    outputChannel.appendLine(`📈 EXECUTION TIMELINE:`);
                    const sortedMembers = [...batchMembers].sort((a, b) =>
                        new Date(a.createdAt || '').getTime() - new Date(b.createdAt || '').getTime()
                    );

                    sortedMembers.forEach((member, index) => {
                        const statusIcon = member.status === 'completed' ? '✅' :
                            member.status === 'failed' ? '❌' :
                                member.status === 'running' ? '⏳' : '⏸️';
                        const duration = member.runTime ? ` (${member.runTime}ms)` : '';
                        outputChannel.appendLine(`   ${index + 1}. ${statusIcon} ${member.id.substring(0, 8)} - ${member.status}${duration}`);
                    });
                }
            } else {
                outputChannel.appendLine(`⚠️ Detailed batch logs unavailable - ExecutionMetadataService not available`);
                outputChannel.appendLine(`Basic batch info: ${summary.completionText} (${summary.total} total)`);
            }

            outputChannel.appendLine(`\n${'='.repeat(70)}`);
            outputChannel.show(); // Bring to foreground when explicitly requested

        } catch (error) {
            this.logger.error('[ProgressManager] Error showing batch logs', error instanceof Error ? error : undefined);
            // Fallback to basic display
            const outputChannel = vscode.window.createOutputChannel('DBMN Batch Results');
            outputChannel.appendLine(`\n${'='.repeat(60)}`);
            outputChannel.appendLine(`Batch ${batchId} - ${new Date().toLocaleString()}`);
            outputChannel.appendLine(`${summary.completionText} (${summary.total} total)`);
            outputChannel.appendLine(`Error loading detailed logs: ${error instanceof Error ? error.message : String(error)}`);
            outputChannel.appendLine(`${'='.repeat(60)}\n`);
            outputChannel.show();
        }
    }

    private batchResults = new Map<string, any>();

    private storeBatchResult(batchId: string, summary: any): void {
        this.batchResults.set(batchId, {
            ...summary,
            timestamp: new Date()
        });
    }

    /**
     * Mark progress as closed (user dismissed it)
     */
    markProgressClosed(): void {
        this.progressIsActive = false;
    }

    /**
     * Clear stored batch result data (memory cleanup after batch completion)
     */
    clearBatchResult(batchId: string): void {
        this.batchResults.delete(batchId);
    }
}