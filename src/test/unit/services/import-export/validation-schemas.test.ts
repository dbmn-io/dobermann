// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';
import { validateImportPackage } from '../../../../services/import-export/validation-schemas';

/**
 * Tests for import/export validation schemas
 * GitHub Issue #177: Import file from v0.0.49 shows "[object Object]" error
 */

/**
 * Helper to create a minimal valid import package for testing.
 * Override specific fields as needed.
 */
function createMinimalImportPackage(overrides: Record<string, unknown> = {}) {
    return {
        metadata: {
            version: '1.0.0',
            exportedAt: new Date().toISOString(),
            exportedBy: 'Dobermann',
            dobermannVersion: '0.0.49'
        },
        endpoints: {
            version: '1.0.0',
            folders: [],
            endpoints: []
        },
        environments: {
            version: '1.0.0',
            folders: [],
            environments: []
        },
        folders: {
            version: '1.0.0',
            endpoints: { folders: [] },
            environments: { folders: [] }
        },
        ...overrides
    };
}

describe('Import/Export Validation Schemas (GitHub Issue #177)', () => {

    describe('Bug 1: authMethod enum should accept all AuthenticationMethod values', () => {

        it('should accept authMethod "jwt"', () => {
            const pkg = createMinimalImportPackage({
                environments: {
                    version: '1.0.0',
                    folders: [],
                    environments: [{
                        id: 'env-1',
                        name: 'Test Env',
                        authMethod: 'jwt'
                    }]
                }
            });

            const result = validateImportPackage(pkg);
            expect(result.errors).to.be.undefined;
            expect(result.package).to.exist;
        });

        it('should accept authMethod "oauth"', () => {
            const pkg = createMinimalImportPackage({
                environments: {
                    version: '1.0.0',
                    folders: [],
                    environments: [{
                        id: 'env-1',
                        name: 'Test Env',
                        authMethod: 'oauth'
                    }]
                }
            });

            const result = validateImportPackage(pkg);
            expect(result.errors).to.be.undefined;
            expect(result.package).to.exist;
        });

        it('should accept authMethod "google-service-account"', () => {
            const pkg = createMinimalImportPackage({
                environments: {
                    version: '1.0.0',
                    folders: [],
                    environments: [{
                        id: 'env-1',
                        name: 'Test Env',
                        authMethod: 'google-service-account'
                    }]
                }
            });

            const result = validateImportPackage(pkg);
            expect(result.errors).to.be.undefined;
            expect(result.package).to.exist;
        });

        it('should accept authMethod "none"', () => {
            const pkg = createMinimalImportPackage({
                environments: {
                    version: '1.0.0',
                    folders: [],
                    environments: [{
                        id: 'env-1',
                        name: 'Test Env',
                        authMethod: 'none'
                    }]
                }
            });

            const result = validateImportPackage(pkg);
            expect(result.errors).to.be.undefined;
            expect(result.package).to.exist;
        });

        it('should reject an invalid authMethod value', () => {
            const pkg = createMinimalImportPackage({
                environments: {
                    version: '1.0.0',
                    folders: [],
                    environments: [{
                        id: 'env-1',
                        name: 'Test Env',
                        authMethod: 'invalid-auth-method'
                    }]
                }
            });

            const result = validateImportPackage(pkg);
            expect(result.errors).to.exist;
            expect(result.errors!.length).to.be.greaterThan(0);
        });
    });

    describe('Future-proofing: schemas should pass through unknown fields', () => {

        it('should accept environment with extra fields from newer versions', () => {
            const pkg = createMinimalImportPackage({
                environments: {
                    version: '1.0.0',
                    folders: [],
                    environments: [{
                        id: 'env-1',
                        name: 'Test Env',
                        authMethod: 'jwt',
                        someNewFieldFromFuture: 'value',
                        anotherNewField: { nested: true }
                    }]
                }
            });

            const result = validateImportPackage(pkg);
            expect(result.errors).to.be.undefined;
            expect(result.package).to.exist;
        });

        it('should accept endpoint with extra fields from newer versions', () => {
            const pkg = createMinimalImportPackage({
                endpoints: {
                    version: '1.0.0',
                    folders: [],
                    endpoints: [{
                        id: 'ep-1',
                        name: 'Test Endpoint',
                        path: '/api/test',
                        method: 'POST',
                        someNewFieldFromFuture: 'value'
                    }]
                }
            });

            const result = validateImportPackage(pkg);
            expect(result.errors).to.be.undefined;
            expect(result.package).to.exist;
        });
    });

    describe('Bug 2: Error display should handle object-shaped errors', () => {

        it('should produce string errors from validateImportPackage', () => {
            const pkg = createMinimalImportPackage({
                environments: {
                    version: '1.0.0',
                    folders: [],
                    environments: [{
                        id: 'env-1',
                        name: 'Test Env',
                        authMethod: 'invalid-value'
                    }]
                }
            });

            const result = validateImportPackage(pkg);
            expect(result.errors).to.exist;
            // Each error should be a string (not an object)
            for (const err of result.errors!) {
                expect(typeof err).to.equal('string', `Expected string error but got ${typeof err}: ${JSON.stringify(err)}`);
            }
        });

        it('should produce readable error messages when joined', () => {
            // Simulate what import-export.service.ts does: wraps errors as {code, message}
            const errorObjects = [
                { code: 'SCHEMA_ERROR', message: 'environments.environments.0.authMethod: Invalid enum value' },
                { code: 'SCHEMA_ERROR', message: 'Another error' }
            ];

            // Bug: .join() on objects produces "[object Object]"
            const buggyDisplay = errorObjects.join(', ');
            expect(buggyDisplay).to.include('[object Object]', 'Demonstrates the bug: .join() on objects produces [object Object]');

            // Fix: extract .message first
            const fixedDisplay = errorObjects.map(e => typeof e === 'object' ? e.message : e).join(', ');
            expect(fixedDisplay).to.not.include('[object Object]');
            expect(fixedDisplay).to.include('Invalid enum value');
        });
    });

    describe('Backward compatibility: active8Version in metadata', () => {

        it('should accept metadata with active8Version instead of dobermannVersion', () => {
            const pkg = createMinimalImportPackage({
                metadata: {
                    version: '1.0.0',
                    exportedAt: new Date().toISOString(),
                    exportedBy: 'Active8 VS Code Extension',
                    active8Version: '0.0.45'
                }
            });

            const result = validateImportPackage(pkg);
            expect(result.errors).to.be.undefined;
            expect(result.package).to.exist;
        });

        it('should accept metadata with dobermannVersion (current format)', () => {
            const pkg = createMinimalImportPackage();
            const result = validateImportPackage(pkg);
            expect(result.errors).to.be.undefined;
            expect(result.package).to.exist;
        });

        it('should accept metadata with both active8Version and dobermannVersion', () => {
            const pkg = createMinimalImportPackage({
                metadata: {
                    version: '1.0.0',
                    exportedAt: new Date().toISOString(),
                    exportedBy: 'Dobermann',
                    dobermannVersion: '0.1.0',
                    active8Version: '0.0.49'
                }
            });

            const result = validateImportPackage(pkg);
            expect(result.errors).to.be.undefined;
            expect(result.package).to.exist;
        });

        it('should reject metadata with neither active8Version nor dobermannVersion', () => {
            const pkg = createMinimalImportPackage({
                metadata: {
                    version: '1.0.0',
                    exportedAt: new Date().toISOString(),
                    exportedBy: 'Unknown'
                }
            });

            const result = validateImportPackage(pkg);
            expect(result.errors).to.exist;
            expect(result.errors!.length).to.be.greaterThan(0);
        });
    });

    describe('Environment with google-service-account config fields', () => {

        it('should accept environment with googleServiceAccountConfig', () => {
            const pkg = createMinimalImportPackage({
                environments: {
                    version: '1.0.0',
                    folders: [],
                    environments: [{
                        id: 'env-1',
                        name: 'PubSub Env',
                        authMethod: 'google-service-account',
                        googleServiceAccountConfig: {
                            type: 'service_account',
                            project_id: 'my-project',
                            private_key_id: 'key-id',
                            private_key: '-----BEGIN PRIVATE KEY-----\n...',
                            client_email: 'sa@project.iam.gserviceaccount.com',
                            client_id: '12345',
                            auth_uri: 'https://accounts.google.com/o/oauth2/auth',
                            token_uri: 'https://oauth2.googleapis.com/token',
                            auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
                            client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/sa'
                        },
                        googleServiceAccountScopes: ['https://www.googleapis.com/auth/pubsub']
                    }]
                }
            });

            const result = validateImportPackage(pkg);
            expect(result.errors).to.be.undefined;
            expect(result.package).to.exist;
        });
    });
});
