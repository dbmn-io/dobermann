// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Error thrown during transaction preparation process
 * Provides context about which phase and operation failed
 */
export class TransactionPreparationError extends Error {
    constructor(
        message: string,
        public readonly phase: 'validation' | 'creation' | 'file_operation' | 'status_update',
        public readonly executionType: 'individual' | 'batch' | 'batch_member',
        public readonly originalError?: Error
    ) {
        super(message);
        this.name = 'TransactionPreparationError';
        
        // Maintain proper stack trace for debugging
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, TransactionPreparationError);
        }
    }
}

/**
 * Error thrown when batch preparation fails and cleanup is needed
 */
export class BatchPreparationError extends TransactionPreparationError {
    constructor(
        message: string,
        public readonly batchId?: string,
        public readonly createdExecutionIds: string[] = [],
        originalError?: Error
    ) {
        super(message, 'creation', 'batch', originalError);
        this.name = 'BatchPreparationError';
    }
}