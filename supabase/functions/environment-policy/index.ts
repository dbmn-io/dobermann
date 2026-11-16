/**
 * environment-policy Edge Function — Prod Protect
 *
 * Returns the server-managed policy (if any) for a batch of environment base
 * URLs. Called by the extension on activation, when an environment is added or
 * edited, on a low-frequency background refresh, and inline the first time an
 * unknown URL is executed against.
 *
 * Batched rather than folded into check-license because policies must apply to
 * environments that have been CONFIGURED but never called — the extension syncs
 * from its full environment list, not from the verified-environments set. One
 * call for N environments instead of N calls.
 *
 * POST body:
 *   { urls: string[] }
 *
 * Response:
 *   {
 *     policies: Array<{
 *       environmentBaseUrl, enforcedEnvironmentType, lockEnvironmentType,
 *       managedByLabel, policy, policyVersion, updatedAt
 *     }>,
 *     checkedUrls: string[],
 *     fetchedAt: number
 *   }
 *
 * `checkedUrls` is load-bearing. The extension's policy cache is sticky — it
 * survives restarts, network failures and sign-out, and is only ever evicted
 * when the server explicitly confirms a URL has no policy. Without the list of
 * URLs we actually looked at, "no policy" would be indistinguishable from
 * "wasn't asked", and a transient partial response would silently unprotect a
 * production environment.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

/** Upper bound on URLs per request — guards against a runaway client. */
const MAX_URLS = 100;

interface PolicyRow {
    environment_base_url: string;
    enforced_environment_type: string | null;
    lock_environment_type: boolean | null;
    managed_by_label: string | null;
    policy: Record<string, unknown> | null;
    policy_version: number | null;
    has_policy: boolean;
    updated_at: string | null;
    /** #357. Absent from a database that hasn't had the migration yet. */
    vscode_only?: boolean | null;
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    try {
        // #418: a sign-in is not required. This is a look-up: the caller names URLs and hears
        // about those and nothing else, so a signed-out app (VS Code, the desktop app) gets
        // its production protection too. Signed in, the user's token is used as before; signed
        // out, the service role reads on the caller's behalf, and callers without an identity
        // are rate-limited per address so the list can't be guessed at speed. The table itself
        // stays closed to anonymous reads.
        const authHeader = req.headers.get('Authorization');
        const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
        const signedIn = !!authHeader && authHeader !== `Bearer ${anonKey}`;
        let supabase;
        if (signedIn) {
            supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', anonKey, { global: { headers: { Authorization: authHeader! } } });
            const { data: { user }, error: userError } = await supabase.auth.getUser();
            if (userError || !user) {
                return new Response(JSON.stringify({ error: 'Invalid token' }), {
                    status: 401,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }
        } else {
            const address = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('cf-connecting-ip') || 'unknown';
            supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
            // Counted in the database (this runtime keeps nothing between requests): 60 a
            // minute per address. A failure to count fails closed.
            const { data: allowed, error: countError } = await supabase.rpc('allow_anonymous_policy_lookup', { p_address: address });
            if (countError || allowed !== true) {
                if (countError) console.error('allow_anonymous_policy_lookup error:', JSON.stringify(countError));
                return new Response(JSON.stringify({ error: 'Too many requests' }), {
                    status: 429,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': '60' }
                });
            }
        }

        let body: { urls?: unknown };
        try {
            body = await req.json();
        } catch {
            return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const rawUrls = body?.urls;
        if (!Array.isArray(rawUrls)) {
            return new Response(JSON.stringify({ error: 'Body must include a "urls" array' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const urls = [...new Set(
            rawUrls.filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
        )];

        if (urls.length > MAX_URLS) {
            return new Response(JSON.stringify({ error: `Too many URLs (max ${MAX_URLS})` }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        if (urls.length === 0) {
            return new Response(
                JSON.stringify({ policies: [], checkedUrls: [], fetchedAt: Date.now() }),
                { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        const { data, error } = await supabase.rpc('get_environment_policies', { p_urls: urls });

        if (error) {
            console.error('get_environment_policies RPC error:', JSON.stringify(error));
            return new Response(JSON.stringify({ error: 'Failed to fetch environment policies' }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const rows: PolicyRow[] = Array.isArray(data) ? data : [];

        // Every row the RPC returns is a URL we genuinely looked at — including
        // the ones with no policy. That set is what lets the client evict.
        const checkedUrls = rows.map(r => r.environment_base_url);

        const policies = rows
            .filter(r => r.has_policy)
            .map(r => ({
                environmentBaseUrl: r.environment_base_url,
                enforcedEnvironmentType: r.enforced_environment_type,
                lockEnvironmentType: r.lock_environment_type ?? true,
                managedByLabel: r.managed_by_label,
                policy: r.policy ?? {},
                policyVersion: r.policy_version ?? 1,
                vscodeOnly: r.vscode_only === true,
                updatedAt: r.updated_at
            }));

        return new Response(
            JSON.stringify({ policies, checkedUrls, fetchedAt: Date.now() }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );

    } catch (error) {
        console.error('environment-policy error:', error);
        return new Response(JSON.stringify({ error: 'Internal server error' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});
