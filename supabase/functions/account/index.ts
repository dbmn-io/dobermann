/**
 * account Edge Function (0.4.1)
 *
 * The signed-in user's account summary for the Account page. Replaces the parts of
 * check-license the app still used; there are no licences from 0.4.0.
 *
 * Query params:
 *   - include_stats=true: also return this week's and all-time usage counts
 *
 * Response:
 *   { displayName, weekStart, telemetryStats? }
 * A 401 means the server no longer accepts the session.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

interface TelemetryStats {
    apiCalls: number;
    batchRuns: number;
    rowsProcessed: number;
    totalExecutionTimeMs: number;
}

interface StatsRow {
    period: string;
    total_batch_runs: number;
    total_batch_records: number;
    total_api_calls: number;
    total_execution_time_ms: number;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const authHeader = req.headers.get('Authorization');
        if (!authHeader) {
            return json({ error: 'Missing authorization header' }, 401);
        }

        const supabase = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_ANON_KEY') ?? '',
            { global: { headers: { Authorization: authHeader } } }
        );

        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError || !user) {
            return json({ error: 'Invalid token' }, 401);
        }

        // The profile's name is more reliable than the sign-in's metadata.
        let displayName = '';
        try {
            const { data: profile } = await supabase
                .from('user_profiles')
                .select('display_name')
                .eq('id', user.id)
                .maybeSingle();
            displayName = profile?.display_name || '';
        } catch {
            // Not critical: the app keeps the name it has.
        }

        // Not critical, and not awaited.
        supabase
            .from('user_profiles')
            .update({ last_seen_at: new Date().toISOString() })
            .eq('id', user.id)
            .then(() => {});

        const body: Record<string, unknown> = { displayName, weekStart: getWeekStart() };

        if (new URL(req.url).searchParams.get('include_stats') === 'true') {
            try {
                const { data, error } = await supabase.rpc('get_telemetry_stats', { p_user_id: user.id });
                if (error) {
                    console.error('get_telemetry_stats error:', JSON.stringify(error));
                }
                if (Array.isArray(data)) {
                    const parse = (row: StatsRow | undefined): TelemetryStats => ({
                        apiCalls: Number(row?.total_api_calls ?? 0),
                        batchRuns: Number(row?.total_batch_runs ?? 0),
                        rowsProcessed: Number(row?.total_batch_records ?? 0),
                        totalExecutionTimeMs: Number(row?.total_execution_time_ms ?? 0)
                    });
                    body.telemetryStats = {
                        weekly: parse(data.find((r: StatsRow) => r.period === 'weekly')),
                        alltime: parse(data.find((r: StatsRow) => r.period === 'alltime'))
                    };
                }
            } catch (statsError) {
                console.error('Usage stats error:', statsError);
            }
        }

        return json(body);
    } catch (error) {
        console.error('account error:', error);
        return json({ error: 'Internal server error' }, 500);
    }
});

/** The week the usage counts start from: Monday 00:00 UTC, as an ISO date. */
function getWeekStart(): string {
    const now = new Date();
    const day = now.getUTCDay();
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - (day === 0 ? 6 : day - 1));
    monday.setUTCHours(0, 0, 0, 0);
    return monday.toISOString().split('T')[0];
}
