// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';

/**
 * Unit Tests for Validation Utilities
 * 
 * These tests verify pure business logic for data validation,
 * including API endpoint validation, path validation, and configuration validation.
 */

interface EndpointConfig {
    name: string;
    path: string;
    method: string;
    body?: string;
    description?: string;
    customHeaders?: Record<string, string>;
    queryParams?: Record<string, string>;
}

interface ArrayConfig {
    enabled: boolean;
    path: string;
    itemTemplate: string;
    maxItems?: number;
}

interface ErrorToleranceConfig {
    mode: 'strict' | 'absolute' | 'percentage';
    absoluteLimit?: number;
    percentageLimit?: number;
}

// Validation Utility Functions
class ValidationUtils {
    /**
     * Validates API endpoint configuration
     */
    static validateEndpointConfig(config: EndpointConfig): { isValid: boolean; errors: string[] } {
        const errors: string[] = [];

        // Validate name
        if (!config.name || config.name.trim() === '') {
            errors.push('Endpoint name is required');
        }

        // Validate path
        if (!config.path || config.path.trim() === '') {
            errors.push('Endpoint path is required');
        } else if (!config.path.startsWith('/')) {
            errors.push('Endpoint path must start with /');
        }

        // Validate HTTP method
        const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
        if (!config.method || !validMethods.includes(config.method.toUpperCase())) {
            errors.push(`HTTP method must be one of: ${validMethods.join(', ')}`);
        }

        // Validate JSON body if provided
        if (config.body && config.body.trim() !== '') {
            try {
                JSON.parse(config.body);
            } catch {
                errors.push('Request body must be valid JSON');
            }
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Validates URL path format
     */
    static validatePath(path: string): { isValid: boolean; error?: string } {
        if (!path || path.trim() === '') {
            return { isValid: false, error: 'Path cannot be empty' };
        }

        if (!path.startsWith('/')) {
            return { isValid: false, error: 'Path must start with /' };
        }

        // Check for invalid characters
        const invalidChars = /[<>:"\\|?*\s]/;
        if (invalidChars.test(path)) {
            return { isValid: false, error: 'Path contains invalid characters' };
        }

        return { isValid: true };
    }

    /**
     * Validates HTTP method
     */
    static validateHttpMethod(method: string): { isValid: boolean; error?: string } {
        const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
        const upperMethod = method.toUpperCase();

        if (!validMethods.includes(upperMethod)) {
            return { 
                isValid: false, 
                error: `Invalid HTTP method. Must be one of: ${validMethods.join(', ')}` 
            };
        }

        return { isValid: true };
    }

    /**
     * Validates JSON string
     */
    static validateJson(jsonString: string): { isValid: boolean; error?: string } {
        if (!jsonString || jsonString.trim() === '') {
            return { isValid: true }; // Empty is valid (optional)
        }

        try {
            JSON.parse(jsonString);
            return { isValid: true };
        } catch (error: any) {
            return { 
                isValid: false, 
                error: error instanceof Error ? error.message : 'Invalid JSON format'
            };
        }
    }

    /**
     * Validates array configuration
     */
    static validateArrayConfig(config: ArrayConfig): { isValid: boolean; errors: string[] } {
        const errors: string[] = [];

        if (config.enabled) {
            if (!config.path || config.path.trim() === '') {
                errors.push('Array path is required when array processing is enabled');
            }

            if (!config.itemTemplate || config.itemTemplate.trim() === '') {
                errors.push('Item template is required when array processing is enabled');
            } else {
                const jsonValidation = this.validateJson(config.itemTemplate);
                if (!jsonValidation.isValid) {
                    errors.push(`Item template JSON is invalid: ${jsonValidation.error}`);
                }
            }

            if (config.maxItems !== undefined && config.maxItems < 1) {
                errors.push('Maximum items must be greater than 0');
            }
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Validates error tolerance configuration
     */
    static validateErrorToleranceConfig(config: ErrorToleranceConfig): { isValid: boolean; errors: string[] } {
        const errors: string[] = [];

        if (config.mode === 'absolute') {
            if (config.absoluteLimit === undefined || config.absoluteLimit < 0) {
                errors.push('Absolute error limit must be 0 or greater');
            }
        } else if (config.mode === 'percentage') {
            if (config.percentageLimit === undefined || config.percentageLimit < 0 || config.percentageLimit > 100) {
                errors.push('Percentage error limit must be between 0 and 100');
            }
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Validates key-value pairs (headers, query params)
     */
    static validateKeyValuePairs(pairs: Record<string, string>): { isValid: boolean; errors: string[] } {
        const errors: string[] = [];

        for (const [key, value] of Object.entries(pairs)) {
            if (!key || key.trim() === '') {
                errors.push('Key cannot be empty');
            }

            if (key.includes(' ') || key.includes('\t')) {
                errors.push(`Key "${key}" cannot contain spaces or tabs`);
            }

            if (value === undefined || value === null) {
                errors.push(`Value for key "${key}" cannot be null or undefined`);
            }
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Validates progress calculation values
     */
    static validateProgressValues(processed: number, total: number): { isValid: boolean; error?: string } {
        if (processed < 0) {
            return { isValid: false, error: 'Processed count cannot be negative' };
        }

        if (total < 0) {
            return { isValid: false, error: 'Total count cannot be negative' };
        }

        if (processed > total) {
            return { isValid: false, error: 'Processed count cannot exceed total count' };
        }

        return { isValid: true };
    }

    /**
     * Calculates percentage with validation
     */
    static calculatePercentage(processed: number, total: number): number {
        const validation = this.validateProgressValues(processed, total);
        if (!validation.isValid) {
            throw new Error(validation.error);
        }

        if (total === 0) {
            return 0;
        }

        return Math.round((processed / total) * 100);
    }
}

describe('Validation Utilities', () => {
    
    describe('validateEndpointConfig', () => {
        it('should validate correct endpoint configuration', () => {
            const config: EndpointConfig = {
                name: 'Test Endpoint',
                path: '/api/test',
                method: 'POST',
                body: '{"test": true}',
                description: 'Test endpoint description'
            };
            
            const result = ValidationUtils.validateEndpointConfig(config);
            expect(result.isValid).to.be.true;
            expect(result.errors).to.have.length(0);
        });

        it('should reject endpoint with missing name', () => {
            const config: EndpointConfig = {
                name: '',
                path: '/api/test',
                method: 'POST'
            };
            
            const result = ValidationUtils.validateEndpointConfig(config);
            expect(result.isValid).to.be.false;
            expect(result.errors).to.include('Endpoint name is required');
        });

        it('should reject endpoint with invalid path', () => {
            const config: EndpointConfig = {
                name: 'Test',
                path: 'api/test',
                method: 'POST'
            };
            
            const result = ValidationUtils.validateEndpointConfig(config);
            expect(result.isValid).to.be.false;
            expect(result.errors).to.include('Endpoint path must start with /');
        });

        it('should reject endpoint with invalid HTTP method', () => {
            const config: EndpointConfig = {
                name: 'Test',
                path: '/api/test',
                method: 'INVALID'
            };
            
            const result = ValidationUtils.validateEndpointConfig(config);
            expect(result.isValid).to.be.false;
            expect(result.errors).to.include('HTTP method must be one of: GET, POST, PUT, DELETE, PATCH');
        });

        it('should reject endpoint with invalid JSON body', () => {
            const config: EndpointConfig = {
                name: 'Test',
                path: '/api/test',
                method: 'POST',
                body: '{"invalid": json}'
            };
            
            const result = ValidationUtils.validateEndpointConfig(config);
            expect(result.isValid).to.be.false;
            expect(result.errors).to.include('Request body must be valid JSON');
        });
    });

    describe('validatePath', () => {
        it('should validate correct paths', () => {
            expect(ValidationUtils.validatePath('/api/test').isValid).to.be.true;
            expect(ValidationUtils.validatePath('/api/test/123').isValid).to.be.true;
            expect(ValidationUtils.validatePath('/').isValid).to.be.true;
        });

        it('should reject paths without leading slash', () => {
            const result = ValidationUtils.validatePath('api/test');
            expect(result.isValid).to.be.false;
            expect(result.error).to.equal('Path must start with /');
        });

        it('should reject empty paths', () => {
            const result = ValidationUtils.validatePath('');
            expect(result.isValid).to.be.false;
            expect(result.error).to.equal('Path cannot be empty');
        });

        it('should reject paths with invalid characters', () => {
            const result = ValidationUtils.validatePath('/api/test with spaces');
            expect(result.isValid).to.be.false;
            expect(result.error).to.equal('Path contains invalid characters');
        });
    });

    describe('validateHttpMethod', () => {
        it('should validate standard HTTP methods', () => {
            const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
            methods.forEach(method => {
                expect(ValidationUtils.validateHttpMethod(method).isValid).to.be.true;
                expect(ValidationUtils.validateHttpMethod(method.toLowerCase()).isValid).to.be.true;
            });
        });

        it('should reject invalid HTTP methods', () => {
            const result = ValidationUtils.validateHttpMethod('INVALID');
            expect(result.isValid).to.be.false;
            expect(result.error).to.include('Invalid HTTP method');
        });
    });

    describe('validateJson', () => {
        it('should validate correct JSON', () => {
            expect(ValidationUtils.validateJson('{"valid": "json"}').isValid).to.be.true;
            expect(ValidationUtils.validateJson('[]').isValid).to.be.true;
            expect(ValidationUtils.validateJson('null').isValid).to.be.true;
        });

        it('should allow empty JSON', () => {
            expect(ValidationUtils.validateJson('').isValid).to.be.true;
            expect(ValidationUtils.validateJson('   ').isValid).to.be.true;
        });

        it('should reject invalid JSON', () => {
            const result = ValidationUtils.validateJson('{"invalid": json}');
            expect(result.isValid).to.be.false;
            expect(result.error).to.not.be.undefined;
        });
    });

    describe('validateArrayConfig', () => {
        it('should validate disabled array config', () => {
            const config: ArrayConfig = {
                enabled: false,
                path: '',
                itemTemplate: ''
            };
            
            const result = ValidationUtils.validateArrayConfig(config);
            expect(result.isValid).to.be.true;
        });

        it('should validate enabled array config with correct values', () => {
            const config: ArrayConfig = {
                enabled: true,
                path: 'items',
                itemTemplate: '{"sku": "{{SKU}}"}',
                maxItems: 100
            };
            
            const result = ValidationUtils.validateArrayConfig(config);
            expect(result.isValid).to.be.true;
        });

        it('should reject enabled array config with missing path', () => {
            const config: ArrayConfig = {
                enabled: true,
                path: '',
                itemTemplate: '{"sku": "{{SKU}}"}'
            };
            
            const result = ValidationUtils.validateArrayConfig(config);
            expect(result.isValid).to.be.false;
            expect(result.errors).to.include('Array path is required when array processing is enabled');
        });

        it('should reject enabled array config with invalid JSON template', () => {
            const config: ArrayConfig = {
                enabled: true,
                path: 'items',
                itemTemplate: '{"invalid": json}'
            };
            
            const result = ValidationUtils.validateArrayConfig(config);
            expect(result.isValid).to.be.false;
            expect(result.errors.some(e => e.includes('Item template JSON is invalid'))).to.be.true;
        });
    });

    describe('validateErrorToleranceConfig', () => {
        it('should validate strict mode', () => {
            const config: ErrorToleranceConfig = { mode: 'strict' };
            const result = ValidationUtils.validateErrorToleranceConfig(config);
            expect(result.isValid).to.be.true;
        });

        it('should validate absolute mode with valid limit', () => {
            const config: ErrorToleranceConfig = { mode: 'absolute', absoluteLimit: 5 };
            const result = ValidationUtils.validateErrorToleranceConfig(config);
            expect(result.isValid).to.be.true;
        });

        it('should validate percentage mode with valid limit', () => {
            const config: ErrorToleranceConfig = { mode: 'percentage', percentageLimit: 10 };
            const result = ValidationUtils.validateErrorToleranceConfig(config);
            expect(result.isValid).to.be.true;
        });

        it('should reject absolute mode with invalid limit', () => {
            const config: ErrorToleranceConfig = { mode: 'absolute', absoluteLimit: -1 };
            const result = ValidationUtils.validateErrorToleranceConfig(config);
            expect(result.isValid).to.be.false;
            expect(result.errors).to.include('Absolute error limit must be 0 or greater');
        });

        it('should reject percentage mode with invalid limit', () => {
            const config: ErrorToleranceConfig = { mode: 'percentage', percentageLimit: 150 };
            const result = ValidationUtils.validateErrorToleranceConfig(config);
            expect(result.isValid).to.be.false;
            expect(result.errors).to.include('Percentage error limit must be between 0 and 100');
        });
    });

    describe('calculatePercentage', () => {
        it('should calculate percentage correctly', () => {
            expect(ValidationUtils.calculatePercentage(25, 100)).to.equal(25);
            expect(ValidationUtils.calculatePercentage(50, 200)).to.equal(25);
            expect(ValidationUtils.calculatePercentage(1, 3)).to.equal(33);
        });

        it('should handle zero total', () => {
            expect(ValidationUtils.calculatePercentage(0, 0)).to.equal(0);
        });

        it('should throw error for invalid values', () => {
            expect(() => ValidationUtils.calculatePercentage(-1, 100)).to.throw('Processed count cannot be negative');
            expect(() => ValidationUtils.calculatePercentage(150, 100)).to.throw('Processed count cannot exceed total count');
        });
    });
});