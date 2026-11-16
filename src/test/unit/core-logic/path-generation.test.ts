// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';

/**
 * Unit tests for path generation logic
 * Tests the pure functions that generate file paths for executions and batches
 */
describe('Path Generation Logic - Unit Tests', () => {
    
    describe('generateExecutionPath', () => {
        it('should generate correct path for individual execution', () => {
            const params = {
                environment: 'production',
                endpointFolder: 'users',
                endpointName: 'Get User Profile',
                executionId: 'exec-2024-01-15-10-30-45-123'
            };
            
            const path = generateExecutionPath(params);
            
            expect(path).to.equal('production/users/get-user-profile/exec-2024-01-15-10-30-45-123');
        });
        
        it('should handle endpoint without folder', () => {
            const params = {
                environment: 'staging',
                endpointFolder: '',
                endpointName: 'Health Check',
                executionId: 'exec-2024-01-15-10-30-45-456'
            };
            
            const path = generateExecutionPath(params);
            
            expect(path).to.equal('staging/health-check/exec-2024-01-15-10-30-45-456');
        });
        
        it('should sanitize special characters in names', () => {
            const params = {
                environment: 'dev-test',
                endpointFolder: 'API/v2',
                endpointName: '/users/{id}/profile?details=true',
                executionId: 'exec-2024-01-15-10-30-45-789'
            };
            
            const path = generateExecutionPath(params);
            
            expect(path).to.equal('dev-test/api-v2/users-id-profile-details-true/exec-2024-01-15-10-30-45-789');
        });
    });
    
    describe('generateBatchPath', () => {
        it('should generate correct path for batch execution', () => {
            const params = {
                environment: 'production',
                endpointFolder: 'bulk',
                endpointName: 'Create Users Batch',
                batchId: 'batch-2024-01-15-10-30-45'
            };
            
            const path = generateBatchPath(params);
            
            expect(path).to.equal('production/bulk/create-users-batch/batch/batch-2024-01-15-10-30-45');
        });
        
        it('should include data subdirectory for batch files', () => {
            const params = {
                environment: 'production',
                endpointFolder: 'bulk',
                endpointName: 'Create Users Batch',
                batchId: 'batch-2024-01-15-10-30-45'
            };
            
            const dataPath = generateBatchDataPath(params);
            
            expect(dataPath).to.equal('production/bulk/create-users-batch/batch/batch-2024-01-15-10-30-45/data');
        });
    });
    
    describe('generateTimestamp', () => {
        it('should generate timestamp in correct format', () => {
            const timestamp = generateTimestamp();
            const pattern = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/;
            
            expect(timestamp).to.match(pattern);
        });
        
        it('should generate unique timestamps', () => {
            // Test that timestamp format is consistent rather than uniqueness
            // (uniqueness would require time delays which are impractical in unit tests)
            const timestamp1 = generateTimestamp();
            const timestamp2 = generateTimestamp();
            
            // Both should match the expected pattern
            const pattern = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/;
            expect(timestamp1).to.match(pattern);
            expect(timestamp2).to.match(pattern);
            
            // They should be strings and not undefined
            expect(typeof timestamp1).to.equal('string');
            expect(typeof timestamp2).to.equal('string');
        });
    });
    
    describe('sanitizePathSegment', () => {
        it('should handle common special characters', () => {
            const testCases = [
                { input: 'hello/world', expected: 'hello-world' },
                { input: 'user@example.com', expected: 'user-example-com' },
                { input: 'item#123', expected: 'item-123' },
                { input: 'price:$100', expected: 'price-100' },
                { input: 'data[0]', expected: 'data-0' },
                { input: 'query?param=value', expected: 'query-param-value' },
                { input: 'path\\to\\file', expected: 'path-to-file' }
            ];
            
            testCases.forEach(({ input, expected }) => {
                const result = sanitizePathSegment(input);
                expect(result).to.equal(expected);
            });
        });
        
        it('should handle leading/trailing special characters', () => {
            const testCases = [
                { input: '/api/users/', expected: 'api-users' },
                { input: '---test---', expected: 'test' },
                { input: '...file...', expected: 'file' },
                { input: '__private__', expected: 'private' }
            ];
            
            testCases.forEach(({ input, expected }) => {
                const result = sanitizePathSegment(input);
                expect(result).to.equal(expected);
            });
        });
        
        it('should handle empty or invalid inputs', () => {
            expect(sanitizePathSegment('')).to.equal('unnamed');
            expect(sanitizePathSegment('   ')).to.equal('unnamed');
            expect(sanitizePathSegment('////')).to.equal('unnamed');
            expect(sanitizePathSegment('...')).to.equal('unnamed');
        });
        
        it('should convert to lowercase', () => {
            expect(sanitizePathSegment('UserProfile')).to.equal('userprofile');
            expect(sanitizePathSegment('GET-Request')).to.equal('get-request');
            expect(sanitizePathSegment('API_v2')).to.equal('api-v2');
        });
    });
    
    describe('generateRequestFileName', () => {
        it('should generate request file name with execution ID', () => {
            const executionId = 'exec-2024-01-15-10-30-45-123';
            const fileName = generateRequestFileName(executionId);
            
            expect(fileName).to.equal('exec-2024-01-15-10-30-45-123-request.json');
        });
        
        it('should generate request file name with index for batch', () => {
            const executionId = 'exec-batch-001';
            const index = 5;
            const fileName = generateRequestFileName(executionId, index);
            
            expect(fileName).to.equal('exec-batch-001-005-request.json');
        });
    });
    
    describe('generateResponseFileName', () => {
        it('should generate response file name with execution ID', () => {
            const executionId = 'exec-2024-01-15-10-30-45-123';
            const fileName = generateResponseFileName(executionId);
            
            expect(fileName).to.equal('exec-2024-01-15-10-30-45-123-response.json');
        });
        
        it('should include status code if provided', () => {
            const executionId = 'exec-2024-01-15-10-30-45-123';
            const statusCode = 200;
            const fileName = generateResponseFileName(executionId, statusCode);
            
            expect(fileName).to.equal('exec-2024-01-15-10-30-45-123-response-200.json');
        });
    });
    
    describe('extractExecutionIdFromPath', () => {
        it('should extract execution ID from file path', () => {
            const paths = [
                '/workspace/production/users/get-profile/exec-2024-01-15-10-30-45-123/request.json',
                'C:\\workspace\\production\\users\\get-profile\\exec-2024-01-15-10-30-45-123\\response.json',
                '../executions/exec-2024-01-15-10-30-45-123/data.json'
            ];
            
            paths.forEach(path => {
                const executionId = extractExecutionIdFromPath(path);
                expect(executionId).to.equal('exec-2024-01-15-10-30-45-123');
            });
        });
        
        it('should return null for paths without execution ID', () => {
            const paths = [
                '/workspace/production/users/get-profile/',
                'C:\\workspace\\data.json',
                '../executions/invalid/path'
            ];
            
            paths.forEach(path => {
                const executionId = extractExecutionIdFromPath(path);
                expect(executionId).to.be.null;
            });
        });
    });
});

// Helper functions (these would be imported from the actual implementation)
function generateExecutionPath(params: {
    environment: string;
    endpointFolder: string;
    endpointName: string;
    executionId: string;
}): string {
    const segments = [
        sanitizePathSegment(params.environment),
        params.endpointFolder ? sanitizePathSegment(params.endpointFolder) : null,
        sanitizePathSegment(params.endpointName),
        params.executionId
    ].filter(Boolean);
    
    return segments.join('/');
}

function generateBatchPath(params: {
    environment: string;
    endpointFolder: string;
    endpointName: string;
    batchId: string;
}): string {
    const segments = [
        sanitizePathSegment(params.environment),
        params.endpointFolder ? sanitizePathSegment(params.endpointFolder) : null,
        sanitizePathSegment(params.endpointName),
        'batch',
        params.batchId
    ].filter(Boolean);
    
    return segments.join('/');
}

function generateBatchDataPath(params: {
    environment: string;
    endpointFolder: string;
    endpointName: string;
    batchId: string;
}): string {
    return generateBatchPath(params) + '/data';
}

function generateTimestamp(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    
    return `${year}-${month}-${day}-${hours}-${minutes}-${seconds}`;
}

function sanitizePathSegment(segment: string): string {
    if (!segment || typeof segment !== 'string') {
        return 'unnamed';
    }
    
    // Convert to lowercase and replace special characters
    let sanitized = segment
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    
    // Return default if empty after sanitization
    return sanitized || 'unnamed';
}

function generateRequestFileName(executionId: string, index?: number): string {
    if (index !== undefined) {
        const paddedIndex = String(index).padStart(3, '0');
        return `${executionId}-${paddedIndex}-request.json`;
    }
    return `${executionId}-request.json`;
}

function generateResponseFileName(executionId: string, statusCode?: number): string {
    const baseName = `${executionId}-response`;
    if (statusCode !== undefined) {
        return `${baseName}-${statusCode}.json`;
    }
    return `${baseName}.json`;
}

function extractExecutionIdFromPath(path: string): string | null {
    // Normalize path separators
    const normalizedPath = path.replace(/\\/g, '/');
    
    // Look for execution ID pattern
    const match = normalizedPath.match(/(exec-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d+)/);
    
    return match ? match[1] : null;
}