// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit tests for OAuth authentication status display in EnvironmentStatusService
 * Tests the status bar display logic for OAuth environments vs JWT environments
 */

import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import * as vscode from 'vscode';
import { EnvironmentStatusService } from '../../../../services/environment/environment-status.service';
import { EnvironmentManager, createDefaultEnvironment } from '../../../../environmentManager';

// Mock OAuth service for testing
interface MockOAuthService {
    isAuthenticated(environmentId: string): Promise<boolean>;
    getUserInfo(environmentId: string): Promise<any>;
    getAuthenticationStatus(environmentId: string): Promise<any>;
}

// Mock token expiry service
interface MockTokenExpiryService {
    getExpiryInfo(token: string): any;
    startMonitoring(callback: (info: any) => void): void;
    stopMonitoring(): void;
}

class MockOAuthServiceImpl implements MockOAuthService {
    private authenticatedEnvironments = new Map<string, boolean>();
    private userInfoMap = new Map<string, any>();

    setAuthenticated(environmentId: string, authenticated: boolean, userInfo?: any): void {
        this.authenticatedEnvironments.set(environmentId, authenticated);
        if (userInfo) {
            this.userInfoMap.set(environmentId, userInfo);
        }
    }

    async isAuthenticated(environmentId: string): Promise<boolean> {
        return this.authenticatedEnvironments.get(environmentId) ?? false;
    }

    async getUserInfo(environmentId: string): Promise<any> {
        return this.userInfoMap.get(environmentId);
    }

    async getAuthenticationStatus(environmentId: string): Promise<any> {
        const isAuth = await this.isAuthenticated(environmentId);
        return {
            isAuthenticated: isAuth,
            status: isAuth ? 'authenticated' : 'not_authenticated'
        };
    }

    reset(): void {
        this.authenticatedEnvironments.clear();
        this.userInfoMap.clear();
    }
}

class MockTokenExpiryServiceImpl implements MockTokenExpiryService {
    private expiryResults = new Map<string, any>();

    setTokenExpiry(token: string, expiryInfo: any): void {
        this.expiryResults.set(token, expiryInfo);
    }

    getExpiryInfo(token: string): any {
        return this.expiryResults.get(token) ?? {
            isExpired: false,
            warningLevel: 'normal',
            remainingMinutes: 60,
            expiresAt: new Date(Date.now() + 3600000)
        };
    }

    startMonitoring(callback: (info: any) => void): void {
        // Mock implementation
    }

    stopMonitoring(): void {
        // Mock implementation
    }

    reset(): void {
        this.expiryResults.clear();
    }

    isTokenExpired(token: string): boolean {
        const info = this.getExpiryInfo(token);
        return info.isExpired;
    }

    getTimeUntilExpiry(token: string): number {
        const info = this.getExpiryInfo(token);
        return info.isExpired ? 0 : info.remainingMinutes * 60; // Convert to seconds
    }
}

describe('EnvironmentStatusService - OAuth Authentication Display', () => {
    let environmentStatusService: EnvironmentStatusService;
    let environmentManager: EnvironmentManager;
    let mockOAuthService: MockOAuthServiceImpl;
    let mockTokenExpiryService: MockTokenExpiryServiceImpl;
    let mockContext: vscode.ExtensionContext;
    let globalState: Map<string, any>;
    let secretsStore: Map<string, string>;

    beforeEach(() => {
        globalState = new Map();
        secretsStore = new Map();
        
        mockContext = {
            globalState: {
                get: (key: string) => globalState.get(key),
                update: (key: string, value: any) => {
                    globalState.set(key, value);
                    return Promise.resolve();
                }
            },
            secrets: {
                get: (key: string) => Promise.resolve(secretsStore.get(key)),
                store: (key: string, value: string) => {
                    secretsStore.set(key, value);
                    return Promise.resolve();
                },
                delete: (key: string) => {
                    secretsStore.delete(key);
                    return Promise.resolve();
                }
            },
            subscriptions: []
        } as any;

        environmentManager = new EnvironmentManager(mockContext);
        mockOAuthService = new MockOAuthServiceImpl();
        mockTokenExpiryService = new MockTokenExpiryServiceImpl();

        environmentStatusService = new EnvironmentStatusService(
            mockContext,
            environmentManager,
            mockTokenExpiryService as any,
            mockOAuthService as any
        );
    });

    describe('OAuth Environment Status Display', () => {
        it('should show authenticated status for OAuth environment', async () => {
            // Arrange
            const environment = createDefaultEnvironment('oauth-authenticated-env');
            environment.authMethod = 'oauth';
            environment.name = 'OAuth Test Env';
            environment.isActive = true;
            await environmentManager.addEnvironment(environment);

            // Mock OAuth service responses
            mockOAuthService.setAuthenticated(environment.id, true, {
                name: 'OAuth User',
                email: 'oauth@example.com'
            });
            await environmentManager.updateEnvironment(environment.id, { variables: { org: 'ACM-APAC-DEV' }, variableSettings: { org: { showInHeader: true } } });

            // Act
            const statusText = await environmentStatusService.getCurrentEnvironmentText();
            const tooltipText = await environmentStatusService.getCurrentEnvironmentTooltip();

            // Assert
            expect(statusText).to.include('🛡️'); // OAuth authenticated indicator
            expect(statusText).to.include('OAuth Test Env');
            expect(statusText).to.include('ACM-APAC-DEV');
            expect(statusText).to.include('OAuth User');

            expect(tooltipText).to.include('🛡️ OAuth: Authenticated');
            expect(tooltipText).to.include('User: OAuth User');
            expect(tooltipText).to.include('Email: oauth@example.com');
            expect(tooltipText).to.include('org: ACM-APAC-DEV');
        });

        it('should show not authenticated status for OAuth environment', async () => {
            // Arrange
            const environment = createDefaultEnvironment('oauth-not-auth-env');
            environment.authMethod = 'oauth';
            environment.name = 'OAuth Unauth Env';
            environment.isActive = true;
            await environmentManager.addEnvironment(environment);

            // Mock OAuth service responses - NOT authenticated
            mockOAuthService.setAuthenticated(environment.id, false);
            // Act
            const statusText = await environmentStatusService.getCurrentEnvironmentText();
            const tooltipText = await environmentStatusService.getCurrentEnvironmentTooltip();

            // Assert
            expect(statusText).to.include('🚫'); // OAuth not authenticated indicator
            expect(statusText).to.include('OAuth Unauth Env');

            expect(tooltipText).to.include('🚫 OAuth: Not authenticated');
            expect(tooltipText).to.include('Click to configure OAuth authentication');
        });

        it('should show error status for OAuth authentication check failure', async () => {
            // Arrange
            const environment = createDefaultEnvironment('oauth-error-env');
            environment.authMethod = 'oauth';
            environment.name = 'OAuth Error Env';
            environment.isActive = true;
            await environmentManager.addEnvironment(environment);

            // Mock OAuth service to throw error
            const originalIsAuthenticated = mockOAuthService.isAuthenticated;
            mockOAuthService.isAuthenticated = async () => {
                throw new Error('OAuth service unavailable');
            };

            // Act
            const statusText = await environmentStatusService.getCurrentEnvironmentText();
            const tooltipText = await environmentStatusService.getCurrentEnvironmentTooltip();

            // Assert
            expect(statusText).to.include('⚠️'); // OAuth error indicator
            expect(tooltipText).to.include('⚠️ OAuth: Error checking authentication status');

            // Restore original method
            mockOAuthService.isAuthenticated = originalIsAuthenticated;
        });
    });

    describe('JWT Environment Status Display (Comparison)', () => {
        it('should show JWT token status without OAuth indicators', async () => {
            // Arrange
            const environment = createDefaultEnvironment('jwt-env');
            environment.authMethod = 'jwt'; // NOT OAuth
            environment.name = 'JWT Test Env';
            environment.isActive = true;
            await environmentManager.addEnvironment(environment);

            // Set valid JWT token
            const payload = Buffer.from(JSON.stringify({
                userOrgs: ['ACM-APAC-DEV'],
                exp: Math.floor(Date.now() / 1000) + 3600
            })).toString('base64');
            const jwtToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
            await environmentManager.setEnvironmentToken(environment.id, jwtToken);

            await environmentManager.updateEnvironment(environment.id, { variables: { org: 'ACM-APAC-DEV' }, variableSettings: { org: { showInHeader: true } } });

            // Act
            const statusText = await environmentStatusService.getCurrentEnvironmentText();
            const tooltipText = await environmentStatusService.getCurrentEnvironmentTooltip();

            // Assert
            expect(statusText).to.not.include('🛡️'); // Should NOT have OAuth indicators
            expect(statusText).to.not.include('🚫');
            expect(statusText).to.include('JWT Test Env');
            expect(statusText).to.include('ACM-APAC-DEV');

            expect(tooltipText).to.not.include('OAuth'); // Should NOT mention OAuth
            expect(tooltipText).to.include('JWT Token: Valid');
        });

        it('should show JWT token expiry warnings', async () => {
            // Arrange
            const environment = createDefaultEnvironment('jwt-warning-env');
            environment.authMethod = 'jwt';
            environment.name = 'JWT Warning Env';
            environment.isActive = true;
            await environmentManager.addEnvironment(environment);

            const jwtToken = 'valid.jwt.token';
            await environmentManager.setEnvironmentToken(environment.id, jwtToken);

            // Mock token expiry service to return warning
            mockTokenExpiryService.setTokenExpiry(jwtToken, {
                isExpired: false,
                warningLevel: 'warning',
                remainingMinutes: 15,
                expiresAt: new Date(Date.now() + 15 * 60000)
            });

            // Act
            const statusText = await environmentStatusService.getCurrentEnvironmentText();

            // Assert
            expect(statusText).to.include('[!]'); // JWT warning indicator
            expect(statusText).to.not.include('🛡️'); // Should NOT have OAuth indicators
        });
    });

    describe('Status Background Colors', () => {
        it('should return error background for OAuth authentication failure', async () => {
            // This test would require access to the private getStatusColor method
            // For now, we can test the behavior indirectly through updateDisplay
            
            // Arrange
            const environment = createDefaultEnvironment('oauth-color-test-env');
            environment.authMethod = 'oauth';
            environment.isActive = true;
            await environmentManager.addEnvironment(environment);

            // Mock OAuth service to return false for authentication
            mockOAuthService.setAuthenticated(environment.id, false);

            // Act - This should internally call getStatusColor
            await environmentStatusService.updateDisplay();

            // Assert - We can't directly test the color, but we can verify the status text
            const statusText = await environmentStatusService.getCurrentEnvironmentText();
            expect(statusText).to.include('🚫'); // Indicates warning background should be used
        });

        it('should return success background for OAuth authenticated environment', async () => {
            // Arrange
            const environment = createDefaultEnvironment('oauth-success-color-env');
            environment.authMethod = 'oauth';
            environment.isActive = true;
            await environmentManager.addEnvironment(environment);

            // Mock OAuth service to return true for authentication
            mockOAuthService.setAuthenticated(environment.id, true);
            await environmentManager.updateEnvironment(environment.id, { variables: { org: 'ACM-APAC-DEV' }, variableSettings: { org: { showInHeader: true } } });

            // Act
            await environmentStatusService.updateDisplay();

            // Assert
            const statusText = await environmentStatusService.getCurrentEnvironmentText();
            expect(statusText).to.include('🛡️'); // Indicates success/remote background should be used
        });
    });

    describe('Mixed Environment Handling', () => {
        it('should handle OAuth and JWT environments differently in same session', async () => {
            // Arrange - Create both OAuth and JWT environments
            const oauthEnv = createDefaultEnvironment('oauth-mixed-env');
            oauthEnv.authMethod = 'oauth';
            oauthEnv.name = 'OAuth Env';
            
            const jwtEnv = createDefaultEnvironment('jwt-mixed-env');
            jwtEnv.authMethod = 'jwt';
            jwtEnv.name = 'JWT Env';
            
            await environmentManager.addEnvironment(oauthEnv);
            await environmentManager.addEnvironment(jwtEnv);

            // Set up OAuth environment
            mockOAuthService.setAuthenticated(oauthEnv.id, true, { name: 'OAuth User' });
            await environmentManager.updateEnvironment(oauthEnv.id, { variables: { org: 'OAUTH-ORG' }, variableSettings: { org: { showInHeader: true } } });

            // Set up JWT environment
            const jwtToken = 'valid.jwt.token';
            await environmentManager.setEnvironmentToken(jwtEnv.id, jwtToken);
            await environmentManager.updateEnvironment(jwtEnv.id, { variables: { org: 'JWT-ORG' }, variableSettings: { org: { showInHeader: true } } });

            // Test OAuth environment as active
            oauthEnv.isActive = true;
            jwtEnv.isActive = false;

            let statusText = await environmentStatusService.getCurrentEnvironmentText();
            expect(statusText).to.include('🛡️'); // OAuth indicator
            expect(statusText).to.include('OAuth Env');
            expect(statusText).to.include('OAuth User');

            // Test JWT environment as active
            oauthEnv.isActive = false;
            jwtEnv.isActive = true;

            statusText = await environmentStatusService.getCurrentEnvironmentText();
            expect(statusText).to.not.include('🛡️'); // Should not have OAuth indicators
            expect(statusText).to.include('JWT Env');
        });

        it('should handle environment switching between OAuth and JWT correctly', async () => {
            // Arrange
            const oauthEnv = createDefaultEnvironment('switch-oauth-env');
            oauthEnv.authMethod = 'oauth';
            oauthEnv.isActive = true; // Start as active
            
            await environmentManager.addEnvironment(oauthEnv);
            mockOAuthService.setAuthenticated(oauthEnv.id, true);

            // Act & Assert - OAuth environment active
            let statusText = await environmentStatusService.getCurrentEnvironmentText();
            expect(statusText).to.include('🛡️');

            // Switch to JWT environment
            oauthEnv.isActive = false;
            const jwtEnv = createDefaultEnvironment('switch-jwt-env');
            jwtEnv.authMethod = 'jwt';
            jwtEnv.isActive = true;
            await environmentManager.addEnvironment(jwtEnv);

            const jwtToken = 'valid.jwt.token';
            await environmentManager.setEnvironmentToken(jwtEnv.id, jwtToken);

            // Act & Assert - JWT environment active
            statusText = await environmentStatusService.getCurrentEnvironmentText();
            expect(statusText).to.not.include('🛡️');
            expect(statusText).to.not.include('🚫');
        });
    });

    describe('User Information Display', () => {
        it('should display OAuth user information when available', async () => {
            // Arrange
            const environment = createDefaultEnvironment('oauth-userinfo-env');
            environment.authMethod = 'oauth';
            environment.isActive = true;
            await environmentManager.addEnvironment(environment);

            const userInfo = {
                name: 'John OAuth User',
                email: 'john.oauth@example.com',
                organizations: ['ACM-APAC-DEV', 'ACM-EMEA-PROD']
            };

            mockOAuthService.setAuthenticated(environment.id, true, userInfo);
            await environmentManager.updateEnvironment(environment.id, { variables: { org: 'ACM-APAC-DEV' }, variableSettings: { org: { showInHeader: true } } });

            // Act
            const statusText = await environmentStatusService.getCurrentEnvironmentText();
            const tooltipText = await environmentStatusService.getCurrentEnvironmentTooltip();

            // Assert
            expect(statusText).to.include('John OAuth User'); // User name in status bar
            expect(tooltipText).to.include('User: John OAuth User');
            expect(tooltipText).to.include('Email: john.oauth@example.com');
        });

        it('should handle OAuth environments without user information gracefully', async () => {
            // Arrange
            const environment = createDefaultEnvironment('oauth-no-userinfo-env');
            environment.authMethod = 'oauth';
            environment.isActive = true;
            await environmentManager.addEnvironment(environment);

            mockOAuthService.setAuthenticated(environment.id, true); // No user info
            await environmentManager.updateEnvironment(environment.id, { variables: { org: 'ACM-APAC-DEV' }, variableSettings: { org: { showInHeader: true } } });

            // Act
            const statusText = await environmentStatusService.getCurrentEnvironmentText();
            const tooltipText = await environmentStatusService.getCurrentEnvironmentTooltip();

            // Assert
            expect(statusText).to.include('🛡️'); // Should still show authenticated
            expect(statusText).to.not.include(' • '); // No user info separator
            expect(tooltipText).to.include('🛡️ OAuth: Authenticated');
            expect(tooltipText).to.not.include('User:'); // No user info section
        });
    });
});