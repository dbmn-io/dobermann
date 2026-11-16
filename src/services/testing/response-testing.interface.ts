// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { TestExecutionResult } from '../../data-loading/javascript-test-runner';

export interface TestScriptConfig {
    name: string;
    script: string;
    enabled: boolean;
    priority: number;
}

export interface ExecutionTestResult {
    success: boolean;
    testResults: TestExecutionResult;
    functionalErrors: Array<{
        location: string;
        code: string;
        message: string;
        timestamp: string;
    }>;
    errorMessage?: string;
}

export interface IResponseTestingService {
    /**
     * Execute tests for an API response
     */
    executeTests(
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
    ): Promise<ExecutionTestResult>;

    /**
     * Validate test script syntax
     */
    validateTestScript(script: string): { isValid: boolean; error?: string };
}