// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
export interface FunctionalErrorPattern {
    id: string;
    location: string;
    errorCode: string;
    message: string;
    frequency: number;
    firstSeen: string;
    lastSeen: string;
    endpointId: string;
    suggestedTestAssertion: string;
}

export interface TestSuggestion {
    testName: string;
    testScript: string;
    description: string;
    confidence: number; // 0-100
    basedOnPatterns: string[]; // Pattern IDs
}

export interface ErrorPatternLibrary {
    version: string;
    patterns: FunctionalErrorPattern[];
    generatedAt: string;
    endpointId?: string;
}

export interface IErrorLearningService {
    /**
     * Record a functional error pattern from test execution
     */
    recordFunctionalError(
        executionId: string,
        endpointId: string,
        errorPattern: {
            location: string;
            code: string;
            message: string;
        }
    ): Promise<void>;

    /**
     * Get all error patterns for an endpoint
     */
    getErrorPatterns(endpointId: string): Promise<FunctionalErrorPattern[]>;

    /**
     * Suggest test assertions based on learned error patterns
     */
    suggestTestAssertions(endpointId: string): Promise<TestSuggestion[]>;

    /**
     * Export error pattern library for an endpoint
     */
    exportErrorPatterns(endpointId: string): Promise<ErrorPatternLibrary>;

    /**
     * Import error pattern library
     */
    importErrorPatterns(library: ErrorPatternLibrary): Promise<void>;

    /**
     * Get summary statistics for learned patterns
     */
    getLearningSummary(): Promise<{
        totalPatterns: number;
        endpointsWithPatterns: number;
        mostCommonErrors: Array<{
            code: string;
            frequency: number;
            endpoints: string[];
        }>;
    }>;

    /**
     * Clear all learned patterns (for testing/reset)
     */
    clearAllPatterns(): Promise<void>;
}