// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';
import { BatchStatusService } from '../../../services/batch-status/batch-status.service';
import { BatchStatusCounts } from '../../../services/batch-status/batch-status.interface';

/**
 * Unit Tests for BatchStatusService
 * 
 * These tests verify pure business logic for dynamic status counting,
 * emoji mapping, and status text formatting without external dependencies.
 */
describe('BatchStatusService', () => {
    let batchStatusService: BatchStatusService;

    beforeEach(() => {
        batchStatusService = new BatchStatusService();
    });

    describe('calculateStatusCounts - Dynamic GROUP BY Logic', () => {
        it('should count various statuses dynamically without hardcoding', () => {
            const batchMembers = [
                { status: 'completed' },
                { status: 'completed' },
                { status: 'error' },
                { status: 'timeout' },  // Unknown status - should still be counted
                { status: 'completed' },
                { status: 'retrying' }  // Another unknown status
            ];

            const result = batchStatusService.calculateStatusCounts(batchMembers);

            expect(result.total).to.equal(6);
            expect(result.completed).to.equal(3);
            expect(result.error).to.equal(1);
            expect(result.timeout).to.equal(1);
            expect(result.retrying).to.equal(1);
        });

        it('should handle legacy "failed" status by mapping to "error"', () => {
            const batchMembers = [
                { status: 'completed' },
                { status: 'failed' },      // Legacy status
                { status: 'Failed' },      // Case variation
                { status: 'FAILED' }       // Case variation
            ];

            const result = batchStatusService.calculateStatusCounts(batchMembers);

            // All failed statuses should be mapped to error
            expect(result.error).to.equal(3);
            expect(result.completed).to.equal(1);
            expect(result.failed).to.be.undefined; // Should not exist
        });

        it('should handle empty batch members', () => {
            const result = batchStatusService.calculateStatusCounts([]);
            
            expect(result.total).to.equal(0);
            expect(Object.keys(result)).to.deep.equal(['total']);
        });

        it('should handle members with no status', () => {
            const batchMembers = [
                { status: 'completed' },
                { status: null },
                { status: undefined },
                { status: '' },
                { status: 'error' }
            ];

            const result = batchStatusService.calculateStatusCounts(batchMembers);

            expect(result.total).to.equal(5);
            expect(result.completed).to.equal(1);
            expect(result.error).to.equal(1);
            // Null/undefined/empty statuses should not be counted
        });
    });

    describe('createStatusSummary - Text Formatting', () => {
        it('should create status text with emojis for known statuses', () => {
            const counts: BatchStatusCounts = {
                total: 10,
                completed: 5,
                error: 2,
                pending: 3
            };

            const summary = batchStatusService.createStatusSummary(counts);

            expect(summary.statusText).to.include('✅ 5'); // Completed
            expect(summary.statusText).to.include('❌ 2'); // Error  
            expect(summary.statusText).to.include('⏳ 3'); // Pending
        });

        it('should handle unknown statuses with fallback emoji', () => {
            const counts: BatchStatusCounts = {
                total: 5,
                completed: 2,
                weird_status: 1,
                another_unknown: 2
            };

            const summary = batchStatusService.createStatusSummary(counts);

            expect(summary.statusText).to.include('✅ 2');  // Known status
            expect(summary.statusText).to.include('❓ 1');  // Unknown status fallback
            expect(summary.statusText).to.include('❓ 2');  // Another unknown status
        });

        it('should create completion text with status names', () => {
            const counts: BatchStatusCounts = {
                total: 8,
                completed: 5,
                error: 2,
                cancelled: 1
            };

            const summary = batchStatusService.createStatusSummary(counts);

            expect(summary.completionText).to.include('5 completed');
            expect(summary.completionText).to.include('2 error');
            expect(summary.completionText).to.include('1 cancelled');
        });

        it('should create tooltip lines with emojis and names', () => {
            const counts: BatchStatusCounts = {
                total: 7,
                completed: 4,
                error: 2,
                timeout: 1
            };

            const summary = batchStatusService.createStatusSummary(counts);

            expect(summary.tooltipLines).to.have.length(3);
            expect(summary.tooltipLines[0]).to.equal('✅ 4 completed');
            expect(summary.tooltipLines[1]).to.equal('❌ 2 error');
            expect(summary.tooltipLines[2]).to.equal('⏱️ 1 timeout'); // Known timeout status
        });

        it('should handle zero counts correctly', () => {
            const counts: BatchStatusCounts = {
                total: 0
            };

            const summary = batchStatusService.createStatusSummary(counts);

            expect(summary.statusText).to.equal('⏸️ 0'); // Default when no statuses
            expect(summary.completionText).to.equal('No results');
            expect(summary.tooltipLines).to.have.length(0);
        });
    });

    describe('getBatchStatusSummary - Integration Logic', () => {
        it('should handle batchMemberProgress data from BatchExecutionEngine', () => {
            const batchData = {
                batchMemberProgress: {
                    total: 10,
                    successful: 6,  // Legacy name
                    failed: 2,      // Legacy name
                    cancelled: 1,
                    pending: 1
                }
            };

            const summary = batchStatusService.getBatchStatusSummary(batchData);

            // Should map legacy names to current names
            expect(summary.statusText).to.include('✅ 6'); // successful → completed
            expect(summary.statusText).to.include('❌ 2'); // failed → error
            expect(summary.statusText).to.include('⚠️ 1'); // cancelled
            expect(summary.statusText).to.include('⏳ 1'); // pending
        });

        it('should calculate from batch members when no progress data', () => {
            const batchData = {
                batchMembers: [
                    { status: 'completed' },
                    { status: 'completed' },
                    { status: 'error' },
                    { status: 'pending' }
                ],
                totalMembers: 4
            };

            const summary = batchStatusService.getBatchStatusSummary(batchData);

            expect(summary.statusText).to.include('✅ 2'); // completed
            expect(summary.statusText).to.include('❌ 1'); // error
            expect(summary.statusText).to.include('⏳ 1'); // pending
        });

        it('should handle missing data gracefully', () => {
            const batchData = {
                totalMembers: 5
            };

            const summary = batchStatusService.getBatchStatusSummary(batchData);

            expect(summary.statusText).to.equal('⏸️ 0');
            expect(summary.completionText).to.equal('No results');
        });
    });
});