// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Request JSON hash validation service interface
 * Validates that request JSON hasn't been modified since execution was queued
 */

export interface HashValidationResult {
    isValid: boolean;
    originalHash?: string;
    currentHash?: string;
    errorMessage?: string;
    needsRegeneration?: boolean;
}

export interface HashGenerationResult {
    success: boolean;
    hash?: string;
    errorMessage?: string;
}

export interface RequestValidationResult {
    isValid: boolean;
    requestHash: string;
    validationDetails: {
        originalExecutionTime?: Date;
        validationTime: Date;
        hashAlgorithm: string;
        contentLength: number;
    };
    errorMessage?: string;
}

export interface IRequestHashValidatorService {
    /**
     * Generate a hash for request JSON content
     */
    generateRequestHash(requestContent: string): Promise<HashGenerationResult>;

    /**
     * Validate that a request JSON matches its stored hash
     */
    validateRequestHash(executionId: string, currentRequestContent: string): Promise<HashValidationResult>;

    /**
     * Compare two request JSON contents for equality
     */
    compareRequestContent(originalContent: string, currentContent: string): Promise<boolean>;

    /**
     * Validate a complete request including metadata
     */
    validateRequestIntegrity(
        executionId: string, 
        requestContent: string, 
        expectedHash: string
    ): Promise<RequestValidationResult>;

    /**
     * Get hash algorithm information
     */
    getHashAlgorithm(): string;

    /**
     * Regenerate hash for execution if needed
     */
    regenerateExecutionHash(executionId: string, newRequestContent: string): Promise<HashGenerationResult>;

    /**
     * Batch validate multiple executions
     */
    validateBatchRequestHashes(executionIds: string[]): Promise<Map<string, HashValidationResult>>;
}