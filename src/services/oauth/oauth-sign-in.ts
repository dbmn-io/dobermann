// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #343: an OAuth sign-in (authorization code, with PKCE when the environment asks for it), the
 * same in both hosts. The host only opens the provider's sign-in page (VS Code: the user's
 * browser; the web app: a popup) and hands the browser's answer to deliverOAuthCallback (VS
 * Code: its URI handler; the web app: its callback page). Everything else is here.
 */
import type { OAuthConfig, OAuthToken } from '../../types/oauth';
import type { IOAuthFlowHandler } from './oauth.interface';
import { awaitOAuthCallback } from './oauth-callback';

export interface OAuthSignInRequest {
    environmentId: string;
    config: OAuthConfig;
    scopes: string[];
    /** Ask the provider for its sign-in page even when it remembers the user (Request new token). */
    forceLogin?: boolean;
    /** Open the provider's sign-in page; false when it could not be opened. */
    open(url: string): Promise<boolean>;
    /** Called once the page is open: `cancel` gives up waiting (the user cancelled). */
    waiting?(cancel: (reason: string) => void): void;
    timeoutMs?: number;
}

export async function runOAuthSignIn(flow: IOAuthFlowHandler, request: OAuthSignInRequest): Promise<OAuthToken> {
    const { config, environmentId } = request;
    const started = await startOAuthSignIn(flow, request);
    // Listen before opening: a fast provider can answer before open() returns
    const callback = awaitOAuthCallback(started.state, request.timeoutMs ?? 60_000);
    if (!(await request.open(started.url))) {
        callback.code.catch(() => undefined);
        callback.cancel('Could not open the sign-in page');
        throw new Error('Failed to open the sign-in page');
    }
    request.waiting?.(reason => callback.cancel(reason));
    const code = await callback.code;
    return flow.exchangeCodeForToken({ config, code, state: started.state, codeVerifier: started.codeVerifier, environmentId });
}

/** A sign-in begun: the provider's page to open, and what the exchange needs back (keep the verifier). */
export interface StartedOAuthSignIn {
    url: string;
    state: string;
    codeVerifier?: string;
}

/**
 * The first half of a sign-in: the provider's page, with a fresh state (and PKCE challenge).
 * #344: the local agent starts here in VS Code and the web app opens the page; the code comes
 * back to the web app's callback page and VS Code finishes with `flow.exchangeCodeForToken`.
 */
export async function startOAuthSignIn(flow: IOAuthFlowHandler, request: Pick<OAuthSignInRequest, 'config' | 'environmentId' | 'scopes' | 'forceLogin'>): Promise<StartedOAuthSignIn> {
    const { config, environmentId } = request;
    const pkceChallenge = config.usePKCE ? await flow.generatePKCEChallenge() : undefined;
    const state = flow.generateState();
    const url = flow.generateAuthorizationUrl({
        config,
        state,
        pkceChallenge,
        scopes: request.scopes.length > 0 ? request.scopes : (config.scopes || []),
        environmentId,
        ...(request.forceLogin ? { promptParam: 'login' } : {})
    });
    return { url, state, codeVerifier: pkceChallenge?.codeVerifier };
}
