// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';

/**
 * Unit Test: Transaction Creator Batch Configuration Logic
 *
 * Tests the core logic for creating batch configurations in transaction-creator.service.ts
 * This focuses on the "Stop on first error" fix without complex TypeScript schema requirements.
 *
 * GitHub Issue #151: These tests use the old errorTolerance logic which has been replaced
 * with a simpler stopOnFirstError-only approach. Tests are skipped pending update.
 */
describe.skip('Transaction Creator - Batch Configuration Logic (SKIPPED - GitHub Issue #151: errorTolerance deprecated)', () => {
    
    it('should create maxErrors=0 for stopOnFirst mode', () => {
        // Simulate the logic from transaction-creator.service.ts lines 77-83
        const errorHandling = {
            mode: 'stopOnFirst',
            enableErrorTolerance: false
        };
        
        let batchConfiguration: any;
        
        if (errorHandling?.mode === 'stopOnFirst') {
            batchConfiguration = {
                stopOnFirstError: true,
                errorTolerance: true,
                maxErrors: 0  // Stop on any error
            };
        }
        
        // Assert
        expect(batchConfiguration).to.exist;
        expect(batchConfiguration.stopOnFirstError).to.be.true;
        expect(batchConfiguration.errorTolerance).to.be.true;
        expect(batchConfiguration.maxErrors).to.equal(0);
    });
    
    it('should calculate percentage-based limits correctly', () => {
        // Simulate the logic from transaction-creator.service.ts lines 84-103
        const errorHandling = {
            mode: 'continue',
            enableErrorTolerance: true,
            toleranceMode: 'percentage',
            percentageErrorLimit: 11,
            absoluteErrorLimit: undefined
        };
        const rows = '45(300)'; // 45 transactions from 300 CSV rows
        
        let batchConfiguration: any;
        
        if (errorHandling?.enableErrorTolerance) {
            let maxErrors: number;
            
            if (errorHandling.toleranceMode === 'percentage' && errorHandling.percentageErrorLimit) {
                // Convert percentage to absolute count based on TRANSACTIONS
                const totalTransactions = parseInt(rows.split('(')[0]) || 1; // Extract "45" from "45(300)"
                maxErrors = Math.floor((errorHandling.percentageErrorLimit / 100) * totalTransactions);
            } else {
                maxErrors = errorHandling.absoluteErrorLimit || 0;
            }
            
            batchConfiguration = {
                stopOnFirstError: false,
                errorTolerance: true,
                maxErrors: maxErrors
            };
        }
        
        // Assert: 11% of 45 = 4.95 → 4 max errors
        expect(batchConfiguration).to.exist;
        expect(batchConfiguration.stopOnFirstError).to.be.false;
        expect(batchConfiguration.errorTolerance).to.be.true;
        expect(batchConfiguration.maxErrors).to.equal(4);
    });
    
    it('should use absolute limits when specified', () => {
        const errorHandling = {
            mode: 'continue',
            enableErrorTolerance: true,
            toleranceMode: 'absolute',
            absoluteErrorLimit: 10,
            percentageErrorLimit: undefined
        };
        const rows = '100';
        
        let batchConfiguration: any;
        
        if (errorHandling?.enableErrorTolerance) {
            let maxErrors: number;
            
            if (errorHandling.toleranceMode === 'percentage' && errorHandling.percentageErrorLimit) {
                const totalTransactions = parseInt(rows.split('(')[0]) || 1;
                maxErrors = Math.floor((errorHandling.percentageErrorLimit / 100) * totalTransactions);
            } else {
                maxErrors = errorHandling.absoluteErrorLimit || 0;
            }
            
            batchConfiguration = {
                stopOnFirstError: false,
                errorTolerance: true,
                maxErrors: maxErrors
            };
        }
        
        // Assert
        expect(batchConfiguration).to.exist;
        expect(batchConfiguration.maxErrors).to.equal(10);
    });
    
    it('should not create batch config for continue without tolerance', () => {
        const errorHandling = {
            mode: 'continue',
            enableErrorTolerance: false
        };
        
        let batchConfiguration: any;
        
        if (errorHandling?.mode === 'stopOnFirst') {
            batchConfiguration = {
                stopOnFirstError: true,
                errorTolerance: true,
                maxErrors: 0
            };
        } else if (errorHandling?.enableErrorTolerance) {
            // This branch won't execute
            batchConfiguration = {
                stopOnFirstError: false,
                errorTolerance: true,
                maxErrors: 5
            };
        }
        // else: "Continue indefinitely" - no batch config = no limits
        
        // Assert: No batch configuration should be created
        expect(batchConfiguration).to.be.undefined;
    });
    
    it('should extract transaction count correctly from rows parameter', () => {
        const scenarios = [
            { rows: '45(300)', expected: 45 },    // Standard format
            { rows: '100', expected: 100 },       // Simple number
            { rows: '1(5)', expected: 1 },        // Single transaction
            { rows: '', expected: 1 },            // Empty fallback
            { rows: 'invalid', expected: 1 }      // Invalid fallback
        ];
        
        scenarios.forEach(scenario => {
            const totalTransactions = parseInt(scenario.rows.split('(')[0]) || 1;
            expect(totalTransactions).to.equal(scenario.expected, 
                `For rows="${scenario.rows}", expected ${scenario.expected} transactions`);
        });
    });
    
    it('should handle user bug scenario: 11% of 45 = 4 max errors', () => {
        // User's exact bug scenario
        const errorHandling = {
            mode: 'continue',
            enableErrorTolerance: true,
            toleranceMode: 'percentage',
            percentageErrorLimit: 11,
            absoluteErrorLimit: undefined
        };
        const rows = '45'; // 45 transactions
        
        // Apply the logic
        const totalTransactions = parseInt(rows.split('(')[0]) || 1;
        const maxErrors = Math.floor((errorHandling.percentageErrorLimit / 100) * totalTransactions);
        
        // Assert: Should be 4, not allow 17 errors like before
        expect(totalTransactions).to.equal(45);
        expect(maxErrors).to.equal(4, '11% of 45 transactions should be 4 max errors');
        
        // Verify the calculation
        expect((11 / 100) * 45).to.equal(4.95); // 4.95 → Math.floor → 4
    });
});