/**
 * Test fixture utilities for file format testing
 */

import * as fs from 'fs';
import * as path from 'path';

export interface TestFixture {
    name: string;
    fileName: string;
    format: 'csv' | 'tsv' | 'txt' | 'custom';
    expectedDelimiter: string;
    expectedColumns: string[];
    expectedTypes: { [columnName: string]: string };
    description: string;
}

/**
 * Test fixture definitions
 */
export const TEST_FIXTURES: TestFixture[] = [
    {
        name: 'COBOL Sample',
        fileName: 'cobol-sample.txt',
        format: 'txt',
        expectedDelimiter: '|',
        expectedColumns: ['name', 'amount', 'balance', 'active', 'date'],
        expectedTypes: {
            'name': 'string',
            'amount': 'number',
            'balance': 'number', 
            'active': 'boolean',
            'date': 'date'
        },
        description: 'COBOL format with pipe delimiters and padded numbers'
    },
    {
        name: 'Standard CSV',
        fileName: 'standard-csv.csv', 
        format: 'csv',
        expectedDelimiter: ',',
        expectedColumns: ['name', 'amount', 'balance', 'active', 'date'],
        expectedTypes: {
            'name': 'string',
            'amount': 'number',
            'balance': 'number',
            'active': 'boolean', 
            'date': 'date'
        },
        description: 'Standard comma-separated CSV with quoted values'
    },
    {
        name: 'Tab Separated',
        fileName: 'tab-separated.tsv',
        format: 'tsv', 
        expectedDelimiter: '\t',
        expectedColumns: ['name', 'amount', 'balance', 'active', 'date'],
        expectedTypes: {
            'name': 'string',
            'amount': 'number',
            'balance': 'number',
            'active': 'boolean',
            'date': 'date'
        },
        description: 'Tab-delimited values file'
    },
    {
        name: 'Mixed Data Types',
        fileName: 'mixed-data-types.csv',
        format: 'csv',
        expectedDelimiter: ',',
        expectedColumns: ['id', 'name', 'salary', 'start_date', 'is_active', 'rating', 'notes'],
        expectedTypes: {
            'id': 'number',
            'name': 'string', 
            'salary': 'number',
            'start_date': 'date',
            'is_active': 'boolean',
            'rating': 'number',
            'notes': 'string'
        },
        description: 'Mixed data types for comprehensive type detection testing'
    },
    {
        name: 'Scientific Notation',
        fileName: 'scientific-notation.csv',
        format: 'csv',
        expectedDelimiter: ',',
        expectedColumns: ['measurement_id', 'temperature', 'pressure', 'volume', 'concentration'],
        expectedTypes: {
            'measurement_id': 'string',
            'temperature': 'number',
            'pressure': 'number', 
            'volume': 'number',
            'concentration': 'number'
        },
        description: 'Scientific notation numbers for numeric type detection'
    },
    {
        name: 'Currency Formats',
        fileName: 'currency-formats.csv',
        format: 'csv',
        expectedDelimiter: ',', 
        expectedColumns: ['item', 'price_usd', 'price_eur', 'price_gbp', 'discount_pct'],
        expectedTypes: {
            'item': 'string',
            'price_usd': 'currency',
            'price_eur': 'currency',
            'price_gbp': 'currency',
            'discount_pct': 'number'
        },
        description: 'Currency and percentage formats'
    }
];

/**
 * Load test fixture content
 */
export function loadFixture(fixtureName: string): string {
    const fixturesDir = path.join(__dirname, '../fixtures/file-formats');
    const fixture = TEST_FIXTURES.find(f => f.name === fixtureName || f.fileName === fixtureName);
    
    if (!fixture) {
        throw new Error(`Test fixture '${fixtureName}' not found`);
    }
    
    const filePath = path.join(fixturesDir, fixture.fileName);
    
    if (!fs.existsSync(filePath)) {
        throw new Error(`Fixture file not found: ${filePath}`);
    }
    
    return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Get fixture definition by name
 */
export function getFixture(fixtureName: string): TestFixture {
    const fixture = TEST_FIXTURES.find(f => f.name === fixtureName || f.fileName === fixtureName);
    
    if (!fixture) {
        throw new Error(`Test fixture '${fixtureName}' not found`);
    }
    
    return fixture;
}

/**
 * Get all fixture names
 */
export function getAllFixtureNames(): string[] {
    return TEST_FIXTURES.map(f => f.name);
}

/**
 * Load fixture as Buffer (for binary format testing)
 */
export function loadFixtureAsBuffer(fixtureName: string): Buffer {
    const fixturesDir = path.join(__dirname, '../fixtures/file-formats');
    const fixture = TEST_FIXTURES.find(f => f.name === fixtureName || f.fileName === fixtureName);
    
    if (!fixture) {
        throw new Error(`Test fixture '${fixtureName}' not found`);
    }
    
    const filePath = path.join(fixturesDir, fixture.fileName);
    
    if (!fs.existsSync(filePath)) {
        throw new Error(`Fixture file not found: ${filePath}`);
    }
    
    return fs.readFileSync(filePath);
}