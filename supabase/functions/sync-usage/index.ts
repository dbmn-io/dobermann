/**
 * sync-usage Edge Function (GitHub Issue #208)
 *
 * Accepts batched usage counter increments from the extension.
 * Atomically upserts into usage_tracking for the current week via the
 * increment_usage RPC (GitHub Issue #295).
 * Server-side authoritative — returns the updated totals.
 *
 * POST body:
 *   {
 *     batchCountDelta: number,
 *     exportCountDelta: number,
 *     importCountDelta: number
 *   }
 *
 * Response:
 *   {
 *     usage: { weekStart, batchCount, exportCount, importCount },
 *     accepted: boolean
 *   }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const authHeader = req.headers.get('Authorization');
        if (!authHeader) {
            return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
                status: 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const supabase = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_ANON_KEY') ?? '',
            { global: { headers: { Authorization: authHeader } } }
        );

        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError || !user) {
            return new Response(JSON.stringify({ error: 'Invalid token' }), {
                status: 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const body = await req.json();
        const {
            batchCountDelta = 0,
            exportCountDelta = 0,
            importCountDelta = 0
        } = body;

        // Validate deltas are non-negative integers
        const deltas = [batchCountDelta, exportCountDelta, importCountDelta];
        if (deltas.some(d => typeof d !== 'number' || d < 0 || !Number.isInteger(d))) {
            return new Response(JSON.stringify({ error: 'Invalid delta values' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const weekStart = getWeekStart();

        // Atomic increment via RPC (GitHub Issue #295): one
        // INSERT ... ON CONFLICT DO UPDATE, so two overlapping syncs for the
        // same account can neither lose an increment nor race each other into
        // a unique-constraint failure.
        const { data: usageData, error } = await supabase.rpc('increment_usage', {
            p_week_start: weekStart,
            p_batch_delta: batchCountDelta,
            p_export_delta: exportCountDelta,
            p_import_delta: importCountDelta
        });

        if (error || !usageData) {
            console.error('Usage increment error (issue#295):', error);
            return new Response(JSON.stringify({ error: 'Failed to update usage' }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const usage = {
            weekStart: usageData.week_start,
            batchCount: usageData.batch_count,
            exportCount: usageData.export_count,
            importCount: usageData.import_count
        };

        return new Response(JSON.stringify({ usage, accepted: true }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('sync-usage error:', error);
        return new Response(JSON.stringify({ error: 'Internal server error' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});

function getWeekStart(): string {
    const now = new Date();
    const day = now.getUTCDay();
    const diff = day === 0 ? 6 : day - 1;
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - diff);
    monday.setUTCHours(0, 0, 0, 0);
    return monday.toISOString().split('T')[0];
}
