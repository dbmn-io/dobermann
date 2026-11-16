// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Regression tests for root-variable pre-grouping in nested templates.
 *
 * Ensures the fix for 2-level/3-level nesting with root CSV variables
 * doesn't break existing flat, 1-level, 2-level (no root), 3-level (no root),
 * or static wrapper scenarios.
 */

import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import { JsonGenerator } from '../../../data-loading/json-generator';

describe('Root-Variable Grouping Regression Tests', () => {
    let jsonGenerator: JsonGenerator;

    beforeEach(() => {
        jsonGenerator = new JsonGenerator();
    });

    // =========================================================================
    // FLAT ARRAY — no nesting, no root variables
    // =========================================================================
    describe('Flat array (no nesting)', () => {
        it('should batch flat rows by maxRepetitions unchanged', async () => {
            const template = JSON.stringify({
                items: [{ sku: '{{SKU}}', qty: '{{Qty}}' }]
            });

            const csvData = 'SKU,Qty\nA1,5\nA2,3\nA3,7\nA4,1\nA5,2';

            const options = {
                template,
                headers: ['SKU', 'Qty'],
                mappings: [
                    { variable: 'SKU', column: 'SKU', dataType: 'string' },
                    { variable: 'Qty', column: 'Qty', dataType: 'string' }
                ],
                repeatableArrays: [{ arrayPath: 'items', enabled: true, maxRepetitions: 3 }]
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            // 5 rows / 3 per batch = 2 files
            expect(result.files).to.have.lengthOf(2);
            expect(result.files[0].content.items).to.have.lengthOf(3);
            expect(result.files[1].content.items).to.have.lengthOf(2);
        });

        it('should produce one file per row without array repetition', async () => {
            const template = JSON.stringify({
                name: '{{Name}}',
                value: '{{Value}}'
            });

            const csvData = 'Name,Value\nAlpha,100\nBeta,200';

            const options = {
                template,
                headers: ['Name', 'Value'],
                mappings: [
                    { variable: 'Name', column: 'Name', dataType: 'string' },
                    { variable: 'Value', column: 'Value', dataType: 'string' }
                ]
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            expect(result.files).to.have.lengthOf(2);
            expect(result.files[0].content.name).to.equal('Alpha');
            expect(result.files[1].content.name).to.equal('Beta');
        });
    });

    // =========================================================================
    // 1-LEVEL NESTING — root grouping (existing, should be unchanged)
    // =========================================================================
    describe('1-level nesting with root grouping', () => {
        it('should group by root variable, one file per unique value', async () => {
            const template = JSON.stringify({
                dest: '{{dest}}',
                OriginalOrderLine: [{
                    item: '{{item}}',
                    qty: '{{qty}}'
                }]
            });

            const csvData = 'dest,item,qty\nNYC,A1,5\nNYC,A2,3\nLAX,B1,7\nLAX,B2,1';

            const options = {
                template,
                headers: ['dest', 'item', 'qty'],
                mappings: [
                    { variable: 'dest', column: 'dest', dataType: 'string' },
                    { variable: 'item', column: 'item', dataType: 'string' },
                    { variable: 'qty', column: 'qty', dataType: 'string' }
                ],
                repeatableArrays: [{ arrayPath: 'OriginalOrderLine', enabled: true, maxRepetitions: 100 }]
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            expect(result.files).to.have.lengthOf(2);

            // Auto-sort orders alphabetically by dest: LAX before NYC
            expect(result.files[0].content.dest).to.equal('LAX');
            expect(result.files[0].content.OriginalOrderLine).to.have.lengthOf(2);

            expect(result.files[1].content.dest).to.equal('NYC');
            expect(result.files[1].content.OriginalOrderLine).to.have.lengthOf(2);
        });
    });

    // =========================================================================
    // 2-LEVEL NESTING — WITHOUT root variables (existing, should be unchanged)
    // =========================================================================
    describe('2-level nesting WITHOUT root variables', () => {
        it('should group by outerVariable only, batch by maxRepetitions', async () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    items: [{
                        item: '{{Item}}',
                        qty: '{{Qty}}'
                    }]
                }]
            });

            const csvData = 'PO,Item,Qty\n100,A1,5\n100,A2,3\n200,B1,7\n200,B2,1\n300,C1,9';

            const options = {
                template,
                headers: ['PO', 'Item', 'Qty'],
                mappings: [
                    { variable: 'PO', column: 'PO', dataType: 'string' },
                    { variable: 'Item', column: 'Item', dataType: 'string' },
                    { variable: 'Qty', column: 'Qty', dataType: 'string' }
                ],
                repeatableArrays: [{ arrayPath: 'orders', enabled: true, maxRepetitions: 2 }]
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            // 3 PO groups batched by 2 → 2 files (2+1)
            expect(result.files).to.have.lengthOf(2);

            // First file: PO=100 and PO=200
            expect(result.files[0].content.orders).to.have.lengthOf(2);
            expect(result.files[0].content.orders[0].po).to.equal('100');
            expect(result.files[0].content.orders[0].items).to.have.lengthOf(2);
            expect(result.files[0].content.orders[1].po).to.equal('200');
            expect(result.files[0].content.orders[1].items).to.have.lengthOf(2);

            // Second file: PO=300
            expect(result.files[1].content.orders).to.have.lengthOf(1);
            expect(result.files[1].content.orders[0].po).to.equal('300');
            expect(result.files[1].content.orders[0].items).to.have.lengthOf(1);
        });

        it('should put all groups in one file when maxRepetitions is large', async () => {
            const template = JSON.stringify({
                orders: [{
                    po: '{{PO}}',
                    items: [{
                        item: '{{Item}}'
                    }]
                }]
            });

            const csvData = 'PO,Item\n100,A1\n100,A2\n200,B1';

            const options = {
                template,
                headers: ['PO', 'Item'],
                mappings: [
                    { variable: 'PO', column: 'PO', dataType: 'string' },
                    { variable: 'Item', column: 'Item', dataType: 'string' }
                ],
                repeatableArrays: [{ arrayPath: 'orders', enabled: true, maxRepetitions: 100 }]
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            expect(result.files).to.have.lengthOf(1);
            expect(result.files[0].content.orders).to.have.lengthOf(2);
        });
    });

    // =========================================================================
    // 2-LEVEL NESTING — WITH root variables (the bug fix scenario)
    // =========================================================================
    describe('2-level nesting WITH root variables', () => {
        it('should create separate files per unique root variable value', async () => {
            const template = JSON.stringify({
                RoleId: '{{RollId:string}}',
                RoleName: '{{RoleName:string}}',
                Grant: [{
                    ResourceId: '{{ResourceId}}',
                    ExclusionGrant: [{
                        ExcludedResourceId: '{{ExcludedResourceId}}'
                    }]
                }]
            });

            const csvData = 'RollId,RoleName,ResourceId,ExcludedResourceId\n' +
                '840,Role840,*,EXC-001\n' +
                '840,Role840,*,EXC-002\n' +
                '840,Role840,*,EXC-003\n' +
                '880,Role880,*,EXC-004\n' +
                '880,Role880,*,EXC-005\n' +
                '880,Role880,*,EXC-006';

            const options = {
                template,
                headers: ['RollId', 'RoleName', 'ResourceId', 'ExcludedResourceId'],
                mappings: [
                    { variable: 'RollId', column: 'RollId', dataType: 'string' },
                    { variable: 'RoleName', column: 'RoleName', dataType: 'string' },
                    { variable: 'ResourceId', column: 'ResourceId', dataType: 'string' },
                    { variable: 'ExcludedResourceId', column: 'ExcludedResourceId', dataType: 'string' }
                ],
                repeatableArrays: [{ arrayPath: 'Grant', enabled: true, maxRepetitions: 100 }]
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            expect(result.files).to.have.lengthOf(2);

            // File 1: RollId=840
            expect(result.files[0].content.RoleId).to.equal('840');
            expect(result.files[0].content.RoleName).to.equal('Role840');
            expect(result.files[0].content.Grant).to.have.lengthOf(1);
            expect(result.files[0].content.Grant[0].ExclusionGrant).to.have.lengthOf(3);

            // File 2: RollId=880
            expect(result.files[1].content.RoleId).to.equal('880');
            expect(result.files[1].content.RoleName).to.equal('Role880');
            expect(result.files[1].content.Grant).to.have.lengthOf(1);
            expect(result.files[1].content.Grant[0].ExclusionGrant).to.have.lengthOf(3);
        });

        it('should handle root variables with multiple outer groups per root', async () => {
            // Root: RoleId drives file grouping
            // Outer: ResourceId drives array grouping within each file
            const template = JSON.stringify({
                RoleId: '{{RoleId}}',
                Grant: [{
                    ResourceId: '{{ResourceId}}',
                    Permissions: [{
                        PermissionId: '{{PermissionId}}'
                    }]
                }]
            });

            const csvData = 'RoleId,ResourceId,PermissionId\n' +
                'Admin,Res-A,P1\n' +
                'Admin,Res-A,P2\n' +
                'Admin,Res-B,P3\n' +
                'User,Res-C,P4\n' +
                'User,Res-C,P5';

            const options = {
                template,
                headers: ['RoleId', 'ResourceId', 'PermissionId'],
                mappings: [
                    { variable: 'RoleId', column: 'RoleId', dataType: 'string' },
                    { variable: 'ResourceId', column: 'ResourceId', dataType: 'string' },
                    { variable: 'PermissionId', column: 'PermissionId', dataType: 'string' }
                ],
                repeatableArrays: [{ arrayPath: 'Grant', enabled: true, maxRepetitions: 100 }]
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            // 2 root groups: Admin and User
            expect(result.files).to.have.lengthOf(2);

            // File 1: Admin — 2 Grant entries (Res-A with 2 perms, Res-B with 1 perm)
            expect(result.files[0].content.RoleId).to.equal('Admin');
            expect(result.files[0].content.Grant).to.have.lengthOf(2);
            expect(result.files[0].content.Grant[0].ResourceId).to.equal('Res-A');
            expect(result.files[0].content.Grant[0].Permissions).to.have.lengthOf(2);
            expect(result.files[0].content.Grant[1].ResourceId).to.equal('Res-B');
            expect(result.files[0].content.Grant[1].Permissions).to.have.lengthOf(1);

            // File 2: User — 1 Grant entry (Res-C with 2 perms)
            expect(result.files[1].content.RoleId).to.equal('User');
            expect(result.files[1].content.Grant).to.have.lengthOf(1);
            expect(result.files[1].content.Grant[0].ResourceId).to.equal('Res-C');
            expect(result.files[1].content.Grant[0].Permissions).to.have.lengthOf(2);
        });

        it('should still work when there is only one unique root value (no split)', async () => {
            const template = JSON.stringify({
                RoleId: '{{RoleId}}',
                Grant: [{
                    ResourceId: '{{ResourceId}}',
                    Perms: [{
                        PermId: '{{PermId}}'
                    }]
                }]
            });

            const csvData = 'RoleId,ResourceId,PermId\n' +
                'Admin,Res-A,P1\n' +
                'Admin,Res-A,P2\n' +
                'Admin,Res-B,P3';

            const options = {
                template,
                headers: ['RoleId', 'ResourceId', 'PermId'],
                mappings: [
                    { variable: 'RoleId', column: 'RoleId', dataType: 'string' },
                    { variable: 'ResourceId', column: 'ResourceId', dataType: 'string' },
                    { variable: 'PermId', column: 'PermId', dataType: 'string' }
                ],
                repeatableArrays: [{ arrayPath: 'Grant', enabled: true, maxRepetitions: 100 }]
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            // Only 1 root value → 1 file
            expect(result.files).to.have.lengthOf(1);
            expect(result.files[0].content.RoleId).to.equal('Admin');
            expect(result.files[0].content.Grant).to.have.lengthOf(2);
        });

        it('should track rowRange correctly across root groups', async () => {
            const template = JSON.stringify({
                Id: '{{Id}}',
                Items: [{
                    GroupKey: '{{GroupKey}}',
                    SubItems: [{
                        Val: '{{Val}}'
                    }]
                }]
            });

            const csvData = 'Id,GroupKey,Val\nA,G1,V1\nA,G1,V2\nB,G2,V3\nB,G2,V4\nB,G2,V5';

            const options = {
                template,
                headers: ['Id', 'GroupKey', 'Val'],
                mappings: [
                    { variable: 'Id', column: 'Id', dataType: 'string' },
                    { variable: 'GroupKey', column: 'GroupKey', dataType: 'string' },
                    { variable: 'Val', column: 'Val', dataType: 'string' }
                ],
                repeatableArrays: [{ arrayPath: 'Items', enabled: true, maxRepetitions: 100 }]
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            expect(result.files).to.have.lengthOf(2);
            expect(result.files[0].rowRange).to.deep.equal({ start: 1, end: 2 });
            expect(result.files[1].rowRange).to.deep.equal({ start: 3, end: 5 });
        });

        it('should handle root variables with ENV variables at root level (ENV excluded from grouping)', async () => {
            const template = JSON.stringify({
                RoleId: '{{RoleId}}',
                OrgId: '{{ENV:org}}',
                Grant: [{
                    ResourceId: '{{ResourceId}}',
                    Perms: [{
                        PermId: '{{PermId}}'
                    }]
                }]
            });

            const csvData = 'RoleId,ResourceId,PermId\n' +
                'Admin,*,P1\n' +
                'Admin,*,P2\n' +
                'User,*,P3';

            const options = {
                template,
                headers: ['RoleId', 'ResourceId', 'PermId'],
                mappings: [
                    { variable: 'RoleId', column: 'RoleId', dataType: 'string' },
                    { variable: 'ResourceId', column: 'ResourceId', dataType: 'string' },
                    { variable: 'PermId', column: 'PermId', dataType: 'string' }
                ],
                repeatableArrays: [{ arrayPath: 'Grant', enabled: true, maxRepetitions: 100 }],
                environmentVariables: { org: 'TestOrg' }
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            // RoleId drives grouping (ENV:org is excluded), so 2 files
            expect(result.files).to.have.lengthOf(2);
            expect(result.files[0].content.RoleId).to.equal('Admin');
            expect(result.files[0].content.OrgId).to.equal('TestOrg');
            expect(result.files[1].content.RoleId).to.equal('User');
            expect(result.files[1].content.OrgId).to.equal('TestOrg');
        });
    });

    // =========================================================================
    // 3-LEVEL NESTING — WITHOUT root variables (existing, should be unchanged)
    // =========================================================================
    describe('3-level nesting WITHOUT root variables', () => {
        it('should group by outer then middle variables correctly', async () => {
            const template = JSON.stringify({
                shipments: [{
                    shipmentId: '{{ShipmentID}}',
                    packages: [{
                        packageId: '{{PackageID}}',
                        items: [{
                            sku: '{{SKU}}'
                        }]
                    }]
                }]
            });

            const csvData = 'ShipmentID,PackageID,SKU\n' +
                'S1,P1,SKU-A\n' +
                'S1,P1,SKU-B\n' +
                'S1,P2,SKU-C\n' +
                'S2,P3,SKU-D';

            const options = {
                template,
                headers: ['ShipmentID', 'PackageID', 'SKU'],
                mappings: [
                    { variable: 'ShipmentID', column: 'ShipmentID', dataType: 'string' },
                    { variable: 'PackageID', column: 'PackageID', dataType: 'string' },
                    { variable: 'SKU', column: 'SKU', dataType: 'string' }
                ],
                repeatableArrays: [{ arrayPath: 'shipments', enabled: true, maxRepetitions: 100 }]
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            // All in 1 file (maxReps=100, only 2 shipments)
            expect(result.files).to.have.lengthOf(1);

            const content = result.files[0].content;
            expect(content.shipments).to.have.lengthOf(2);

            // S1 has 2 packages
            expect(content.shipments[0].shipmentId).to.equal('S1');
            expect(content.shipments[0].packages).to.have.lengthOf(2);
            expect(content.shipments[0].packages[0].items).to.have.lengthOf(2);
            expect(content.shipments[0].packages[1].items).to.have.lengthOf(1);

            // S2 has 1 package
            expect(content.shipments[1].shipmentId).to.equal('S2');
            expect(content.shipments[1].packages).to.have.lengthOf(1);
        });
    });

    // =========================================================================
    // 2-LEVEL NESTING — STATIC WRAPPER (no outerVariables, should be unchanged)
    // =========================================================================
    describe('2-level nesting with static wrapper (no outerVariables)', () => {
        it('should fallback to innerVariables grouping when outer is static', async () => {
            const template = JSON.stringify({
                messages: [{
                    ItemCode: [{
                        code: '{{Code}}',
                        desc: '{{Description}}'
                    }]
                }]
            });

            const csvData = 'Code,Description\nC1,Desc1\nC2,Desc2\nC3,Desc3';

            const options = {
                template,
                headers: ['Code', 'Description'],
                mappings: [
                    { variable: 'Code', column: 'Code', dataType: 'string' },
                    { variable: 'Description', column: 'Description', dataType: 'string' }
                ],
                repeatableArrays: [{ arrayPath: 'messages', enabled: true, maxRepetitions: 2 }]
            };

            const result = await jsonGenerator.generateBatchJsonFiles(csvData, options);

            expect(result.success).to.be.true;
            // Should produce files based on inner variable grouping
            expect(result.files.length).to.be.greaterThan(0);
        });
    });
});
