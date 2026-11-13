-- Photo cleanup (Manny: "Approved photo cleanup", 2026-11-13 16:05 UTC).
-- Server backstop for deleted accounts, deleted photos and failed posts: any file in jar-photos with no
-- product_photos row, older than 1 hour, is removed by the photo-cleanup edge function (SQL can't delete
-- storage files directly; protect_objects_delete). Rows already cascade when an account is deleted.
-- Anything new that stores files in jar-photos must be added to photo_orphans' NOT EXISTS list, or it gets swept.

create or replace function public.photo_orphans(p_limit int default 500)
returns table (path text)
language sql security definer set search_path = '' stable as $$
  select o.name from storage.objects o
  where o.bucket_id = 'jar-photos'
    and o.created_at < now() - interval '1 hour'
    and not exists (select 1 from public.product_photos p where p.path = o.name)
    and not exists (select 1 from public.posts q where q.photo_path = o.name)
  order by o.created_at
  limit greatest(1, least(p_limit, 1000));
$$;
revoke all on function public.photo_orphans(int) from public, anon, authenticated;
grant execute on function public.photo_orphans(int) to service_role;

create or replace function public.photo_cleanup_kick()
returns void language plpgsql security definer set search_path = '' as $$
declare url text; secret text;
begin
  select decrypted_secret into url from vault.decrypted_secrets where name = 'moderate_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'moderate_hook_secret';
  if url is null or secret is null then return; end if;
  perform net.http_post(
    url := regexp_replace(url, '/moderate/?$', '/photo-cleanup'),
    headers := jsonb_build_object('Content-Type','application/json','x-moderate-secret', secret),
    body := '{}'::jsonb, timeout_milliseconds := 30000);
end $$;
revoke all on function public.photo_cleanup_kick() from public, anon, authenticated;

select cron.schedule('photo-cleanup', '17 * * * *', 'select public.photo_cleanup_kick()');
