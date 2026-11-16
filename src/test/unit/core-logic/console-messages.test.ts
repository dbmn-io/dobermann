// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for console message types and type guards
 * GitHub Issue #166: RAW tab message types
 */
import { expect } from 'chai';
import {
    ConsoleMessageTypes,
    isGetRawTabDataRequest,
    isGetRawTransactionContentRequest,
    isGetTransactionLogRequest,
    isRawTabDataResponse,
    RawTransactionSummary
} from '../../../types/console-messages';
import { BaseMessage } from '../../../types/base-message';

// Helper to create minimal valid BaseMessage for testing type guards
function createTestMessage(type: string, payload: any = {}): BaseMessage {
    return {
        type,
        correlationId: 'test-123',
        timestamp: Date.now(),
        source: 'webview',
        target: 'extension',
        payload
    };
}

describe('Console Messages - RAW Tab (GitHub Issue #166)', () => {

    describe('Message Type Constants', () => {
        it('should have GET_RAW_TAB_DATA message type', () => {
            expect(ConsoleMessageTypes.GET_RAW_TAB_DATA).to.equal('console.get_raw_tab_data');
        });

        it('should have GET_RAW_TRANSACTION_CONTENT message type', () => {
            expect(ConsoleMessageTypes.GET_RAW_TRANSACTION_CONTENT).to.equal('console.get_raw_transaction_content');
        });

        it('should have RAW_TAB_DATA_RESPONSE message type', () => {
            expect(ConsoleMessageTypes.RAW_TAB_DATA_RESPONSE).to.equal('console.raw_tab_data_response');
        });

        it('should have RAW_TRANSACTION_CONTENT_RESPONSE message type', () => {
            expect(ConsoleMessageTypes.RAW_TRANSACTION_CONTENT_RESPONSE).to.equal('console.raw_transaction_content_response');
        });

        it('should have GET_TRANSACTION_LOG message type', () => {
            expect(ConsoleMessageTypes.GET_TRANSACTION_LOG).to.equal('console.get_transaction_log');
        });

        it('should have TRANSACTION_LOG_RESPONSE message type', () => {
            expect(ConsoleMessageTypes.TRANSACTION_LOG_RESPONSE).to.equal('console.transaction_log_response');
        });
    });

    describe('isGetRawTabDataRequest type guard', () => {
        it('should return true for valid GetRawTabDataRequest', () => {
            const message = createTestMessage(ConsoleMessageTypes.GET_RAW_TAB_DATA, {
                batchId: 'batch-456'
            });
            expect(isGetRawTabDataRequest(message)).to.be.true;
        });

        it('should return false for different message type', () => {
            const message = createTestMessage('some.other.type', {});
            expect(isGetRawTabDataRequest(message)).to.be.false;
        });
    });

    describe('isGetRawTransactionContentRequest type guard', () => {
        it('should return true for valid GetRawTransactionContentRequest', () => {
            const message = createTestMessage(ConsoleMessageTypes.GET_RAW_TRANSACTION_CONTENT, {
                executionIds: ['exec-1', 'exec-2', 'exec-3']
            });
            expect(isGetRawTransactionContentRequest(message)).to.be.true;
        });

        it('should return false for different message type', () => {
            const message = createTestMessage(ConsoleMessageTypes.GET_RAW_TAB_DATA, {
                executionIds: []
            });
            expect(isGetRawTransactionContentRequest(message)).to.be.false;
        });
    });

    describe('isGetTransactionLogRequest type guard', () => {
        it('should return true for valid GetTransactionLogRequest', () => {
            const message = createTestMessage(ConsoleMessageTypes.GET_TRANSACTION_LOG, {
                executionId: 'exec-456',
                transactionIndex: 1,
                logFilePath: '/path/to/log.log'
            });
            expect(isGetTransactionLogRequest(message)).to.be.true;
        });

        it('should return false for different message type', () => {
            const message = createTestMessage('console.something_else', {
                executionId: 'exec-456'
            });
            expect(isGetTransactionLogRequest(message)).to.be.false;
        });
    });

    describe('isRawTabDataResponse type guard', () => {
        it('should return true for valid RawTabDataResponse', () => {
            const message = createTestMessage(ConsoleMessageTypes.RAW_TAB_DATA_RESPONSE, {
                transactions: [
                    {
                        executionId: 'exec-1',
                        status: 'COMPLETED',
                        httpStatus: '200',
                        hasRequest: true,
                        hasResponse: true,
                        rowStart: 0,
                        rows: '3'
                    }
                ],
                totalCount: 1
            });
            expect(isRawTabDataResponse(message)).to.be.true;
        });

        it('should return false for request message types', () => {
            const message = createTestMessage(ConsoleMessageTypes.GET_RAW_TAB_DATA, {});
            expect(isRawTabDataResponse(message)).to.be.false;
        });
    });

    describe('RawTransactionSummary interface', () => {
        it('should include rowStart and rows fields for CSV data mapping', () => {
            // This tests the interface structure by creating a valid object
            const summary: RawTransactionSummary = {
                executionId: 'exec-123',
                status: 'COMPLETED',
                httpStatus: '200',
                timestamp: '2026-02-03T10:20:30Z',
                hasRequest: true,
                hasResponse: true,
                rowStart: 0,
                rows: '5'
            };

            // Verify fields exist and have correct values
            expect(summary.rowStart).to.equal(0);
            expect(summary.rows).to.equal('5');
            expect(summary.executionId).to.equal('exec-123');
        });

        it('should allow optional timestamp field', () => {
            const summary: RawTransactionSummary = {
                executionId: 'exec-123',
                status: 'ERROR',
                httpStatus: '400',
                hasRequest: true,
                hasResponse: true,
                rowStart: 10,
                rows: '2'
                // timestamp is optional, not included
            };

            expect(summary.timestamp).to.be.undefined;
            expect(summary.rowStart).to.equal(10);
        });

        it('should support string httpStatus for non-numeric statuses', () => {
            // httpStatus can be string (e.g., 'N/A', 'ERROR') or numeric string
            const summary: RawTransactionSummary = {
                executionId: 'exec-123',
                status: 'FAILED',
                httpStatus: 'N/A',
                hasRequest: true,
                hasResponse: false,
                rowStart: 0,
                rows: '1'
            };

            expect(summary.httpStatus).to.equal('N/A');
        });
    });
});
