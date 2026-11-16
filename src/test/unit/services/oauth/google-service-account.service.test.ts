// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for GoogleServiceAccountService
 *
 * GitHub Issue #126 - Phase 2: Google Service Account Authentication
 */

import { expect } from 'chai';
import * as sinon from 'sinon';
import { GoogleServiceAccountService } from '../../../../services/oauth/google-service-account.service';
import { GoogleServiceAccountConfig } from '../../../../types/oauth';
import { EnvironmentManager } from '../../../../environmentManager';

describe('GoogleServiceAccountService', () => {
    let service: GoogleServiceAccountService;
    let mockEnvironmentManager: sinon.SinonStubbedInstance<EnvironmentManager>;

    const validConfig: GoogleServiceAccountConfig = {
        type: 'service_account',
        project_id: 'test-project',
        private_key_id: 'key123',
        private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA2Z3qX2BTLS4e0ek94JZF0gJYdkSrZ0eEuJXFqwKLbUzT3I7h\nEjQqv8xOPGLLqbJJTqKp7YfKvCfWO3MpKjCrGzBdJZmPsWmk8Y5E0hKlT6QbX7DR\n-----END RSA PRIVATE KEY-----\n', // gitleaks:allow (a truncated made-up key, not a usable one)
        client_email: 'test@test-project.iam.gserviceaccount.com',
        client_id: '123456789',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
        auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
        client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/test%40test-project.iam.gserviceaccount.com'
    };

    beforeEach(() => {
        mockEnvironmentManager = sinon.createStubInstance(EnvironmentManager);
        service = new GoogleServiceAccountService(mockEnvironmentManager as unknown as EnvironmentManager);
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('validateConfig', () => {
        it('should return valid for a correct service account config', () => {
            const result = service.validateConfig(validConfig);
            expect(result.valid).to.be.true;
            expect(result.errors).to.be.empty;
        });

        it('should reject config with wrong type', () => {
            const invalidConfig = { ...validConfig, type: 'invalid_type' };
            const result = service.validateConfig(invalidConfig);
            expect(result.valid).to.be.false;
            expect(result.errors).to.include("Invalid type: expected 'service_account', got 'invalid_type'");
        });

        it('should reject config with missing client_email', () => {
            const invalidConfig = { ...validConfig, client_email: '' };
            const result = service.validateConfig(invalidConfig);
            expect(result.valid).to.be.false;
            expect(result.errors).to.include('Missing client_email');
        });

        it('should reject config with invalid client_email format', () => {
            const invalidConfig = { ...validConfig, client_email: 'invalid@gmail.com' };
            const result = service.validateConfig(invalidConfig);
            expect(result.valid).to.be.false;
            expect(result.errors).to.include('Invalid client_email: must be a Google service account email');
        });

        it('should reject config with missing private_key', () => {
            const invalidConfig = { ...validConfig, private_key: '' };
            const result = service.validateConfig(invalidConfig);
            expect(result.valid).to.be.false;
            expect(result.errors).to.include('Missing private_key');
        });

        it('should reject config with invalid private_key format', () => {
            const invalidConfig = { ...validConfig, private_key: 'not-a-pem-key' };
            const result = service.validateConfig(invalidConfig);
            expect(result.valid).to.be.false;
            expect(result.errors).to.include('Invalid private_key: must be in PEM format');
        });

        it('should reject config with missing token_uri', () => {
            const invalidConfig = { ...validConfig, token_uri: '' };
            const result = service.validateConfig(invalidConfig);
            expect(result.valid).to.be.false;
            expect(result.errors).to.include('Missing token_uri');
        });

        it('should reject config with missing project_id', () => {
            const invalidConfig = { ...validConfig, project_id: '' };
            const result = service.validateConfig(invalidConfig);
            expect(result.valid).to.be.false;
            expect(result.errors).to.include('Missing project_id');
        });

        it('should return multiple errors for config with multiple issues', () => {
            const invalidConfig = {
                ...validConfig,
                type: 'wrong',
                client_email: '',
                private_key: ''
            };
            const result = service.validateConfig(invalidConfig);
            expect(result.valid).to.be.false;
            expect(result.errors.length).to.be.greaterThan(1);
        });

        it('should handle null config gracefully', () => {
            const result = service.validateConfig(null as unknown as GoogleServiceAccountConfig);
            expect(result.valid).to.be.false;
            expect(result.errors).to.include('Configuration is required');
        });
    });

    describe('hasValidCredentials', () => {
        it('should return false when environment does not exist', async () => {
            mockEnvironmentManager.getEnvironment.resolves(undefined);
            const result = await service.hasValidCredentials('non-existent');
            expect(result).to.be.false;
        });

        it('should return false when authMethod is not google-service-account', async () => {
            mockEnvironmentManager.getEnvironment.resolves({
                id: 'env1',
                name: 'Test',
                baseUrl: 'https://api.example.com',
                authMethod: 'jwt'
            } as any);
            const result = await service.hasValidCredentials('env1');
            expect(result).to.be.false;
        });

        it('should return false when service account config is missing', async () => {
            mockEnvironmentManager.getEnvironment.resolves({
                id: 'env1',
                name: 'Test',
                baseUrl: 'https://api.example.com',
                authMethod: 'google-service-account',
                googleServiceAccountConfig: undefined
            } as any);
            const result = await service.hasValidCredentials('env1');
            expect(result).to.be.false;
        });

        it('should return true when config is valid', async () => {
            mockEnvironmentManager.getEnvironment.resolves({
                id: 'env1',
                name: 'Test',
                baseUrl: 'https://api.example.com',
                authMethod: 'google-service-account',
                googleServiceAccountConfig: validConfig
            } as any);
            const result = await service.hasValidCredentials('env1');
            expect(result).to.be.true;
        });
    });

    describe('clearCachedToken', () => {
        it('should not throw when clearing non-existent cache entry', () => {
            expect(() => service.clearCachedToken('non-existent')).to.not.throw();
        });
    });

    describe('getAccessToken', () => {
        it('should return null when environment does not exist', async () => {
            mockEnvironmentManager.getEnvironment.resolves(undefined);
            const result = await service.getAccessToken('non-existent');
            expect(result).to.be.null;
        });

        it('should return null when authMethod is not google-service-account', async () => {
            mockEnvironmentManager.getEnvironment.resolves({
                id: 'env1',
                name: 'Test',
                baseUrl: 'https://api.example.com',
                authMethod: 'oauth'
            } as any);
            const result = await service.getAccessToken('env1');
            expect(result).to.be.null;
        });

        it('should return null when config is missing', async () => {
            mockEnvironmentManager.getEnvironment.resolves({
                id: 'env1',
                name: 'Test',
                baseUrl: 'https://api.example.com',
                authMethod: 'google-service-account',
                googleServiceAccountConfig: undefined
            } as any);
            const result = await service.getAccessToken('env1');
            expect(result).to.be.null;
        });
    });
});
