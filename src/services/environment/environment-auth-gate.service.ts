// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Environment authentication gate (GitHub Issue #311).
 *
 * One place that answers "may a run against this environment start now?":
 * checks the environment's credentials and, when they have expired, asks
 * the user — Sign In (OAuth / DBMN), Continue anyway, or Cancel.
 *
 * It began life as two private methods on ExecutionCommands, so only a
 * fresh Run went through it. Resume did not: a batch that stopped on 401s
 * after its token expired was resumed with the same dead token, failed the
 * same way, and the user had no idea why. Now Run, Resume and Reprocess all
 * pass through here.
 *
 * The logic is core (./auth-gate.ts, #343): the web app runs the same gate. This is VS Code's
 * adapter: its ports come from the service container, its prompts from dbmn-prompts (the DBMN
 * modal bridge).
 */

import { IServiceContainer, ServiceTokens } from '../../container/service-container.interface';
import { UIServiceTokens } from '../../container/ui-services-registry';
import { IOAuthService } from '../oauth/oauth.interface';
import { OAuthStatus } from '../../types/oauth';
import { ITokenExpiryService } from '../token/token-expiry.service';
import { IDbmnAuthService } from '../dbmn-auth/dbmn-auth.interface';
import { IToastService } from '../notifications/toast.interface';
import { getToast } from '../notifications/get-toast';
import { promptEnvAuthExpired, sendDbmnSignInLinkInApp } from '../ui/dbmn-prompts';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';
import type { EnvironmentConfig } from '../../environmentManager';
import { AuthGate, type BatchEnvironmentRef, type GateEnvironment, type IEnvironmentAuthGate } from './auth-gate';

export type { BatchEnvironmentRef, GateEnvironment, IEnvironmentAuthGate } from './auth-gate';

/** Injectable prompt seam so tests never open a modal. */
export interface AuthGatePrompts {
    promptEnvAuthExpired: typeof promptEnvAuthExpired;
    sendDbmnSignInLinkInApp: typeof sendDbmnSignInLinkInApp;
}

interface EnvironmentLookup {
    getEnvironment(id: string): Promise<EnvironmentConfig | undefined>;
    getAllEnvironments(): Promise<EnvironmentConfig[]>;
    getEnvironmentToken(environmentId: string): Promise<string | undefined>;
}

export class EnvironmentAuthGateService implements IEnvironmentAuthGate {
    private readonly gate: AuthGate;

    constructor(
        private readonly serviceContainer: IServiceContainer,
        private readonly logger: IExtensionDiagnosticLogger,
        prompts?: Partial<AuthGatePrompts>
    ) {
        const p: AuthGatePrompts = { promptEnvAuthExpired, sendDbmnSignInLinkInApp, ...prompts };
        // Resolved per call, not here: services register after the gate is built
        const environments = () => this.serviceContainer.resolve<EnvironmentLookup>(ServiceTokens.EnvironmentManager);
        const oauth = () => this.serviceContainer.resolve<IOAuthService>('IOAuthService');
        const dbmnAuth = () => (global as Record<string, unknown>).dbmnAuthService as IDbmnAuthService | undefined;
        this.gate = new AuthGate({
            environments: {
                getEnvironment: id => environments().getEnvironment(id),
                getAllEnvironments: () => environments().getAllEnvironments(),
                getEnvironmentToken: id => environments().getEnvironmentToken(id)
            },
            oauth: {
                isSignedIn: async id => {
                    const status = await oauth().getAuthenticationStatus(id);
                    // Expiring counts as valid — the OAuth service refreshes it itself
                    if (status === OAuthStatus.Authenticated || status === OAuthStatus.TokenExpiring) return true;
                    // #359: expired, or no session: the refresh token gets a new one without the browser
                    return oauth().refreshSilently(id);
                },
                signIn: async id => { await oauth().authenticate(id); }
            },
            dbmn: {
                // GitHub Issue #396: a session that can no longer refresh is not signed in
                isSignedIn: async () => {
                    const auth = dbmnAuth();
                    if (!auth || !auth.isAuthenticated()) return false;
                    return (await auth.ensureValidSession()).status !== 'auth_error';
                },
                sendSignInLink: async () => {
                    const auth = dbmnAuth();
                    if (!auth) return;
                    const toast = (global as Record<string, unknown>).dbmnToastService as IToastService;
                    await p.sendDbmnSignInLinkInApp(auth, toast);
                }
            },
            isTokenExpired: token => this.serviceContainer.resolve<ITokenExpiryService>(UIServiceTokens.TokenExpiryService).isTokenExpired(token),
            promptAuthExpired: name => p.promptEnvAuthExpired(name),
            toast: {
                warn: message => getToast()?.warn(message),
                error: message => getToast()?.error(message)
            },
            log: {
                info: (message, data) => this.logger.info(message, undefined, data),
                warn: (message, error, data) => this.logger.warn(message, error, data),
                error: (message, error, data) => this.logger.error(message, error, data)
            }
        });
    }

    isAuthenticationValid(environment: GateEnvironment): Promise<boolean> {
        return this.gate.isAuthenticationValid(environment);
    }

    ensureAuthenticated(environment: GateEnvironment): Promise<boolean> {
        return this.gate.ensureAuthenticated(environment);
    }

    ensureAuthenticatedForBatch(batch: BatchEnvironmentRef): Promise<boolean> {
        return this.gate.ensureAuthenticatedForBatch(batch);
    }
}
