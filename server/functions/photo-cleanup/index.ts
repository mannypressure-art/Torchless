// photo-cleanup: removes jar-photos files that no product_photos row points at (deleted accounts, deleted
// photos, failed posts), once they are over an hour old. Called hourly by pg_cron through
// public.photo_cleanup_kick() with the same x-moderate-secret as moderate. Manny OK'd 2026-11-13 16:05 UTC.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

Deno.serve(async req => {
  if (req.method !== "POST" || req.headers.get("x-moderate-secret") !== Deno.env.get("MODERATE_HOOK_SECRET")) {
    return new Response("no", { status: 401 });
  }
  const { data, error } = await db.rpc("photo_orphans", { p_limit: 500 });
  if (error) return new Response("list failed", { status: 500 });
  const paths = (data as { path: string }[]).map(r => r.path);
  let removed = 0;
  for (let i = 0; i < paths.length; i += 100) {
    const { data: gone, error: e } = await db.storage.from("jar-photos").remove(paths.slice(i, i + 100));
    if (e) return new Response(`removed ${removed}, then failed`, { status: 500 });
    removed += gone?.length ?? 0;
  }
  return new Response(`removed ${removed}`);
});
