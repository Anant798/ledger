import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Creates an admin client using SUPABASE_SERVICE_ROLE_KEY if available.
 * Falls back to public key if service role is not defined, but service role is recommended
 * for background worker tasks (e.g. Gmail Webhook / PubSub triggers).
 */
export function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase URL or Key configuration.");
  }

  return createSupabaseClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
