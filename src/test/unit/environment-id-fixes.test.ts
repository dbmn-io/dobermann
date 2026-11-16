// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { describe, it } from 'mocha';
import { expect } from 'chai';
import { ExecutionMetadata, metadataToRow } from '../../storage/execution-metadata';

/**
 * GitHub Issue #69: Environment ID Storage Tests
 * Simple unit tests to verify environmentId field handling
 */
describe('Environment ID Storage - GitHub Issue #69', () => {

    describe('ExecutionMetadata schema changes', () => {
        it('should include environmentId in metadata to row conversion', () => {
            // Arrange
            const metadata: ExecutionMetadata = {
                id: 'test-123',
                environment: 'Production',
                environmentId: 'prod-uuid-12345',
                organization: 'TestOrg',
                endpointId: 'endpoint-1',
                endpointName: 'Test Endpoint',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch',
                status: 'completed',
                rows: '10',
                createdAt: new Date('2023-01-01T00:00:00Z')
            };

            // Act
            const row = metadataToRow(metadata);

            // Assert
            expect(row).to.have.property('environment', 'Production');
            expect(row).to.have.property('environment_id', 'prod-uuid-12345');
            expect(row).to.have.property('organization', 'TestOrg');
            expect(row).to.have.property('execution_type', 'batch');
        });

        it('should handle undefined environmentId in metadata to row conversion', () => {
            // Arrange
            const metadata: ExecutionMetadata = {
                id: 'test-123',
                environment: 'Production',
                // environmentId: undefined (legacy batch)
                organization: 'TestOrg',
                endpointId: 'endpoint-1',
                endpointName: 'Test Endpoint',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch',
                status: 'completed',
                rows: '10',
                createdAt: new Date('2023-01-01T00:00:00Z')
            };

            // Act
            const row = metadataToRow(metadata);

            // Assert
            expect(row).to.have.property('environment', 'Production');
            expect(row).to.have.property('environment_id', null);
            expect(row).to.have.property('organization', 'TestOrg');
        });
    });

    describe('Environment ID field validation', () => {
        it('should accept UUID format for environmentId', () => {
            // Arrange
            const validUUIDs = [
                '12345678-1234-1234-1234-123456789abc',
                'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                '00000000-0000-0000-0000-000000000000'
            ];

            // Act & Assert
            validUUIDs.forEach(uuid => {
                const metadata: ExecutionMetadata = {
                    id: 'test-123',
                    environment: 'Test',
                    environmentId: uuid,
                    organization: 'TestOrg',
                    endpointId: 'endpoint-1',
                    endpointName: 'Test',
                    endpointMethod: 'POST',
                    endpointPath: '/test',
                    executionType: 'batch',
                    status: 'completed',
                    rows: '1',
                    createdAt: new Date()
                };

                const row = metadataToRow(metadata);
                expect(row.environment_id).to.equal(uuid);

                // Test that conversion maintains environmentId
                expect(row.environment_id).to.equal(uuid);
            });
        });

        it('should handle environmentId consistency across batch operations', () => {
            // Arrange - Simulate batch with parent and members
            const environmentId = 'test-env-uuid-12345';
            const batchId = 'batch-123';

            const batchParent: ExecutionMetadata = {
                id: batchId,
                environment: 'Production',
                environmentId: environmentId,
                organization: 'TestOrg',
                endpointId: 'endpoint-1',
                endpointName: 'Test Endpoint',
                endpointMethod: 'POST',
                endpointPath: '/test',
                executionType: 'batch',
                status: 'completed',
                rows: '5',
                createdAt: new Date()
            };

            const batchMember: ExecutionMetadata = {
                id: 'member-001',
                environment: 'Production',
                environmentId: environmentId, // Should match parent
                organization: 'TestOrg',
                endpointId: 'endpoint-1',
                endpointName: 'Test Endpoint',
                endpointMethod: 'POST',
                endpointPath: '/test',
                batchId: batchId,
                executionType: 'batch_member',
                status: 'completed',
                rows: '1',
                createdAt: new Date()
            };

            // Act
            const parentRow = metadataToRow(batchParent);
            const memberRow = metadataToRow(batchMember);

            // Assert - Both should have same environmentId
            expect(parentRow.environment_id).to.equal(environmentId);
            expect(memberRow.environment_id).to.equal(environmentId);
            expect(parentRow.environment_id).to.equal(memberRow.environment_id);
        });
    });
});