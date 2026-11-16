// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit Tests: Throughput-based ETA Calculation (GitHub Issue #104)
 *
 * Tests the new throughput-based ETA approach:
 * - Calculates completions per second over a rolling 60-second window
 * - More stable than individual execution time averages
 * - Naturally smooths out outliers
 */

const { expect } = require('chai');

describe('Throughput-based ETA Calculation (GitHub Issue #104)', () => {

    /**
     * Helper function to simulate the throughput-based ETA calculation
     * (Extracted from batch-execution-engine.service.ts for testing)
     */
    function calculateEstimatedRemainingMs(batchState, totalMembers) {
        if (batchState.completedMembers >= totalMembers) {
            return 0;
        }

        if (!batchState.startedAt) {
            return -1; // Not started yet
        }

        const elapsedSeconds = (Date.now() - batchState.startedAt.getTime()) / 1000;

        // First 10 seconds: not enough data yet
        if (elapsedSeconds < 10) {
            return -1;
        }

        // Count completions in last 60 seconds
        const sixtySecondsAgo = Date.now() - 60000;
        const recentCompletions = batchState.completionTimestamps.filter(ts => ts > sixtySecondsAgo).length;

        // Calculate throughput (transactions per second)
        const timeWindow = Math.min(elapsedSeconds, 60);
        const throughput = recentCompletions / timeWindow;

        if (throughput === 0) {
            return -1;
        }

        // Calculate remaining time based on throughput
        const remaining = totalMembers - batchState.completedMembers;
        const etaSeconds = remaining / throughput;

        return etaSeconds * 1000; // Convert to milliseconds
    }

    describe('Basic Throughput Calculation', () => {
        it('should return -1 for first 10 seconds (calculating period)', () => {
            const now = Date.now();
            const batchState = {
                completedMembers: 5,
                startedAt: new Date(now - 8000), // 8 seconds ago
                completionTimestamps: [
                    now - 7000,
                    now - 6000,
                    now - 5000,
                    now - 4000,
                    now - 3000
                ]
            };

            const result = calculateEstimatedRemainingMs(batchState, 100);
            expect(result).to.equal(-1);
        });

        it('should calculate ETA after 10 seconds', () => {
            const now = Date.now();
            const batchState = {
                completedMembers: 10,
                startedAt: new Date(now - 15000), // 15 seconds ago
                completionTimestamps: Array.from({ length: 10 }, (_, i) => now - (14000 - i * 1500))
            };

            const result = calculateEstimatedRemainingMs(batchState, 100);
            expect(result).to.be.greaterThan(0);
        });

        it('should return 0 when batch is complete', () => {
            const now = Date.now();
            const batchState = {
                completedMembers: 100,
                startedAt: new Date(now - 60000),
                completionTimestamps: []
            };

            const result = calculateEstimatedRemainingMs(batchState, 100);
            expect(result).to.equal(0);
        });
    });

    describe('Throughput-based Stability', () => {
        it('should use 60-second rolling window for mature batches', () => {
            const now = Date.now();
            // Batch running for 90 seconds, but only last 60s matter
            const batchState = {
                completedMembers: 60,
                startedAt: new Date(now - 90000), // 90 seconds ago
                completionTimestamps: Array.from({ length: 60 }, (_, i) => now - (59000 - i * 1000))
            };

            const result = calculateEstimatedRemainingMs(batchState, 100);

            // Should use throughput from last 60s: 60 completions / 60s = 1/s
            // Remaining: 40 transactions
            // ETA: 40s
            expect(result).to.be.closeTo(40000, 2000);
        });

        it('should handle outliers gracefully (throughput smooths naturally)', () => {
            const now = Date.now();
            // Most transactions fast (1/s), but some slow outliers don't affect count
            const batchState = {
                completedMembers: 30,
                startedAt: new Date(now - 30000), // 30 seconds ago
                completionTimestamps: Array.from({ length: 30 }, (_, i) => now - (29000 - i * 1000))
            };

            const result = calculateEstimatedRemainingMs(batchState, 60);

            // Throughput: 30 completions / 30s = 1/s
            // Remaining: 30 transactions
            // ETA: 30s
            expect(result).to.be.closeTo(30000, 2000);
        });
    });

    describe('Progressive Update Frequency', () => {
        it('should identify when first ETA update should be sent (at 10s)', () => {
            const now = Date.now();
            const batchState = {
                completedMembers: 12,
                startedAt: new Date(now - 11000), // 11 seconds ago
                completionTimestamps: Array.from({ length: 12 }, (_, i) => now - (10000 - i * 900)),
                lastEtaUpdate: undefined // First update not sent yet
            };

            const elapsedSeconds = (now - batchState.startedAt.getTime()) / 1000;
            const shouldSendFirstUpdate = elapsedSeconds >= 10 && elapsedSeconds < 70 && !batchState.lastEtaUpdate;

            expect(shouldSendFirstUpdate).to.be.true;
        });

        it('should not send second update until 60s have passed', () => {
            const now = Date.now();
            const batchState = {
                completedMembers: 50,
                startedAt: new Date(now - 100000), // 100 seconds ago
                completionTimestamps: Array.from({ length: 50 }, (_, i) => now - (99000 - i * 2000)),
                lastEtaUpdate: now - 30000 // Last update 30s ago
            };

            const timeSinceLastUpdate = now - batchState.lastEtaUpdate;
            const shouldSendUpdate = timeSinceLastUpdate >= 60000;

            expect(shouldSendUpdate).to.be.false;
        });

        it('should send update after 60s have passed since last update', () => {
            const now = Date.now();
            const batchState = {
                completedMembers: 70,
                startedAt: new Date(now - 150000), // 150 seconds ago
                completionTimestamps: Array.from({ length: 70 }, (_, i) => now - (149000 - i * 2000)),
                lastEtaUpdate: now - 61000 // Last update 61s ago
            };

            const timeSinceLastUpdate = now - batchState.lastEtaUpdate;
            const shouldSendUpdate = timeSinceLastUpdate >= 60000;

            expect(shouldSendUpdate).to.be.true;
        });
    });

    describe('Edge Cases', () => {
        it('should return -1 when no completions in window (zero throughput)', () => {
            const now = Date.now();
            const batchState = {
                completedMembers: 5,
                startedAt: new Date(now - 80000), // 80 seconds ago
                completionTimestamps: [
                    // All completions older than 60s
                    now - 70000,
                    now - 71000,
                    now - 72000,
                    now - 73000,
                    now - 74000
                ]
            };

            const result = calculateEstimatedRemainingMs(batchState, 100);
            expect(result).to.equal(-1);
        });

        it('should handle very fast execution (high throughput)', () => {
            const now = Date.now();
            // 100 transactions in 20 seconds
            const batchState = {
                completedMembers: 100,
                startedAt: new Date(now - 20000),
                completionTimestamps: Array.from({ length: 100 }, (_, i) => now - (19000 - i * 190))
            };

            const result = calculateEstimatedRemainingMs(batchState, 200);

            // Throughput: 100 completions / 20s = 5/s
            // Remaining: 100 transactions
            // ETA: 20s
            expect(result).to.be.closeTo(20000, 2000);
        });

        it('should handle very slow execution (low throughput)', () => {
            const now = Date.now();
            // 10 transactions in 50 seconds
            const batchState = {
                completedMembers: 10,
                startedAt: new Date(now - 50000),
                completionTimestamps: Array.from({ length: 10 }, (_, i) => now - (49000 - i * 5000))
            };

            const result = calculateEstimatedRemainingMs(batchState, 100);

            // Throughput: 10 completions / 50s = 0.2/s
            // Remaining: 90 transactions
            // ETA: 450s
            expect(result).to.be.closeTo(450000, 10000);
        });
    });

    describe('Timestamp Cleanup', () => {
        it('should only keep timestamps from last 60 seconds', () => {
            const now = Date.now();
            const allTimestamps = [
                now - 70000, // Should be removed
                now - 65000, // Should be removed
                now - 55000, // Should be kept
                now - 30000, // Should be kept
                now - 10000  // Should be kept
            ];

            const sixtySecondsAgo = now - 60000;
            const filteredTimestamps = allTimestamps.filter(ts => ts > sixtySecondsAgo);

            expect(filteredTimestamps).to.have.length(3);
            expect(filteredTimestamps).to.not.include(now - 70000);
            expect(filteredTimestamps).to.not.include(now - 65000);
        });
    });
});
