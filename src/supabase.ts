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

/**
 * A throwaway client for one sign-in check (password / SMS code). Signing in stores the user's session on
 * the client, so it must never be the shared service-role client above.
 */
export function supabaseAuthCheck(): SupabaseClient {
  if (!supabaseConfigured()) throw new Error('Supabase is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  return createClient(env.supabaseUrl, env.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
