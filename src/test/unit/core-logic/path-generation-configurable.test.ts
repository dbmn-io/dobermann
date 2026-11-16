// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { PathGeneratorHelper } from '../../../services/transaction-preparation/helpers/path-generator.helper';

describe('PathGeneratorHelper - Configurable Folder Structure', () => {
    let pathGenerator: PathGeneratorHelper;

    beforeEach(() => {
        pathGenerator = new PathGeneratorHelper();
    });

    describe('generateDirectoryPath - New Configurable Structure', () => {
        it('should generate individual path without optional folders', () => {
            const result = pathGenerator.generateDirectoryPath({
                workspaceRoot: '/workspace',
                environment: 'VSDEV',
                endpointName: 'test',
                executionType: 'individual'
            });

            expect(result).to.equal('/workspace/vsdev/test');
        });

        it('should generate individual path with environment folder', () => {
            const result = pathGenerator.generateDirectoryPath({
                workspaceRoot: '/workspace',
                environment: 'VSDEV',
                environmentFolder: 'acm',
                endpointName: 'test',
                executionType: 'individual'
            });

            expect(result).to.equal('/workspace/acm/vsdev/test');
        });

        it('should generate individual path with endpoint folder', () => {
            const result = pathGenerator.generateDirectoryPath({
                workspaceRoot: '/workspace',
                environment: 'VSDEV',
                endpointName: 'test',
                endpointFolder: 'masterData',
                executionType: 'individual'
            });

            expect(result).to.equal('/workspace/vsdev/masterdata/test');
        });

        it('should generate full path with both environment and endpoint folders', () => {
            const result = pathGenerator.generateDirectoryPath({
                workspaceRoot: '/workspace',
                environment: 'VSDEV',
                environmentFolder: 'acm',
                endpointName: 'test',
                endpointFolder: 'masterData',
                executionType: 'individual'
            });

            expect(result).to.equal('/workspace/acm/vsdev/masterdata/test');
        });

        it('should generate batch path with both folders and batch subdirectory', () => {
            const result = pathGenerator.generateDirectoryPath({
                workspaceRoot: '/workspace',
                environment: 'VSDEV',
                environmentFolder: 'acm',
                endpointName: 'test',
                endpointFolder: 'masterData',
                executionType: 'batch',
                batchId: 'batch_123'
            });

            expect(result).to.equal('/workspace/acm/vsdev/masterdata/test/batch/batch_123');
        });

        it('should ignore empty environment folder', () => {
            const result = pathGenerator.generateDirectoryPath({
                workspaceRoot: '/workspace',
                environment: 'VSDEV',
                environmentFolder: '',
                endpointName: 'test',
                executionType: 'individual'
            });

            expect(result).to.equal('/workspace/vsdev/test');
        });

        it('should ignore empty endpoint folder', () => {
            const result = pathGenerator.generateDirectoryPath({
                workspaceRoot: '/workspace',
                environment: 'VSDEV',
                endpointName: 'test',
                endpointFolder: '',
                executionType: 'individual'
            });

            expect(result).to.equal('/workspace/vsdev/test');
        });

        it('should sanitize folder names properly', () => {
            const result = pathGenerator.generateDirectoryPath({
                workspaceRoot: '/workspace',
                environment: 'VS DEV',
                environmentFolder: 'ACM/Test',
                endpointName: 'Test Endpoint',
                endpointFolder: 'Master Data',
                executionType: 'individual'
            });

            expect(result).to.equal('/workspace/acm-test/vs-dev/master-data/test-endpoint');
        });
    });

    describe('Real-world scenarios matching user examples', () => {
        it('should generate path matching user example: acm/VSDEV/masterData/test/', () => {
            const result = pathGenerator.generateDirectoryPath({
                workspaceRoot: '/workspace',
                environment: 'VSDEV',
                environmentFolder: 'acm',
                endpointName: 'test',
                endpointFolder: 'masterData',
                executionType: 'individual'
            });

            expect(result).to.equal('/workspace/acm/vsdev/masterdata/test');
        });

        it('should NOT include DBMN\'s own folder (.dbmn, formerly .active8) in any path', () => {
            const result = pathGenerator.generateDirectoryPath({
                workspaceRoot: '/workspace',
                environment: 'VSDEV',
                environmentFolder: 'acm',
                endpointName: 'test',
                endpointFolder: 'masterData',
                executionType: 'individual'
            });

            expect(result).to.not.include('.active8');
            expect(result).to.not.include('.dbmn');
        });

        it('should handle batch member transaction paths correctly', () => {
            const result = pathGenerator.generateDirectoryPath({
                workspaceRoot: '/workspace',
                environment: 'VSDEV',
                environmentFolder: 'acm',
                endpointName: 'test',
                endpointFolder: 'masterData',
                executionType: 'batch_member',
                batchId: 'batch_456'
            });

            expect(result).to.equal('/workspace/acm/vsdev/masterdata/test/batch/batch_456');
        });
    });
});