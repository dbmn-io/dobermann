// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The environment editor's host logic (environment/environment.js), shared by VS Code and the
 * web app. Moved from EnvironmentWebviewManager (#343): the same handlers, talking to the screen
 * through a ScreenSession and to the host through EnvironmentEditorPorts.
 */
import type { NewEnvironmentDraft } from '../new-environment-prompt';
import type { SystemConfig } from '../../data-loading/system-schema';
import type { EnvironmentConfig } from '../../environmentManager';
import type { Disposable } from '../../platform/events';
import type { GoogleServiceAccountConfig } from '../../types/oauth';
import { decodeJwtPayload } from '../../utils/jwt-payload';
import { clientAuthFor } from '../../services/oauth/client-auth';
import { ownOAuthValues, resolveOAuthConfig, systemOAuthDefaults, type SystemOAuthDefaults } from '../../services/systems/system-oauth';
import { systemConfiguration } from '../../services/systems/system-configuration';
import { defaultHeadersFor, defaultVariablesFor } from '../../services/systems/system-headers';
import { describeEnvironmentChanges, sameEnvironment } from '../../services/environment/environment-changes';
import { promptNewSystemInModal } from '../new-system-prompt';
import type { ScreenSession } from '../screen-session';
import { EnvironmentEditorPorts } from './environment-editor.ports';
import { baseUrlProblem } from '../../utils/environment-url';

export interface JWTPayload {
    exp?: number;
    iat?: number;
    iss?: string;
    userOrgs?: string[];
    userLocations?: Array<{ locationId: string, locationType: string }>;
    [key: string]: unknown;
}

interface TokenValidationResult {
    isValid: boolean;
    errorMessage?: string;
    decodedToken?: JWTPayload;
    tokenType?: 'jwt' | 'bearer';
    isExpired?: boolean;
    baseUrl?: string;
}

/** The environment as the page sent it, minus its secrets (#344: they're kept in DBMN for VS Code). */
function withoutSecrets(environment: Partial<EnvironmentConfig> & { jwtToken?: string }): Partial<EnvironmentConfig> & { jwtToken?: string } {
    const env = { ...environment } as Partial<EnvironmentConfig> & { jwtToken?: string; googleServiceAccountConfig?: Record<string, unknown> | object };
    delete env.jwtToken;
    if (env.oauthConfig) {
        const { clientSecret: _secret, ...oauthConfig } = env.oauthConfig;
        env.oauthConfig = oauthConfig as typeof env.oauthConfig;
    }
    if (env.googleServiceAccountConfig) {
        const { private_key: _key, private_key_id: _keyId, ...serviceAccount } = env.googleServiceAccountConfig as Record<string, unknown>;
        (env as Record<string, unknown>).googleServiceAccountConfig = serviceAccount;
    }
    return env;
}

const SIGNED_OUT_STATUS = { authenticated: false, icon: '🚫', text: 'Not Signed In', userInfo: '', color: '#f5f5f5', hasRefreshCapability: false };

export class EnvironmentEditorController {
    private currentToken: string | undefined;
    private decodedToken: JWTPayload | undefined;
    private systemsChanged?: Disposable;
    private environmentsChanged?: Disposable;
    /**
     * The stored environment as the page last took it (loaded, saved, or applied after a change
     * elsewhere). A save compares the store with this: different means someone changed it since,
     * and the page's form is older than the store.
     */
    private loaded?: EnvironmentConfig;
    private saving = false;

    constructor(
        private readonly session: ScreenSession,
        private readonly ports: EnvironmentEditorPorts,
        /** The environment being edited; empty for a new one. Set on first save. */
        private itemId: string | undefined,
        /** #415: a new environment's System and URL, from the New environment dialog. */
        private readonly draft?: NewEnvironmentDraft
    ) {}

    get environmentId(): string | undefined {
        return this.itemId;
    }

    async handle(message: Record<string, unknown>): Promise<void> {
        switch (message.type) {
            case 'ready':
                await this.onReady();
                break;
            case 'submitToken':
                await this.handleTokenSubmission(message.token as string, true);
                break;
            case 'clearToken':
                await this.clearToken();
                break;
            case 'saveEnvironment':
                await this.handleSaveEnvironment(message.environment as Partial<EnvironmentConfig> & { jwtToken?: string });
                break;
            case 'loadEnvironment':
                await this.handleLoadEnvironment(message.environmentId as string);
                break;
            case 'environmentChangeApplied':
                // The page's form had no edits, so it took the change from elsewhere: that is what it shows now
                this.loaded = (message.environment as EnvironmentConfig | undefined) ?? this.loaded;
                break;
            case 'createSystem':
                await this.handleCreateSystem();
                break;
            case 'closeWebview':
                this.ports.host.close();
                break;
            case 'windowMaximize':
                this.ports.host.maximize?.();
                break;
            case 'setActiveEnvironment':
                await this.handleSetActiveEnvironment(message.environmentId as string);
                break;
            // Webview-origin feedback → the editor's own DbmnToast overlay.
            case 'validationError':
            case 'showWarning':
                this.session.post({ type: 'dbmnToast', level: 'warn', message: message.message });
                break;
            case 'showSuccess':
                this.session.post({ type: 'dbmnToast', level: 'success', message: message.message });
                break;
            case 'showInfo':
                this.session.post({ type: 'dbmnToast', level: 'info', message: message.message });
                break;
            case 'showError':
                this.session.post({ type: 'dbmnToast', level: 'error', message: message.message });
                break;
            case 'loadOAuthConfig':
                await this.handleLoadOAuthConfig(message.environmentId as string);
                break;
            case 'resolveOAuthDefaults':
                // #415: the page's address or System changed; what the Standard System says now
                this.session.post({ type: 'oauthDefaults', defaults: await this.oauthDefaultsFor(message.baseUrl as string | undefined, message.systemId as string | undefined) });
                break;
            case 'oauthSignIn':
                await this.handleOAuthSignIn(message.environmentId as string);
                break;
            case 'oauthSignOut':
                await this.handleOAuthSignOut(message.environmentId as string);
                break;
            case 'oauthRefresh':
                await this.handleOAuthRefresh(message.environmentId as string);
                break;
            case 'oauthRequestNewToken':
                await this.handleOAuthRequestNewToken(message.environmentId as string);
                break;
            case 'checkOAuthStatus':
                await this.handleCheckOAuthStatus(message.environmentId as string);
                break;
            case 'checkEnvironmentTransactions':
                await this.handleCheckEnvironmentTransactions(message.environmentId as string);
                break;
            case 'confirmDeleteEnvironment':
                await this.handleConfirmDeleteEnvironment(message.environmentId as string, message.environmentName as string, message.transactionCount as number);
                break;
            case 'testServiceAccountAuth':
                await this.handleTestServiceAccountAuth(message.config as GoogleServiceAccountConfig, message.scopes as string[]);
                break;
            case 'openDbmnAccount':
                await this.handleOpenDbmnAccount();
                break;
        }
    }

    /** The screen loaded: fill it for the environment being edited (or an empty new one). */
    async onReady(): Promise<void> {
        // Clear any cached state when initializing to ensure fresh context
        this.currentToken = undefined;
        this.decodedToken = undefined;

        // handleLoadEnvironment also decodes and shows the stored token (it once did so three times)
        if (this.itemId) {
            await this.handleLoadEnvironment(this.itemId);
        } else {
            // New environment: the System the New environment dialog asked for (#415). Without
            // one, no preselection: saveEnvironment refuses to submit until the user picks one.
            await this.broadcastSystemsList(this.draft?.systemId);
            this.ensureSystemsChangedSubscription();
            if (this.draft) {
                // #415: the Standard System's sign-in defaults for this address, read live
                const defaults = await this.oauthDefaultsFor(this.draft.baseUrl, this.draft.systemId);
                this.session.post({ type: 'newEnvironmentDraft', baseUrl: this.draft.baseUrl, name: this.draft.name, ...(defaults?.clientAuth ? { clientAuth: defaults.clientAuth } : {}) });
                if (defaults) this.session.post({ type: 'oauthDefaults', defaults });
            }
        }
    }

    dispose(): void {
        this.currentToken = undefined;
        this.decodedToken = undefined;
        this.systemsChanged?.dispose();
        this.systemsChanged = undefined;
        this.environmentsChanged?.dispose();
        this.environmentsChanged = undefined;
    }

    // `userInitiated` is true only when the user actively pastes/submits a token. The load path
    // auto-decodes the stored token to display it: not a state change, so no toasts.
    private async handleTokenSubmission(token: string, userInitiated = false): Promise<void> {
        try {
            const environmentId = this.itemId ?? (await this.ports.environments.getActiveEnvironment())?.id;
            if (!environmentId) {
                throw new Error('No environment context available for token submission');
            }
            const environment = await this.ports.environments.getEnvironment(environmentId);
            if (!environment) {
                throw new Error('Environment not found');
            }

            const validation = this.validateToken(token);
            if (!validation.isValid) {
                throw new Error(validation.errorMessage || 'Token validation failed');
            }

            await this.ports.environments.setEnvironmentToken(environmentId, token);

            // OAuth environments: the pasted token becomes the OAuth session
            if (environment.authMethod === 'oauth') {
                try {
                    await this.ports.oauth?.adoptPastedToken(environmentId, token, validation.decodedToken);
                } catch (error) {
                    // Never break token storage over the session update
                    console.warn('[EnvironmentEditor] Failed to update OAuth session:', error);
                }
            }

            this.currentToken = token;
            this.decodedToken = validation.decodedToken;

            // JWT tokens: the issuer gives the base URL
            if (validation.decodedToken && validation.baseUrl && validation.baseUrl !== environment.baseUrl) {
                await this.ownWrite(() => this.ports.environments.updateEnvironment(environmentId, { baseUrl: validation.baseUrl }));
            }

            if (validation.decodedToken) {
                this.session.post({
                    type: 'tokenDecoded',
                    token,
                    decodedToken: validation.decodedToken,
                    isExpired: validation.isExpired,
                    baseUrl: validation.baseUrl
                });
            }

            // Feedback only on a real user submit, in the editor's own toast
            if (userInitiated) {
                if (validation.isExpired) {
                    this.session.post({ type: 'dbmnToast', level: 'warn', message: 'Token has expired but has been stored.' });
                } else if (environment.authMethod === 'oauth') {
                    this.session.post({ type: 'dbmnToast', level: 'info', message: 'OAuth token validated and session updated.' });
                }
            }
        } catch (error) {
            console.error('[EnvironmentEditor] Token submission failed:', error);
            this.session.post({ type: 'tokenError', error: error instanceof Error ? error.message : String(error) });
            this.ports.toast.error(`Token submission failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** JWT (three dot-separated parts): decode, check expiry, take the base URL from the issuer. Anything else is a bearer token. */
    private validateToken(token: string): TokenValidationResult {
        const parts = token.split('.');
        if (parts.length === 3 && parts.every(part => part.length > 0)) {
            const decoded = decodeJwtPayload<JWTPayload>(token);
            if (!decoded) {
                return { isValid: false, errorMessage: 'Invalid JWT token - cannot decode payload' };
            }
            const now = Math.floor(Date.now() / 1000);
            return {
                isValid: true,
                decodedToken: decoded,
                isExpired: decoded.exp ? decoded.exp < now : false,
                baseUrl: decoded.iss ? this.extractBaseUrlFromIss(decoded.iss) : undefined,
                tokenType: 'jwt'
            };
        }
        if (!token || token.trim().length === 0) {
            return { isValid: false, errorMessage: 'Empty or invalid bearer token' };
        }
        if (token.trim().length < 10) {
            return { isValid: false, errorMessage: 'Bearer token too short to be valid' };
        }
        return { isValid: true, tokenType: 'bearer', isExpired: false };
    }

    private async clearToken(): Promise<void> {
        this.currentToken = undefined;
        this.decodedToken = undefined;
        const environmentId = this.itemId ?? (await this.ports.environments.getActiveEnvironment())?.id;
        if (environmentId) {
            await this.ports.environments.deleteEnvironmentToken(environmentId);
        }
        this.session.post({ type: 'tokenCleared' });
    }

    private async handleSaveEnvironment(environmentData: Partial<EnvironmentConfig> & { jwtToken?: string }): Promise<void> {
        try {
            // The webview payload goes straight through: EnvironmentManager's sanitizeEnvironmentConfig
            // (and the catalogue's safe form) is the authoritative filter. A whitelist reshape here
            // once caused three separate systemId-drop bugs.
            // #344: secrets kept elsewhere (DBMN for VS Code) are never saved here, whatever the
            // page sent, and this host's token for the environment goes
            const elsewhere = this.ports.secretsElsewhere?.(environmentData);
            if (elsewhere) environmentData = withoutSecrets(environmentData);
            const wasNew = !environmentData.id;
            // The store changed since the page read this environment (the header picker, another
            // tab, another device): the form is older than the store. Nothing is written; the user
            // reloads to see the change, or keeps editing. Never a silent overwrite.
            if (!wasNew && this.loaded && this.loaded.id === environmentData.id) {
                const current = await this.ports.environments.getEnvironment(environmentData.id as string);
                if (current && !sameEnvironment(current, this.loaded)) {
                    const changes = describeEnvironmentChanges(this.loaded, current);
                    const answer = await this.session.showModal({
                        title: 'Changed since you opened it',
                        body: `${current.name} was changed elsewhere: ${changes.join(', ')}. Reload to see it (your edits here go), or keep editing without saving.`,
                        actions: [
                            { id: 'keep', label: 'Keep editing', variant: 'secondary' },
                            { id: 'reload', label: 'Reload', variant: 'primary' }
                        ],
                        size: 'sm'
                    });
                    if (answer.actionId === 'reload') await this.handleLoadEnvironment(environmentData.id as string);
                    this.ports.host.saveFailed?.();
                    return;
                }
            }
            const stored = wasNew ? undefined : await this.ports.environments.getEnvironment(environmentData.id as string);
            // #424: a base URL may hold variables in its path, never in its host; an existing
            // environment's host is its identity and stays, its path may change (to make part of it
            // a variable). Checked only when the URL changed, so an older odd one still saves.
            if (environmentData.baseUrl !== undefined && environmentData.baseUrl !== stored?.baseUrl) {
                const problem = baseUrlProblem(environmentData.baseUrl, stored?.baseUrl);
                if (problem) {
                    this.session.post({ type: 'environmentSaveError', error: problem });
                    this.ports.host.saveFailed?.();
                    return;
                }
            }
            // #415: an environment's System is fixed once it has one; the page locks the picker,
            // and this keeps the stored System whatever a page sends
            if (stored?.systemId) environmentData = { ...environmentData, systemId: stored.systemId };
            // #415: a new environment on a Standard System starts with the headers its row names,
            // and (#424) the variables they read; whatever the page already has is kept
            if (wasNew && environmentData.systemId && this.ports.systems) {
                const configuration = systemConfiguration((await this.ports.systems.getAllSystems()).find(s => s.id === environmentData.systemId));
                const headers = Object.keys(environmentData.headers ?? {}).length ? undefined : defaultHeadersFor(configuration);
                if (headers) environmentData = { ...environmentData, headers };
                const variables = Object.keys(environmentData.variables ?? {}).length ? undefined : defaultVariablesFor(configuration);
                if (variables) environmentData = { ...environmentData, ...variables };
            }
            // #415: only the user's own OAuth values are stored; what equals the Standard System's
            // default is the System's, read live from then on
            if (environmentData.oauthConfig) {
                const defaults = await this.oauthDefaultsFor(environmentData.baseUrl, environmentData.systemId);
                environmentData = { ...environmentData, oauthConfig: ownOAuthValues(environmentData.oauthConfig, defaults) };
            }
            const savedEnvironment = await this.ownWrite(() => wasNew
                ? this.ports.environments.addEnvironment(environmentData)
                : this.ports.environments.updateEnvironment(environmentData.id as string, environmentData));
            this.ensureEnvironmentsChangedSubscription();

            if (elsewhere) {
                await this.ports.environments.deleteEnvironmentToken(savedEnvironment.id || environmentData.id as string);
            } else if (environmentData.jwtToken && environmentData.authMethod === 'jwt') {
                await this.ports.environments.setEnvironmentToken(savedEnvironment.id || environmentData.id as string, environmentData.jwtToken);
            }

            this.itemId = savedEnvironment.id;
            this.ports.host.saved?.(savedEnvironment, wasNew);
            this.session.post({ type: 'environmentSaved', environment: savedEnvironment });
        } catch (error) {
            this.session.post({ type: 'environmentSaveError', error: error instanceof Error ? error.message : String(error) });
            this.ports.host.saveFailed?.();
        }
    }

    private async handleLoadEnvironment(environmentId: string): Promise<void> {
        try {
            const environment = await this.ports.environments.getEnvironment(environmentId);
            if (!environment) return;
            const token = await this.ports.environments.getEnvironmentToken(environmentId);
            this.loaded = environment;
            this.ensureEnvironmentsChangedSubscription();

            // Systems list BEFORE environmentLoaded, so the dropdown exists when the form sets it
            await this.broadcastSystemsList(environment.systemId);
            this.ensureSystemsChangedSubscription();

            // #415: an OAuth environment shows its Standard System's defaults where it has no
            // value of its own (read live), and the client authentication it has been using
            // where it was saved before that was a setting, so the page never shows a blank
            const { shown, defaults } = await this.pageFormOf(environment);
            this.session.post({ type: 'environmentLoaded', environment: shown });
            if (environment.authMethod === 'oauth') this.session.post({ type: 'oauthDefaults', defaults });

            if (environment.authMethod === 'oauth' && await this.ports.oauth?.status?.(environmentId)) {
                // #344: signed in (or not) elsewhere: DBMN for VS Code
                await this.handleCheckOAuthStatus(environmentId);
            } else if (token) {
                if (environment.authMethod === 'oauth') {
                    this.session.post({
                        type: 'oauthTokenLoaded',
                        token,
                        tokenType: 'oauth',
                        baseUrl: environment?.name || 'OAuth Environment'
                    });
                    await this.handleCheckOAuthStatus(environmentId);
                } else {
                    await this.handleTokenSubmission(token);
                }
            }

            // GitHub Issue #165: variables the endpoint editor asked to add to this environment
            const pendingVars = await this.ports.takePendingVariables?.(environmentId);
            if (pendingVars && pendingVars.length > 0) {
                this.session.post({ type: 'addPendingVariables', variables: pendingVars });
            }
        } catch (error) {
            console.error('Error loading environment:', error);
        }
    }

    private async handleLoadOAuthConfig(environmentId: string): Promise<void> {
        try {
            const environment = await this.ports.environments.getEnvironment(environmentId);
            if (environment?.oauthConfig) {
                this.session.post({ type: 'oauthConfigLoaded', config: environment.oauthConfig });
            }
        } catch (error) {
            console.error('Error loading OAuth config:', error);
        }
    }

    private async handleSetActiveEnvironment(environmentId: string): Promise<void> {
        try {
            await this.ports.environments.setActiveEnvironment(environmentId);
            this.session.post({ type: 'environmentSetActive', environmentId });
        } catch (error) {
            this.ports.toast.error(`Error setting active environment: ${error}`);
        }
    }

    private async handleDeleteEnvironment(environmentId: string): Promise<void> {
        try {
            const success = await this.ports.environments.deleteEnvironment(environmentId);
            if (!success) {
                throw new Error('Environment not found');
            }
            this.session.post({ type: 'environmentDeleted', environmentId });
            // The environment being edited no longer exists: close the editor
            if (this.itemId === environmentId) {
                this.ports.host.close();
            }
        } catch (error) {
            this.session.post({ type: 'environmentDeleteError', error: error instanceof Error ? error.message : String(error) });
        }
    }

    private isTokenExpired(): boolean {
        if (!this.decodedToken || !this.decodedToken.exp) {
            return false;
        }
        return this.decodedToken.exp < Math.floor(Date.now() / 1000);
    }

    private extractBaseUrlFromIss(iss: string): string {
        try {
            const url = new URL(iss);
            const hostname = url.hostname.replace('-auth', '');
            return `${url.protocol}//${hostname}`;
        } catch {
            return '';
        }
    }

    /** OAuth runs through the host's OAuth flows (VS Code); a host without them says so. */
    private oauthOrSay(): EnvironmentEditorPorts['oauth'] {
        if (!this.ports.oauth) {
            this.ports.toast.error('OAuth sign-in runs in DBMN for VS Code for now.');
        }
        return this.ports.oauth;
    }

    private async postOAuthToken(environmentId: string): Promise<void> {
        // #344: signed in elsewhere (DBMN for VS Code): its state, there's no token here
        if (await this.ports.oauth?.status?.(environmentId)) {
            await this.handleCheckOAuthStatus(environmentId);
            return;
        }
        const environment = await this.ports.environments.getEnvironment(environmentId);
        const token = await this.ports.environments.getEnvironmentToken(environmentId);
        if (token && token.trim() !== '') {
            await this.handleCheckOAuthStatus(environmentId);
            this.session.post({ type: 'oauthTokenLoaded', token, tokenType: 'oauth', baseUrl: environment?.name || 'OAuth Environment' });
        }
    }

    private async handleOAuthSignIn(environmentId: string): Promise<void> {
        const oauth = this.oauthOrSay();
        if (!oauth) return;
        try {
            await oauth.signIn(environmentId);
            const elsewhere = await oauth.status?.(environmentId);
            if (elsewhere) {
                await this.handleCheckOAuthStatus(environmentId);
                if (elsewhere.signedIn) this.ports.toast.info(`Signed in through ${elsewhere.where}.`);
                return;
            }
            const token = await this.ports.environments.getEnvironmentToken(environmentId);
            if (token && token.trim() !== '') {
                await this.postOAuthToken(environmentId);
                this.ports.toast.info('OAuth authentication successful!');
            }
        } catch (error) {
            console.error('[EnvironmentEditor] OAuth sign in failed:', error);
            const message = error instanceof Error ? error.message : String(error);
            // #344: an agent sign-in's error already says who failed and why
            this.ports.toast.error(message.startsWith('DBMN for VS Code') ? message : `OAuth authentication failed: ${message}`);
        }
    }

    private async handleOAuthSignOut(environmentId: string): Promise<void> {
        const oauth = this.oauthOrSay();
        if (!oauth) return;
        try {
            // Only update the status if sign-out completed (not cancelled)
            if (await oauth.signOut(environmentId)) {
                this.session.post({ type: 'oauthStatusUpdate', status: SIGNED_OUT_STATUS });
            }
        } catch (error) {
            console.error('[EnvironmentEditor] OAuth sign out failed:', error);
            this.ports.toast.error(`OAuth sign out failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async handleOAuthRefresh(environmentId: string): Promise<void> {
        const oauth = this.oauthOrSay();
        if (!oauth) return;
        try {
            await oauth.refresh(environmentId);
            this.ports.toast.info('Refreshing OAuth token...');
        } catch (error) {
            console.error('[EnvironmentEditor] OAuth token refresh failed:', error);
            this.ports.toast.error(`OAuth token refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async handleOAuthRequestNewToken(environmentId: string): Promise<void> {
        const oauth = this.oauthOrSay();
        if (!oauth) return;
        try {
            await oauth.requestNewToken(environmentId);
            await this.postOAuthToken(environmentId);
        } catch (error) {
            console.error('[EnvironmentEditor] Request new token failed:', error);
            this.ports.toast.error(`Request new token failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async handleCheckOAuthStatus(environmentId: string): Promise<void> {
        try {
            const elsewhere = await this.ports.oauth?.status?.(environmentId);
            if (elsewhere) {
                this.session.post({
                    type: 'oauthStatusUpdate',
                    status: {
                        authenticated: elsewhere.signedIn,
                        icon: elsewhere.signedIn ? '✅' : '🚫',
                        text: elsewhere.signedIn ? 'Authenticated' : 'Not Signed In',
                        userInfo: `In ${elsewhere.where}`,
                        color: elsewhere.signedIn ? '#d4edda' : '#f5f5f5',
                        hasRefreshCapability: false
                    }
                });
                return;
            }
            const refreshCapable = (await this.ports.oauth?.hasRefreshToken(environmentId)) ?? false;
            const token = await this.ports.environments.getEnvironmentToken(environmentId);
            const isAuthenticated = !!token && token.trim() !== '';
            this.session.post({
                type: 'oauthStatusUpdate',
                status: {
                    authenticated: isAuthenticated,
                    icon: isAuthenticated ? '✅' : '🚫',
                    text: isAuthenticated ? 'Authenticated' : 'Not Signed In',
                    userInfo: isAuthenticated ? 'OAuth token available' : '',
                    color: isAuthenticated ? '#d4edda' : '#f5f5f5',
                    hasRefreshCapability: !!refreshCapable
                }
            });
        } catch (error) {
            console.error('[EnvironmentEditor] Failed to check OAuth status:', error);
            this.session.post({ type: 'oauthStatusUpdate', status: { ...SIGNED_OUT_STATUS, text: 'Status Unknown' } });
        }
    }

    private async handleConfirmDeleteEnvironment(environmentId: string, environmentName: string, transactionCount: number): Promise<void> {
        const body = transactionCount > 0
            ? `⚠️ WARNING: This environment has ${transactionCount} linked transaction${transactionCount === 1 ? '' : 's'}.\n\nDeleting "${environmentName}" will affect these transactions.\n\nThis action cannot be undone. Are you sure?`
            : `Are you sure you want to delete the environment "${environmentName}"?\n\nThis action cannot be undone.`;
        if (await this.ports.confirmDestructive({ title: 'Delete environment?', body, confirmLabel: 'Delete' })) {
            await this.handleDeleteEnvironment(environmentId);
        }
    }

    private async handleCheckEnvironmentTransactions(environmentId: string): Promise<void> {
        let count = 0;
        try {
            count = (await this.ports.countTransactions?.(environmentId)) ?? 0;
        } catch (error) {
            // A failed count still allows deletion
            console.error('[EnvironmentEditor] Failed to count environment transactions:', error);
        }
        this.session.post({ type: 'transactionCountResponse', count });
    }

    private async handleOpenDbmnAccount(): Promise<void> {
        if (this.ports.account) {
            await this.ports.account.openAccountPage();
        } else {
            this.session.openExternal('https://dbmn.io/account/');
        }
    }

    /** Issue #126 Phase 2: test a Google service account's credentials. */
    private async handleTestServiceAccountAuth(config: GoogleServiceAccountConfig, scopes: string[]): Promise<void> {
        if (!this.ports.testServiceAccount) {
            this.session.post({ type: 'serviceAccountAuthResult', success: false, error: 'Service accounts run in DBMN for VS Code for now.' });
            return;
        }
        try {
            const { expiresIn } = await this.ports.testServiceAccount(config, scopes);
            this.session.post({ type: 'serviceAccountAuthResult', success: true, message: `✅ Authentication successful! Token expires in ${expiresIn} seconds.` });
        } catch (error) {
            console.error('[EnvironmentEditor] Service account auth test failed:', error);
            this.session.post({ type: 'serviceAccountAuthResult', success: false, error: error instanceof Error ? error.message : String(error) });
        }
    }

    /** Post the Systems list; a new environment shows the placeholder until the user picks one. */
    /** #415: what the environment's Standard System says about signing in at this address, if anything. */
    private async oauthDefaultsFor(baseUrl: string | undefined, systemId: string | undefined): Promise<SystemOAuthDefaults | undefined> {
        if (!systemId || !this.ports.systems) return undefined;
        try {
            return systemOAuthDefaults({ baseUrl }, (await this.ports.systems.getAllSystems()).find(s => s.id === systemId));
        } catch {
            return undefined;
        }
    }

    private async broadcastSystemsList(selectedSystemId?: string): Promise<void> {
        const systems = this.ports.systems;
        if (!systems) return;
        try {
            this.session.post({ type: 'systemsList', systems: sortedSystems(await systems.getAllSystems()), selectedSystemId });
        } catch (err) {
            // Surface the failure instead of silently leaving the dropdown empty
            this.ports.toast.error(`Could not load Systems: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /**
     * The environment this editor shows changed elsewhere (the Hub's header picker, another tab,
     * another device): the page is told what changed. A form with no edits takes it and says so
     * (environmentChangeApplied); one with edits keeps them and is asked at save time.
     */
    /** A write of this editor's own: not a change from elsewhere, and what the page shows from now on. */
    private async ownWrite(write: () => Promise<EnvironmentConfig>): Promise<EnvironmentConfig> {
        this.saving = true;
        try {
            const written = await write();
            this.loaded = (await this.ports.environments.getEnvironment(written.id)) ?? written;
            return written;
        } finally {
            this.saving = false;
        }
    }

    /** The environment as the page's form shows it: an OAuth one with its Standard System's defaults filled in. */
    private async pageFormOf(environment: EnvironmentConfig): Promise<{ shown: EnvironmentConfig; defaults: SystemOAuthDefaults | undefined }> {
        const defaults = environment.authMethod === 'oauth' ? await this.oauthDefaultsFor(environment.baseUrl, environment.systemId) : undefined;
        let shown = environment;
        if (environment.authMethod === 'oauth' && environment.oauthConfig) {
            const { system: _runtimeOnly, ...resolved } = resolveOAuthConfig(environment.oauthConfig, defaults) ?? environment.oauthConfig;
            shown = { ...environment, oauthConfig: { ...resolved, clientAuth: clientAuthFor(resolved) } };
        }
        return { shown, defaults };
    }

    private ensureEnvironmentsChangedSubscription(): void {
        if (this.environmentsChanged || !this.ports.environments.onEnvironmentsChanged) return;
        this.environmentsChanged = this.ports.environments.onEnvironmentsChanged(() => {
            if (this.saving || !this.itemId || !this.loaded) return;
            void this.ports.environments.getEnvironment(this.itemId).then(async current => {
                if (!current || this.saving || !this.loaded || sameEnvironment(current, this.loaded)) return;
                const { shown } = await this.pageFormOf(current);
                this.session.post({
                    type: 'environmentChangedElsewhere',
                    environment: shown,
                    stored: current,
                    changes: describeEnvironmentChanges(this.loaded, current)
                });
            });
        });
    }

    private ensureSystemsChangedSubscription(): void {
        if (this.systemsChanged || !this.ports.systems?.onSystemsChanged) return;
        this.systemsChanged = this.ports.systems.onSystemsChanged(() => {
            // The Standard Systems arrived or changed (they are fetched after the page can open):
            // the list, and the OAuth defaults the page may have asked for before they were known
            if (this.itemId) {
                void this.ports.environments.getEnvironment(this.itemId).then(async env => {
                    await this.broadcastSystemsList(env?.systemId);
                    if (env?.authMethod === 'oauth') this.session.post({ type: 'oauthDefaults', defaults: await this.oauthDefaultsFor(env.baseUrl, env.systemId) });
                });
            } else {
                void this.broadcastSystemsList(undefined).then(async () => {
                    if (this.draft) this.session.post({ type: 'oauthDefaults', defaults: await this.oauthDefaultsFor(this.draft.baseUrl, this.draft.systemId) });
                });
            }
        });
    }

    private async handleCreateSystem(): Promise<void> {
        const systems = this.ports.systems;
        if (!systems) return;
        try {
            // The modal opens over the environment editor
            const created = await promptNewSystemInModal(systems, this.session);
            if (!created) return;
            this.session.post({ type: 'systemsList', systems: sortedSystems(await systems.getAllSystems()), selectedSystemId: created.id });
        } catch (err) {
            this.ports.toast.error(`Add System failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

/** Systems for the picker: name order (compareSystemsByName); #415: global ones say so. */
function sortedSystems(systems: SystemConfig[]): Array<{ id: string; name: string; scope?: 'global' }> {
    return systems.slice().sort((a, b) => a.name.localeCompare(b.name)).map(s => ({ id: s.id, name: s.name, ...(s.scope ? { scope: s.scope } : {}) }));
}
