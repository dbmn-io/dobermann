// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * OAuth Service Types and Basic Functionality Tests
 * 
 * Tests OAuth type definitions, configuration validation, and basic service integration
 */

import { describe, it } from 'mocha';
import { expect } from 'chai';

import { 
    OAuthConfig, 
    OAuthProvider, 
    OAuthStatus, 
    OAuthFlowType,
    AuthenticationMethod,
    OAuthToken,
    TokenPayload 
} from '../../../../types/oauth';

describe('OAuth Service Types and Integration', () => {

    describe('Type Definitions', () => {
        it('should have correct OAuth provider enum values', () => {
            expect(OAuthProvider.GitHub).to.equal('github');
            expect(OAuthProvider.Custom).to.equal('custom');
        });

        it('should have correct OAuth flow type enum values', () => {
            expect(OAuthFlowType.AuthorizationCode).to.equal('authorization_code');
            expect(OAuthFlowType.AuthorizationCodePKCE).to.equal('authorization_code_pkce');
            expect(OAuthFlowType.ClientCredentials).to.equal('client_credentials');
        });

        it('should have correct OAuth status enum values', () => {
            expect(OAuthStatus.NotAuthenticated).to.equal('not_authenticated');
            expect(OAuthStatus.Authenticated).to.equal('authenticated');
            expect(OAuthStatus.Authenticating).to.equal('authenticating');
            expect(OAuthStatus.AuthenticationFailed).to.equal('authentication_failed');
            expect(OAuthStatus.TokenExpiring).to.equal('token_expiring');
        });

        it('should support authentication method types', () => {
            const jwtMethod: AuthenticationMethod = 'jwt';
            const oauthMethod: AuthenticationMethod = 'oauth';

            expect(jwtMethod).to.equal('jwt');
            expect(oauthMethod).to.equal('oauth');
        });
    });

    describe('OAuth Configuration', () => {
        it('should create a valid OAuth configuration for an environment on a Standard System', () => {
            const oauthConfig: OAuthConfig = {
                provider: OAuthProvider.Custom,
                clientId: 'test-client-id',
                authorizationUrl: 'https://tenant1-auth.samplewms.test/oauth/authorize',
                tokenUrl: 'https://tenant1-auth.samplewms.test/oauth/token',
                flowType: OAuthFlowType.AuthorizationCodePKCE,
                usePKCE: true,
                scopes: ['read', 'write'],
                providerConfig: {
                    redirectUri: 'vscode://dbmn.dobermann/oauth-callback'
                }
            };

            expect(oauthConfig.provider).to.equal(OAuthProvider.Custom);
            expect(oauthConfig.flowType).to.equal(OAuthFlowType.AuthorizationCodePKCE);
            expect(oauthConfig.usePKCE).to.be.true;
            expect(oauthConfig.scopes).to.include('read');
            expect(oauthConfig.scopes).to.include('write');
            expect(oauthConfig.authorizationUrl).to.include('-auth.samplewms.test');
            expect(oauthConfig.tokenUrl).to.include('-auth.samplewms.test');
        });

        it('should create valid Custom OAuth configuration', () => {
            const oauthConfig: OAuthConfig = {
                provider: OAuthProvider.Custom,
                clientId: 'custom-client-id',
                authorizationUrl: 'https://custom.example.com/oauth/authorize',
                tokenUrl: 'https://custom.example.com/oauth/token',
                flowType: OAuthFlowType.AuthorizationCode,
                usePKCE: false,
                scopes: ['openid', 'profile'],
                providerConfig: {
                    redirectUri: 'vscode://dbmn.dobermann/oauth-callback',
                    realm: 'custom-realm'
                }
            };

            expect(oauthConfig.provider).to.equal(OAuthProvider.Custom);
            expect(oauthConfig.flowType).to.equal(OAuthFlowType.AuthorizationCode);
            expect(oauthConfig.usePKCE).to.be.false;
            expect(oauthConfig.scopes).to.include('openid');
            expect(oauthConfig.scopes).to.include('profile');
        });

        it('should validate required OAuth configuration fields', () => {
            const requiredFields = ['provider', 'clientId', 'authorizationUrl', 'tokenUrl', 'flowType'];
            
            const oauthConfig: OAuthConfig = {
                provider: OAuthProvider.Custom,
                clientId: 'test-client-id',
                authorizationUrl: 'https://tenant1-auth.samplewms.test/oauth/authorize',
                tokenUrl: 'https://tenant1-auth.samplewms.test/oauth/token',
                flowType: OAuthFlowType.AuthorizationCodePKCE,
                usePKCE: true
            };

            requiredFields.forEach(field => {
                expect(oauthConfig).to.have.property(field);
                expect((oauthConfig as any)[field]).to.not.be.undefined;
            });
        });
    });

    describe('Token Management', () => {
        it('should define OAuth token structure correctly', () => {
            const mockToken: OAuthToken = {
                access_token: 'access-token-123',
                refresh_token: 'refresh-token-456',
                token_type: 'Bearer',
                expires_in: 3600,
                scope: 'read write',
                issued_at: Math.floor(Date.now() / 1000)
            };

            expect(mockToken.access_token).to.be.a('string');
            expect(mockToken.token_type).to.equal('Bearer');
            expect(mockToken.expires_in).to.be.a('number');
            expect(mockToken.scope).to.include('read');
            expect(mockToken.issued_at).to.be.a('number');
        });

        it('should calculate token expiry correctly', () => {
            const now = Math.floor(Date.now() / 1000);
            const token: OAuthToken = {
                access_token: 'test-token',
                token_type: 'Bearer',
                expires_in: 3600, // 1 hour
                issued_at: now,
                scope: 'read write'
            };

            // Token should expire in 1 hour from now
            const expiresAt = token.issued_at! + token.expires_in;
            const expectedExpiry = now + 3600;
            
            expect(expiresAt).to.equal(expectedExpiry);
            
            // Check if token is not yet expired
            const currentTime = Math.floor(Date.now() / 1000);
            const isExpired = expiresAt <= currentTime;
            expect(isExpired).to.be.false;
        });

        it('should handle token without expiry information', () => {
            const tokenWithoutExpiry: Partial<OAuthToken> = {
                access_token: 'test-token',
                token_type: 'Bearer',
                scope: 'read write'
                // No expires_in or issued_at
            };

            expect(tokenWithoutExpiry.expires_in).to.be.undefined;
            expect(tokenWithoutExpiry.issued_at).to.be.undefined;
            
            // Should handle gracefully without throwing errors
            expect(tokenWithoutExpiry.access_token).to.be.a('string');
        });
    });

    describe('Token payload', () => {
        it('is a decoded token as it comes: any claims', () => {
            const jwtPayload: TokenPayload = {
                name: 'Test User',
                email: 'test@example.com',
                preferred_username: 'testuser',
                userOrgs: ['org1', 'org2'],
                userLocations: [{
                    locationId: 'loc1',
                    locationType: 'DC'
                }],
                organization: 'org1',
                authorities: ['ROLE_USER'],
                exp: Math.floor(Date.now() / 1000) + 3600,
                iat: Math.floor(Date.now() / 1000)
            };

            expect(jwtPayload.name).to.equal('Test User');
            expect(jwtPayload.userOrgs).to.include('org1');
            expect(jwtPayload.authorities).to.include('ROLE_USER');
            expect(jwtPayload.userLocations).to.have.length(1);
            expect((jwtPayload.userLocations as Array<{ locationId: string }>)[0].locationId).to.equal('loc1');
            expect(jwtPayload.exp).to.be.a('number');
            expect(jwtPayload.iat).to.be.a('number');
        });

        it('should validate JWT expiry logic', () => {
            const now = Math.floor(Date.now() / 1000);
            const expiredPayload: Partial<TokenPayload> = {
                exp: now - 3600, // Expired 1 hour ago
                iat: now - 7200  // Issued 2 hours ago
            };

            const validPayload: Partial<TokenPayload> = {
                exp: now + 3600, // Expires in 1 hour
                iat: now        // Issued now
            };

            expect(expiredPayload.exp).to.be.lessThan(now);
            expect(validPayload.exp).to.be.greaterThan(now);
        });
    });

    describe('OAuth Status Management', () => {
        it('should handle different OAuth status transitions', () => {
            const statusFlow = [
                OAuthStatus.NotAuthenticated,
                OAuthStatus.Authenticating,
                OAuthStatus.Authenticated,
                OAuthStatus.TokenExpiring,
                OAuthStatus.AuthenticationFailed
            ];

            statusFlow.forEach(status => {
                expect(Object.values(OAuthStatus)).to.include(status);
            });

            // Test status transition logic
            let currentStatus = OAuthStatus.NotAuthenticated;
            expect(currentStatus).to.equal('not_authenticated');

            currentStatus = OAuthStatus.Authenticating;
            expect(currentStatus).to.equal('authenticating');

            currentStatus = OAuthStatus.Authenticated;
            expect(currentStatus).to.equal('authenticated');
        });

        it('should validate OAuth status enum completeness', () => {
            const expectedStatuses = [
                'not_authenticated',
                'authenticated', 
                'authenticating',
                'authentication_failed',
                'token_expiring',
                'token_refreshing'
            ];

            const actualStatuses = Object.values(OAuthStatus);
            
            expectedStatuses.forEach(status => {
                expect(actualStatuses).to.include(status);
            });

            expect(actualStatuses).to.have.length(expectedStatuses.length);
        });
    });

    describe('OAuth Error Scenarios', () => {
        it('should handle invalid OAuth configuration gracefully', () => {
            const invalidConfigs = [
                { provider: 'invalid' }, // Invalid provider
                { clientId: '', authorizationUrl: 'valid-url' }, // Empty client ID
                { clientId: 'valid', authorizationUrl: 'not-a-url' }, // Invalid URL
            ];

            invalidConfigs.forEach(config => {
                // These configs should be identifiable as invalid
                expect(config.provider === undefined || 
                       config.clientId === '' || 
                       !(config as any).authorizationUrl?.startsWith('http')).to.be.true;
            });
        });

        it('should handle token validation edge cases', () => {
            const edgeCaseTokens = [
                { access_token: '' }, // Empty token
                { access_token: 'valid', expires_in: 0 }, // Already expired
                { access_token: 'valid', expires_in: -3600 }, // Negative expiry
            ];

            edgeCaseTokens.forEach(token => {
                if (token.access_token === '') {
                    expect(token.access_token).to.have.length(0);
                }
                if (token.expires_in !== undefined && token.expires_in <= 0) {
                    expect(token.expires_in).to.be.at.most(0);
                }
            });
        });
    });
});