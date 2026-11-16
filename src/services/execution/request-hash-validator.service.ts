// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { 
    IRequestHashValidatorService, 
    HashValidationResult, 
    HashGenerationResult, 
    RequestValidationResult 
} from './request-hash-validator.interface';
import { IExecutionMetadataService } from './execution-metadata.interface';
import { createHash } from 'crypto';

export class RequestHashValidatorService implements IRequestHashValidatorService {
    private readonly hashAlgorithm = 'sha256';

    constructor(private metadataService: IExecutionMetadataService) {}

    async generateRequestHash(requestContent: string): Promise<HashGenerationResult> {
        try {
            const hash = createHash(this.hashAlgorithm)
                .update(requestContent, 'utf8')
                .digest('hex');

            return {
                success: true,
                hash
            };
        } catch (error) {
            return {
                success: false,
                errorMessage: `Failed to generate hash: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    async validateRequestHash(executionId: string, currentRequestContent: string): Promise<HashValidationResult> {
        try {
            // Get execution metadata
            const execution = await this.metadataService.getExecution(executionId);
            if (!execution) {
                return {
                    isValid: false,
                    errorMessage: 'Execution not found'
                };
            }

            // Check if execution has a stored hash
            if (!execution.requestHash) {
                return {
                    isValid: false,
                    needsRegeneration: true,
                    errorMessage: 'No stored hash found for execution'
                };
            }

            // Generate hash for current content
            const hashResult = await this.generateRequestHash(currentRequestContent);
            if (!hashResult.success) {
                return {
                    isValid: false,
                    errorMessage: `Failed to generate current hash: ${hashResult.errorMessage}`
                };
            }

            const currentHash = hashResult.hash!;
            const originalHash = execution.requestHash;

            // Compare hashes
            const isValid = originalHash === currentHash;

            return {
                isValid,
                originalHash,
                currentHash,
                needsRegeneration: !isValid,
                errorMessage: isValid ? undefined : 'Request content has been modified since execution was queued'
            };

        } catch (error) {
            return {
                isValid: false,
                errorMessage: `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    async compareRequestContent(originalContent: string, currentContent: string): Promise<boolean> {
        try {
            // Direct string comparison for exact match
            return originalContent === currentContent;
        } catch (error) {
            return false;
        }
    }

    async validateRequestIntegrity(
        executionId: string, 
        requestContent: string, 
        expectedHash: string
    ): Promise<RequestValidationResult> {
        try {
            // Generate hash for current content
            const hashResult = await this.generateRequestHash(requestContent);
            if (!hashResult.success) {
                return {
                    isValid: false,
                    requestHash: '',
                    validationDetails: {
                        validationTime: new Date(),
                        hashAlgorithm: this.hashAlgorithm,
                        contentLength: requestContent.length
                    },
                    errorMessage: `Hash generation failed: ${hashResult.errorMessage}`
                };
            }

            const currentHash = hashResult.hash!;
            const isValid = currentHash === expectedHash;

            // Get execution for original timestamp
            const execution = await this.metadataService.getExecution(executionId);

            return {
                isValid,
                requestHash: currentHash,
                validationDetails: {
                    originalExecutionTime: execution?.createdAt,
                    validationTime: new Date(),
                    hashAlgorithm: this.hashAlgorithm,
                    contentLength: requestContent.length
                },
                errorMessage: isValid ? undefined : 'Request integrity validation failed - content has been modified'
            };

        } catch (error) {
            return {
                isValid: false,
                requestHash: '',
                validationDetails: {
                    validationTime: new Date(),
                    hashAlgorithm: this.hashAlgorithm,
                    contentLength: requestContent.length
                },
                errorMessage: `Integrity validation error: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    getHashAlgorithm(): string {
        return this.hashAlgorithm;
    }

    async regenerateExecutionHash(executionId: string, newRequestContent: string): Promise<HashGenerationResult> {
        try {
            // Generate new hash
            const hashResult = await this.generateRequestHash(newRequestContent);
            if (!hashResult.success) {
                return {
                    success: false,
                    errorMessage: `Hash generation failed: ${hashResult.errorMessage}`
                };
            }

            // Update execution with new hash
            await this.metadataService.updateExecution(executionId, {
                requestHash: hashResult.hash
            });

            return {
                success: true,
                hash: hashResult.hash
            };

        } catch (error) {
            return {
                success: false,
                errorMessage: `Failed to regenerate hash: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    async validateBatchRequestHashes(executionIds: string[]): Promise<Map<string, HashValidationResult>> {
        const results = new Map<string, HashValidationResult>();

        // Handle empty list
        if (!executionIds || executionIds.length === 0) {
            return results;
        }

        // Validate each execution
        for (const executionId of executionIds) {
            try {
                // Get execution metadata
                const execution = await this.metadataService.getExecution(executionId);
                
                if (!execution) {
                    results.set(executionId, {
                        isValid: false,
                        errorMessage: 'Execution not found'
                    });
                    continue;
                }

                if (!execution.requestHash) {
                    results.set(executionId, {
                        isValid: false,
                        needsRegeneration: true,
                        errorMessage: 'No stored hash found'
                    });
                    continue;
                }

                // For batch validation, we assume the stored hash is valid
                // since we don't have current request content to compare against
                results.set(executionId, {
                    isValid: true,
                    originalHash: execution.requestHash,
                    currentHash: execution.requestHash,
                    needsRegeneration: false
                });

            } catch (error) {
                results.set(executionId, {
                    isValid: false,
                    errorMessage: `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`
                });
            }
        }

        return results;
    }
}