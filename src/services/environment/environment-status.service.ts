// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Environment Status Service
 * Handles status bar display for the environment and the variables its header shows
 * Integrates with existing StatusBarService
 */

import * as vscode from 'vscode';
import { getToast } from '../notifications/get-toast';
import { EnvironmentManager, EnvironmentConfig } from '../../environmentManager';
import { ITokenExpiryService, TokenExpiryInfo } from '../token/token-expiry.service';
import { IOAuthService } from '../oauth/oauth.interface';
import { OAuthStatus } from '../../types/oauth';
import { getDobermannWorkspaceFolder } from '../../utils/workspace-helper';
import { IToastService } from '../notifications/toast.interface';
import * as path from 'path';
import { hasUsableValue, optionLabel } from './variable-options';

export interface IEnvironmentStatusService {
    updateDisplay(): Promise<void>;
    startAutoUpdate(): void;
    stopAutoUpdate(): void;
    showEnvironmentSelector(): Promise<void>;
    getCurrentEnvironmentText(): Promise<string>;
    getCurrentEnvironmentTooltip(): Promise<string>;
    showEnvironmentStatusMenu(): Promise<void>;
}

export class EnvironmentStatusService implements IEnvironmentStatusService {
    private statusBarItem: vscode.StatusBarItem;
    private autoUpdateTimer?: NodeJS.Timeout;
    private isAutoUpdateEnabled = false;
    private readonly AUTO_UPDATE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes (same as token monitoring)

    constructor(
        private context: vscode.ExtensionContext,
        private environmentManager: EnvironmentManager,
        private tokenExpiryService?: ITokenExpiryService,
        private oauthService?: IOAuthService
    ) {
        // Create dedicated status bar item for environment display
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100 // Higher priority than execution status bar (90) - appears left
        );
        this.statusBarItem.command = {
            command: 'dbmn.environmentStatusMenuClick',
            title: 'Environment Status Actions'
        };
        
        // Register for cleanup
        this.context.subscriptions.push(this.statusBarItem);

        // Listen for environment changes if the method exists
        try {
            if (this.environmentManager.onEnvironmentsChanged) {
                this.environmentManager.onEnvironmentsChanged(() => {
                    this.updateDisplay();
                    this.updateCurrentTokenTracking(); // Track token changes when environments change
                });
            }
        } catch (error) {
            // Silently handle environment change subscription errors
        }
    }

    /**
     * Updates the status bar display with current environment and its header variables
     */
    async updateDisplay(): Promise<void> {
        try {
            const activeEnv = await this.environmentManager.getActiveEnvironment();
            
            if (!activeEnv) {
                this.statusBarItem.text = '$(gear) No Environment';
                this.statusBarItem.tooltip = 'No active environment selected. Click to manage environments.';
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                // Hub env switcher (hub.html: hubEnvSelector) covers this now;
            // service stays alive for token-expiry monitoring + auto-logout.
            this.statusBarItem.hide();
                return;
            }

            const text = await this.generateStatusText(activeEnv);
            const tooltip = await this.generateTooltip(activeEnv);
            const backgroundColor = await this.getStatusColor(activeEnv);

            this.statusBarItem.text = text;
            this.statusBarItem.tooltip = tooltip;
            this.statusBarItem.backgroundColor = backgroundColor;
            // Hub env switcher (hub.html: hubEnvSelector) covers this now;
            // service stays alive for token-expiry monitoring + auto-logout.
            this.statusBarItem.hide();

        } catch (error) {
            // Handle display update errors gracefully
            this.statusBarItem.text = '$(alert) Environment Error';
            this.statusBarItem.tooltip = 'Error loading environment information';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            // Hub env switcher (hub.html: hubEnvSelector) covers this now;
            // service stays alive for token-expiry monitoring + auto-logout.
            this.statusBarItem.hide();
        }
    }

    /**
     * Starts automatic status updates
     */
    startAutoUpdate(): void {
        if (this.isAutoUpdateEnabled) {
            return; // Already running
        }

        this.isAutoUpdateEnabled = true;
        
        // Initial update
        this.updateDisplay();

        // Set up periodic updates
        this.autoUpdateTimer = setInterval(() => {
            this.updateDisplay();
        }, this.AUTO_UPDATE_INTERVAL_MS);

        // Start token expiry monitoring if service is available
        if (this.tokenExpiryService) {
            this.tokenExpiryService.startMonitoring((info: TokenExpiryInfo) => {
                // Update display when token expiry status changes
                this.updateDisplay();
                
                // Handle automatic logout on token expiry
                if (info.isExpired) {
                    this.handleTokenExpiry(info);
                }
            });
            
            // Initialize token tracking for current environment
            this.updateCurrentTokenTracking();
        }
    }

    /**
     * Stops automatic status updates
     */
    stopAutoUpdate(): void {
        this.isAutoUpdateEnabled = false;

        if (this.autoUpdateTimer) {
            clearInterval(this.autoUpdateTimer);
            this.autoUpdateTimer = undefined;
        }

        if (this.tokenExpiryService) {
            this.tokenExpiryService.stopMonitoring();
        }
    }

    /**
     * The Hub, where the environment and its header variables are switched.
     * With no environment yet, adding one.
     */
    async showEnvironmentSelector(): Promise<void> {
        try {
            const activeEnv = await this.environmentManager.getActiveEnvironment();
            await vscode.commands.executeCommand(activeEnv ? 'dbmn.openHub' : 'dbmn.addEnvironment');
        } catch (error) {
            getToast()?.error('Failed to open the Hub');
        }
    }

    /** The header variables that hold a value, for the status text and tooltip. */
    private async headerVariableValues(environmentId: string): Promise<Array<{ name: string; value: string }>> {
        try {
            const variables = await this.environmentManager.getHeaderVariables(environmentId);
            return variables.filter(v => v.value).map(v => ({ name: v.name, value: optionLabel(v, v.value) }));
        } catch {
            return [];
        }
    }

    /**
     * Gets the current environment display text
     */
    async getCurrentEnvironmentText(): Promise<string> {
        const activeEnv = await this.environmentManager.getActiveEnvironment();
        if (!activeEnv) {
            return 'No Environment';
        }
        return await this.generateStatusText(activeEnv);
    }

    /**
     * Gets the current environment tooltip text
     */
    async getCurrentEnvironmentTooltip(): Promise<string> {
        const activeEnv = await this.environmentManager.getActiveEnvironment();
        if (!activeEnv) {
            return 'No active environment selected';
        }
        return await this.generateTooltip(activeEnv);
    }

    /**
     * Shows the environment status menu with workspace and environment options
     */
    async showEnvironmentStatusMenu(): Promise<void> {
        const workspaceUri = getDobermannWorkspaceFolder();
        const workspacePath = workspaceUri?.fsPath;
        
        const options = [
            {
                label: '$(organization) Switch Environment',
                description: 'Change the active environment',
                id: 'switchEnvironment'
            },
            {
                label: '$(folder-opened) Open Dobermann Workspace',
                description: workspacePath ? `Open ${workspacePath}` : 'Open workspace in new window',
                id: 'openWorkspace'
            },
            {
                label: '$(gear) Change Workspace Location',
                description: 'Select a different folder for Dobermann files',
                id: 'changeWorkspace'
            },
            {
                label: '$(info) Copy Workspace Path',
                description: workspacePath || 'No workspace configured',
                id: 'copyWorkspacePath'
            }
        ];

        const choice = await vscode.window.showQuickPick(options, {
            title: 'Environment & Workspace Management',
            placeHolder: 'Select an action'
        });

        if (!choice) return;

        switch (choice.id) {
            case 'switchEnvironment':
                await this.showEnvironmentSelector();
                break;
            case 'openWorkspace':
                await vscode.commands.executeCommand('dbmn.openWorkspace');
                break;
            case 'changeWorkspace':
                await vscode.commands.executeCommand('dbmn.selectWorkspaceFolder');
                break;
            case 'copyWorkspacePath':
                if (workspacePath) {
                    await vscode.env.clipboard.writeText(workspacePath);
                    getToast()?.info('Workspace path copied to clipboard');
                } else {
                    getToast()?.warn('No workspace configured');
                }
                break;
        }
    }

    /**
     * Generates the status bar text for an environment
     */
    private async generateStatusText(environment: EnvironmentConfig): Promise<string> {
        const values = await this.headerVariableValues(environment.id);

        // Check authentication status and get user info
        let authIndicator = '';
        let userInfo = '';
        
        if (environment.authMethod === 'dbmn') {
            // DBMN auth — check DBMN session status
            const dbmnAuth = (global as Record<string, unknown>).dbmnAuthService as { isAuthenticated(): boolean } | undefined;
            authIndicator = dbmnAuth?.isAuthenticated() ? '🛡️ ' : '🚫 ';
        } else if (environment.authMethod === 'oauth' && this.oauthService) {
            try {
                const isAuthenticated = await this.oauthService.isAuthenticated(environment.id);
                if (isAuthenticated) {
                    authIndicator = '🛡️ ';
                    // Get user info from OAuth service (handles different token formats)
                    try {
                        const userInfoData = await this.oauthService.getUserInfo(environment.id);
                        if (userInfoData && userInfoData.name) {
                            userInfo = ` • ${userInfoData.name}`;
                        }
                    } catch (error) {
                        // Silently handle user info retrieval errors
                    }
                } else {
                    authIndicator = '🚫 ';
                }
            } catch (error) {
                authIndicator = '⚠️ ';
            }
        } else {
            // JWT authentication - check for token expiry warnings
            try {
                const token = await this.environmentManager.getEnvironmentToken(environment.id);
                if (token && this.tokenExpiryService && typeof this.tokenExpiryService.getExpiryInfo === 'function') {
                    const expiryInfo = this.tokenExpiryService.getExpiryInfo(token);
                    
                    if (expiryInfo.isExpired) {
                        authIndicator = '❌ ';
                    } else if (expiryInfo.warningLevel === 'warning') {
                        authIndicator = '⚠️ ';
                    } else {
                        authIndicator = '$(globe) ';
                    }
                }
            } catch (error) {
                // Handle token expiry check errors gracefully
            }
        }

        // Format environment name with folder if present
        const envDisplayName = environment.folder 
            ? `${environment.folder}/${environment.name}`
            : environment.name;

        // The header variables' values after a colon, as the Hub header shows them
        const variablesDisplay = values.length ? `: ${values.map(v => v.value).join(' · ')}` : '';

        return `${authIndicator}🌍 ${envDisplayName}${variablesDisplay}${userInfo}`;
    }

    /**
     * Generates the tooltip for an environment
     */
    private async generateTooltip(environment: EnvironmentConfig): Promise<string> {
        let tooltip = `Environment: ${environment.name}\n`;
        
        if (environment.description) {
            tooltip += `Description: ${environment.description}\n`;
        }

        // The header variables, one line each
        for (const variable of await this.headerVariableValues(environment.id)) {
            tooltip += `${variable.name}: ${variable.value}\n`;
        }

        // Authentication information
        tooltip += '─────────────────\n';
        
        if (environment.authMethod === 'dbmn') {
            // DBMN Authentication
            const dbmnAuth = (global as Record<string, unknown>).dbmnAuthService as { isAuthenticated(): boolean } | undefined;
            if (dbmnAuth?.isAuthenticated()) {
                tooltip += '🛡️ DBMN: Authenticated\n';
                tooltip += 'Token: Injected at execution time';
            } else {
                tooltip += '🚫 DBMN: Not authenticated\n';
                tooltip += 'Sign in via the Account tab';
            }
        } else if (environment.authMethod === 'oauth' && this.oauthService) {
            // OAuth Authentication
            try {
                const isAuthenticated = await this.oauthService.isAuthenticated(environment.id);
                if (isAuthenticated) {
                    tooltip += '🛡️ OAuth: Authenticated\n';
                    
                    // Get user information from OAuth service (handles different token formats)
                    try {
                        const userInfoData = await this.oauthService.getUserInfo(environment.id);
                        if (userInfoData) {
                            if (userInfoData.name) {
                                tooltip += `User: ${userInfoData.name}\n`;
                            }
                            if (userInfoData.email) {
                                tooltip += `Email: ${userInfoData.email}\n`;
                            }
                        }
                        
                        // Most OAuth tokens (like GitHub) don't expire or have very long expiration
                        // Show simple active status instead of trying to decode expiry
                        tooltip += 'Token: Active (OAuth access token)';
                        
                        // Note: OAuth tokens typically don't have expiry dates or expire far in the future
                        // Unlike JWT tokens which have explicit exp claims
                    } catch (error) {
                        // Silently handle user info retrieval errors
                    }
                } else {
                    tooltip += '🚫 OAuth: Not authenticated\n';
                    tooltip += 'Click to configure OAuth authentication';
                }
            } catch (error) {
                tooltip += '⚠️ OAuth: Error checking authentication status';
            }
        } else {
            // JWT Authentication
            try {
                const token = await this.environmentManager.getEnvironmentToken(environment.id);
                if (token && this.tokenExpiryService && typeof this.tokenExpiryService.getExpiryInfo === 'function') {
                    const expiryInfo = this.tokenExpiryService.getExpiryInfo(token);
                    
                    if (expiryInfo.isExpired) {
                        tooltip += '❌ JWT Token: EXPIRED\n';
                        tooltip += 'Please refresh your token before executing API calls.';
                    } else if (expiryInfo.warningLevel === 'warning') {
                        tooltip += `⚠️ JWT Token: Expires in ${expiryInfo.remainingMinutes} minutes\n`;
                        tooltip += `Expires at: ${expiryInfo.expiresAt.toLocaleTimeString()}`;
                    } else {
                        tooltip += `✅ JWT Token: Valid (${expiryInfo.remainingMinutes} minutes remaining)\n`;
                        tooltip += `Expires at: ${expiryInfo.expiresAt.toLocaleTimeString()}`;
                    }
                } else {
                    tooltip += '❌ JWT Token: Not configured';
                }
            } catch (error) {
                // Handle token expiry tooltip errors gracefully
                tooltip += '❌ JWT Token: Error checking expiry';
            }
        }

        // Environment metadata
        if (environment.baseUrl) {
            tooltip += `\nBase URL: ${environment.baseUrl}`;
        }
        
        if (environment.folder) {
            tooltip += `\nFolder: ${environment.folder}`;
        }

        // Workspace information
        try {
            const workspaceUri = getDobermannWorkspaceFolder();
            if (workspaceUri) {
                tooltip += '\n─────────────────';
                tooltip += `\n📁 Dobermann Workspace: ${workspaceUri.fsPath}`;
            }
        } catch (error) {
            // If workspace not available, don't show workspace info
        }

        tooltip += '\n\nClick to manage environments';
        tooltip += '\nRight-click for workspace options';

        return tooltip;
    }

    /**
     * Gets the status background color based on environment state
     */
    private async getStatusColor(environment: EnvironmentConfig): Promise<vscode.ThemeColor | undefined> {
        // Check status and show appropriate color
        let token: string | undefined;
        
        // Check token expiry status - ONLY for JWT authentication (not OAuth or DBMN)
        if (environment.authMethod !== 'oauth' && environment.authMethod !== 'dbmn') {
            try {
                token = await this.environmentManager.getEnvironmentToken(environment.id);
                if (token && this.tokenExpiryService && typeof this.tokenExpiryService.getExpiryInfo === 'function') {
                    const expiryInfo = this.tokenExpiryService.getExpiryInfo(token);
                    
                    if (expiryInfo.isExpired) {
                        return new vscode.ThemeColor('statusBarItem.errorBackground');
                    } else if (expiryInfo.warningLevel === 'warning') {
                        return new vscode.ThemeColor('statusBarItem.warningBackground');
                    }
                }
            } catch (error) {
                // Handle token expiry color check errors gracefully
            }
        }

        // A header variable a run would ask for (none of its options picked, or empty): warn, as the Hub header does
        try {
            const variables = await this.environmentManager.getHeaderVariables(environment.id);
            if (variables.some(v => !hasUsableValue(v))) {
                return new vscode.ThemeColor('statusBarItem.warningBackground');
            }
        } catch (error) {
            // Don't show warning color for variable check errors
        }

        // Check authentication status based on auth method
        if (environment.authMethod === 'dbmn') {
            const dbmnAuth = (global as Record<string, unknown>).dbmnAuthService as { isAuthenticated(): boolean } | undefined;
            if (!dbmnAuth?.isAuthenticated()) {
                return new vscode.ThemeColor('statusBarItem.warningBackground');
            }
        } else if (environment.authMethod === 'oauth' && this.oauthService) {
            // OAuth Authentication - check OAuth service
            try {
                const isAuthenticated = await this.oauthService.isAuthenticated(environment.id);
                if (!isAuthenticated) {
                    return new vscode.ThemeColor('statusBarItem.warningBackground');
                }
            } catch (error) {
                return new vscode.ThemeColor('statusBarItem.warningBackground');
            }
        } else {
            // JWT Authentication - check for token (only if not already retrieved above)
            if (!token) {
                token = await this.environmentManager.getEnvironmentToken(environment.id);
            }
            if (!token) {
                return new vscode.ThemeColor('statusBarItem.warningBackground');
            }
        }

        // Everything is good - show remote/connected background
        return new vscode.ThemeColor('statusBarItem.remoteBackground'); // Blue - fully connected to real environment
    }

    /**
     * Forces an immediate display update
     */
    forceUpdate(): void {
        this.updateDisplay();
    }

    /**
     * Updates token tracking in TokenExpiryService when environment changes
     */
    private async updateCurrentTokenTracking(): Promise<void> {
        if (!this.tokenExpiryService) {
            return;
        }

        try {
            const activeEnv = await this.environmentManager.getActiveEnvironment();
            
            if (!activeEnv) {
                // No active environment - clear token tracking
                this.tokenExpiryService.clearCurrentToken();
                return;
            }

            if (activeEnv.authMethod === 'oauth' || activeEnv.authMethod === 'dbmn') {
                // OAuth/DBMN environment - clear token tracking (tokens managed externally)
                this.tokenExpiryService.clearCurrentToken();
                return;
            }

            // JWT environment - get token and start tracking
            const token = await this.environmentManager.getEnvironmentToken(activeEnv.id);
            if (token) {
                this.tokenExpiryService.setCurrentToken(token);
            } else {
                this.tokenExpiryService.clearCurrentToken();
            }
        } catch (error) {
            // Silently handle token tracking errors
            this.tokenExpiryService.clearCurrentToken();
        }
    }

    /**
     * Notifies the user when a JWT token expires. The expired token is left in
     * storage so the user can see/replace it — we only remove a token when it
     * is being replaced or the user explicitly clears it.
     */
    private async handleTokenExpiry(expiryInfo: TokenExpiryInfo): Promise<void> {
        try {
            const activeEnv = await this.environmentManager.getActiveEnvironment();

            if (!activeEnv || activeEnv.authMethod === 'oauth' || activeEnv.authMethod === 'dbmn') {
                return; // Not applicable for OAuth, DBMN, or no environment
            }

            // Refresh status bar so it reflects the "expired" state — that is the
            // only *passive* surface. We deliberately do NOT toast here: proactive
            // expiry toasts on env-switch/interval were noisy (and duplicated,
            // since this fires from both the immediate setCurrentToken check and
            // the monitor interval). Auth is handled lazily at run time —
            // ExecutionCommands.checkAndPromptAuthentication prompts when the user
            // actually executes against an expired-token environment.
            this.updateDisplay();

        } catch (error) {
            // Passive-only: a failure here shouldn't nag the user with a toast.
            console.warn('[EnvironmentStatus] Failed to handle token expiry:', error);
        }
    }

    /**
     * Hides the status bar item
     */
    hide(): void {
        this.statusBarItem.hide();
    }

    /**
     * No-op: Hub env switcher (hub.html: hubEnvSelector) is the visible
     * surface now. Method kept for API compatibility; calls are ignored.
     */
    show(): void {
        this.statusBarItem.hide();
    }

    /**
     * Gets the current visibility state
     */
    isVisible(): boolean {
        // VS Code doesn't expose the visible property directly
        // We'll track visibility state internally if needed
        return true; // Assume visible since we don't have direct access
    }

    /**
     * Dispose method for cleanup
     */
    dispose(): void {
        this.stopAutoUpdate();
        this.statusBarItem.dispose();
    }
}

// Service token for dependency injection
export const ENVIRONMENT_STATUS_SERVICE_TOKEN = Symbol('EnvironmentStatusService');