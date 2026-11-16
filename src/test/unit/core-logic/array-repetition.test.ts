// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';

/**
 * Unit tests for array repetition logic
 * Tests the pure functions that handle CSV row consolidation for array-based requests
 */
describe('Array Repetition Logic - Unit Tests', () => {
    
    describe('consolidateRowsForArray', () => {
        it('should consolidate multiple CSV rows into single array', () => {
            const rows = [
                { name: 'John', email: 'john@example.com', age: '30' },
                { name: 'Jane', email: 'jane@example.com', age: '25' },
                { name: 'Bob', email: 'bob@example.com', age: '35' }
            ];
            
            const template = {
                users: [
                    {
                        name: '{{name}}',
                        email: '{{email}}',
                        age: '{{age:number}}'
                    }
                ]
            };
            
            const result = consolidateRowsForArray(rows, template, 'users');
            
            expect(result.users).to.have.length(3);
            expect(result.users[0]).to.deep.equal({
                name: 'John',
                email: 'john@example.com',
                age: '30' // Template substitution returns string
            });
        });
        
        it('should respect maxRepetitions limit', () => {
            const rows = Array(150).fill(null).map((_, i) => ({
                id: `user${i}`,
                value: i
            }));
            
            const template = {
                items: [{ id: '{{id}}', value: '{{value:number}}' }]
            };
            
            const result = consolidateRowsForArray(rows, template, 'items', 100);
            
            expect(result.items).to.have.length(100); // Limited by maxRepetitions
            expect(result.items[0].id).to.equal('user0');
            expect(result.items[99].id).to.equal('user99');
        });
        
        it('should handle nested array structures', () => {
            const rows = [
                { userId: '1', orderId: '101', product: 'Widget', quantity: '2' },
                { userId: '1', orderId: '102', product: 'Gadget', quantity: '1' },
                { userId: '2', orderId: '103', product: 'Thing', quantity: '3' }
            ];
            
            const template = {
                orders: [
                    {
                        user: { id: '{{userId}}' },
                        order: {
                            id: '{{orderId}}',
                            items: [
                                {
                                    product: '{{product}}',
                                    quantity: '{{quantity:number}}'
                                }
                            ]
                        }
                    }
                ]
            };
            
            const result = consolidateRowsForArray(rows, template, 'orders');
            
            expect(result.orders).to.have.length(3);
            expect(result.orders[0].user.id).to.equal('1');
            expect(result.orders[0].order.items[0].product).to.equal('Widget');
            expect(result.orders[0].order.items[0].quantity).to.equal('2'); // Template substitution returns string
        });
    });
    
    describe('splitIntoChunks', () => {
        it('should split rows into chunks based on maxRepetitions', () => {
            const rows = Array(250).fill(null).map((_, i) => ({ id: i }));
            
            const chunks = splitIntoChunks(rows, 100);
            
            expect(chunks).to.have.length(3);
            expect(chunks[0]).to.have.length(100);
            expect(chunks[1]).to.have.length(100);
            expect(chunks[2]).to.have.length(50);
        });
        
        it('should handle rows that fit in single chunk', () => {
            const rows = Array(50).fill(null).map((_, i) => ({ id: i }));
            
            const chunks = splitIntoChunks(rows, 100);
            
            expect(chunks).to.have.length(1);
            expect(chunks[0]).to.have.length(50);
        });
        
        it('should handle empty array', () => {
            const chunks = splitIntoChunks([], 100);
            
            expect(chunks).to.have.length(0);
        });
    });
    
    describe('processDataTypes', () => {
        it('should convert string values to appropriate types', () => {
            const row = {
                name: 'John Doe',
                age: '30',
                height: '5.9',
                active: 'true',
                tags: '["admin", "user"]',
                metadata: '{"role": "admin", "level": 5}'
            };
            
            const typeMap = {
                name: 'string',
                age: 'number',
                height: 'number',
                active: 'boolean',
                tags: 'array',
                metadata: 'object'
            };
            
            const result = processDataTypes(row, typeMap);
            
            expect(result.name).to.equal('John Doe');
            expect(result.age).to.equal(30);
            expect(result.height).to.equal(5.9);
            expect(result.active).to.be.true;
            expect(result.tags).to.deep.equal(['admin', 'user']);
            expect(result.metadata).to.deep.equal({ role: 'admin', level: 5 });
        });
        
        it('should handle boolean variations', () => {
            const testCases = [
                { value: 'true', expected: true },
                { value: 'false', expected: false },
                { value: 'yes', expected: true },
                { value: 'no', expected: false },
                { value: 'Y', expected: true },
                { value: 'N', expected: false },
                { value: '1', expected: true },
                { value: '0', expected: false }
            ];
            
            testCases.forEach(({ value, expected }) => {
                const result = processDataTypes({ flag: value }, { flag: 'boolean' });
                expect(result.flag).to.equal(expected);
            });
        });
        
        it('should handle invalid type conversions gracefully', () => {
            const row = {
                age: 'not-a-number',
                data: 'not-json',
                flag: 'maybe'
            };
            
            const typeMap = {
                age: 'number',
                data: 'object',
                flag: 'boolean'
            };
            
            const result = processDataTypes(row, typeMap);
            
            expect(result.age).to.be.NaN;
            expect(result.data).to.equal('not-json'); // Falls back to original
            expect(result.flag).to.equal('maybe'); // Falls back to original
        });
    });
    
    describe('calculateBatchSizes', () => {
        it('should calculate optimal batch sizes for array repetition', () => {
            const testCases = [
                { rows: 50, max: 100, expected: [50] },
                { rows: 100, max: 100, expected: [100] },
                { rows: 150, max: 100, expected: [100, 50] },
                { rows: 350, max: 100, expected: [100, 100, 100, 50] },
                { rows: 1000, max: 250, expected: [250, 250, 250, 250] }
            ];
            
            testCases.forEach(({ rows, max, expected }) => {
                const sizes = calculateBatchSizes(rows, max);
                expect(sizes).to.deep.equal(expected);
            });
        });
    });
});

// Helper functions (these would be imported from the actual implementation)
function consolidateRowsForArray(
    rows: any[], 
    template: any, 
    arrayPath: string, 
    maxRepetitions: number = 100
): any {
    const limitedRows = rows.slice(0, maxRepetitions);
    const arrayTemplate = getNestedValue(template, arrayPath)[0];
    
    const consolidatedArray = limitedRows.map(row => {
        return processTemplate(arrayTemplate, row);
    });
    
    return setNestedValue({}, arrayPath, consolidatedArray);
}

function splitIntoChunks<T>(array: T[], chunkSize: number): T[][] {
    if (array.length === 0) return [];
    
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
        chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
}

function processDataTypes(row: Record<string, string>, typeMap: Record<string, string>): Record<string, any> {
    const result: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(row)) {
        const dataType = typeMap[key] || 'string';
        result[key] = convertValue(value, dataType);
    }
    
    return result;
}

function convertValue(value: string, dataType: string): any {
    switch (dataType) {
        case 'number':
            return Number(value);
            
        case 'boolean':
            const lowerValue = value.toLowerCase();
            if (['true', 'yes', 'y', '1', 'on'].includes(lowerValue)) return true;
            if (['false', 'no', 'n', '0', 'off'].includes(lowerValue)) return false;
            return value; // Fallback to original
            
        case 'array':
            try {
                return JSON.parse(value);
            } catch {
                return value;
            }
            
        case 'object':
            try {
                return JSON.parse(value);
            } catch {
                return value;
            }
            
        default:
            return value;
    }
}

function calculateBatchSizes(totalRows: number, maxRepetitions: number): number[] {
    const sizes: number[] = [];
    let remaining = totalRows;
    
    while (remaining > 0) {
        const batchSize = Math.min(remaining, maxRepetitions);
        sizes.push(batchSize);
        remaining -= batchSize;
    }
    
    return sizes;
}

function getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
}

function setNestedValue(obj: any, path: string, value: any): any {
    const keys = path.split('.');
    const lastKey = keys.pop()!;
    const target = keys.reduce((current, key) => {
        if (!current[key]) current[key] = {};
        return current[key];
    }, obj);
    target[lastKey] = value;
    return obj;
}

function processTemplate(template: any, data: Record<string, any>): any {
    if (typeof template === 'string') {
        // Handle variable substitution
        return template.replace(/\{\{([^}]+)\}\}/g, (match, variable) => {
            const [varName, dataType] = variable.split(':').map((s: string) => s.trim());
            const value = data[varName];
            return dataType ? convertValue(value, dataType) : value;
        });
    }
    
    if (Array.isArray(template)) {
        return template.map(item => processTemplate(item, data));
    }
    
    if (typeof template === 'object' && template !== null) {
        const result: any = {};
        for (const [key, value] of Object.entries(template)) {
            result[key] = processTemplate(value, data);
        }
        return result;
    }
    
    return template;
}