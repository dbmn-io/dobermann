"use strict";
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
 *     usage: { weekStart, apiCalls, batchCount, batchRecordCount, exportCount, importCount }
 *   }
 */
Object.defineProperty(exports, "__esModule", { value: true });
const supabase_js_2_1 = require("https://esm.sh/@supabase/supabase-js@2");
const cors_ts_1 = require("../_shared/cors.ts");
Deno.serve(async (req) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: cors_ts_1.corsHeaders });
    }
    try {
        // Get auth token from request
        const authHeader = req.headers.get('Authorization');
        if (!authHeader) {
            return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
                status: 401,
                headers: { ...cors_ts_1.corsHeaders, 'Content-Type': 'application/json' }
            });
        }
        // Create Supabase client with user's auth token
        const supabase = (0, supabase_js_2_1.createClient)(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: authHeader } } });
        // Get authenticated user
        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError || !user) {
            return new Response(JSON.stringify({ error: 'Invalid token' }), {
                status: 401,
                headers: { ...cors_ts_1.corsHeaders, 'Content-Type': 'application/json' }
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
                headers: { ...cors_ts_1.corsHeaders, 'Content-Type': 'application/json' }
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
            fetchedAt: Date.now()
        } : {
            licenseType: 'free',
            accessLevel: 'limited',
            status: 'active',
            trialEndsAt: null,
            subscriptionEndsAt: null,
            licensedEnvironmentUrls: [],
            fetchedAt: Date.now()
        };
        // Get current week's usage
        const { data: usageData } = await supabase
            .from('usage_tracking')
            .select('*')
            .eq('user_id', user.id)
            .eq('week_start', getWeekStart())
            .single();
        const usage = usageData ? {
            weekStart: usageData.week_start,
            apiCalls: usageData.api_call_count,
            batchCount: usageData.batch_count,
            batchRecordCount: usageData.batch_record_count,
            exportCount: usageData.export_count,
            importCount: usageData.import_count
        } : {
            weekStart: getWeekStart(),
            apiCalls: 0,
            batchCount: 0,
            batchRecordCount: 0,
            exportCount: 0,
            importCount: 0
        };
        // Update last_seen_at on user profile
        await supabase
            .from('user_profiles')
            .update({ last_seen_at: new Date().toISOString() })
            .eq('id', user.id);
        return new Response(JSON.stringify({ license, usage }), {
            status: 200,
            headers: { ...cors_ts_1.corsHeaders, 'Content-Type': 'application/json' }
        });
    }
    catch (error) {
        console.error('check-license error:', error);
        return new Response(JSON.stringify({ error: 'Internal server error' }), {
            status: 500,
            headers: { ...cors_ts_1.corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});
/** Get current week start as ISO date (Monday 00:00 UTC) */
function getWeekStart() {
    const now = new Date();
    const day = now.getUTCDay();
    const diff = day === 0 ? 6 : day - 1; // Monday = 0
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - diff);
    monday.setUTCHours(0, 0, 0, 0);
    return monday.toISOString().split('T')[0];
}
//# sourceMappingURL=index.js.map