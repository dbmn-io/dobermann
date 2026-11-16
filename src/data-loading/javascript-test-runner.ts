// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * JavaScript Test Runner for Data Loading
 * 
 * This module provides a secure sandbox for executing user-written JavaScript tests
 * against API responses using lightweight assertion library.
 */

import { strict as assert } from 'assert';
import { expect } from '../utils/expect-lite';
import * as vm from 'vm';

export interface ResponseContext {
    status: number;
    headers: Record<string, string>;
    body: string;
    json(): any;
    text(): string;
}

export interface RequestContext {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
    json(): any;
}

export interface BatchAnalysisResult {
    totalCount: number;
    successCount: number;
    failureCount: number;
    failureRate: number;
    criticalErrors: string[];
}

export interface FunctionalError {
    location: string;
    code: string;
    message: string;
    timestamp: string;
}

export interface TestContext {
    response: ResponseContext;
    request: RequestContext;
    csvRow: Record<string, string>;
    rowIndex: number;
    totalRows: number;
    executionId: string;
    batchContext?: {
        batchId: string;
        memberIndex: number;
        totalMembers: number;
    };
    expect: typeof expect;
    assert: typeof assert;
    reportFunctionalError: (location: string, code: string, message: string) => void;
    analyzeBatch: (responseArray: any[]) => BatchAnalysisResult;
}

export interface TestConfig {
    name: string;
    script: string;
    enabled: boolean;
    priority: number;
}

export interface TestResult {
    testName: string;
    success: boolean;
    error?: string;
    executionTime: number;
    timestamp: string;
    functionalErrors: FunctionalError[];
}

export interface TestExecutionResult {
    totalTests: number;
    passedTests: number;
    failedTests: number;
    results: TestResult[];
    executionTime: number;
}

export class JavaScriptTestRunner {
    private readonly DEFAULT_TIMEOUT = 5000; // 5 seconds
    private readonly MAX_TIMEOUT = 30000;    // 30 seconds

    /**
     * Create test context with all necessary objects and functions
     */
    createTestContext(
        response: ResponseContext,
        request: RequestContext,
        csvRow: Record<string, string>,
        rowIndex: number,
        totalRows: number,
        executionId: string,
        batchContext?: {
            batchId: string;
            memberIndex: number;
            totalMembers: number;
        }
    ): TestContext {
        return {
            response,
            request,
            csvRow,
            rowIndex,
            totalRows,
            executionId,
            batchContext,
            expect,
            assert,
            // Placeholder functions - actual implementation is in sandbox
            reportFunctionalError: () => {},
            analyzeBatch: () => ({ totalCount: 0, successCount: 0, failureCount: 0, failureRate: 0, criticalErrors: [] })
        };
    }

    /**
     * Execute a single JavaScript test in a secure sandbox
     */
    async executeTest(
        testName: string,
        testScript: string,
        context: TestContext,
        timeout: number = this.DEFAULT_TIMEOUT
    ): Promise<TestResult> {
        const startTime = Date.now();
        const timestamp = new Date().toISOString();
        const functionalErrors: FunctionalError[] = [];

        // Validate timeout
        const effectiveTimeout = Math.min(timeout, this.MAX_TIMEOUT);

        try {
            // Create a secure sandbox context with functional error tracking
            const sandbox = this.createSandbox(context, functionalErrors);

            // Validate script syntax first
            try {
                new vm.Script(testScript);
            } catch (syntaxError) {
                return {
                    testName,
                    success: false,
                    error: `Syntax Error: ${syntaxError}`,
                    executionTime: Date.now() - startTime,
                    timestamp,
                    functionalErrors
                };
            }

            // Execute the test script with timeout
            await this.executeInSandbox(testScript, sandbox, effectiveTimeout);

            return {
                testName,
                success: true,
                executionTime: Date.now() - startTime,
                timestamp,
                functionalErrors
            };

        } catch (error) {
            let errorMessage = 'Unknown error';
            
            if (error instanceof Error) {
                errorMessage = error.message;
            } else if (typeof error === 'string') {
                errorMessage = error;
            }

            return {
                testName,
                success: false,
                error: errorMessage,
                executionTime: Date.now() - startTime,
                timestamp,
                functionalErrors
            };
        }
    }

    /**
     * Execute multiple tests and aggregate results
     */
    async executeMultipleTests(
        testConfigs: TestConfig[],
        context: TestContext,
        timeout: number = this.DEFAULT_TIMEOUT
    ): Promise<TestExecutionResult> {
        const startTime = Date.now();
        const results: TestResult[] = [];

        // Filter enabled tests and sort by priority (ascending)
        const enabledTests = testConfigs
            .filter(test => test.enabled)
            .sort((a, b) => (a.priority || 0) - (b.priority || 0));

        // Execute each test in priority order
        for (const testConfig of enabledTests) {
            const result = await this.executeTest(
                testConfig.name,
                testConfig.script,
                context,
                timeout
            );
            results.push(result);
        }

        // Calculate aggregated results
        const passedTests = results.filter(r => r.success).length;
        const failedTests = results.filter(r => !r.success).length;

        return {
            totalTests: enabledTests.length,
            passedTests,
            failedTests,
            results,
            executionTime: Date.now() - startTime
        };
    }

    /**
     * Create a secure sandbox for test execution
     */
    private createSandbox(context: TestContext, functionalErrors: FunctionalError[]): vm.Context {
        // Create a clean context with only necessary objects
        const sandbox = {
            // Test context
            response: context.response,
            request: context.request,
            csvRow: context.csvRow,
            rowIndex: context.rowIndex,
            totalRows: context.totalRows,
            executionId: context.executionId,
            batchContext: context.batchContext,

            // Assertion libraries
            expect: context.expect,
            assert: context.assert,

            // Enhanced test functions
            reportFunctionalError: (location: string, code: string, message: string) => {
                functionalErrors.push({
                    location,
                    code,
                    message,
                    timestamp: new Date().toISOString()
                });
            },
            analyzeBatch: (responseArray: any[]): BatchAnalysisResult => {
                const total = responseArray.length;
                const failures = responseArray.filter(item => 
                    item.status === 'Failed' || 
                    item.Status === 'Failed' || 
                    item.success === false
                );
                const successes = total - failures.length;
                
                return {
                    totalCount: total,
                    successCount: successes,
                    failureCount: failures.length,
                    failureRate: total > 0 ? failures.length / total : 0,
                    criticalErrors: failures.map(f => f.errorMessage || f.ErrorMessage || 'Unknown error')
                };
            },

            // Safe built-in objects and functions
            console: {
                log: () => {}, // Disable console output for security
                error: () => {},
                warn: () => {},
                info: () => {}
            },
            JSON: JSON,
            Math: Math,
            Date: Date,
            Array: Array,
            Object: Object,
            String: String,
            Number: Number,
            Boolean: Boolean,
            RegExp: RegExp,
            Error: Error,
            TypeError: TypeError,
            ReferenceError: ReferenceError,
            SyntaxError: SyntaxError,

            // Safe utility functions
            parseInt: parseInt,
            parseFloat: parseFloat,
            isNaN: isNaN,
            isFinite: isFinite,
            decodeURIComponent: decodeURIComponent,
            encodeURIComponent: encodeURIComponent,

            // Block dangerous objects
            require: undefined,
            process: undefined,
            global: undefined,
            Buffer: undefined,
            setImmediate: undefined,
            clearImmediate: undefined,
            __dirname: undefined,
            __filename: undefined,
            module: undefined,
            exports: undefined
        };

        return vm.createContext(sandbox);
    }

    /**
     * Execute script in sandbox with timeout protection
     */
    private async executeInSandbox(
        script: string,
        sandbox: vm.Context,
        timeout: number
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Test execution timeout after ${timeout}ms`));
            }, timeout);

            try {
                vm.runInContext(script, sandbox, {
                    timeout: timeout,
                    displayErrors: true
                });
                
                clearTimeout(timer);
                resolve();
            } catch (error) {
                clearTimeout(timer);
                reject(error);
            }
        });
    }

    /**
     * Validate test script syntax without executing
     */
    validateTestScript(script: string): { isValid: boolean; error?: string } {
        try {
            new vm.Script(script);
            return { isValid: true };
        } catch (error) {
            return {
                isValid: false,
                error: error instanceof Error ? error.message : 'Unknown syntax error'
            };
        }
    }

    /**
     * Create response context from HTTP response data
     */
    createResponseContext(
        status: number,
        headers: Record<string, string>,
        body: string
    ): ResponseContext {
        return {
            status,
            headers,
            body,
            json: () => {
                try {
                    return JSON.parse(body);
                } catch (error) {
                    throw new Error(`Invalid JSON response: ${error}`);
                }
            },
            text: () => body
        };
    }

    /**
     * Create request context from HTTP request data
     */
    createRequestContext(
        method: string,
        url: string,
        headers: Record<string, string>,
        body: string
    ): RequestContext {
        return {
            method,
            url,
            headers,
            body,
            json: () => {
                try {
                    return JSON.parse(body);
                } catch (error) {
                    throw new Error(`Invalid JSON request: ${error}`);
                }
            }
        };
    }

    /**
     * Get safe execution environment information
     */
    getExecutionEnvironmentInfo(): {
        defaultTimeout: number;
        maxTimeout: number;
        availableAssertions: string[];
        blockedObjects: string[];
    } {
        return {
            defaultTimeout: this.DEFAULT_TIMEOUT,
            maxTimeout: this.MAX_TIMEOUT,
            availableAssertions: [
                'expect().to.equal()',
                'expect().to.be.true',
                'expect().to.have.property()',
                'expect().to.be.an()',
                'expect().to.include()',
                'assert.equal()',
                'assert.deepEqual()',
                'assert.strictEqual()'
            ],
            blockedObjects: [
                'require',
                'process',
                'global',
                'Buffer',
                'fs',
                'http',
                'https',
                'child_process',
                'cluster',
                'os'
            ]
        };
    }
}