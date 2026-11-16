// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Zod Schemas for Webview JavaScript
 * 
 * This file is auto-generated from the TypeScript Zod schemas.
 * DO NOT EDIT MANUALLY - changes will be overwritten.
 * 
 * To update these schemas:
 * 1. Edit src/data-loading/zod-schemas.ts
 * 2. Run: npm run build-schemas
 */

(function() {
    // Ensure Zod is available
    if (typeof z === 'undefined') {
        console.error('Zod library (z) is not available. Make sure zod.js is loaded before this script.');
        return;
    }
    
    // Initialize namespace
    window.ZodSchemas = {};
    
    /**
 * Zod Schemas for Data Loading Configuration
 *
 * These schemas provide both TypeScript type inference and runtime validation
 * for sharing types between the TypeScript backend and JavaScript frontend.
 */
// Base data types
window.ZodSchemas.DataTypeSchema = z.enum(['string', 'number', 'boolean', 'date']);
window.ZodSchemas.ErrorHandlingModeSchema = z.enum(['stopOnFirst', 'continue']);
window.ZodSchemas.ErrorToleranceModeSchema = z.enum(['absolute', 'percentage']);
// Repeatable Array Configuration
window.ZodSchemas.RepeatableArraySchema = z.object({
    arrayPath: z.string().min(1, 'Array path is required'),
    maxRepetitions: z.number().min(1, 'Max repetitions must be greater than 0'),
    enabled: z.boolean()
});
// Test Script Configuration
window.ZodSchemas.TestScriptSchema = z.object({
    name: z.string().min(1, 'Test script name is required'),
    script: z.string().min(1, 'Test script code is required'),
    enabled: z.boolean(),
    priority: z.number().min(0, 'Priority must be non-negative').default(0)
});
// Retry Conditions Configuration
window.ZodSchemas.RetryConditionsSchema = z.object({
    networkErrors: z.boolean(),
    serverErrors: z.boolean(),
    rateLimiting: z.boolean(),
    clientErrors: z.boolean()
});
// Retry Configuration
window.ZodSchemas.RetryConfigSchema = z.object({
    maxAttempts: z.number().min(0).max(5, 'Maximum retry attempts cannot exceed 5'),
    delaySeconds: z.number().min(1).max(30, 'Retry delay cannot exceed 30 seconds'),
    retryConditions: window.ZodSchemas.RetryConditionsSchema
});
// Error Tolerance Configuration
window.ZodSchemas.ErrorToleranceSchema = z.object({
    type: window.ZodSchemas.ErrorToleranceModeSchema,
    value: z.number().min(0, 'Error tolerance value cannot be negative')
}).refine((data) => {
    if (data.type === 'percentage') {
        return data.value <= 100;
    }
    return true;
}, {
    message: 'Error tolerance percentage cannot exceed 100',
    path: ['value']
});
// Error Handling Configuration
window.ZodSchemas.ErrorHandlingConfigSchema = z.object({
    mode: window.ZodSchemas.ErrorHandlingModeSchema,
    // Flat structure fields (current implementation)
    enableErrorTolerance: z.boolean().optional(),
    toleranceMode: window.ZodSchemas.ErrorToleranceModeSchema.optional(),
    absoluteErrorLimit: z.number().min(1).max(1000).optional(),
    percentageErrorLimit: z.number().min(1).max(100).optional(),
    // Nested structure for backward compatibility
    maxErrorTolerance: z.object({
        enabled: z.boolean(),
        type: window.ZodSchemas.ErrorToleranceModeSchema,
        value: z.number().min(0)
    }).optional(),
    retryConfig: window.ZodSchemas.RetryConfigSchema
});
// Data Validation Configuration
window.ZodSchemas.DataValidationConfigSchema = z.object({
    enforceDataTypes: z.boolean(),
    variableDataTypes: z.record(z.string(), window.ZodSchemas.DataTypeSchema)
});
// Main Data Loading Configuration
window.ZodSchemas.DataLoadingConfigSchema = z.object({
    // JSON Template Configuration
    jsonTemplate: z.string().optional().refine((val) => {
        if (!val || val.trim() === '')
            return true;
        try {
            // Strip comments before validating JSON to support JSONC
            const cleanJson = window.stripJsonCommentsSafe ? window.stripJsonCommentsSafe(val) : val;
            JSON.parse(cleanJson);
            return true;
        }
        catch {
            return false;
        }
    }, 'JSON template must be valid JSON (comments are allowed)'),
    detectArrays: z.boolean(),
    repeatableArrays: z.array(window.ZodSchemas.RepeatableArraySchema),
    // JavaScript Test Configuration (multiple tests with priority ordering)
    testScripts: z.array(window.ZodSchemas.TestScriptSchema).optional().default([]),
    // Error Handling Configuration
    errorHandling: window.ZodSchemas.ErrorHandlingConfigSchema,
    // Data Validation Configuration
    dataValidation: window.ZodSchemas.DataValidationConfigSchema,
    // GitHub Issue #307: remembered Run Batch mapping (variable → column). Hand-added: the
    // copy-schemas generator emits a require() the webview cannot run.
    columnMappings: z.record(z.string(), z.string()).optional()
});
// Header Configuration Schema
window.ZodSchemas.HeaderConfigSchema = z.object({
    value: z.string(),
    enabled: z.boolean()
});
// API Endpoint Configuration
window.ZodSchemas.APIEndpointConfigSchema = z.object({
    id: z.string().min(1, 'Endpoint ID is required'),
    name: z.string()
        .min(1, 'Endpoint name is required')
        .refine((name) => {
        // Check for invalid characters that would cause folder creation issues
        const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
        return !invalidChars.test(name);
    }, 'Endpoint name contains invalid characters for folder creation')
        .refine((name) => {
        // Check for reserved Windows names
        const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
        return !reservedNames.test(name);
    }, 'Endpoint name cannot use reserved system names')
        .refine((name) => {
        // Ensure name doesn't start/end with spaces or dots (problematic on Windows)
        return name.trim() === name && !name.startsWith('.') && !name.endsWith('.');
    }, 'Endpoint name cannot start/end with spaces or dots'),
    path: z.string()
        .min(1, 'Endpoint path is required')
        .refine((path) => path.startsWith('/'), 'Endpoint path must start with /'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    headers: z.union([
        z.record(z.string(), z.string()),
        z.record(z.string(), window.ZodSchemas.HeaderConfigSchema) // New format with enabled/disabled state
    ]),
    queryParams: z.union([
        z.record(z.string(), z.string()), // Legacy format for backward compatibility (GitHub Issue #101)
        z.record(z.string(), window.ZodSchemas.HeaderConfigSchema) // New format with enabled/disabled state (GitHub Issue #108)
    ]),
    body: z.string()
        .optional()
        .refine((body) => {
        // Allow empty/undefined body for all methods
        if (!body || body.trim() === '')
            return true;
        // Validate JSON format if body has content
        try {
            JSON.parse(body);
            return true;
        }
        catch {
            return false;
        }
    }, 'Request body must be valid JSON'),
    description: z.string().optional(),
    folder: z.string()
        .optional()
        .refine((folder) => {
        // Allow empty/undefined folder
        if (!folder || folder.trim() === '')
            return true;
        // Check for invalid characters that would cause folder creation issues
        const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
        return !invalidChars.test(folder);
    }, 'Folder name contains invalid characters')
        .refine((folder) => {
        // Check for reserved Windows names
        if (!folder || folder.trim() === '')
            return true;
        const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
        return !reservedNames.test(folder);
    }, 'Folder name cannot use reserved system names')
        .refine((folder) => {
        // Ensure folder doesn't start/end with spaces or dots (problematic on Windows)
        if (!folder || folder.trim() === '')
            return true;
        return folder.trim() === folder && !folder.startsWith('.') && !folder.endsWith('.');
    }, 'Folder name cannot start/end with spaces or dots'),
    dataLoadingConfig: window.ZodSchemas.DataLoadingConfigSchema.optional()
})
    .superRefine((data, ctx) => {
    // Method-specific body validation using superRefine for better error reporting
    // Note: We allow storing body for GET/DELETE requests to enable users to switch between methods
    // without losing data, but the body won't be used in actual GET/DELETE requests
    // The validation is now moved to the request execution phase rather than the save phase
    // Data loading validation - only POST supports data loading
    // Note: We allow saving dataLoadingConfig for non-POST methods but it won't be used
    // This allows users to switch between methods without losing their configuration
    if (data.dataLoadingConfig && data.method !== 'POST') {
        // We don't add an issue here - just allow the save
        // The data loading functionality will only be available for POST endpoints
        // but the configuration is preserved when switching methods
    }
});
// Webview Message Schemas
window.ZodSchemas.WebviewMessageSchema = z.object({
    type: z.string(),
}).passthrough(); // Allow additional properties
window.ZodSchemas.SaveEndpointMessageSchema = z.object({
    type: z.literal('saveEndpoint'),
    endpoint: window.ZodSchemas.APIEndpointConfigSchema
});
window.ZodSchemas.EndpointSavedMessageSchema = z.object({
    type: z.literal('endpointSaved'),
    endpoint: window.ZodSchemas.APIEndpointConfigSchema
});
window.ZodSchemas.EndpointSaveErrorMessageSchema = z.object({
    type: z.literal('endpointSaveError'),
    error: z.string()
});
// Default configuration factory functions
const createDefaultRetryConfig = () => ({
    maxAttempts: 1,
    delaySeconds: 5,
    retryConditions: {
        networkErrors: true,
        serverErrors: true,
        rateLimiting: true,
        clientErrors: false
    }
});
window.ZodSchemas.createDefaultRetryConfig = createDefaultRetryConfig;
const createDefaultErrorHandling = () => ({
    mode: 'stopOnFirst',
    retryConfig: (0, window.ZodSchemas.createDefaultRetryConfig)()
});
window.ZodSchemas.createDefaultErrorHandling = createDefaultErrorHandling;
const createDefaultDataValidation = () => ({
    enforceDataTypes: false,
    variableDataTypes: {}
});
window.ZodSchemas.createDefaultDataValidation = createDefaultDataValidation;
const createDefaultDataLoadingConfig = () => ({
    jsonTemplate: '',
    detectArrays: true,
    repeatableArrays: [],
    testScripts: [],
    errorHandling: (0, window.ZodSchemas.createDefaultErrorHandling)(),
    dataValidation: (0, window.ZodSchemas.createDefaultDataValidation)()
});
window.ZodSchemas.createDefaultDataLoadingConfig = createDefaultDataLoadingConfig;
// Validation helper functions
const validateDataLoadingConfig = (config) => {
    const result = window.ZodSchemas.DataLoadingConfigSchema.safeParse(config);
    if (result.success) {
        return { success: true, data: result.data };
    }
    else {
        const errors = result.error.errors.map(err => err.path.length > 0 ? `${err.path.join('.')}: ${err.message}` : err.message);
        return { success: false, errors };
    }
};
window.ZodSchemas.validateDataLoadingConfig = validateDataLoadingConfig;
const validateAPIEndpointConfig = (config) => {
    const result = window.ZodSchemas.APIEndpointConfigSchema.safeParse(config);
    if (result.success) {
        return { success: true, data: result.data };
    }
    else {
        const errors = result.error.errors.map(err => err.path.length > 0 ? `${err.path.join('.')}: ${err.message}` : err.message);
        return { success: false, errors };
    }
};
window.ZodSchemas.validateAPIEndpointConfig = validateAPIEndpointConfig;
// Schema exports for JavaScript frontend
window.ZodSchemas.schemas = {
    DataLoadingConfig: window.ZodSchemas.DataLoadingConfigSchema,
    APIEndpointConfig: window.ZodSchemas.APIEndpointConfigSchema,
    TestScript: window.ZodSchemas.TestScriptSchema,
    RetryConfig: window.ZodSchemas.RetryConfigSchema,
    ErrorHandlingConfig: window.ZodSchemas.ErrorHandlingConfigSchema,
    DataValidationConfig: window.ZodSchemas.DataValidationConfigSchema,
    SaveEndpointMessage: window.ZodSchemas.SaveEndpointMessageSchema,
    EndpointSavedMessage: window.ZodSchemas.EndpointSavedMessageSchema,
    EndpointSaveErrorMessage: window.ZodSchemas.EndpointSaveErrorMessageSchema
};

    
    // Export validation helpers for JavaScript
    window.ZodValidation = {
        validateDataLoadingConfig: window.ZodSchemas.validateDataLoadingConfig,
        validateAPIEndpointConfig: window.ZodSchemas.validateAPIEndpointConfig,
        createDefaultDataLoadingConfig: window.ZodSchemas.createDefaultDataLoadingConfig,
        createDefaultErrorHandling: window.ZodSchemas.createDefaultErrorHandling,
        createDefaultRetryConfig: window.ZodSchemas.createDefaultRetryConfig,
        createDefaultDataValidation: window.ZodSchemas.createDefaultDataValidation,
        schemas: window.ZodSchemas.schemas
    };
    
    console.log('✅ Zod validation schemas loaded successfully');
})();
