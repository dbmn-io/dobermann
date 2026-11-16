// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';

/**
 * Unit Tests for Template Analysis Utilities
 * 
 * These tests verify pure business logic for template variable extraction,
 * data type inference, and JSON validation without DOM dependencies.
 */

interface TemplateVariable {
    name: string;
    dataType: string;
    hasExplicitType: boolean;
    isRequired: boolean;
}

interface ArrayInfo {
    path: string;
    itemTemplate: string;
    variables: TemplateVariable[];
}

// Template Analysis Utility Functions
class TemplateAnalyzer {
    /**
     * Extracts variables from template string
     */
    static extractVariables(template: string): TemplateVariable[] {
        const variablePattern = /\{\{([^}]+)\}\}/g;
        const variables: TemplateVariable[] = [];
        let match;

        while ((match = variablePattern.exec(template)) !== null) {
            const variableExpression = match[1].trim();
            const variable = this.parseVariableExpression(variableExpression);
            
            // Avoid duplicates
            if (!variables.some(v => v.name === variable.name)) {
                variables.push(variable);
            }
        }

        return variables;
    }

    /**
     * Parses variable expression to extract name and type
     */
    private static parseVariableExpression(expression: string): TemplateVariable {
        const typePattern = /^([^:]+):([^:]+)$/;
        const match = expression.match(typePattern);

        if (match) {
            return {
                name: match[1].trim(),
                dataType: match[2].trim(),
                hasExplicitType: true,
                isRequired: true
            };
        }

        return {
            name: expression,
            dataType: 'string',
            hasExplicitType: false,
            isRequired: true
        };
    }

    /**
     * Detects array structures in JSON template
     */
    static detectArrays(template: string): ArrayInfo[] {
        let parsedTemplate;
        try {
            parsedTemplate = JSON.parse(template);
        } catch {
            return [];
        }

        const arrays: ArrayInfo[] = [];
        this.findArraysRecursive(parsedTemplate, '', arrays);
        return arrays;
    }

    /**
     * Recursively finds arrays in JSON structure
     */
    private static findArraysRecursive(obj: any, path: string, arrays: ArrayInfo[]): void {
        if (Array.isArray(obj) && obj.length > 0) {
            const itemTemplate = JSON.stringify(obj[0]);
            const variables = this.extractVariables(itemTemplate);
            
            arrays.push({
                path: path || 'root',
                itemTemplate,
                variables
            });
            
            // Also check inside the array items for nested arrays
            this.findArraysRecursive(obj[0], path, arrays);
        } else if (typeof obj === 'object' && obj !== null) {
            for (const [key, value] of Object.entries(obj)) {
                const newPath = path ? `${path}.${key}` : key;
                this.findArraysRecursive(value, newPath, arrays);
            }
        }
    }

    /**
     * Validates JSON template structure
     */
    static validateJsonTemplate(template: string): { isValid: boolean; error?: string } {
        try {
            JSON.parse(template);
            return { isValid: true };
        } catch (error: any) {
            return { 
                isValid: false, 
                error: error instanceof Error ? error.message : 'Invalid JSON'
            };
        }
    }

    /**
     * Infers data type from variable name and context
     */
    static inferDataType(variableName: string): string {
        const name = variableName.toLowerCase();
        
        if (name.includes('date') || name.includes('time')) {
            return 'date';
        }
        if (name.includes('count') || name.includes('quantity') || name.includes('amount')) {
            return 'number';
        }
        if (name.includes('active') || name.includes('enabled') || name.includes('valid')) {
            return 'boolean';
        }
        if (name.includes('id') || name.includes('code') || name.includes('key')) {
            return 'string';
        }
        
        return 'string';
    }

    /**
     * Validates variable name format
     */
    static validateVariableName(name: string): { isValid: boolean; error?: string } {
        if (!name || name.trim() === '') {
            return { isValid: false, error: 'Variable name cannot be empty' };
        }

        const validNamePattern = /^[A-Z_][A-Z0-9_]*$/;
        if (!validNamePattern.test(name)) {
            return { 
                isValid: false, 
                error: 'Variable name must start with letter or underscore and contain only uppercase letters, numbers, and underscores'
            };
        }

        return { isValid: true };
    }
}

describe('Template Analysis Utilities', () => {
    
    describe('extractVariables', () => {
        it('should extract simple variables without types', () => {
            const template = '{"itemId": "{{SKU}}", "location": "{{BIN_LOCN}}"}';
            const variables = TemplateAnalyzer.extractVariables(template);
            
            expect(variables).to.have.length(2);
            
            const skuVar = variables.find(v => v.name === 'SKU');
            expect(skuVar).to.not.be.undefined;
            expect(skuVar?.dataType).to.equal('string');
            expect(skuVar?.hasExplicitType).to.be.false;
            
            const locationVar = variables.find(v => v.name === 'BIN_LOCN');
            expect(locationVar).to.not.be.undefined;
            expect(locationVar?.dataType).to.equal('string');
            expect(locationVar?.hasExplicitType).to.be.false;
        });

        it('should extract variables with explicit data types', () => {
            const template = '{"quantity": "{{QUANTITY:number}}", "active": "{{ACTIVE:boolean}}", "date": "{{LOAD_DATE:date}}"}';
            const variables = TemplateAnalyzer.extractVariables(template);
            
            expect(variables).to.have.length(3);
            
            const quantityVar = variables.find(v => v.name === 'QUANTITY');
            expect(quantityVar?.dataType).to.equal('number');
            expect(quantityVar?.hasExplicitType).to.be.true;
            
            const activeVar = variables.find(v => v.name === 'ACTIVE');
            expect(activeVar?.dataType).to.equal('boolean');
            expect(activeVar?.hasExplicitType).to.be.true;
            
            const dateVar = variables.find(v => v.name === 'LOAD_DATE');
            expect(dateVar?.dataType).to.equal('date');
            expect(dateVar?.hasExplicitType).to.be.true;
        });

        it('should avoid duplicate variables', () => {
            const template = '{"a": "{{SKU}}", "b": "{{SKU}}", "c": "{{QUANTITY:number}}"}';
            const variables = TemplateAnalyzer.extractVariables(template);
            
            expect(variables).to.have.length(2);
            expect(variables.map(v => v.name)).to.include.members(['SKU', 'QUANTITY']);
        });

        it('should handle empty template', () => {
            const variables = TemplateAnalyzer.extractVariables('');
            expect(variables).to.have.length(0);
        });
    });

    describe('detectArrays', () => {
        it('should detect simple array structures', () => {
            const template = '{"items": [{"sku": "{{SKU}}", "qty": "{{QUANTITY:number}}"}]}';
            const arrays = TemplateAnalyzer.detectArrays(template);
            
            expect(arrays).to.have.length(1);
            expect(arrays[0].path).to.equal('items');
            expect(arrays[0].variables).to.have.length(2);
        });

        it('should detect nested arrays', () => {
            const template = '{"orders": [{"items": [{"sku": "{{SKU}}"}]}]}';
            const arrays = TemplateAnalyzer.detectArrays(template);
            
            expect(arrays).to.have.length(2);
            expect(arrays.map(a => a.path)).to.include.members(['orders', 'orders.items']);
        });

        it('should return empty array for invalid JSON', () => {
            const template = '{"invalid": json}';
            const arrays = TemplateAnalyzer.detectArrays(template);
            
            expect(arrays).to.have.length(0);
        });

        it('should handle empty arrays', () => {
            const template = '{"items": []}';
            const arrays = TemplateAnalyzer.detectArrays(template);
            
            expect(arrays).to.have.length(0);
        });
    });

    describe('validateJsonTemplate', () => {
        it('should validate correct JSON', () => {
            const template = '{"valid": "json", "with": {"nested": "object"}}';
            const result = TemplateAnalyzer.validateJsonTemplate(template);
            
            expect(result.isValid).to.be.true;
            expect(result.error).to.be.undefined;
        });

        it('should detect invalid JSON', () => {
            const template = '{"invalid": json, "missing": quotes}';
            const result = TemplateAnalyzer.validateJsonTemplate(template);
            
            expect(result.isValid).to.be.false;
            expect(result.error).to.not.be.undefined;
        });

        it('should handle empty string', () => {
            const result = TemplateAnalyzer.validateJsonTemplate('');
            
            expect(result.isValid).to.be.false;
            expect(result.error).to.not.be.undefined;
        });
    });

    describe('inferDataType', () => {
        it('should infer date type from variable names', () => {
            expect(TemplateAnalyzer.inferDataType('LOAD_DATE')).to.equal('date');
            expect(TemplateAnalyzer.inferDataType('TIMESTAMP')).to.equal('date');
            expect(TemplateAnalyzer.inferDataType('CREATE_TIME')).to.equal('date');
        });

        it('should infer number type from variable names', () => {
            expect(TemplateAnalyzer.inferDataType('QUANTITY')).to.equal('number');
            expect(TemplateAnalyzer.inferDataType('ITEM_COUNT')).to.equal('number');
            expect(TemplateAnalyzer.inferDataType('TOTAL_AMOUNT')).to.equal('number');
        });

        it('should infer boolean type from variable names', () => {
            expect(TemplateAnalyzer.inferDataType('IS_ACTIVE')).to.equal('boolean');
            expect(TemplateAnalyzer.inferDataType('ENABLED')).to.equal('boolean');
            expect(TemplateAnalyzer.inferDataType('VALID')).to.equal('boolean');
        });

        it('should default to string type', () => {
            expect(TemplateAnalyzer.inferDataType('SKU')).to.equal('string');
            expect(TemplateAnalyzer.inferDataType('DESCRIPTION')).to.equal('string');
            expect(TemplateAnalyzer.inferDataType('UNKNOWN_FIELD')).to.equal('string');
        });
    });

    describe('validateVariableName', () => {
        it('should validate correct variable names', () => {
            expect(TemplateAnalyzer.validateVariableName('SKU').isValid).to.be.true;
            expect(TemplateAnalyzer.validateVariableName('ITEM_ID').isValid).to.be.true;
            expect(TemplateAnalyzer.validateVariableName('_PRIVATE').isValid).to.be.true;
            expect(TemplateAnalyzer.validateVariableName('A123').isValid).to.be.true;
        });

        it('should reject invalid variable names', () => {
            expect(TemplateAnalyzer.validateVariableName('').isValid).to.be.false;
            expect(TemplateAnalyzer.validateVariableName('123ABC').isValid).to.be.false;
            expect(TemplateAnalyzer.validateVariableName('item-id').isValid).to.be.false;
            expect(TemplateAnalyzer.validateVariableName('item.id').isValid).to.be.false;
            expect(TemplateAnalyzer.validateVariableName('item id').isValid).to.be.false;
        });

        it('should provide meaningful error messages', () => {
            const result = TemplateAnalyzer.validateVariableName('123ABC');
            expect(result.error).to.include('must start with letter or underscore');
        });
    });
});