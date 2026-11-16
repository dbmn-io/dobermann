/**
 * check-license Edge Function (GitHub Issue #208)
 *
 * Returns license status + usage remaining for the authenticated user.
 * Called by the extension on startup and every 15 minutes.
 *
 * Query params:
 *   - environment_url (optional): environment URL for env-based license check
 *
 * Response:
 *   {
 *     license: { licenseType, accessLevel, status, trialEndsAt, subscriptionEndsAt, licensedEnvironmentUrls },
 *     usage: { weekStart, batchCount, exportCount, importCount }
 *   }
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

Deno.serve(async (req: Request) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        // Get auth token from request
        const authHeader = req.headers.get('Authorization');
        if (!authHeader) {
            return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
                status: 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Create Supabase client with user's auth token
        const supabase = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_ANON_KEY') ?? '',
            { global: { headers: { Authorization: authHeader } } }
        );

        // Get authenticated user
        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError || !user) {
            return new Response(JSON.stringify({ error: 'Invalid token' }), {
                status: 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Parse query params
        const url = new URL(req.url);
        const environmentUrl = url.searchParams.get('environment_url') || undefined;

        // Get effective license using database function
        const { data: licenseData, error: licenseError } = await supabase
            .rpc('get_effective_license', {
                p_user_id: user.id,
                p_environment_url: environmentUrl ?? null
            });

        if (licenseError) {
            console.error('License check error:', licenseError);
            return new Response(JSON.stringify({ error: 'Failed to check license' }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const licenseRow = licenseData?.[0];
        const license = licenseRow ? {
            licenseType: licenseRow.license_type,
            accessLevel: licenseRow.access_level,
            status: licenseRow.status,
            trialEndsAt: licenseRow.trial_ends_at,
            subscriptionEndsAt: licenseRow.subscription_ends_at,
            licensedEnvironmentUrls: licenseRow.licensed_environment_urls || [],
            isLifetime: licenseRow.is_lifetime || false,
            cancelAtPeriodEnd: licenseRow.cancel_at_period_end || false,
            fetchedAt: Date.now()
        } : {
            licenseType: 'free',
            accessLevel: 'limited',
            status: 'active',
            trialEndsAt: null,
            subscriptionEndsAt: null,
            licensedEnvironmentUrls: [],
            isLifetime: false,
            cancelAtPeriodEnd: false,
            fetchedAt: Date.now()
        };

        // Get current week's usage
        // maybeSingle: no row yet this week is normal, not a 406 (GitHub Issue #295)
        const { data: usageData, error: usageError } = await supabase
            .from('usage_tracking')
            .select('*')
            .eq('user_id', user.id)
            .eq('week_start', getWeekStart())
            .maybeSingle();

        if (usageError) {
            // Fall through to zero usage: a fetch failure must not lock the
            // user out, but it must not be silent either.
            console.error('Usage fetch error (issue#295):', usageError);
        }

        const usage = usageData ? {
            weekStart: usageData.week_start,
            batchCount: usageData.batch_count ?? 0,
            exportCount: usageData.export_count,
            importCount: usageData.import_count
        } : {
            weekStart: getWeekStart(),
            batchCount: 0,
            exportCount: 0,
            importCount: 0
        };

        // Fetch display_name from user profile
        let displayName = '';
        try {
            const { data: profileData } = await supabase
                .from('user_profiles')
                .select('display_name')
                .eq('id', user.id)
                .single();
            displayName = profileData?.display_name || '';
        } catch {
            // Profile fetch is non-critical — continue without displayName
        }

        // Update last_seen_at separately (non-critical)
        supabase
            .from('user_profiles')
            .update({ last_seen_at: new Date().toISOString() })
            .eq('id', user.id)
            .then(() => {});

        // Optionally fetch telemetry stats (only when Account dashboard is open)
        const includeStats = url.searchParams.get('include_stats') === 'true';
        let telemetryStats: { weekly: TelemetryStats; alltime: TelemetryStats } | undefined;

        if (includeStats) {
            try {
                const { data: statsData, error: statsError } = await supabase.rpc('get_telemetry_stats', { p_user_id: user.id });
                if (statsError) {
                    console.error('get_telemetry_stats RPC error:', JSON.stringify(statsError));
                }
                if (statsData && Array.isArray(statsData)) {
                    const weeklyRow = statsData.find((r: StatsRow) => r.period === 'weekly');
                    const alltimeRow = statsData.find((r: StatsRow) => r.period === 'alltime');

                    const parseRow = (row: StatsRow | undefined): TelemetryStats => ({
                        apiCalls: Number(row?.total_api_calls ?? 0),
                        batchRuns: Number(row?.total_batch_runs ?? 0),
                        rowsProcessed: Number(row?.total_batch_records ?? 0),
                        totalExecutionTimeMs: Number(row?.total_execution_time_ms ?? 0)
                    });

                    telemetryStats = {
                        weekly: parseRow(weeklyRow),
                        alltime: parseRow(alltimeRow)
                    };
                }
            } catch (statsError) {
                console.error('Telemetry stats fetch error:', statsError);
                // Non-critical — continue without stats
            }
        }

        const responseBody: Record<string, unknown> = { license, usage, displayName };
        if (telemetryStats) {
            responseBody.telemetryStats = telemetryStats;
        }

        return new Response(JSON.stringify(responseBody), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('check-license error:', error);
        return new Response(JSON.stringify({ error: 'Internal server error' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});

/** Get current week start as ISO date (Monday 00:00 UTC) */
function getWeekStart(): string {
    const now = new Date();
    const day = now.getUTCDay();
    const diff = day === 0 ? 6 : day - 1; // Monday = 0
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - diff);
    monday.setUTCHours(0, 0, 0, 0);
    return monday.toISOString().split('T')[0];
}
