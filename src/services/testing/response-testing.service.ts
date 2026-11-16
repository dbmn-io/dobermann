// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { JavaScriptTestRunner, TestConfig, TestExecutionResult, FunctionalError } from '../../data-loading/javascript-test-runner';
import { IResponseTestingService, TestScriptConfig, ExecutionTestResult } from './response-testing.interface';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';

export class ResponseTestingService implements IResponseTestingService {
    private testRunner: JavaScriptTestRunner;

    constructor(private logger: IExtensionDiagnosticLogger) {
        this.testRunner = new JavaScriptTestRunner();
    }

    async executeTests(
        executionId: string,
        response: any,
        testScripts: TestScriptConfig[],
        executionContext: {
            request: any;
            csvRow?: Record<string, string>;
            rowIndex?: number;
            totalRows?: number;
            batchContext?: {
                batchId: string;
                memberIndex: number;
                totalMembers: number;
            };
        }
    ): Promise<ExecutionTestResult> {
        try {
            this.logger.info(`[ResponseTestingService] Executing ${testScripts.length} tests for execution ${executionId}`);

            // Convert test scripts to TestConfig format
            const testConfigs: TestConfig[] = testScripts.map(script => ({
                name: script.name,
                script: script.script,
                enabled: script.enabled,
                priority: script.priority
            }));

            // Create response context
            const responseContext = this.testRunner.createResponseContext(
                response.status || 200,
                response.headers || {},
                JSON.stringify(response.data || response)
            );

            // Create request context  
            const requestContext = this.testRunner.createRequestContext(
                executionContext.request?.method || 'POST',
                executionContext.request?.url || '/unknown',
                executionContext.request?.headers || {},
                JSON.stringify(executionContext.request?.body || {})
            );

            // Create test context with execution metadata
            const testContext = this.testRunner.createTestContext(
                responseContext,
                requestContext,
                executionContext.csvRow || {},
                executionContext.rowIndex || 0,
                executionContext.totalRows || 1,
                executionId,
                executionContext.batchContext
            );

            // Execute all tests
            const testResults = await this.testRunner.executeMultipleTests(
                testConfigs,
                testContext
            );

            // Aggregate functional errors from all test results
            const allFunctionalErrors: FunctionalError[] = [];
            testResults.results.forEach(result => {
                if (result.functionalErrors) {
                    allFunctionalErrors.push(...result.functionalErrors);
                }
            });

            // Determine overall success
            const success = testResults.failedTests === 0;

            // Create error message for failed tests
            let errorMessage: string | undefined;
            if (!success) {
                // #428: says which test failed and why, in words. It is the reason a 200 is an
                // error, shown on the Console's card and in its Reason column.
                const failedTestNames = testResults.results
                    .filter(r => !r.success)
                    .map(r => `"${r.testName}"`);
                errorMessage = `${failedTestNames.length === 1 ? 'Test' : 'Tests'} ${failedTestNames.join(', ')} failed`;
                const firstError = testResults.results.find(r => !r.success && r.error);
                if (firstError) {
                    errorMessage += `: ${firstError.error}`;
                }
            }

            this.logger.info(`[ResponseTestingService] Test execution completed for ${executionId}`, undefined, {
                executionId,
                totalTests: testResults.totalTests,
                passedTests: testResults.passedTests,
                failedTests: testResults.failedTests,
                functionalErrorCount: allFunctionalErrors.length,
                success
            });

            return {
                success,
                testResults,
                functionalErrors: allFunctionalErrors,
                errorMessage
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown test execution error';
            this.logger.error(`[ResponseTestingService] Test execution failed for ${executionId}`, error instanceof Error ? error : undefined, { executionId });

            return {
                success: false,
                testResults: {
                    totalTests: testScripts.length,
                    passedTests: 0,
                    failedTests: testScripts.length,
                    results: [],
                    executionTime: 0
                },
                functionalErrors: [],
                errorMessage: `Test execution error: ${errorMessage}`
            };
        }
    }

    validateTestScript(script: string): { isValid: boolean; error?: string } {
        return this.testRunner.validateTestScript(script);
    }
}