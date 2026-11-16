// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ExecutionLoggingService } from '../../../../services/logging/execution-logging.service';
import { LogEvent, LogQueryFilters } from '../../../../services/logging/execution-logging.interface';
import { createMockLogger } from '../../../helpers/logging/mock-logger';
import { readRunFile, runFileExists } from '../../../../services/run-content/run-content-store';

describe('ExecutionLoggingService', () => {
    let service: ExecutionLoggingService;
    let tempDir: string;
    let mockExecutionMetadataService: any;
    let mockExtensionContext: any;

    beforeEach(async () => {
        // Create temporary directory for test files
        tempDir = path.join(__dirname, 'temp-logs');
        await fs.mkdir(tempDir, { recursive: true });

        // Mock extension context
        mockExtensionContext = {
            storageUri: vscode.Uri.file(tempDir)
        } as vscode.ExtensionContext;

        // Mock execution metadata service
        mockExecutionMetadataService = {
            getExecution: async (executionId: string) => ({
                id: executionId,
                requestFile: path.join(tempDir, `${executionId}-request.json`),
                endpointName: 'Test Endpoint'
            })
        };

        // Initialize service
        const mockLogger = createMockLogger();
        service = new ExecutionLoggingService({
            executionMetadataService: mockExecutionMetadataService
        }, mockLogger);
    });

    afterEach(async () => {
        // Clean up temp directory
        try {
            await fs.rm(tempDir, { recursive: true, force: true });   // rmdir's recursive option is gone in newer Node
        } catch (error) {
            // Ignore cleanup errors
        }
    });

    describe('createLogFile', () => {
        it('should create a log file with proper naming convention', async () => {
            const executionId = 'test-exec-123';
            const requestFile = path.join(tempDir, 'test-request.json');
            
            // Create the request file
            await fs.writeFile(requestFile, '{}');

            const logPath = await service.createLogFile(executionId, requestFile);

            // Check file naming convention
            expect(logPath).to.equal(path.join(tempDir, 'test-request.log'));
            
            // Check file was created
            const fileExists = runFileExists(logPath);   // #358: in the run folder's content archive
            expect(fileExists).to.be.true;

            // Check initial log entry was written
            const content = readRunFile(logPath);
            const lines = content.trim().split('\n');
            expect(lines).to.have.length(1);

            const initialLog = JSON.parse(lines[0]);
            expect(initialLog).to.deep.include({
                level: 'info',
                phase: 'preparation',
                event: 'log_file_created'
            });
            expect(initialLog.data).to.deep.include({
                executionId,
                requestFile,
                logPath
            });
        });

        it('should create directory if it does not exist', async () => {
            const executionId = 'test-exec-456';
            const nestedDir = path.join(tempDir, 'nested', 'deeper');
            const requestFile = path.join(nestedDir, 'test-request.json');

            await service.createLogFile(executionId, requestFile);

            const logPath = path.join(nestedDir, 'test-request.log');
            const fileExists = runFileExists(logPath);   // #358: in the run folder's content archive
            expect(fileExists).to.be.true;
        });
    });

    describe('logEvent', () => {
        it('should write log events in JSON Lines format', async () => {
            const logPath = path.join(tempDir, 'test.log');
            
            const event1: LogEvent = {
                timestamp: '2024-01-01T10:00:00.000Z',
                level: 'info',
                phase: 'execution',
                event: 'test_event_1',
                data: { key: 'value1' }
            };

            const event2: LogEvent = {
                timestamp: '2024-01-01T10:00:01.000Z',
                level: 'error',
                phase: 'completion',
                event: 'test_event_2',
                error: { message: 'Test error', code: 'TEST_ERROR' }
            };

            await service.logEvent(logPath, event1);
            await service.logEvent(logPath, event2);

            const content = readRunFile(logPath);
            const lines = content.trim().split('\n');
            expect(lines).to.have.length(2);

            const parsedEvent1 = JSON.parse(lines[0]);
            expect(parsedEvent1).to.deep.equal(event1);

            const parsedEvent2 = JSON.parse(lines[1]);
            expect(parsedEvent2).to.deep.equal(event2);
        });

        it('should not throw errors when logging fails', async () => {
            const invalidLogPath = '/invalid/path/test.log';
            
            const event: LogEvent = {
                timestamp: '2024-01-01T10:00:00.000Z',
                level: 'info',
                phase: 'execution',
                event: 'test_event'
            };

            // Should not throw - we expect this to succeed silently
            let errorThrown = false;
            try {
                await service.logEvent(invalidLogPath, event);
            } catch (error) {
                errorThrown = true;
            }
            expect(errorThrown).to.be.false;
        });
    });

    describe('getLogsFromFile', () => {
        it('should read and parse JSON Lines format', async () => {
            const logPath = path.join(tempDir, 'test-read.log');
            
            const events = [
                { timestamp: '2024-01-01T10:00:00.000Z', level: 'info', phase: 'execution', event: 'event1' },
                { timestamp: '2024-01-01T10:00:01.000Z', level: 'warn', phase: 'execution', event: 'event2' },
                { timestamp: '2024-01-01T10:00:02.000Z', level: 'error', phase: 'completion', event: 'event3' }
            ];

            // Write test data
            const content = events.map(e => JSON.stringify(e)).join('\n');
            await fs.writeFile(logPath, content);

            const readEvents = await service.getLogsFromFile(logPath);
            expect(readEvents).to.have.length(3);
            expect(readEvents).to.deep.equal(events);
        });

        it('should apply level filters correctly', async () => {
            const logPath = path.join(tempDir, 'test-filter.log');
            
            const events = [
                { timestamp: '2024-01-01T10:00:00.000Z', level: 'info', phase: 'execution', event: 'event1' },
                { timestamp: '2024-01-01T10:00:01.000Z', level: 'error', phase: 'execution', event: 'event2' },
                { timestamp: '2024-01-01T10:00:02.000Z', level: 'info', phase: 'completion', event: 'event3' }
            ];

            const content = events.map(e => JSON.stringify(e)).join('\n');
            await fs.writeFile(logPath, content);

            const filters: LogQueryFilters = { level: 'error' };
            const readEvents = await service.getLogsFromFile(logPath, filters);
            
            expect(readEvents).to.have.length(1);
            expect(readEvents[0].event).to.equal('event2');
        });

        it('should apply phase filters correctly', async () => {
            const logPath = path.join(tempDir, 'test-phase-filter.log');
            
            const events = [
                { timestamp: '2024-01-01T10:00:00.000Z', level: 'info', phase: 'preparation', event: 'event1' },
                { timestamp: '2024-01-01T10:00:01.000Z', level: 'info', phase: 'execution', event: 'event2' },
                { timestamp: '2024-01-01T10:00:02.000Z', level: 'info', phase: 'execution', event: 'event3' }
            ];

            const content = events.map(e => JSON.stringify(e)).join('\n');
            await fs.writeFile(logPath, content);

            const filters: LogQueryFilters = { phase: 'execution' };
            const readEvents = await service.getLogsFromFile(logPath, filters);
            
            expect(readEvents).to.have.length(2);
            expect(readEvents[0].event).to.equal('event2');
            expect(readEvents[1].event).to.equal('event3');
        });

        it('should apply limit and offset pagination', async () => {
            const logPath = path.join(tempDir, 'test-pagination.log');
            
            const events = Array.from({ length: 10 }, (_, i) => ({
                timestamp: `2024-01-01T10:00:${i.toString().padStart(2, '0')}.000Z`,
                level: 'info',
                phase: 'execution',
                event: `event${i}`
            }));

            const content = events.map(e => JSON.stringify(e)).join('\n');
            await fs.writeFile(logPath, content);

            const filters: LogQueryFilters = { limit: 3, offset: 2 };
            const readEvents = await service.getLogsFromFile(logPath, filters);
            
            expect(readEvents).to.have.length(3);
            expect(readEvents[0].event).to.equal('event2');
            expect(readEvents[1].event).to.equal('event3');
            expect(readEvents[2].event).to.equal('event4');
        });

        it('should handle malformed JSON lines gracefully', async () => {
            const logPath = path.join(tempDir, 'test-malformed.log');
            
            const content = [
                '{"timestamp":"2024-01-01T10:00:00.000Z","level":"info","phase":"execution","event":"valid"}',
                'invalid json line',
                '{"timestamp":"2024-01-01T10:00:01.000Z","level":"info","phase":"execution","event":"valid2"}'
            ].join('\n');
            
            await fs.writeFile(logPath, content);

            const readEvents = await service.getLogsFromFile(logPath);
            expect(readEvents).to.have.length(2);
            expect(readEvents[0].event).to.equal('valid');
            expect(readEvents[1].event).to.equal('valid2');
        });

        it('should return empty array for non-existent files', async () => {
            const nonExistentPath = path.join(tempDir, 'non-existent.log');
            const readEvents = await service.getLogsFromFile(nonExistentPath);
            expect(readEvents).to.deep.equal([]);
        });
    });

    describe('logExecutionEvent', () => {
        it('should log event for execution with cached log path', async () => {
            const executionId = 'test-exec-789';
            const requestFile = path.join(tempDir, 'cached-request.json');
            
            // Create log file to establish cache
            const logPath = await service.createLogFile(executionId, requestFile);
            
            const event: LogEvent = {
                timestamp: '2024-01-01T10:00:00.000Z',
                level: 'info',
                phase: 'execution',
                event: 'test_execution_event',
                data: { test: 'data' }
            };

            await service.logExecutionEvent(executionId, event);

            // Read back and verify
            const content = readRunFile(logPath);
            const lines = content.trim().split('\n');
            expect(lines).to.have.length(2); // Initial + our event
            
            const loggedEvent = JSON.parse(lines[1]);
            // logExecutionEvent tags each event with its execution, so a batch log can say whose it is
            expect(loggedEvent).to.deep.equal({ ...event, data: { ...event.data, executionId } });
        });

        it('should handle missing execution gracefully', async () => {
            const executionId = 'non-existent-exec';
            
            const event: LogEvent = {
                timestamp: '2024-01-01T10:00:00.000Z',
                level: 'info',
                phase: 'execution',
                event: 'test_event'
            };

            // Should not throw - we expect this to succeed silently  
            let errorThrown = false;
            try {
                await service.logExecutionEvent(executionId, event);
            } catch (error) {
                errorThrown = true;
            }
            expect(errorThrown).to.be.false;
        });
    });

    describe('getLogPath', () => {
        it('should return cached log path', async () => {
            const executionId = 'test-exec-cache';
            const requestFile = path.join(tempDir, 'cache-request.json');
            
            const createdPath = await service.createLogFile(executionId, requestFile);
            const retrievedPath = await service.getLogPath(executionId);
            
            expect(retrievedPath).to.equal(createdPath);
        });

        it('should return undefined for non-existent execution', async () => {
            const retrievedPath = await service.getLogPath('non-existent-exec');
            expect(retrievedPath).to.be.undefined;
        });
    });

});