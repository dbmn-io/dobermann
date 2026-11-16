// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it, beforeEach, afterEach } from 'mocha';
import * as vscode from 'vscode';
import { EnvironmentStatusService } from '../../../../services/environment/environment-status.service';
import { EnvironmentManager, EnvironmentConfig, createDefaultEnvironment } from '../../../../environmentManager';
import { TokenExpiryService, TokenExpiryInfo } from '../../../../services/token/token-expiry.service';

describe('EnvironmentStatusService', () => {
    let environmentStatusService: EnvironmentStatusService;
    let mockContext: vscode.ExtensionContext;
    let mockEnvironmentManager: EnvironmentManager;
    let mockTokenExpiryService: TokenExpiryService;
    let globalState: Map<string, any>;

    beforeEach(() => {
        globalState = new Map();
        
        mockContext = {
            globalState: {
                get: (key: string) => globalState.get(key),
                update: (key: string, value: any) => {
                    globalState.set(key, value);
                    return Promise.resolve();
                }
            },
            secrets: {
                get: () => Promise.resolve(undefined),
                store: () => Promise.resolve(),
                delete: () => Promise.resolve()
            },
            subscriptions: []
        } as any;

        mockEnvironmentManager = new EnvironmentManager(mockContext);
        mockTokenExpiryService = new TokenExpiryService();

        environmentStatusService = new EnvironmentStatusService(
            mockContext,
            mockEnvironmentManager,
            mockTokenExpiryService
        );
    });

    afterEach(() => {
        environmentStatusService.dispose();
    });

    describe('getCurrentEnvironmentText', () => {
        it('should return "No Environment" when no active environment', async () => {
            const result = await environmentStatusService.getCurrentEnvironmentText();
            expect(result).to.equal('No Environment');
        });

        it('should return the environment and its header variables when active environment exists', async () => {
            // Setup environment: an org variable shown in the header (#424)
            const env = createDefaultEnvironment('test-env');
            env.isActive = true;
            env.variables = { org: 'ACM-APAC-DEV' };
            env.variableSettings = { org: { showInHeader: true } };
            await mockEnvironmentManager.addEnvironment(env);

            const result = await environmentStatusService.getCurrentEnvironmentText();
            expect(result).to.include('test-env');
            expect(result).to.include('ACM-APAC-DEV');
        });

        it('should include warning indicator for token expiring soon', async () => {
            // Setup environment with expiring token
            const env = createDefaultEnvironment('test-env');
            env.isActive = true;
            await mockEnvironmentManager.addEnvironment(env);

            // Create token expiring in 15 minutes
            const soonExpiryTime = Math.floor(Date.now() / 1000) + (15 * 60);
            const expiringToken = createTestToken({ exp: soonExpiryTime });
            await mockEnvironmentManager.setEnvironmentToken(env.id, expiringToken);

            const result = await environmentStatusService.getCurrentEnvironmentText();
            expect(result).to.include('⚠️');
            expect(result).to.include('test-env');
        });

        it('should include error indicator for expired token', async () => {
            // Setup environment with expired token
            const env = createDefaultEnvironment('test-env');
            env.isActive = true;
            await mockEnvironmentManager.addEnvironment(env);

            // Create expired token
            const expiredTime = Math.floor(Date.now() / 1000) - 3600;
            const expiredToken = createTestToken({ exp: expiredTime });
            await mockEnvironmentManager.setEnvironmentToken(env.id, expiredToken);

            const result = await environmentStatusService.getCurrentEnvironmentText();
            expect(result).to.include('❌');
            expect(result).to.include('test-env');
        });

        it('should not include indicators for valid token', async () => {
            // Setup environment with valid token
            const env = createDefaultEnvironment('test-env');
            env.isActive = true;
            await mockEnvironmentManager.addEnvironment(env);

            // Create valid token (2 hours remaining)
            const futureTime = Math.floor(Date.now() / 1000) + (2 * 3600);
            const validToken = createTestToken({ exp: futureTime });
            await mockEnvironmentManager.setEnvironmentToken(env.id, validToken);

            const result = await environmentStatusService.getCurrentEnvironmentText();
            expect(result).to.not.include('⚠️');
            expect(result).to.not.include('❌');
            expect(result).to.include('test-env');
            expect(result).to.include('$(globe)');
        });
    });

    describe('getCurrentEnvironmentTooltip', () => {
        it('should return basic message when no active environment', async () => {
            const result = await environmentStatusService.getCurrentEnvironmentTooltip();
            expect(result).to.equal('No active environment selected');
        });

        it('should include environment details in tooltip', async () => {
            // Setup environment
            const env = createDefaultEnvironment('test-env');
            env.description = 'Test environment description';
            env.isActive = true;
            env.variables = { org: 'ACM-APAC-DEV' };
            env.variableSettings = { org: { showInHeader: true } };
            await mockEnvironmentManager.addEnvironment(env);

            const result = await environmentStatusService.getCurrentEnvironmentTooltip();
            
            expect(result).to.include('Environment: test-env');
            expect(result).to.include('Description: Test environment description');
            expect(result).to.include('org: ACM-APAC-DEV');
        });

        it('should include token expiry information for valid token', async () => {
            // Setup environment with valid token
            const env = createDefaultEnvironment('test-env');
            env.isActive = true;
            await mockEnvironmentManager.addEnvironment(env);

            // Create valid token (2 hours remaining)
            const futureTime = Math.floor(Date.now() / 1000) + (2 * 3600);
            const validToken = createTestToken({ exp: futureTime });
            await mockEnvironmentManager.setEnvironmentToken(env.id, validToken);

            const result = await environmentStatusService.getCurrentEnvironmentTooltip();
            
            expect(result).to.include('✅ JWT Token: Valid');
            expect(result).to.include('120 minutes remaining');
            expect(result).to.include('Expires at:');
        });

        it('should include warning information for expiring token', async () => {
            // Setup environment with expiring token
            const env = createDefaultEnvironment('test-env');
            env.isActive = true;
            await mockEnvironmentManager.addEnvironment(env);

            // Create token expiring in 15 minutes
            const soonExpiryTime = Math.floor(Date.now() / 1000) + (15 * 60);
            const expiringToken = createTestToken({ exp: soonExpiryTime });
            await mockEnvironmentManager.setEnvironmentToken(env.id, expiringToken);

            const result = await environmentStatusService.getCurrentEnvironmentTooltip();
            
            expect(result).to.include('⚠️ JWT Token: Expires in 15 minutes');
            expect(result).to.include('Expires at:');
        });

        it('should include error information for expired token', async () => {
            // Setup environment with expired token
            const env = createDefaultEnvironment('test-env');
            env.isActive = true;
            await mockEnvironmentManager.addEnvironment(env);

            // Create expired token
            const expiredTime = Math.floor(Date.now() / 1000) - 3600;
            const expiredToken = createTestToken({ exp: expiredTime });
            await mockEnvironmentManager.setEnvironmentToken(env.id, expiredToken);

            const result = await environmentStatusService.getCurrentEnvironmentTooltip();
            
            expect(result).to.include('❌ JWT Token: EXPIRED');
            expect(result).to.include('Please refresh your token');
        });

        it('should include warning for no token configured', async () => {
            // Setup environment without token
            const env = createDefaultEnvironment('test-env');
            env.isActive = true;
            await mockEnvironmentManager.addEnvironment(env);

            const result = await environmentStatusService.getCurrentEnvironmentTooltip();
            
            expect(result).to.include('❌ JWT Token: Not configured');
        });

        it('should include environment metadata when available', async () => {
            // Setup environment with metadata
            const env = createDefaultEnvironment('test-env');
            env.description = 'Test description';
            env.baseUrl = 'https://api.example.com';
            env.folder = 'Test Folder';
            env.isActive = true;
            await mockEnvironmentManager.addEnvironment(env);

            const result = await environmentStatusService.getCurrentEnvironmentTooltip();
            
            expect(result).to.include('Base URL: https://api.example.com');
            expect(result).to.include('Folder: Test Folder');
            expect(result).to.include('Click to manage environments');
        });
    });

    describe('startAutoUpdate and stopAutoUpdate', () => {
        it('should start and stop auto update without errors', () => {
            expect(() => {
                environmentStatusService.startAutoUpdate();
                environmentStatusService.stopAutoUpdate();
            }).to.not.throw();
        });

        it('should handle multiple start calls gracefully', () => {
            expect(() => {
                environmentStatusService.startAutoUpdate();
                environmentStatusService.startAutoUpdate(); // Should not cause issues
                environmentStatusService.stopAutoUpdate();
            }).to.not.throw();
        });

        it('should handle stop without start gracefully', () => {
            expect(() => {
                environmentStatusService.stopAutoUpdate();
            }).to.not.throw();
        });
    });

    describe('visibility methods', () => {
        it('should handle show/hide operations', () => {
            expect(() => {
                environmentStatusService.show();
                environmentStatusService.hide();
            }).to.not.throw();
        });

        it('should handle force update', () => {
            expect(() => {
                environmentStatusService.forceUpdate();
            }).to.not.throw();
        });
    });

    describe('error handling', () => {
        it('should handle updateDisplay errors gracefully', async () => {
            // Create service with invalid environment manager
            const brokenEnvironmentManager = {
                getActiveEnvironment: () => Promise.reject(new Error('Test error'))
            } as any;

            const brokenService = new EnvironmentStatusService(
                mockContext,
                brokenEnvironmentManager
            );

            // Should not throw - just call the method
            await brokenService.updateDisplay();
            
            brokenService.dispose();
        });
    });

});

/**
 * Helper function to create test JWT tokens
 */
function createTestToken(payload: any): string {
    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64');
    const signature = 'test-signature';
    
    return `${encodedHeader}.${encodedPayload}.${signature}`;
}