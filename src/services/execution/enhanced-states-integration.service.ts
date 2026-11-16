// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import {
    IEnhancedStatesIntegrationService,
    StateTransitionContext,
    BlockedExecutionInfo,
    SkippedExecutionInfo,
    PausedExecutionInfo,
    StateIntegrationResult
} from './enhanced-states-integration.interface';
import { ExecutionState } from '../../types/execution-state';
import { IExecutionStateManagerService } from './execution-state-manager.interface';
import { IRequestHashValidatorService } from './request-hash-validator.interface';
import { IExecutionMetadataService } from './execution-metadata.interface';
import { IExecutionQueueManagerService } from './execution-queue-manager.interface';

export class EnhancedStatesIntegrationService implements IEnhancedStatesIntegrationService {
    private transitionHistory = new Map<string, StateTransitionContext[]>();

    constructor(
        private stateManager: IExecutionStateManagerService,
        private hashValidator: IRequestHashValidatorService,
        private metadataService: IExecutionMetadataService,
        private queueManager: IExecutionQueueManagerService
    ) {}

    async handleBlockedTransition(
        executionId: string, 
        blockReason: string, 
        context?: any
    ): Promise<StateIntegrationResult> {
        try {
            const actionsTaken: string[] = [];

            // Mark execution as blocked
            const blockResult = await this.stateManager.markExecutionAsBlocked(executionId, blockReason);
            
            if (!blockResult.success) {
                return {
                    success: false,
                    executionId,
                    newState: ExecutionState.BLOCKED,
                    actionsTaken,
                    errorMessage: blockResult.errorMessage
                };
            }

            actionsTaken.push('Marked execution as blocked');

            // Record transition in history
            this.recordStateTransition({
                executionId,
                fromState: (blockResult.previousState as ExecutionState) || ExecutionState.PENDING,
                toState: ExecutionState.BLOCKED,
                reason: blockReason,
                timestamp: new Date()
            });

            actionsTaken.push('Recorded state transition');

            // Determine next steps based on block reason
            const nextSteps = this.determineBlockedResolutionSteps(blockReason, context);
            actionsTaken.push('Analyzed resolution options');

            return {
                success: true,
                executionId,
                newState: ExecutionState.BLOCKED,
                previousState: (blockResult.previousState as ExecutionState),
                actionsTaken,
                requiresUserAction: true,
                nextSteps
            };

        } catch (error) {
            return {
                success: false,
                executionId,
                newState: ExecutionState.BLOCKED,
                actionsTaken: [],
                errorMessage: `Failed to handle blocked transition: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    async handlePausedTransition(
        executionId: string, 
        pauseReason: string, 
        batchId?: string
    ): Promise<StateIntegrationResult> {
        try {
            const actionsTaken: string[] = [];

            // Transition to paused state
            const pauseResult = await this.stateManager.transitionExecutionState(executionId, ExecutionState.PAUSED);
            
            if (!pauseResult.success) {
                return {
                    success: false,
                    executionId,
                    newState: ExecutionState.PAUSED,
                    actionsTaken,
                    errorMessage: pauseResult.errorMessage
                };
            }

            actionsTaken.push('Transitioned to paused state');

            // Record transition in history
            this.recordStateTransition({
                executionId,
                fromState: (pauseResult.previousState as ExecutionState) || ExecutionState.PENDING,
                toState: ExecutionState.PAUSED,
                reason: pauseReason,
                timestamp: new Date(),
                batchId
            });

            actionsTaken.push('Recorded state transition');

            // Update batch metadata if this is part of a batch
            if (batchId) {
                // Note: Would update batch pause metadata here
                actionsTaken.push('Updated batch metadata');
            }

            return {
                success: true,
                executionId,
                newState: ExecutionState.PAUSED,
                previousState: (pauseResult.previousState as ExecutionState),
                actionsTaken,
                requiresUserAction: false,
                nextSteps: ['Resume execution when ready']
            };

        } catch (error) {
            return {
                success: false,
                executionId,
                newState: ExecutionState.PAUSED,
                actionsTaken: [],
                errorMessage: `Failed to handle paused transition: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    async handleSkippedTransition(
        executionId: string, 
        skipReason: string, 
        skipType: 'user' | 'error' | 'dependency' | 'condition',
        batchId?: string
    ): Promise<StateIntegrationResult> {
        try {
            const actionsTaken: string[] = [];

            // Transition to skipped state
            const skipResult = await this.stateManager.transitionExecutionState(executionId, ExecutionState.SKIPPED);
            
            if (!skipResult.success) {
                return {
                    success: false,
                    executionId,
                    newState: ExecutionState.SKIPPED,
                    actionsTaken,
                    errorMessage: skipResult.errorMessage
                };
            }

            actionsTaken.push('Transitioned to skipped state');

            // Record transition in history
            this.recordStateTransition({
                executionId,
                fromState: (skipResult.previousState as ExecutionState) || ExecutionState.PENDING,
                toState: ExecutionState.SKIPPED,
                reason: `${skipType}: ${skipReason}`,
                timestamp: new Date(),
                batchId
            });

            actionsTaken.push('Recorded state transition');

            // Record skip metadata
            if (skipType === 'user') {
                actionsTaken.push('Recorded user skip action');
            } else {
                actionsTaken.push(`Recorded ${skipType} skip action`);
            }

            // Remove from queue if still queued
            try {
                await this.queueManager.removeFromQueue(executionId);
                actionsTaken.push('Removed from execution queue');
            } catch (error) {
                // May not be in queue, which is fine
            }

            return {
                success: true,
                executionId,
                newState: ExecutionState.SKIPPED,
                previousState: (skipResult.previousState as ExecutionState),
                actionsTaken,
                requiresUserAction: false,
                nextSteps: skipType === 'user' ? [] : ['Review skip reason and potentially retry']
            };

        } catch (error) {
            return {
                success: false,
                executionId,
                newState: ExecutionState.SKIPPED,
                actionsTaken: [],
                errorMessage: `Failed to handle skipped transition: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    async resolveBlockedExecution(
        executionId: string, 
        resolution: 'regenerate_hash' | 'accept_changes' | 'cancel'
    ): Promise<StateIntegrationResult> {
        try {
            const actionsTaken: string[] = [];

            if (resolution === 'cancel') {
                const cancelResult = await this.stateManager.transitionExecutionState(executionId, ExecutionState.CANCELLED);
                actionsTaken.push('Cancelled blocked execution');
                
                return {
                    success: cancelResult.success,
                    executionId,
                    newState: ExecutionState.CANCELLED,
                    actionsTaken,
                    errorMessage: cancelResult.errorMessage
                };
            }

            // Get execution metadata for hash operations
            const execution = await this.metadataService.getExecution(executionId);
            if (!execution) {
                return {
                    success: false,
                    executionId,
                    newState: ExecutionState.BLOCKED,
                    actionsTaken,
                    errorMessage: 'Execution not found'
                };
            }

            // Regenerate hash with current content
            const currentContent = execution.requestFile || '';
            const hashResult = await this.hashValidator.regenerateExecutionHash(executionId, currentContent);
            
            if (!hashResult.success) {
                return {
                    success: false,
                    executionId,
                    newState: ExecutionState.BLOCKED,
                    actionsTaken,
                    errorMessage: `Failed to regenerate hash: ${hashResult.errorMessage}`
                };
            }

            if (resolution === 'regenerate_hash') {
                actionsTaken.push('Regenerated request hash');
            } else {
                actionsTaken.push('Accepted content changes');
                actionsTaken.push('Updated execution hash');
            }

            // Clear blocked state
            const clearResult = await this.stateManager.clearBlockedState(executionId);
            if (!clearResult.success) {
                return {
                    success: false,
                    executionId,
                    newState: ExecutionState.BLOCKED,
                    actionsTaken,
                    errorMessage: clearResult.errorMessage
                };
            }

            actionsTaken.push('Cleared blocked state');

            // Record resolution in history
            this.recordStateTransition({
                executionId,
                fromState: ExecutionState.BLOCKED,
                toState: ExecutionState.PENDING,
                reason: `Resolved: ${resolution}`,
                timestamp: new Date()
            });

            actionsTaken.push('Recorded resolution');

            return {
                success: true,
                executionId,
                newState: ExecutionState.PENDING,
                previousState: ExecutionState.BLOCKED,
                actionsTaken,
                requiresUserAction: false,
                nextSteps: ['Execution ready to proceed']
            };

        } catch (error) {
            return {
                success: false,
                executionId,
                newState: ExecutionState.BLOCKED,
                actionsTaken: [],
                errorMessage: `Failed to resolve blocked execution: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    async resumePausedExecution(executionId: string): Promise<StateIntegrationResult> {
        try {
            const actionsTaken: string[] = [];

            // Check current state
            const stateResult = await this.stateManager.getExecutionState(executionId);
            if (!stateResult.state || stateResult.state !== ExecutionState.PAUSED) {
                return {
                    success: false,
                    executionId,
                    newState: stateResult.state || ExecutionState.PENDING,
                    actionsTaken,
                    errorMessage: 'Execution is not in paused state'
                };
            }

            // Transition back to pending
            const resumeResult = await this.stateManager.transitionExecutionState(executionId, ExecutionState.PENDING);
            
            if (!resumeResult.success) {
                return {
                    success: false,
                    executionId,
                    newState: ExecutionState.PAUSED,
                    actionsTaken,
                    errorMessage: resumeResult.errorMessage
                };
            }

            actionsTaken.push('Resumed paused execution');

            // Record transition
            this.recordStateTransition({
                executionId,
                fromState: ExecutionState.PAUSED,
                toState: ExecutionState.PENDING,
                reason: 'User resumed execution',
                timestamp: new Date()
            });

            actionsTaken.push('Recorded resume action');

            return {
                success: true,
                executionId,
                newState: ExecutionState.PENDING,
                previousState: ExecutionState.PAUSED,
                actionsTaken,
                requiresUserAction: false,
                nextSteps: ['Execution will continue when queue processes it']
            };

        } catch (error) {
            return {
                success: false,
                executionId,
                newState: ExecutionState.PAUSED,
                actionsTaken: [],
                errorMessage: `Failed to resume execution: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    async getExecutionsInEnhancedStates(): Promise<{
        blocked: BlockedExecutionInfo[];
        paused: PausedExecutionInfo[];
        skipped: SkippedExecutionInfo[];
    }> {
        try {
            const result = {
                blocked: [] as BlockedExecutionInfo[],
                paused: [] as PausedExecutionInfo[],
                skipped: [] as SkippedExecutionInfo[]
            };

            // Get executions in each enhanced state
            if (this.stateManager.getExecutionsByState) {
                const blockedExecutions = await this.stateManager.getExecutionsByState(ExecutionState.BLOCKED);
                const pausedExecutions = await this.stateManager.getExecutionsByState(ExecutionState.PAUSED);
                const skippedExecutions = await this.stateManager.getExecutionsByState(ExecutionState.SKIPPED);

                // Convert to info objects
                result.blocked = blockedExecutions.map(exec => this.createBlockedExecutionInfo(exec));
                result.paused = pausedExecutions.map(exec => this.createPausedExecutionInfo(exec));
                result.skipped = skippedExecutions.map(exec => this.createSkippedExecutionInfo(exec));
            }

            return result;

        } catch (error) {
            return {
                blocked: [],
                paused: [],
                skipped: []
            };
        }
    }

    async getBlockedExecutionInfo(executionId: string): Promise<BlockedExecutionInfo | null> {
        try {
            const stateResult = await this.stateManager.getExecutionState(executionId);
            if (!stateResult.state || stateResult.state !== ExecutionState.BLOCKED || !stateResult.metadata) {
                return null;
            }

            return this.createBlockedExecutionInfo(stateResult.metadata);

        } catch (error) {
            return null;
        }
    }

    async getPausedExecutionInfo(executionId: string): Promise<PausedExecutionInfo | null> {
        try {
            const stateResult = await this.stateManager.getExecutionState(executionId);
            if (!stateResult.state || stateResult.state !== ExecutionState.PAUSED || !stateResult.metadata) {
                return null;
            }

            return this.createPausedExecutionInfo(stateResult.metadata);

        } catch (error) {
            return null;
        }
    }

    async getSkippedExecutionInfo(executionId: string): Promise<SkippedExecutionInfo | null> {
        try {
            const stateResult = await this.stateManager.getExecutionState(executionId);
            if (!stateResult.state || stateResult.state !== ExecutionState.SKIPPED || !stateResult.metadata) {
                return null;
            }

            return this.createSkippedExecutionInfo(stateResult.metadata);

        } catch (error) {
            return null;
        }
    }

    async bulkResolveBlockedExecutions(
        executionIds: string[], 
        resolution: 'regenerate_hash' | 'accept_changes' | 'cancel'
    ): Promise<Map<string, StateIntegrationResult>> {
        const results = new Map<string, StateIntegrationResult>();

        for (const executionId of executionIds) {
            try {
                const result = await this.resolveBlockedExecution(executionId, resolution);
                results.set(executionId, result);
            } catch (error) {
                results.set(executionId, {
                    success: false,
                    executionId,
                    newState: ExecutionState.BLOCKED,
                    actionsTaken: [],
                    errorMessage: `Bulk resolution failed: ${error instanceof Error ? error.message : 'Unknown error'}`
                });
            }
        }

        return results;
    }

    async autoResolveBlockedExecutions(
        rules: {
            maxAge?: number;
            autoAcceptMinorChanges?: boolean;
            autoRegenerateHashOnWhitespaceChanges?: boolean;
        }
    ): Promise<StateIntegrationResult[]> {
        try {
            const results: StateIntegrationResult[] = [];

            // Get all blocked executions
            if (!this.stateManager.getExecutionsByState) {
                return results;
            }

            const blockedExecutions = await this.stateManager.getExecutionsByState(ExecutionState.BLOCKED);

            for (const execution of blockedExecutions) {
                const shouldAutoResolve = this.shouldAutoResolveExecution(execution, rules);
                
                if (shouldAutoResolve.resolve) {
                    const result = await this.resolveBlockedExecution(execution.id, shouldAutoResolve.resolution!);
                    results.push(result);
                }
            }

            return results;

        } catch (error) {
            return [];
        }
    }

    async validateStateTransition(
        executionId: string, 
        fromState: ExecutionState, 
        toState: ExecutionState
    ): Promise<{ allowed: boolean; reason?: string }> {
        try {
            const validation = await this.stateManager.validateStateTransition(fromState, toState);
            return {
                allowed: validation.allowed,
                reason: validation.reason
            };

        } catch (error) {
            return {
                allowed: false,
                reason: `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    async getStateTransitionHistory(executionId: string): Promise<StateTransitionContext[]> {
        return this.transitionHistory.get(executionId) || [];
    }

    /**
     * Clear transition history for given execution IDs (memory cleanup after batch completion)
     */
    clearHistory(executionIds: string[]): void {
        for (const id of executionIds) {
            this.transitionHistory.delete(id);
        }
    }

    async handleBatchStateChange(
        batchId: string, 
        newState: ExecutionState, 
        affectedExecutions: string[]
    ): Promise<StateIntegrationResult[]> {
        const results: StateIntegrationResult[] = [];

        for (const executionId of affectedExecutions) {
            try {
                let result: StateIntegrationResult;

                switch (newState) {
                    case ExecutionState.PAUSED:
                        result = await this.handlePausedTransition(executionId, 'Batch paused', batchId);
                        break;
                    case ExecutionState.SKIPPED:
                        result = await this.handleSkippedTransition(executionId, 'Batch cancelled', 'error', batchId);
                        break;
                    default:
                        result = {
                            success: false,
                            executionId,
                            newState,
                            actionsTaken: [],
                            errorMessage: `Unsupported batch state change: ${newState}`
                        };
                }

                results.push(result);

            } catch (error) {
                results.push({
                    success: false,
                    executionId,
                    newState,
                    actionsTaken: [],
                    errorMessage: `Batch state change failed: ${error instanceof Error ? error.message : 'Unknown error'}`
                });
            }
        }

        return results;
    }

    // Private helper methods
    private recordStateTransition(context: StateTransitionContext): void {
        const history = this.transitionHistory.get(context.executionId) || [];
        history.push(context);
        this.transitionHistory.set(context.executionId, history);
    }

    private determineBlockedResolutionSteps(blockReason: string, context?: any): string[] {
        const steps: string[] = [];

        if (blockReason.includes('hash') || blockReason.includes('modified')) {
            steps.push('Review content changes');
            steps.push('Choose: Regenerate hash, Accept changes, or Cancel');
        }

        if (context?.hashMismatch) {
            steps.push('Compare original vs modified content');
        }

        steps.push('Resolve blocking issue to proceed');

        return steps;
    }

    private createBlockedExecutionInfo(execution: any): BlockedExecutionInfo {
        return {
            executionId: execution.id,
            blockReason: execution.errorMessage || 'Unknown block reason',
            blockedAt: execution.startedAt || execution.createdAt || new Date(),
            hashMismatch: execution.errorMessage?.includes('hash') || false,
            canResolve: true,
            resolutionOptions: ['regenerate_hash', 'accept_changes', 'cancel']
        };
    }

    private createPausedExecutionInfo(execution: any): PausedExecutionInfo {
        return {
            executionId: execution.id,
            pausedAt: execution.startedAt || execution.createdAt || new Date(),
            pauseReason: 'Execution paused',
            batchId: execution.batchId,
            canResume: true
        };
    }

    private createSkippedExecutionInfo(execution: any): SkippedExecutionInfo {
        return {
            executionId: execution.id,
            skipReason: execution.errorMessage || 'Execution skipped',
            skippedAt: execution.startedAt || execution.createdAt || new Date(),
            batchId: execution.batchId,
            wasManual: false,
            skipType: 'condition'
        };
    }

    private shouldAutoResolveExecution(
        execution: any, 
        rules: any
    ): { resolve: boolean; resolution?: 'regenerate_hash' | 'accept_changes' | 'cancel' } {
        const age = Date.now() - (execution.createdAt?.getTime() || 0);
        
        // Auto-resolve whitespace changes (highest priority)
        if (rules.autoRegenerateHashOnWhitespaceChanges && 
            execution.errorMessage?.includes('whitespace')) {
            return { resolve: true, resolution: 'regenerate_hash' };
        }

        // Auto-accept minor changes
        if (rules.autoAcceptMinorChanges && 
            execution.errorMessage?.includes('minor')) {
            return { resolve: true, resolution: 'accept_changes' };
        }

        // Auto-resolve if too old (lowest priority)
        if (rules.maxAge && age > rules.maxAge) {
            return { resolve: true, resolution: 'cancel' };
        }

        return { resolve: false };
    }
}