// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { z } from 'zod';
import { stripJsonCommentsSafe } from '../utils/json-comment-stripper';

/**
 * Zod Schemas for Data Loading Configuration
 * 
 * These schemas provide both TypeScript type inference and runtime validation
 * for sharing types between the TypeScript backend and JavaScript frontend.
 */

// Base data types
export const DataTypeSchema = z.enum(['string', 'number', 'boolean', 'date', 'datetime']);
export const ErrorHandlingModeSchema = z.enum(['stopOnFirst', 'continue']);
export const ErrorToleranceModeSchema = z.enum(['absolute', 'percentage']);

// Repeatable Array Configuration
export const RepeatableArraySchema = z.object({
    arrayPath: z.string().min(1, 'Array path is required'),
    maxRepetitions: z.number().min(1, 'Max repetitions must be greater than 0'),
    enabled: z.boolean()
});

// Repeatable Query Parameter Configuration (GitHub Issue #108)
export const RepeatableQueryParamSchema = z.object({
    enabled: z.boolean(),
    paramKey: z.string().min(1, 'Query param key is required'), // Actual URL query param key (e.g., "query")
    pattern: z.string().min(1, 'Query param pattern is required'), // Value pattern (e.g., "itemId={{item}}")
    separator: z.string(), // Can be empty string for no separator
    maxUrlLength: z.number().min(512).max(16384).default(2048),
    maxPerRequest: z.number().min(1).max(1000).nullish() // Accept null, undefined, or number
});

// Test Script Configuration
export const TestScriptSchema = z.object({
    name: z.string().min(1, 'Test script name is required'),
    script: z.string().min(1, 'Test script code is required'),
    enabled: z.boolean(),
    priority: z.number().min(0, 'Priority must be non-negative').default(0)
});

// Retry Conditions Configuration
export const RetryConditionsSchema = z.object({
    networkErrors: z.boolean(),
    serverErrors: z.boolean(),
    rateLimiting: z.boolean(),
    clientErrors: z.boolean()
});

// Retry Configuration
export const RetryConfigSchema = z.object({
    maxAttempts: z.number().min(0).max(5, 'Maximum retry attempts cannot exceed 5'),
    delaySeconds: z.number().min(1).max(30, 'Retry delay cannot exceed 30 seconds'),
    retryConditions: RetryConditionsSchema
});

// Error Tolerance Configuration
export const ErrorToleranceSchema = z.object({
    type: ErrorToleranceModeSchema,
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
export const ErrorHandlingConfigSchema = z.object({
    mode: ErrorHandlingModeSchema,
    // Flat structure fields (current implementation)
    enableErrorTolerance: z.boolean().optional(),
    toleranceMode: ErrorToleranceModeSchema.optional(),
    absoluteErrorLimit: z.number().min(1).max(1000).optional(),
    percentageErrorLimit: z.number().min(1).max(100).optional(),
    // Nested structure for backward compatibility
    maxErrorTolerance: z.object({
        enabled: z.boolean(),
        type: ErrorToleranceModeSchema,
        value: z.number().min(0)
    }).optional().refine((data) => {
        if (!data || !data.enabled) return true;
        if (data.type === 'percentage') {
            return data.value <= 100;
        }
        return true;
    }, {
        message: 'Error tolerance percentage cannot exceed 100'
    }),
    retryConfig: RetryConfigSchema
});

// Data Validation Configuration
export const DataValidationConfigSchema = z.object({
    enforceDataTypes: z.boolean(),
    variableDataTypes: z.record(z.string(), DataTypeSchema)
});

// Main Data Loading Configuration
export const DataLoadingConfigSchema = z.object({
    // JSON Template Configuration
    jsonTemplate: z.string().optional().refine((val) => {
        if (!val || val.trim() === '') return true;
        try {
            // Strip comments before validating JSON to support JSONC
            const cleanJson = stripJsonCommentsSafe(val);
            JSON.parse(cleanJson);
            return true;
        } catch {
            return false;
        }
    }, 'JSON template must be valid JSON (comments are allowed)'),
    
    detectArrays: z.boolean(),
    repeatableArrays: z.array(RepeatableArraySchema),

    // Repeatable Query Parameter Configuration (GitHub Issue #108)
    repeatableQueryParam: RepeatableQueryParamSchema.optional(),

    // JavaScript Test Configuration (multiple tests with priority ordering)
    testScripts: z.array(TestScriptSchema).optional().default([]),
    
    // Error Handling Configuration
    errorHandling: ErrorHandlingConfigSchema,
    
    // Data Validation Configuration
    dataValidation: DataValidationConfigSchema,

    // GitHub Issue #307: Run Batch remembers the last mapping — template variable → source
    // column — and pre-maps it next time a file has that column. The template is untouched.
    columnMappings: z.record(z.string(), z.string()).optional(),
    // Map's functions: each variable's steps (column-functions.ts ColumnFn: { fn, ...values }), remembered with its column
    columnFunctions: z.record(z.string(), z.array(z.object({ fn: z.string() }).passthrough())).optional()
});

// Header Configuration Schema
export const HeaderConfigSchema = z.object({
    value: z.string(),
    enabled: z.boolean()
});

// Console Views (GitHub Issue #229) — view-driven console rendering.
// A view is a saved column configuration per tab per endpoint. See
// docs/console/views/requirements.md for the full model.

type ViewColumnShape = {
    id: string;
    source: 'current' | 'ancestor' | 'nested';
    groupType?: 'object' | 'array';
    display?: 'grouped' | 'flattened';
    children?: ViewColumnShape[];
};

export const ViewColumnSchema: z.ZodType<ViewColumnShape> = z.lazy(() => z.object({
    id: z.string().min(1, 'Column id is required'),
    source: z.enum(['current', 'ancestor', 'nested']),
    groupType: z.enum(['object', 'array']).optional(),
    display: z.enum(['grouped', 'flattened']).optional(),
    children: z.array(ViewColumnSchema).optional()
}));

export const ConsoleViewSchema = z.object({
    name: z.string().min(1, 'View name is required'),
    rowBasis: z.string().min(1, 'Row basis is required'),
    columns: z.array(ViewColumnSchema),
    sortColumn: z.string().optional(),
    sortDirection: z.enum(['asc', 'desc']).optional(),
    /** A column's width set by the user on the table, in px, by column id. */
    columnWidths: z.record(z.number()).optional(),
    /** Record columns the user removed from a list of records, by path (`lines.qty`). */
    hiddenSubColumns: z.array(z.string()).optional(),
    /** Lists of records shown full width, under their row, by column id; the rest open in their cell. */
    recordsWide: z.array(z.string()).optional(),
    /** Saved searches: the search box's text under a name (dbmn-saved-searches), at most 50. */
    searches: z.array(z.object({ name: z.string().min(1).max(30), text: z.string().min(1) })).max(50).optional(),
    isAutoGenerated: z.boolean().optional(),
    // Issue #248: pre-canned views (e.g. Input tab "Mapped Columns" / "All Columns")
    // are derived from endpoint config + sample row and have no editing affordance.
    // Distinct from isAutoGenerated: a saved DEFAULT view becomes editable; these
    // never do.
    isReadOnly: z.boolean().optional()
});

export const TabViewSettingsSchema = z.object({
    activeView: z.string(),
    defaultView: z.string().optional(),
    views: z.array(ConsoleViewSchema)
});

/** A Requests tab View (#466/#468): which of a request's columns show, in what order. */
export const RequestsViewSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(100),
    columns: z.array(z.object({ id: z.string().min(1).max(300), hidden: z.boolean().optional() })).max(500),
    order: z.array(z.string().min(1).max(300)).max(500)
});

export const ConsoleViewsSchema = z.object({
    success: TabViewSettingsSchema,
    errors: TabViewSettingsSchema,
    // The Requests tab's own Views (request-views.ts), kept beside the data tabs'
    requests: z.object({ views: z.array(RequestsViewSchema) }).optional(),
    // The Input tab's saved searches (its Views are made, not kept): in a tab's shape, views always empty
    input: TabViewSettingsSchema.extend({
        searches: z.array(z.object({ name: z.string().min(1).max(30), text: z.string().min(1) })).max(50).optional()
    }).optional()
});

/**
 * Flavour — a body (and optional queryParams override) variation of a parent
 * Endpoint. Plan: Endpoints will hold a `flavours[]` collection; for now this
 * field is optional and the sanitiser keeps `body` and `flavours[0].body` in
 * sync so existing editor + execution paths continue to work unchanged.
 *
 * Naming: deliberately "Flavour" (UK spelling) to free "Version" for API-level
 * versioning (System v1.0, v1.1) — see plan i-want-to-talk-sparkling-rose.md.
 */
export const FlavourSchema = z.object({
    id: z.string().min(1, 'Flavour ID is required'),
    name: z.string().min(1, 'Flavour name is required'),
    body: z.string()
        .optional()
        .refine((body) => {
            if (!body || body.trim() === '') return true;
            try {
                const cleanBody = stripJsonCommentsSafe(body);
                JSON.parse(cleanBody);
                return true;
            } catch {
                return false;
            }
        }, 'Flavour body must be valid JSON (comments are allowed)'),
    bodyWithComments: z.string().optional(),
    /** Per-flavour queryParams override. Endpoint-level queryParams remain the baseline. */
    queryParams: z.union([
        z.record(z.string(), z.string()),
        z.record(z.string(), HeaderConfigSchema)
    ]).optional()
});
export type Flavour = z.infer<typeof FlavourSchema>;

// API Endpoint Configuration
export const APIEndpointConfigSchema = z.object({
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
        z.record(z.string(), z.string()), // Legacy format for backward compatibility
        z.record(z.string(), HeaderConfigSchema) // New format with enabled/disabled state
    ]),
    queryParams: z.union([
        z.record(z.string(), z.string()), // Legacy format for backward compatibility (GitHub Issue #101)
        z.record(z.string(), HeaderConfigSchema) // New format with enabled/disabled state (GitHub Issue #108)
    ]),
    body: z.string()
        .optional()
        .refine((body) => {
            // Allow empty/undefined body for all methods
            if (!body || body.trim() === '') return true;

            // Validate JSON format if body has content - strip comments first to support JSONC
            try {
                const cleanBody = stripJsonCommentsSafe(body);
                JSON.parse(cleanBody);
                return true;
            } catch {
                return false;
            }
        }, 'Request body must be valid JSON (comments are allowed)'),
    bodyWithComments: z.string().optional(),
    description: z.string().optional(),
    /**
     * @deprecated Endpoint folders were superseded by Systems + URL-segment
     * tree. The field is kept so legacy records still validate; nothing writes
     * to it anymore. Treat as inert tag-equivalent data.
     */
    folder: z.string().optional(),
    /** Owning System for this endpoint. Optional during rollout; populated by migration. */
    systemId: z.string().optional(),
    /**
     * Free-typed user tags. `/`-delimited values render as visual hierarchy in
     * the upcoming Catalogue browser. No tag-management UI — typos create new
     * tags (Linear/Postman style).
     */
    tags: z.array(z.string()).optional(),
    /**
     * Body/queryParam children of this Endpoint. Plan target: every Endpoint has
     * 1+ Flavours and `body` is derived from the active flavour. During the
     * rollout this field is optional — the sanitiser auto-wraps `body` into a
     * single Default flavour and keeps the two in sync so legacy consumers
     * (editor, console, batch) continue to read `body` directly.
     */
    flavours: z.array(FlavourSchema).optional(),
    dataLoadingConfig: DataLoadingConfigSchema.optional(),
    sequenceCounter: z.number().min(0).optional(),
    /** GitHub Issue #153: Per-array-path sequence counters for :global modifier */
    arraySequenceCounters: z.record(z.string(), z.number().min(0)).optional(),
    /** Endpoint-level variables that override environment variables (Issue #113 & #126) */
    variables: z.record(z.string(), z.string()).optional(),
    /** Whether to inherit headers from the connected environment (Issue #113). Default: true */
    useEnvironmentHeaders: z.boolean().optional(),
    /** Console view configurations per tab (GitHub Issue #229). Optional — auto Root view if absent. */
    consoleViews: ConsoleViewsSchema.optional()
})
.superRefine((data, ctx) => {
    // Method-specific body validation using superRefine for better error reporting
    // Note: We allow storing body for GET/DELETE requests to enable users to switch between methods
    // without losing data, but the body won't be used in actual GET/DELETE requests
    // The validation is now moved to the request execution phase rather than the save phase
    
    // Data loading validation - only methods with body (POST/PUT/PATCH) support data loading
    const methodsWithBody = ['POST', 'PUT', 'PATCH'];
    if (data.dataLoadingConfig && !methodsWithBody.includes(data.method)) {
        // Check if there's meaningful data loading configuration that requires a body
        const hasJsonTemplate = data.dataLoadingConfig.jsonTemplate && data.dataLoadingConfig.jsonTemplate.trim() !== '';
        const hasRepeatableArrays = data.dataLoadingConfig.repeatableArrays &&
                                   data.dataLoadingConfig.repeatableArrays.some(arr => arr.enabled);

        if (hasJsonTemplate || hasRepeatableArrays) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Data loading with JSON templates is only supported for POST, PUT, and PATCH endpoints'
            });
        }
    }
});

// Webview Message Schemas
export const WebviewMessageSchema = z.object({
    type: z.string(),
}).passthrough(); // Allow additional properties

export const SaveEndpointMessageSchema = z.object({
    type: z.literal('saveEndpoint'),
    endpoint: APIEndpointConfigSchema
});

export const EndpointSavedMessageSchema = z.object({
    type: z.literal('endpointSaved'),
    endpoint: APIEndpointConfigSchema
});

export const EndpointSaveErrorMessageSchema = z.object({
    type: z.literal('endpointSaveError'),
    error: z.string()
});

// Type inference for TypeScript backend
export type DataType = z.infer<typeof DataTypeSchema>;
export type ErrorHandlingMode = z.infer<typeof ErrorHandlingModeSchema>;
export type ErrorToleranceType = z.infer<typeof ErrorToleranceModeSchema>;
export type RepeatableArray = z.infer<typeof RepeatableArraySchema>;
export type RepeatableQueryParam = z.infer<typeof RepeatableQueryParamSchema>;
export type TestScript = z.infer<typeof TestScriptSchema>;
export type RetryConditions = z.infer<typeof RetryConditionsSchema>;
export type RetryConfig = z.infer<typeof RetryConfigSchema>;
export type ErrorTolerance = z.infer<typeof ErrorToleranceSchema>;
export type ErrorHandlingConfig = z.infer<typeof ErrorHandlingConfigSchema>;
export type DataValidationConfig = z.infer<typeof DataValidationConfigSchema>;
export type DataLoadingConfig = z.infer<typeof DataLoadingConfigSchema>;
export type HeaderConfig = z.infer<typeof HeaderConfigSchema>;
export type APIEndpointConfig = z.infer<typeof APIEndpointConfigSchema>;
export type ViewColumn = z.infer<typeof ViewColumnSchema>;
export type ConsoleView = z.infer<typeof ConsoleViewSchema>;
export type TabViewSettings = z.infer<typeof TabViewSettingsSchema>;
export type ConsoleViews = z.infer<typeof ConsoleViewsSchema>;

// Default configuration factory functions
export const createDefaultRetryConfig = (): RetryConfig => ({
    maxAttempts: 1,
    delaySeconds: 5,
    retryConditions: {
        networkErrors: true,
        serverErrors: true,
        rateLimiting: true,
        clientErrors: false
    }
});

export const createDefaultErrorHandling = (): ErrorHandlingConfig => ({
    mode: 'continue',
    retryConfig: createDefaultRetryConfig()
});

export const createDefaultDataValidation = (): DataValidationConfig => ({
    enforceDataTypes: false,
    variableDataTypes: {}
});

export const createDefaultDataLoadingConfig = (): DataLoadingConfig => ({
    jsonTemplate: '',
    detectArrays: true,
    repeatableArrays: [],
    testScripts: [],
    errorHandling: createDefaultErrorHandling(),
    dataValidation: createDefaultDataValidation()
});

// Validation helper functions
export const validateDataLoadingConfig = (config: unknown): { success: boolean; data?: DataLoadingConfig; errors?: string[] } => {
    const result = DataLoadingConfigSchema.safeParse(config);
    if (result.success) {
        return { success: true, data: result.data };
    } else {
        const errors = result.error.errors.map(err => 
            err.path.length > 0 ? `${err.path.join('.')}: ${err.message}` : err.message
        );
        return { success: false, errors };
    }
};

export const validateAPIEndpointConfig = (config: unknown): { success: boolean; data?: APIEndpointConfig; errors?: string[] } => {
    const result = APIEndpointConfigSchema.safeParse(config);
    if (result.success) {
        return { success: true, data: result.data };
    } else {
        const errors = result.error.errors.map(err => 
            err.path.length > 0 ? `${err.path.join('.')}: ${err.message}` : err.message
        );
        return { success: false, errors };
    }
};

// Schema exports for JavaScript frontend
export const schemas = {
    DataLoadingConfig: DataLoadingConfigSchema,
    APIEndpointConfig: APIEndpointConfigSchema,
    TestScript: TestScriptSchema,
    RetryConfig: RetryConfigSchema,
    ErrorHandlingConfig: ErrorHandlingConfigSchema,
    DataValidationConfig: DataValidationConfigSchema,
    HeaderConfig: HeaderConfigSchema,
    ViewColumn: ViewColumnSchema,
    ConsoleView: ConsoleViewSchema,
    TabViewSettings: TabViewSettingsSchema,
    ConsoleViews: ConsoleViewsSchema,
    SaveEndpointMessage: SaveEndpointMessageSchema,
    EndpointSavedMessage: EndpointSavedMessageSchema,
    EndpointSaveErrorMessage: EndpointSaveErrorMessageSchema
};