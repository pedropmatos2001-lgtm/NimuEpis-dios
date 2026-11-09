import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

// Service-role client: bypasses RLS to write the public catalogue.
// SERVER-SIDE ONLY — this key must never ship in the app or hit the client.
export const supabase = createClient(
  config.supabaseUrl,
  config.supabaseServiceRoleKey,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
