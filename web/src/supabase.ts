// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * One Supabase client per page, with the session kept in localStorage (signed in across reloads).
 *
 * #376: the PKCE flow. An email link brings the browser back with a one-time `?code=`, which the
 * client exchanges as it starts, using the verifier this browser kept when it asked for the link.
 * The session itself never travels in a URL, so it never reaches history or a referrer, and a
 * code is no use to anyone else: it only works in the browser that asked.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getBackend } from '../../src/services/dbmn-backend/backend-config';

let client: SupabaseClient | undefined;

export function supabase(): SupabaseClient {
    if (!client) {
        const { apiUrl, anonKey, profile } = getBackend();
        client = createClient(apiUrl, anonKey, {
            auth: {
                flowType: 'pkce', persistSession: true, detectSessionInUrl: true, storageKey: `dbmn-web-${profile}`,
                experimental: { appendPkceFlowIdToRedirects: true }
            }
        });
    }
    return client;
}

/** Why an email link didn't sign this page in, for the sign-in page to say. */
export type SignInLinkProblem = 'elsewhere' | 'expired';

/**
 * Why the link in the address bar didn't sign in, from the client's start-up. With no verifier
 * for it here, the client doesn't take the address for a sign-in at all (no exchange, no error):
 * the link was asked for in another browser. An error from the exchange is the server refusing
 * the code: expired, used, or replaced by a newer link, which cancels this one.
 */
export async function signInLinkProblem(): Promise<SignInLinkProblem> {
    const { error } = await supabase().auth.initialize();
    return !error || error.code === 'pkce_code_verifier_not_found' ? 'elsewhere' : 'expired';
}

/**
 * Read what an email link left in the address bar, then take it out (it has been used, or it was
 * refused): nothing of a sign-in stays in history. Call after the client has started (getSession).
 */
export function takeSignInLink(): { fromLink: boolean; failed: boolean } {
    const url = new URL(location.href);
    const hash = new URLSearchParams(url.hash.slice(1));
    const fromLink = url.searchParams.has('code');
    const failed = url.searchParams.has('error_description') || hash.has('error_description');
    if (fromLink || failed) {
        for (const key of ['code', 'sb_flow_id', 'error', 'error_code', 'error_description']) url.searchParams.delete(key);
        history.replaceState(history.state, '', url.pathname + url.search);
    }
    return { fromLink, failed };
}

/** Where dbmn.io puts a sign-in it hands over (account/shared.js). Not a name supabase-js reads, so the client leaves it alone. */
export const HANDOVER_KEY = 'dbmn_link';

/**
 * A sign-in handed over by dbmn.io. After a VS Code sign-in, the site's "Open DBMN in your
 * browser" link carries a one-time code for a session made for this app alone (the
 * handoff-session function), so one sign-in covers VS Code, the site and this app, and none can
 * sign the others out. The code is spent here, at once, so the copy the browser's history keeps
 * is worthless (#376: no address holds a session), and it leaves the address bar either way. A
 * page that is already signed in keeps its own sign-in.
 * @returns true when this page is now signed in with the handed-over sign-in
 */
export async function takeHandedOverSignIn(client: SupabaseClient): Promise<boolean> {
    const url = new URL(location.href);
    const tokenHash = new URLSearchParams(url.hash.slice(1)).get(HANDOVER_KEY);
    if (tokenHash === null) return false;
    history.replaceState(history.state, '', url.pathname + url.search);
    if (!tokenHash || (await client.auth.getSession()).data.session) return false;
    const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
    if (error) console.warn('[dbmn] The sign-in from dbmn.io was not accepted:', error.message);
    return !error;
}
