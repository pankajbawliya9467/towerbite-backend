import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env, supabaseConfigured } from './env.js';

let client: SupabaseClient | null = null;

/** Server-side Supabase client (service role). Never send this key to an app. */
export function supabase(): SupabaseClient {
  if (!supabaseConfigured()) throw new Error('Supabase is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  client ??= createClient(env.supabaseUrl, env.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
