// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The hand-off between an OAuth sign-in waiting in VS Code and the browser's redirect back to
 * vscode://dbmn.dobermann/oauth-callback (#361). One sign-in waits at a time.
 *
 * The callback's answer reaches the waiting sign-in, whatever it is:
 *   ?error=…                  → the sign-in fails NOW, with the server's own description
 *                               (it used to wait out a 60-second timeout and say "timeout")
 *   ?code=…&state=<theirs>    → the sign-in continues
 *   ?code=…&state=<another>   → not this sign-in's: ignored, the sign-in keeps waiting
 *                               (OAuth's CSRF / mix-up check; `state` used to be sent and never checked)
 *   ?code=… with no state     → accepted, with a warning: a server that drops `state` would
 *                               otherwise stop signing in at all
 */
export type CallbackOutcome = 'delivered' | 'failed' | 'ignored' | 'no-sign-in';

interface PendingSignIn {
    state: string;
    resolve(code: string): void;
    reject(error: Error): void;
}

let pending: PendingSignIn | undefined;

export class OAuthSignInError extends Error {
    constructor(message: string, readonly error: string) {
        super(message);
        this.name = 'OAuthSignInError';
    }
}

/** Wait for the browser to come back with this sign-in's code. `cancel` stops waiting. */
export function awaitOAuthCallback(state: string, timeoutMs: number): { code: Promise<string>; cancel(reason?: string): void } {
    let settle: PendingSignIn | undefined;
    const code = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => finish(() => reject(new Error(`OAuth sign-in timed out (${Math.round(timeoutMs / 1000)} seconds) waiting for the browser`))), timeoutMs);
        const finish = (then: () => void) => {
            clearTimeout(timer);
            if (pending === settle) pending = undefined;
            then();
        };
        settle = {
            state,
            resolve: c => finish(() => resolve(c)),
            reject: e => finish(() => reject(e))
        };
        pending = settle;
    });
    return { code, cancel: (reason = 'Sign-in cancelled') => settle?.reject(new Error(reason)) };
}

/** The browser came back to the callback URI: hand its answer to the waiting sign-in. */
export function deliverOAuthCallback(params: URLSearchParams, log?: (message: string) => void): CallbackOutcome {
    const waiting = pending;
    if (!waiting) return 'no-sign-in';
    const state = params.get('state');
    if (state !== null && state !== waiting.state) {
        log?.('[OAuth] Ignored a sign-in response whose state does not match the sign-in in progress');
        return 'ignored';
    }
    const error = params.get('error');
    if (error) {
        const description = params.get('error_description');
        waiting.reject(new OAuthSignInError(`Sign-in failed: ${description || error}`, error));
        return 'failed';
    }
    const code = params.get('code');
    if (!code) {
        waiting.reject(new OAuthSignInError('Sign-in failed: the browser came back without a code', 'invalid_response'));
        return 'failed';
    }
    if (state === null) log?.('[OAuth] The sign-in response carried no state; accepted, but this server does not echo state as OAuth requires');
    waiting.resolve(code);
    return 'delivered';
}
