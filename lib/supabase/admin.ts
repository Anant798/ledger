import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Creates a backend-only Supabase client. Never substitute a publishable key
 * for service-role work: that can silently bypass the intended server access.
 */
export function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase URL or service-role key configuration.");
  }

  return createSupabaseClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
