// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { ExecutionLoggingService } from '../../../../services/logging/execution-logging.service';
import { LogEvent } from '../../../../services/logging/execution-logging.interface';
import { createMockLogger } from '../../../helpers/logging/mock-logger';

describe('Unified Log Formatter (formatLogEventForDisplay)', () => {
    let loggingService: ExecutionLoggingService;

    beforeEach(() => {
        const mockLogger = createMockLogger();
        loggingService = new ExecutionLoggingService({}, mockLogger);
    });

    // Helper to access private method for testing
    const formatEvent = (executionId: string, event: LogEvent): string[] => {
        return (loggingService as any).formatLogEventForDisplay(executionId, event);
    };

    describe('Basic Formatting', () => {
        it('should format basic log events with emoji and execution ID', () => {
            const event: LogEvent = {
                timestamp: '2024-01-01T10:00:00.000Z',
                level: 'info',
                phase: 'execution',
                event: 'test_event'
            };

            const result = formatEvent('test-exec-12345678', event);
            
            expect(result).to.be.an('array');
            expect(result.length).to.be.greaterThan(0);
            expect(result[0]).to.include('✅'); // info emoji
            expect(result[0]).to.include('🚀'); // execution phase emoji
            expect(result[0]).to.include('[test-exe]'); // shortened execution ID
            expect(result[0]).to.include('test_event');
        });

        it('should use correct emojis for different log levels', () => {
            const levels: Array<{ level: LogEvent['level'], emoji: string }> = [
                { level: 'info', emoji: '✅' },
                { level: 'warn', emoji: '⚠️' },
                { level: 'error', emoji: '❌' },
                { level: 'debug', emoji: '🔍' }
            ];

            levels.forEach(({ level, emoji }) => {
                const event: LogEvent = {
                    timestamp: '2024-01-01T10:00:00.000Z',
                    level,
                    phase: 'general',
                    event: 'test_event'
                };

                const result = formatEvent('test-exec-12345678', event);
                expect(result[0]).to.include(emoji, `Expected ${emoji} for level ${level}`);
            });
        });

        it('should use correct emojis for different phases', () => {
            const phases: Array<{ phase: LogEvent['phase'], emoji: string }> = [
                { phase: 'preparation', emoji: '📦' },
                { phase: 'execution', emoji: '🚀' },
                { phase: 'orchestration', emoji: '🎯' },
                { phase: 'completion', emoji: '🏁' },
                { phase: 'test', emoji: '🧪' },
                { phase: 'general', emoji: '📋' }
            ];

            phases.forEach(({ phase, emoji }) => {
                const event: LogEvent = {
                    timestamp: '2024-01-01T10:00:00.000Z',
                    level: 'info',
                    phase,
                    event: 'test_event'
                };

                const result = formatEvent('test-exec-12345678', event);
                expect(result[0]).to.include(emoji, `Expected ${emoji} for phase ${phase}`);
            });
        });
    });

    describe('HTTP Request/Response Formatting', () => {
        it('should format HTTP request details with headers and body', () => {
            const event: LogEvent = {
                timestamp: '2024-01-01T10:00:00.000Z',
                level: 'info',
                phase: 'execution',
                event: 'http_request_sent',
                data: {
                    isMockExecution: false,
                    environment: 'prod',
                    organization: 'test-org',
                    requestFile: '/tmp/request.json'
                },
                http: {
                    method: 'POST',
                    url: 'https://api.test.com/data',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': '[REDACTED]'
                    },
                    queryParams: {
                        'limit': '10'
                    },
                    body: { test: 'data' }
                }
            };

            const result = formatEvent('test-exec-12345678', event);
            
            // Should have multiple lines for detailed HTTP info
            expect(result.length).to.be.greaterThan(3);
            
            // Main event line
            expect(result[0]).to.include('http_request_sent');
            
            // HTTP request line with live/mock indicator
            expect(result.find(line => line.includes('🌐 LIVE'))).to.exist;
            expect(result.find(line => line.includes('POST https://api.test.com/data'))).to.exist;
            
            // Environment info
            expect(result.find(line => line.includes('🏢 Env: prod'))).to.exist;
            expect(result.find(line => line.includes('Org: test-org'))).to.exist;
            
            // Headers
            expect(result.find(line => line.includes('📋 Headers:'))).to.exist;
            expect(result.find(line => line.includes('Content-Type: application/json'))).to.exist;
            expect(result.find(line => line.includes('Authorization: [REDACTED]'))).to.exist;
            
            // Query params
            expect(result.find(line => line.includes('🔍 Query Params:'))).to.exist;
            expect(result.find(line => line.includes('limit: 10'))).to.exist;
            
            // Request body
            expect(result.find(line => line.includes('📦 Request Body:'))).to.exist;
        });

        it('should indicate mock execution correctly', () => {
            const event: LogEvent = {
                timestamp: '2024-01-01T10:00:00.000Z',
                level: 'info',
                phase: 'execution',
                event: 'http_request_sent',
                data: {
                    isMockExecution: true
                },
                http: {
                    method: 'GET',
                    url: 'https://api.test.com/status'
                }
            };

            const result = formatEvent('test-exec-12345678', event);
            expect(result.find(line => line.includes('🎭 MOCK'))).to.exist;
        });

        it('should format HTTP response with status and duration', () => {
            const event: LogEvent = {
                timestamp: '2024-01-01T10:00:00.000Z',
                level: 'info',
                phase: 'execution',
                event: 'http_response_received',
                data: {
                    responseData: { success: true, id: 123 }
                },
                http: {
                    status: 200,
                    statusText: 'OK',
                    duration: 1500,
                    size: 2048
                }
            };

            const result = formatEvent('test-exec-12345678', event);
            
            expect(result.find(line => line.includes('✅ Response: 200 OK'))).to.exist;
            expect(result.find(line => line.includes('⏱️ 1500ms'))).to.exist;
            expect(result.find(line => line.includes('(2KB)'))).to.exist;
            expect(result.find(line => line.includes('📄 Response Data:'))).to.exist;
        });

        it('should show appropriate status emojis for different HTTP status codes', () => {
            const statuses = [
                { code: 200, emoji: '✅' },
                { code: 404, emoji: '❌' },
                { code: 301, emoji: '⚠️' }
            ];

            statuses.forEach(({ code, emoji }) => {
                const event: LogEvent = {
                    timestamp: '2024-01-01T10:00:00.000Z',
                    level: 'info',
                    phase: 'execution',
                    event: 'http_response_received',
                    http: { status: code }
                };

                const result = formatEvent('test-exec-12345678', event);
                expect(result.find(line => line.includes(emoji))).to.exist;
            });
        });
    });

    describe('Special Event Formatting', () => {
        it('should format transaction_created events with file paths', () => {
            const event: LogEvent = {
                timestamp: '2024-01-01T10:00:00.000Z',
                level: 'info',
                phase: 'preparation',
                event: 'transaction_created',
                data: {
                    endpointName: 'Test API',
                    fileName: 'request.json',
                    directoryPath: '/tmp/executions/batch-123'
                }
            };

            const result = formatEvent('test-exec-12345678', event);
            
            expect(result.find(line => line.includes('📝 Transaction: Test API'))).to.exist;
            expect(result.find(line => line.includes('📁 Request File: /tmp/executions/batch-123/request.json'))).to.exist;
        });

        it('should format execution_started events', () => {
            const event: LogEvent = {
                timestamp: '2024-01-01T10:00:00.000Z',
                level: 'info',
                phase: 'execution',
                event: 'execution_started',
                data: {
                    endpointName: 'Data API',
                    requestFile: '/tmp/request.json'
                }
            };

            const result = formatEvent('test-exec-12345678', event);
            
            expect(result.find(line => line.includes('🏃 Starting: Data API'))).to.exist;
            expect(result.find(line => line.includes('📁 Request File: /tmp/request.json'))).to.exist;
        });

        it('should format execution_completed events with response file', () => {
            const event: LogEvent = {
                timestamp: '2024-01-01T10:00:00.000Z',
                level: 'info',
                phase: 'completion',
                event: 'execution_completed',
                data: {
                    executionStatus: 'completed',
                    totalDuration: 2500,
                    responseFile: '/tmp/response.json'
                }
            };

            const result = formatEvent('test-exec-12345678', event);
            
            expect(result.find(line => line.includes('✅ Execution completed in 2500ms'))).to.exist;
            expect(result.find(line => line.includes('📄 Response File: /tmp/response.json'))).to.exist;
        });

        it('should format batch execution events', () => {
            const batchStartEvent: LogEvent = {
                timestamp: '2024-01-01T10:00:00.000Z',
                level: 'info',
                phase: 'orchestration',
                event: 'batch_execution_started',
                data: {
                    endpointName: 'Bulk Insert API',
                    totalMembers: 5
                }
            };

            const result = formatEvent('batch-exec-12345678', batchStartEvent);
            expect(result.find(line => line.includes('💫 Batch: Bulk Insert API (5 members)'))).to.exist;
        });

        it('should format simple message events', () => {
            const event: LogEvent = {
                timestamp: '2024-01-01T10:00:00.000Z',
                level: 'info',
                phase: 'general',
                event: 'message',
                data: { message: 'Custom log message' }
            };

            const result = formatEvent('test-exec-12345678', event);
            expect(result.find(line => line.includes('💬 Custom log message'))).to.exist;
        });
    });

    describe('Error Handling', () => {
        it('should format error events with error details', () => {
            const event: LogEvent = {
                timestamp: '2024-01-01T10:00:00.000Z',
                level: 'error',
                phase: 'execution',
                event: 'http_request_failed',
                error: {
                    message: 'Connection timeout',
                    code: 'TIMEOUT',
                    httpStatus: 408
                }
            };

            const result = formatEvent('test-exec-12345678', event);
            
            expect(result[0]).to.include('❌'); // error emoji
            expect(result[0]).to.include('ERROR: Connection timeout');
            expect(result[0]).to.include('(TIMEOUT)');
        });
    });

    describe('Edge Cases', () => {
        it('should handle events with minimal data', () => {
            const event: LogEvent = {
                timestamp: '2024-01-01T10:00:00.000Z',
                level: 'info',
                phase: 'general',
                event: 'minimal_event'
            };

            const result = formatEvent('test-exec-12345678', event);
            expect(result).to.have.length.greaterThan(0);
            expect(result[0]).to.include('minimal_event');
        });

        it('should truncate large request bodies', () => {
            const largeBody = 'x'.repeat(1000); // Large body > 500 chars
            const event: LogEvent = {
                timestamp: '2024-01-01T10:00:00.000Z',
                level: 'info',
                phase: 'execution',
                event: 'http_request_sent',
                http: {
                    body: largeBody
                }
            };

            const result = formatEvent('test-exec-12345678', event);
            const bodyLine = result.find(line => line.includes('📦 Request Body Preview'));
            expect(bodyLine).to.exist;
            expect(result.find(line => line.includes('chars total'))).to.exist;
        });

        it('should handle missing execution ID gracefully', () => {
            const event: LogEvent = {
                timestamp: '2024-01-01T10:00:00.000Z',
                level: 'info',
                phase: 'general',
                event: 'test_event'
            };

            const result = formatEvent('', event);
            expect(result).to.have.length.greaterThan(0);
        });
    });

    describe('Progress Information', () => {
        it('should format batch progress information', () => {
            const event: LogEvent = {
                timestamp: '2024-01-01T10:00:00.000Z',
                level: 'info',
                phase: 'orchestration',
                event: 'batch_progress_update',
                data: {
                    progress: {
                        completed: 3,
                        total: 10
                    }
                }
            };

            const result = formatEvent('batch-exec-12345678', event);
            expect(result[0]).to.include('[3/10]');
        });
    });
});