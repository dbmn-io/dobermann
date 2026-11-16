// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Zod Library for Webview JavaScript
 * 
 * This is a browser-compatible version of the Zod validation library.
 * It provides runtime type validation for the webview environment.
 */

(function() {
    // Create a simple module system for loading Zod
    const require = function(name) {
        if (name === 'zod') {
            return window.z;
        }
        throw new Error('Module not found: ' + name);
    };
    
    const module = { exports: {} };
    const exports = module.exports;
    
    // Load the Zod library source
    // This would contain the actual Zod source code
    // For now, let's create a minimal implementation that works with our schemas
    
    const ZodError = class extends Error {
        constructor(errors) {
            super('Validation error');
            this.name = 'ZodError';
            this.errors = errors;
        }
    };
    
    const createValidator = (type, message) => ({
        parse: (data) => {
            const result = validate(type, data);
            if (!result.success) {
                throw new ZodError(result.errors);
            }
            return data;
        },
        safeParse: (data) => validate(type, data)
    });
    
    const validate = (type, data) => {
        const errors = [];
        
        switch (type) {
            case 'string':
                if (typeof data !== 'string') {
                    errors.push({ path: [], message: 'Expected string, received ' + typeof data });
                }
                break;
            case 'number':
                if (typeof data !== 'number' || isNaN(data)) {
                    errors.push({ path: [], message: 'Expected number, received ' + typeof data });
                }
                break;
            case 'boolean':
                if (typeof data !== 'boolean') {
                    errors.push({ path: [], message: 'Expected boolean, received ' + typeof data });
                }
                break;
            case 'object':
                if (typeof data !== 'object' || data === null || Array.isArray(data)) {
                    errors.push({ path: [], message: 'Expected object, received ' + typeof data });
                }
                break;
            case 'array':
                if (!Array.isArray(data)) {
                    errors.push({ path: [], message: 'Expected array, received ' + typeof data });
                }
                break;
        }
        
        return errors.length === 0 ? { success: true, data } : { success: false, errors };
    };
    
    // Simplified Zod implementation for webview use
    const z = {
        string: () => ({
            min: (length, message) => createValidator('string', message),
            optional: () => createValidator('string', ''),
            refine: (fn, config) => createValidator('string', config?.message || '')
        }),
        number: () => ({
            min: (min, message) => ({
                max: (max, message2) => createValidator('number', message2 || message),
                safeParse: (data) => validate('number', data)
            }),
            max: (max, message) => ({
                min: (min, message2) => createValidator('number', message2 || message),
                safeParse: (data) => validate('number', data)
            }),
            safeParse: (data) => validate('number', data)
        }),
        boolean: () => createValidator('boolean', ''),
        object: (shape) => ({
            optional: () => ({
                safeParse: (data) => {
                    if (data === undefined) {
                        return { success: true, data: undefined };
                    }
                    return z.object(shape).safeParse(data);
                }
            }),
            refine: (fn, config) => ({
                safeParse: (data) => {
                    // Basic object validation
                    if (typeof data !== 'object' || data === null) {
                        return { success: false, errors: [{ path: [], message: 'Expected object' }] };
                    }
                    
                    // Validate shape
                    const errors = [];
                    for (const [key, validator] of Object.entries(shape)) {
                        if (data[key] !== undefined) {
                            const result = validator.safeParse(data[key]);
                            if (!result.success) {
                                errors.push(...result.errors.map(err => ({
                                    ...err,
                                    path: [key, ...err.path]
                                })));
                            }
                        }
                    }
                    
                    if (errors.length > 0) {
                        return { success: false, errors };
                    }
                    
                    // Apply refinement
                    try {
                        const isValid = fn(data);
                        if (!isValid) {
                            return { 
                                success: false, 
                                errors: [{ 
                                    path: config?.path || [], 
                                    message: config?.message || 'Refinement failed' 
                                }] 
                            };
                        }
                    } catch (error) {
                        return { 
                            success: false, 
                            errors: [{ path: [], message: error.message }] 
                        };
                    }
                    
                    return { success: true, data };
                }
            })
        }),
        array: (element) => createValidator('array', ''),
        enum: (values) => createValidator('string', ''),
        literal: (value) => createValidator('string', ''),
        record: (keyType, valueType) => createValidator('object', ''),
        optional: (schema) => ({
            safeParse: (data) => {
                if (data === undefined) {
                    return { success: true, data: undefined };
                }
                return schema.safeParse(data);
            }
        })
    };
    
    // Export Zod to global scope
    window.z = z;
    window.ZodError = ZodError;
    
    console.log('✅ Simplified Zod library loaded for webview use');
})();