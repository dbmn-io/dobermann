"use strict";
/**
 * sync-usage Edge Function (GitHub Issue #208)
 *
 * Accepts batched usage counter increments from the extension.
 * Upserts into usage_tracking table for the current week.
 * Server-side authoritative — returns the updated totals.
 *
 * POST body:
 *   {
 *     apiCallsDelta: number,
 *     batchCountDelta: number,
 *     batchRecordCountDelta: number,
 *     exportCountDelta: number,
 *     importCountDelta: number
 *   }
 *
 * Response:
 *   {
 *     usage: { weekStart, apiCalls, batchCount, batchRecordCount, exportCount, importCount },
 *     accepted: boolean
 *   }
 */
Object.defineProperty(exports, "__esModule", { value: true });
const supabase_js_2_1 = require("https://esm.sh/@supabase/supabase-js@2");
const cors_ts_1 = require("../_shared/cors.ts");
Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: cors_ts_1.corsHeaders });
    }
    try {
        const authHeader = req.headers.get('Authorization');
        if (!authHeader) {
            return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
                status: 401,
                headers: { ...cors_ts_1.corsHeaders, 'Content-Type': 'application/json' }
            });
        }
        const supabase = (0, supabase_js_2_1.createClient)(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: authHeader } } });
        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError || !user) {
            return new Response(JSON.stringify({ error: 'Invalid token' }), {
                status: 401,
                headers: { ...cors_ts_1.corsHeaders, 'Content-Type': 'application/json' }
            });
        }
        const body = await req.json();
        const { apiCallsDelta = 0, batchCountDelta = 0, batchRecordCountDelta = 0, exportCountDelta = 0, importCountDelta = 0 } = body;
        // Validate deltas are non-negative integers
        const deltas = [apiCallsDelta, batchCountDelta, batchRecordCountDelta, exportCountDelta, importCountDelta];
        if (deltas.some(d => typeof d !== 'number' || d < 0 || !Number.isInteger(d))) {
            return new Response(JSON.stringify({ error: 'Invalid delta values' }), {
                status: 400,
                headers: { ...cors_ts_1.corsHeaders, 'Content-Type': 'application/json' }
            });
        }
        const weekStart = getWeekStart();
        // Upsert usage with atomic increment using raw SQL via RPC
        // First try to get existing row
        const { data: existing } = await supabase
            .from('usage_tracking')
            .select('*')
            .eq('user_id', user.id)
            .eq('week_start', weekStart)
            .single();
        let usageData;
        if (existing) {
            // Update with increments
            const { data, error } = await supabase
                .from('usage_tracking')
                .update({
                api_call_count: existing.api_call_count + apiCallsDelta,
                batch_count: existing.batch_count + batchCountDelta,
                batch_record_count: existing.batch_record_count + batchRecordCountDelta,
                export_count: existing.export_count + exportCountDelta,
                import_count: existing.import_count + importCountDelta
            })
                .eq('user_id', user.id)
                .eq('week_start', weekStart)
                .select()
                .single();
            if (error) {
                console.error('Usage update error:', error);
                return new Response(JSON.stringify({ error: 'Failed to update usage' }), {
                    status: 500,
                    headers: { ...cors_ts_1.corsHeaders, 'Content-Type': 'application/json' }
                });
            }
            usageData = data;
        }
        else {
            // Insert new row
            const { data, error } = await supabase
                .from('usage_tracking')
                .insert({
                user_id: user.id,
                week_start: weekStart,
                api_call_count: apiCallsDelta,
                batch_count: batchCountDelta,
                batch_record_count: batchRecordCountDelta,
                export_count: exportCountDelta,
                import_count: importCountDelta
            })
                .select()
                .single();
            if (error) {
                console.error('Usage insert error:', error);
                return new Response(JSON.stringify({ error: 'Failed to insert usage' }), {
                    status: 500,
                    headers: { ...cors_ts_1.corsHeaders, 'Content-Type': 'application/json' }
                });
            }
            usageData = data;
        }
        const usage = {
            weekStart: usageData.week_start,
            apiCalls: usageData.api_call_count,
            batchCount: usageData.batch_count,
            batchRecordCount: usageData.batch_record_count,
            exportCount: usageData.export_count,
            importCount: usageData.import_count
        };
        return new Response(JSON.stringify({ usage, accepted: true }), {
            status: 200,
            headers: { ...cors_ts_1.corsHeaders, 'Content-Type': 'application/json' }
        });
    }
    catch (error) {
        console.error('sync-usage error:', error);
        return new Response(JSON.stringify({ error: 'Internal server error' }), {
            status: 500,
            headers: { ...cors_ts_1.corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});
function getWeekStart() {
    const now = new Date();
    const day = now.getUTCDay();
    const diff = day === 0 ? 6 : day - 1;
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - diff);
    monday.setUTCHours(0, 0, 0, 0);
    return monday.toISOString().split('T')[0];
}
//# sourceMappingURL=index.js.map