// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for array repetition with nested templates (GitHub Issue #147)
 *
 * TDD approach: These tests define the expected behavior when both:
 * 1. Template has nested arrays (e.g., Data[].LocationItemAssignment[])
 * 2. User has configured array repetition with maxRepetitions
 *
 * The maxRepetitions setting should be respected even when nested arrays are detected.
 * Nested grouping and array repetition should work TOGETHER:
 * - Step 1: Group CSV rows by outer variable (if needed)
 * - Step 2: Batch those groups by maxRepetitions
 */

import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import { JsonGenerator } from '../../../data-loading/json-generator';

describe('JsonGenerator - Array Repetition with Nested Templates (GitHub Issue #147)', () => {
    let jsonGenerator: JsonGenerator;

    beforeEach(() => {
        jsonGenerator = new JsonGenerator();
    });

    describe('generateBatchJsonFiles() with nested template and array repetition', () => {

        it('should respect maxRepetitions when template has 2-level nested arrays', async () => {
            // Template like user's: Data[].LocationItemAssignment[]
            const template = JSON.stringify({
                Data: [{
                    LocationId: '{{LocationId}}',
                    StorageUomId: 'UNIT',
                    LocationItemAssignment: [{
                        LocationId: '{{LocationId}}',
                        ItemId: '{{ItemId}}'
                    }]
                }]
            });

            // 10 rows of CSV data - each row is independent (no grouping relationship)
            const csvData = `LocationId,ItemId
LOC001,ITEM001
LOC002,ITEM002
LOC003,ITEM003
LOC004,ITEM004
LOC005,ITEM005
LOC006,ITEM006
LOC007,ITEM007
LOC008,ITEM008
LOC009,ITEM009
LOC010,ITEM010`;

            const options = {
                template,
                repeatableArrays: [{
                    arrayPath: 'Data',
                    enabled: true,
                    maxRepetitions: 5  // 10 rows / 5 = 2 files expected
                }],
                mappings: [
                    { variable: 'LocationId', column: 'LocationId', dataType: 'string' },
                    { variable: 'ItemId', column: 'ItemId', dataType: 'string' }
                ],
                headers: ['LocationId', 'ItemId']
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            // With 10 rows and maxRepetitions=5, we expect 2 files
            // Each file should have 5 items in the Data array
            expect(result.success).to.be.true;
            expect(result.files.length).to.equal(2,
                `Expected 2 files (10 rows / 5 maxReps), but got ${result.files.length}`);

            // Verify metadata
            expect(result.metadata.arrayRepetitionUsed).to.be.true;
            expect(result.metadata.maxRepetitions).to.equal(5);

            // Verify first file has 5 Data items
            const firstFileContent = result.files[0].content;
            expect(firstFileContent.Data.length).to.equal(5,
                `Expected first file to have 5 Data items, got ${firstFileContent.Data.length}`);

            // Verify second file has 5 Data items
            const secondFileContent = result.files[1].content;
            expect(secondFileContent.Data.length).to.equal(5,
                `Expected second file to have 5 Data items, got ${secondFileContent.Data.length}`);
        });

        it('should create single file when all rows fit within maxRepetitions', async () => {
            const template = JSON.stringify({
                Data: [{
                    LocationId: '{{LocationId}}',
                    LocationItemAssignment: [{
                        ItemId: '{{ItemId}}'
                    }]
                }]
            });

            // 5 rows of CSV data
            const csvData = `LocationId,ItemId
LOC001,ITEM001
LOC002,ITEM002
LOC003,ITEM003
LOC004,ITEM004
LOC005,ITEM005`;

            const options = {
                template,
                repeatableArrays: [{
                    arrayPath: 'Data',
                    enabled: true,
                    maxRepetitions: 50  // 5 rows easily fit in 50
                }],
                mappings: [
                    { variable: 'LocationId', column: 'LocationId', dataType: 'string' },
                    { variable: 'ItemId', column: 'ItemId', dataType: 'string' }
                ],
                headers: ['LocationId', 'ItemId']
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            // With 5 rows and maxRepetitions=50, we expect 1 file
            expect(result.success).to.be.true;
            expect(result.files.length).to.equal(1,
                `Expected 1 file (5 rows < 50 maxReps), but got ${result.files.length}`);

            // Verify the single file has all 5 Data items
            const fileContent = result.files[0].content;
            expect(fileContent.Data.length).to.equal(5,
                `Expected file to have 5 Data items, got ${fileContent.Data.length}`);
        });

        it('should handle partial last batch correctly', async () => {
            const template = JSON.stringify({
                Data: [{
                    Id: '{{Id}}',
                    Items: [{ Value: '{{Value}}' }]
                }]
            });

            // 7 rows - should create 3 files with maxReps=3 (3+3+1)
            const csvData = `Id,Value
1,A
2,B
3,C
4,D
5,E
6,F
7,G`;

            const options = {
                template,
                repeatableArrays: [{
                    arrayPath: 'Data',
                    enabled: true,
                    maxRepetitions: 3  // 7 rows / 3 = 3 files (3+3+1)
                }],
                mappings: [
                    { variable: 'Id', column: 'Id', dataType: 'string' },
                    { variable: 'Value', column: 'Value', dataType: 'string' }
                ],
                headers: ['Id', 'Value']
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            expect(result.files.length).to.equal(3,
                `Expected 3 files (7 rows / 3 maxReps = 2.33, ceil to 3), but got ${result.files.length}`);

            // First file: 3 items
            expect(result.files[0].content.Data.length).to.equal(3);
            // Second file: 3 items
            expect(result.files[1].content.Data.length).to.equal(3);
            // Third file: 1 item (remainder)
            expect(result.files[2].content.Data.length).to.equal(1);
        });

        it('should NOT group by outer variable when each row is independent', async () => {
            // This is the user's actual scenario: template has nested structure,
            // but CSV rows are independent (not parent-child relationships)
            const template = JSON.stringify({
                Data: [{
                    LocationId: '{{LocationId}}',
                    StorageUomId: 'UNIT',
                    SkuDedicationTypeId: '{{SkuDedicationTypeId}}',
                    LocationItemAssignment: [{
                        LocationId: '{{LocationId}}',
                        ItemId: '{{ItemId}}',
                        MinUomQuantity: '{{MinUomQuantity:number}}',
                        MaxUomQuantity: '{{MaxUomQuantity:number}}'
                    }]
                }]
            });

            // Each row is a unique location - no grouping relationship
            const csvData = `LocationId,SkuDedicationTypeId,ItemId,MinUomQuantity,MaxUomQuantity
LOC001,PERMANENT,ITEM001,1,10
LOC002,PERMANENT,ITEM002,2,20
LOC003,PERMANENT,ITEM003,3,30
LOC004,PERMANENT,ITEM004,4,40`;

            const options = {
                template,
                repeatableArrays: [{
                    arrayPath: 'Data',
                    enabled: true,
                    maxRepetitions: 2  // 4 rows / 2 = 2 files expected
                }],
                mappings: [
                    { variable: 'LocationId', column: 'LocationId', dataType: 'string' },
                    { variable: 'SkuDedicationTypeId', column: 'SkuDedicationTypeId', dataType: 'string' },
                    { variable: 'ItemId', column: 'ItemId', dataType: 'string' },
                    { variable: 'MinUomQuantity', column: 'MinUomQuantity', dataType: 'number' },
                    { variable: 'MaxUomQuantity', column: 'MaxUomQuantity', dataType: 'number' }
                ],
                headers: ['LocationId', 'SkuDedicationTypeId', 'ItemId', 'MinUomQuantity', 'MaxUomQuantity']
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            // With 4 rows and maxRepetitions=2, we expect 2 files
            // NOT 4 files (one per unique LocationId) - that would be wrong!
            expect(result.success).to.be.true;
            expect(result.files.length).to.equal(2,
                `Expected 2 files (4 rows / 2 maxReps), but got ${result.files.length}. ` +
                `If got 4 files, maxRepetitions is being ignored and grouping by LocationId instead.`);
        });
    });
});
