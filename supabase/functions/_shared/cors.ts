/**
 * Shared CORS headers for Supabase Edge Functions
 */
export const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    // Without this a browser allows only GET and POST: Reset My Data (DELETE), PUT and PATCH were refused
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
};
