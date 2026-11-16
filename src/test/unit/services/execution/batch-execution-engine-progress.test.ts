// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for BatchExecutionEngine progress tracking functionality
 * 
 * Tests the progress notification creation and progress scaling logic
 */

import { expect } from 'chai';
import { stub, spy, SinonStub, SinonSpy } from 'sinon';
import * as vscode from 'vscode';
import { BatchExecutionEngine } from '../../../../services/execution/batch-execution-engine.service';
import { createMockLogger } from '../../../helpers/logging/mock-logger';

describe('BatchExecutionEngine Progress Tracking Unit Tests', () => {
    let batchEngine: BatchExecutionEngine;
    let mockDependencies: any;
    let withProgressStub: SinonStub;
    let progressReportSpy: SinonSpy;

    beforeEach(() => {
        // Mock dependencies
        mockDependencies = {
            executionMetadataService: {
                getExecution: stub().resolves({
                    id: 'test-batch',
                    executionType: 'batch',
                    endpointName: 'Test Endpoint'
                }),
                updateExecution: stub().resolves(),
                getBatchMemberExecutions: stub().resolves([
                    { id: 'member-1', status: 'pending' },
                    { id: 'member-2', status: 'pending' }
                ])
            },
            executionService: {
                executeRecord: stub().resolves({ success: true, duration: 1000 })
            }
        };

        const mockLogger = createMockLogger();
        batchEngine = new BatchExecutionEngine(mockDependencies, mockLogger);

        // Mock progress reporting
        progressReportSpy = spy();
        withProgressStub = stub(vscode.window, 'withProgress').callsFake(async (options, task) => {
            const mockProgress = { report: progressReportSpy };
            const mockToken = { 
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose: () => {} })
            };
            return await task(mockProgress, mockToken);
        });
    });

    afterEach(() => {
        withProgressStub.restore();
    });

    describe('Progress Notification Creation', () => {
        it('should create VS Code progress notification when no external progress provided', async () => {
            // Act
            await batchEngine.executeBatch('test-batch');

            // Assert
            expect(withProgressStub.calledOnce).to.be.true;
            
            const progressOptions = withProgressStub.firstCall.args[0];
            expect(progressOptions.location).to.equal(vscode.ProgressLocation.Notification);
            expect(progressOptions.title).to.include('Test Endpoint');
            expect(progressOptions.cancellable).to.be.true;
        });

        it('should not create VS Code progress notification when external progress provided', async () => {
            const externalProgress = { report: spy() };

            // Act
            await batchEngine.executeBatch('test-batch', undefined, externalProgress);

            // Assert
            expect(withProgressStub.called).to.be.false;
        });

        it('should use fallback title when endpoint name not available', async () => {
            // Mock metadata without endpoint name
            mockDependencies.executionMetadataService.getExecution.resolves({
                id: 'test-batch',
                executionType: 'batch'
                // No endpointName
            });

            // Act
            await batchEngine.executeBatch('test-batch');

            // Assert
            const progressOptions = withProgressStub.firstCall.args[0];
            expect(progressOptions.title).to.include('batch');
        });
    });

    describe('Progress Reporting During Execution', () => {
        it('should report progress with runtime and time estimates', async () => {
            // Mock batch state for progress calculation
            const startTime = new Date();
            mockDependencies.executionService.executeRecord.callsFake(async () => {
                // Simulate some execution time
                await new Promise(resolve => setTimeout(resolve, 10));
                return { success: true, duration: 100 };
            });

            // Act
            await batchEngine.executeBatch('test-batch');

            // Assert - Should have progress reports with runtime and estimates
            expect(progressReportSpy.called).to.be.true;
            
            const progressCalls = progressReportSpy.getCalls();
            const executionProgress = progressCalls.find(call => 
                call.args[0].message && call.args[0].message.includes('Runtime:')
            );
            
            expect(executionProgress).to.exist;
            expect(executionProgress!.args[0].message).to.match(/Runtime: \d+[sm]/);
            expect(executionProgress!.args[0].message).to.match(/Est: [\w.]+/);
        });

        it('should calculate correct progress increments', async () => {
            // Act
            await batchEngine.executeBatch('test-batch');

            // Assert - Progress increments should add up to 100% for 2 members
            const progressCalls = progressReportSpy.getCalls();
            const incrementCalls = progressCalls.filter(call => 
                call.args[0].increment !== undefined
            );
            
            if (incrementCalls.length > 0) {
                const expectedIncrement = 100 / 2; // 2 batch members
                incrementCalls.forEach(call => {
                    expect(call.args[0].increment).to.equal(expectedIncrement);
                });
            }
        });
    });

    describe('Cancellation Support', () => {
        it('should handle cancellation during batch execution', async () => {
            // Mock cancellation
            withProgressStub.restore();
            withProgressStub = stub(vscode.window, 'withProgress').callsFake(async (options, task) => {
                const mockProgress = { report: progressReportSpy };
                const mockToken = { 
                    isCancellationRequested: true,
                    onCancellationRequested: () => ({ dispose: () => {} })
                };
                return await task(mockProgress, mockToken);
            });

            // Act
            const result = await batchEngine.executeBatch('test-batch');

            // Assert - Should handle cancellation gracefully
            expect(result.status).to.equal('cancelled');
        });
    });

    describe('Time Calculation Utilities', () => {
        it('should format runtime correctly', () => {
            const startTime = new Date(Date.now() - 65000); // 65 seconds ago
            
            // Access private method for testing
            const formatRuntime = (batchEngine as any).formatRuntime;
            const runtime = formatRuntime.call(batchEngine, startTime);
            
            expect(runtime).to.match(/1m \d+s/);
        });

        it('should calculate time remaining when members completed', async () => {
            const batchState = {
                completedMembers: 1,
                startedAt: new Date(Date.now() - 30000) // 30 seconds ago
            };
            
            // Access private method for testing
            const calculateTimeRemaining = (batchEngine as any).calculateTimeRemaining;
            const timeRemaining = await calculateTimeRemaining.call(batchEngine, batchState, 4);
            
            // Should estimate based on average time per member
            expect(timeRemaining).to.match(/\d+[sm]/);
            expect(timeRemaining).to.not.equal('calculating...');
        });

        it('should show calculating when no members completed yet', async () => {
            const batchState = {
                completedMembers: 0,
                startedAt: new Date()
            };
            
            // Access private method for testing
            const calculateTimeRemaining = (batchEngine as any).calculateTimeRemaining;
            const timeRemaining = await calculateTimeRemaining.call(batchEngine, batchState, 4);
            
            expect(timeRemaining).to.equal('calculating...');
        });
    });
});