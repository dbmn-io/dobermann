// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Hub's Account section in the web app: the DBMN session and licence, from the same
 * check-license function the extension uses (account-manager pushAuthState).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HubSection } from '../../../src/screens/hub/hub.ports';
import { getBackend } from '../../../src/services/dbmn-backend/backend-config';
import { BadgeService, buildPuppySchoolUrl, earnedMessage, type BadgeStore } from '../../../src/services/badges/badge.service';
import { fetchMyBadges } from '../../../src/services/badges/badge-api';
import { forgetAgentIdentity } from './agent-identity';

/**
 * The badge cache in this browser, per backend profile (a local run never shows the production
 * account's collection). Storage can be blocked or cleared: the service then fetches afresh.
 */
function browserBadgeStore(): BadgeStore {
    const key = (name: string) => `dbmn-web:${getBackend().profile}:${name}`;
    return {
        get: <T>(name: string): T | undefined => {
            try { const raw = localStorage.getItem(key(name)); return raw ? JSON.parse(raw) as T : undefined; } catch { return undefined; }
        },
        update: async (name: string, value: unknown) => {
            try {
                if (value === undefined || value === null) localStorage.removeItem(key(name));
                else localStorage.setItem(key(name), JSON.stringify(value));
            } catch { /* storage blocked: nothing cached */ }
        }
    };
}

export function accountSection(client: SupabaseClient, post: (m: Record<string, unknown>) => void, toast: (m: string) => void): HubSection {
    // Puppy School progress for Home and Account: the same service as DBMN for VS Code
    // (get_my_badges), refreshed when the Hub opens and when the learner comes back to this tab
    // from a lesson on the website. Until 2026-11-02 the web app never asked, so Home read
    // "Not started" whatever the learner had passed.
    const badges = new BadgeService({
        store: browserBadgeStore(),
        getSession: async () => {
            const session = (await client.auth.getSession()).data.session;
            return session ? { userId: session.user.id, accessToken: session.access_token } : null;
        },
        fetchBadges: fetchMyBadges
    });
    badges.onChange((_state, newlyEarned) => {
        post(badges.buildMessage() as unknown as Record<string, unknown>);
        if (newlyEarned.length > 0) toast(earnedMessage(newlyEarned));
    });
    const pushBadges = async (force = false) => {
        post(badges.buildMessage() as unknown as Record<string, unknown>);
        await badges.refresh({ force }).catch(error => console.error('[web] badges', error));
    };
    window.addEventListener('focus', () => { void badges.refresh(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void badges.refresh(); });

    const push = async () => {
        const session = (await client.auth.getSession()).data.session;
        const base = {
            type: 'authStateUpdate',
            isAuthenticated: !!session,
            email: session?.user.email ?? null,
            displayName: (session?.user.user_metadata?.display_name as string | undefined) ?? session?.user.email ?? null,
            license: null, userLicense: null, usage: null, telemetryStats: null
        };
        if (!session) {
            post(base);
            return;
        }
        try {
            const response = await fetch(`${getBackend().apiUrl}/functions/v1/check-license?include_stats=true`, {
                headers: { Authorization: `Bearer ${session.access_token}`, apikey: getBackend().anonKey }
            });
            if (!response.ok) throw new Error(`check-license ${response.status}`);
            const licence = await response.json() as { license: unknown; usage: unknown; telemetryStats?: unknown; displayName?: string };
            post({
                ...base,
                displayName: licence.displayName ?? base.displayName,
                license: licence.license, userLicense: licence.license,
                usage: licence.usage, telemetryStats: licence.telemetryStats ?? null
            });
        } catch (error) {
            console.error('[web] account details', error);
            post(base);
        }
    };
    return {
        ready: async () => { await push(); await pushBadges(true); },
        shown: async () => { await push(); await pushBadges(); },
        handle: async message => {
            switch (message.type) {
                case 'signOut': {
                    // This browser's key for DBMN for VS Code goes with the session
                    const userId = (await client.auth.getSession()).data.session?.user.id;
                    if (userId) await forgetAgentIdentity(`${getBackend().profile}:${userId}`, client);
                    await badges.clear();
                    // This app's sign-in only (GitHub Issue #396). The default ends every session
                    // the account has: the VS Code extension's and the website's too.
                    await client.auth.signOut({ scope: 'local' });
                    location.replace('/signin.html');
                    return;
                }
                case 'signIn':
                    location.replace('/signin.html');
                    return;
                case 'openPuppySchool': {
                    // Puppy School lives on the website (as from VS Code), email prefilled
                    const email = (await client.auth.getSession()).data.session?.user.email;
                    window.open(buildPuppySchoolUrl(email, getBackend().siteUrl), '_blank', 'noopener');
                    return;
                }
                case 'refreshSession':
                    await client.auth.refreshSession();
                    await push();
                    return;
                default:
                    toast('That runs in DBMN for VS Code for now.');
            }
        }
    };
}
