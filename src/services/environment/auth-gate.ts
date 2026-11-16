// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Environment authentication gate (#311), the same in both hosts (#343): "may a run against this
 * environment start now?" Valid credentials pass. Missing or expired ones get a DBMN modal
 * naming the environment ("Sign in to <name>"): Sign In (OAuth signs in, then the run goes
 * ahead), Continue (run anyway), or close (no run). The host supplies how to check and sign in
 * (AuthGatePorts): VS Code from its services (EnvironmentAuthGateService), the web app from its own.
 *
 * GitHub Issue #396: the environment's own sign-in and the DBMN account are different things
 * and can be asked for one after the other, so this prompt names the environment and says it
 * is separate. An environment that signs in WITH the DBMN account is one sign-in: it opens
 * the DBMN sign-in directly, with no prompt in front of it.
 */
import type { EnvironmentConfig } from '../../environmentManager';
import type { ModalHost } from '../../screens/modal.types';

/** The slice of an environment the gate reads. */
export type GateEnvironment = Pick<EnvironmentConfig, 'id' | 'name' | 'authMethod'> & {
    googleServiceAccountConfig?: { client_email?: string; private_key?: string; token_uri?: string };
};

/** What a stored batch tells us about the environment it ran against. */
export interface BatchEnvironmentRef {
    environmentId?: string;
    environment?: string;
}

export interface IEnvironmentAuthGate {
    /** True when the environment's credentials are usable right now (no prompt). */
    isAuthenticationValid(environment: GateEnvironment): Promise<boolean>;
    /**
     * Valid → true. Expired → prompt; true if the user signed in or chose to
     * continue, false if they cancelled or must finish signing in first.
     */
    ensureAuthenticated(environment: GateEnvironment): Promise<boolean>;
    /**
     * The same gate for a stored batch: resolves its environment (by id,
     * else by name) and runs ensureAuthenticated. An environment that no
     * longer exists cannot be gated, so that passes — with a log line.
     */
    ensureAuthenticatedForBatch(batch: BatchEnvironmentRef): Promise<boolean>;
}

export type AuthExpiredChoice = 'Sign In' | 'Continue' | undefined;

export interface AuthGatePorts {
    environments: {
        getEnvironment(id: string): Promise<EnvironmentConfig | undefined>;
        getAllEnvironments(): Promise<EnvironmentConfig[]>;
        getEnvironmentToken(environmentId: string): Promise<string | undefined>;
    };
    oauth: {
        /** Signed in now (a token that's expiring counts: it gets refreshed). */
        isSignedIn(environmentId: string): Promise<boolean>;
        signIn(environmentId: string): Promise<void>;
    };
    dbmn: {
        /**
         * Signed in AND usable. A session that exists but can no longer refresh is not signed
         * in (#396): its token is what a DBMN environment is called with, and the run would
         * only fail on HTTP 401. Offline is not a reason to ask for sign-in.
         */
        isSignedIn(): boolean | Promise<boolean>;
        /** VS Code: the in-app magic link (the run waits for the next Run). Absent: nothing to do. */
        sendSignInLink?(): Promise<void>;
    };
    /** A JWT's `exp` has passed (throws for a token that isn't a JWT). */
    isTokenExpired(token: string): boolean;
    promptAuthExpired(environmentName: string): Promise<AuthExpiredChoice>;
    toast: { warn(message: string): void; error(message: string): void };
    log: {
        info(message: string, data?: Record<string, unknown>): void;
        warn(message: string, error?: Error, data?: Record<string, unknown>): void;
        error(message: string, error?: Error, data?: Record<string, unknown>): void;
    };
}

/** The environment's sign-in prompt, in a DbmnModal host (the web app; VS Code's bridge uses the same words). */
export async function promptAuthExpiredInModal(host: ModalHost, environmentName?: string): Promise<AuthExpiredChoice> {
    const result = await host.showModal(authExpiredModal(environmentName));
    if (result.actionId === 'sign-in') return 'Sign In';
    if (result.actionId === 'continue') return 'Continue';
    return undefined;
}

export function authExpiredModal(environmentName?: string) {
    return {
        title: environmentName ? `Sign in to ${environmentName}` : 'Authentication expired',
        body: environmentName
            ? `Your sign-in to "${environmentName}" has expired. That is its own login, separate from your DBMN account. Sign in again, or continue with the expired sign-in.`
            : 'Authentication token has expired. How would you like to proceed?',
        actions: [
            { id: 'continue', label: 'Continue', variant: 'secondary' as const },
            { id: 'sign-in', label: 'Sign In', variant: 'primary' as const }
        ],
        dismissible: true,
        size: 'sm' as const
    };
}

export class AuthGate implements IEnvironmentAuthGate {
    constructor(private readonly ports: AuthGatePorts) {}

    /** Supports OAuth, JWT, Google Service Account, DBMN and 'none' (Issues #113, #126). */
    async isAuthenticationValid(environment: GateEnvironment): Promise<boolean> {
        const environmentId = environment.id;
        try {
            if (environment.authMethod === 'none') {
                return true;
            }
            if (environment.authMethod === 'google-service-account') {
                const config = environment.googleServiceAccountConfig;
                return !!(config && config.client_email && config.private_key && config.token_uri);
            }
            if (environment.authMethod === 'dbmn') {
                return await this.ports.dbmn.isSignedIn();
            }
            if (environment.authMethod === 'oauth') {
                return await this.ports.oauth.isSignedIn(environmentId);
            }
            // JWT (and anything unspecified): the stored token must parse and not be expired
            const token = await this.ports.environments.getEnvironmentToken(environmentId);
            if (!token) {
                return false;
            }
            return !this.ports.isTokenExpired(token);
        } catch (error) {
            this.ports.log.warn('[EnvironmentAuthGate] Error checking authentication validity', error instanceof Error ? error : undefined, {
                environmentId,
                authMethod: environment.authMethod
            });
            if (environment.authMethod === 'jwt') {
                const errorMessage = error instanceof Error ? error.message : String(error);
                // A token that isn't a JWT (e.g. a GitHub PAT) is the API's to judge
                if (errorMessage.includes('Invalid JWT format') ||
                    errorMessage.includes('Failed to parse JWT payload') ||
                    errorMessage.includes('Invalid token format')) {
                    this.ports.log.info('[EnvironmentAuthGate] Token appears to be non-JWT format (e.g., GitHub PAT), passing through to API');
                    return true;
                }
            }
            return false;
        }
    }

    /** GitHub Issue #65: just-in-time authentication. */
    async ensureAuthenticated(environment: GateEnvironment): Promise<boolean> {
        const environmentId = environment.id;
        if (await this.isAuthenticationValid(environment)) {
            return true;
        }
        // GitHub Issue #396: this environment signs in with the DBMN account, so there is one
        // sign-in and one prompt for it — not "authentication expired" and then DBMN's. The
        // run cannot continue until the user has signed in; they run it again afterwards.
        if (environment.authMethod === 'dbmn' && this.ports.dbmn.sendSignInLink) {
            await this.ports.dbmn.sendSignInLink();
            return false;
        }
        const choice = await this.ports.promptAuthExpired(environment.name);
        switch (choice) {
            case 'Sign In':
                try {
                    if (environment.authMethod === 'oauth') {
                        await this.ports.oauth.signIn(environmentId);
                        this.ports.log.info('[EnvironmentAuthGate] OAuth sign-in completed successfully', { environmentId, environmentName: environment.name });
                        return true;
                    }
                    if (environment.authMethod === 'dbmn') {
                        if (this.ports.dbmn.sendSignInLink) {
                            // In-app magic link: the run continues only after the user clicks it
                            // and Runs (or Resumes) again
                            await this.ports.dbmn.sendSignInLink();
                            return false;
                        }
                        return true;
                    }
                    // JWT: nothing to sign in to — the token lives in the environment settings
                    this.ports.toast.warn('Please update your JWT token in the environment settings');
                    return false;
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    this.ports.toast.error(`Authentication failed: ${errorMessage}`);
                    this.ports.log.error('[EnvironmentAuthGate] Authentication failed during sign-in', error instanceof Error ? error : undefined, {
                        environmentId,
                        environmentName: environment.name
                    });
                    return false;
                }
            case 'Continue':
                this.ports.log.warn('[EnvironmentAuthGate] User chose to continue with expired/invalid token', undefined, {
                    environmentId,
                    environmentName: environment.name,
                    reason: 'user_choice_testing'
                });
                return true;
            default:
                return false;
        }
    }

    async ensureAuthenticatedForBatch(batch: BatchEnvironmentRef): Promise<boolean> {
        let environment: EnvironmentConfig | undefined;
        if (batch.environmentId) {
            environment = await this.ports.environments.getEnvironment(batch.environmentId);
        }
        if (!environment && batch.environment) {
            // Older batches recorded only the environment name
            environment = (await this.ports.environments.getAllEnvironments()).find(e => e.name === batch.environment);
        }
        if (!environment) {
            this.ports.log.warn('[EnvironmentAuthGate] issue#311 batch environment not found — cannot check its credentials', undefined, {
                environmentId: batch.environmentId,
                environment: batch.environment
            });
            return true;
        }
        return this.ensureAuthenticated(environment);
    }
}
