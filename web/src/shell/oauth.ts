// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * OAuth in the web app (#343): the same sign-in as VS Code (src/services/oauth/oauth-sign-in.ts).
 * What differs is the host's part: the provider's page opens in a popup, and it comes back to
 * /oauth-callback.html, which hands the answer to this tab (BroadcastChannel, or the opener).
 *
 * The provider must let a browser call its token endpoint (CORS). One that doesn't (the Training Ground's sign-in server,
 * most production systems) fails here, and the sign-in says so: run it in DBMN for VS Code, the
 * local agent (#356, #344 step 4).
 * The access token and the provider's refresh token are kept in this browser's vault (#362). An
 * expired access token is refreshed without the popup (#359); Request new token signs in again.
 */
import type { EnvironmentManager } from '../../../src/environmentManager';
import type { ISecretStore } from '../../../src/platform/interfaces/secret-store.interface';
import type { OAuthActions } from '../../../src/screens/environment/environment-editor.ports';
import { awaitOAuthCallback, deliverOAuthCallback } from '../../../src/services/oauth/oauth-callback';
import { OAuthConfigService, type OAuthSystems } from '../../../src/services/oauth/oauth-config.service';
import { OAuthFlowHandler } from '../../../src/services/oauth/oauth-flow-handler';
import { OAuthTokenRefresher } from '../../../src/services/oauth/oauth-refresh';
import { runOAuthSignIn } from '../../../src/services/oauth/oauth-sign-in';
import { agentSignInMessages } from '../../../src/services/agent/local-agent';

export const OAUTH_CALLBACK_PATH = '/oauth-callback.html';
const CHANNEL = 'dbmn-oauth';

/** Hand the callback page's answer to the sign-in waiting in this tab. Once, at start-up. */
export function listenForOAuthCallbacks(): void {
    const deliver = (data: unknown) => {
        const message = data as { type?: string; url?: string };
        if (message?.type !== 'dbmn-oauth-callback' || !message.url) return;
        deliverOAuthCallback(new URL(message.url).searchParams, warning => console.warn(warning));
    };
    try {
        new BroadcastChannel(CHANNEL).onmessage = event => deliver(event.data);
    } catch {
        // No BroadcastChannel: the opener message below still arrives
    }
    window.addEventListener('message', event => {
        if (event.origin === location.origin) deliver(event.data);
    });
}

/**
 * #344 step 4: OAuth's browser half for an environment that runs in DBMN for VS Code. VS Code
 * starts the sign-in (and keeps the verifier and secret); the provider's page opens here, in a
 * popup, and comes back to this app's callback page; VS Code exchanges the code. The user never
 * leaves the browser, and it doesn't matter which VS Code window is in front.
 */
export function agentBrowserSignIn(): { redirectUri: () => string; run(url: string, state: string): Promise<string> } {
    return {
        redirectUri: () => location.origin + OAUTH_CALLBACK_PATH,
        run: async (url, state) => {
            const callback = awaitOAuthCallback(state, 180_000);
            if (!window.open(url, 'dbmn-oauth-signin', 'popup=yes,width=520,height=720')) {
                callback.code.catch(() => undefined);
                callback.cancel('blocked');
                throw new Error('The browser blocked the sign-in window. Allow pop-ups for this site, then Sign In again.');
            }
            return callback.code;
        }
    };
}

/** #344 step 4: an environment that runs in DBMN for VS Code signs in there (its tokens live there). */
export interface AgentSignIn {
    signIn(environmentId: string, options?: { forceLogin?: boolean }): Promise<boolean>;
    signOut(environmentId: string): Promise<void>;
    isSignedIn(environmentId: string): Promise<boolean>;
}

const callbackFlow = () => new OAuthFlowHandler(undefined, { redirectUri: () => location.origin + OAUTH_CALLBACK_PATH });

/** #359: this browser's refresh tokens, in its vault; one for the whole app (sign-in, the gate, runs). */
export function webOAuthRefresher(environments: EnvironmentManager, vault: ISecretStore, systems?: OAuthSystems): OAuthTokenRefresher {
    const configs = new OAuthConfigService(environments, systems);
    return new OAuthTokenRefresher({
        vault,
        flow: callbackFlow(),
        config: id => configs.getConfig(id),
        saveAccessToken: (id, token) => environments.setEnvironmentToken(id, token.access_token),
        log: (message, error) => (error ? console.warn(message, error) : console.info(message))
    });
}

export function webOAuthActions(environments: EnvironmentManager, refresher: OAuthTokenRefresher, agent?: AgentSignIn, toast?: { info(message: string): void }, systems?: OAuthSystems): OAuthActions {
    const flow = callbackFlow();
    const configs = new OAuthConfigService(environments, systems);

    const runsInAgent = async (environmentId: string) => !!agent && (await environments.getEnvironment(environmentId))?.runOn === 'local-agent';

    const signIn = async (environmentId: string, forceLogin = false) => {
        if (await runsInAgent(environmentId)) {
            const name = (await environments.getEnvironment(environmentId))?.name ?? 'this environment';
            toast?.info(agentSignInMessages.started(name));
            let signedIn: boolean;
            try {
                signedIn = await agent!.signIn(environmentId, { forceLogin });
            } catch (error) {
                throw new Error(agentSignInMessages.failed(name, error));
            }
            if (!signedIn) throw new Error(agentSignInMessages.failed(name, 'it didn\'t finish signing in.'));
            return;
        }
        const config = await configs.getConfig(environmentId);
        if (!config) throw new Error('This environment has no OAuth settings yet: add them on its Authentication tab.');
        let token;
        try {
            token = await runOAuthSignIn(flow, {
                environmentId,
                config,
                scopes: [],
                forceLogin,
                // A popup (the click that asked for it is still the user's: no popup blocker)
                open: async url => Boolean(window.open(url, 'dbmn-oauth-signin', 'popup=yes,width=520,height=720')),
                timeoutMs: 120_000
            });
        } catch (error) {
            // fetch's TypeError is how a browser reports a CORS refusal (or no server at all)
            if (error instanceof TypeError) {
                throw new Error('This system doesn\'t let a browser sign in (CORS). Set the environment\'s Run in to Local agent and open DBMN for VS Code, then sign in again.');
            }
            throw error;
        }
        await environments.setEnvironmentToken(environmentId, token.access_token);
        // #359: the provider's refresh token, if it gave one; a sign-in without one drops the old
        if (token.refresh_token) await refresher.keep(environmentId, token);
        else await refresher.forget(environmentId);
    };

    return {
        // #344: an environment that runs in DBMN for VS Code is signed in (or not) there
        status: async environmentId => {
            if (!(await runsInAgent(environmentId))) return undefined;
            const where = 'DBMN for VS Code';
            try {
                return { signedIn: await agent!.isSignedIn(environmentId), where };
            } catch {
                return { signedIn: false, where: `${where} (not reachable)` };
            }
        },
        signIn: environmentId => signIn(environmentId),
        signOut: async environmentId => {
            // #344: an environment that runs in DBMN for VS Code is signed out there
            if (await runsInAgent(environmentId)) {
                const name = (await environments.getEnvironment(environmentId))?.name ?? 'this environment';
                try {
                    await agent!.signOut(environmentId);
                } catch (error) {
                    throw new Error(`DBMN for VS Code couldn't sign out of ${name}: ${error instanceof Error ? error.message : String(error)}`);
                }
                toast?.info(`Signed out of ${name} in DBMN for VS Code.`);
                return true;
            }
            // The refresh token first: a "signed in?" check in between must find nothing to refresh with
            await refresher.forget(environmentId);
            await environments.clearEnvironmentToken(environmentId);
            return true;
        },
        // #359: the refresh token first; the popup only when there's none or the provider refuses it
        refresh: async environmentId => {
            if (!(await runsInAgent(environmentId)) && await refresher.refresh(environmentId)) return;
            await signIn(environmentId);
        },
        requestNewToken: environmentId => signIn(environmentId, true),
        hasRefreshToken: environmentId => refresher.has(environmentId),
        adoptPastedToken: async (environmentId, token) => environments.setEnvironmentToken(environmentId, token)
    };
}
