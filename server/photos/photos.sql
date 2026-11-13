-- Torchless / Jar Journal: shared jar photos with likes and reports. Revision 1, 2026-11-13.
-- Manny approved building it ("Ok photos", 2026-11-13). NOT APPLIED. The release thread applies it with his
-- written OK. Check the live schema first (reports and mod_events target_type checks, is_admin, blocked_by_me,
-- is_banned, rate_guard, write_log, mod_send, mod_alert from moderation.sql must exist).
--
-- Rules (Fable design Manny approved 2026-11-13):
--   * each account posts at most 3 photos per jar; a jar holds at most 30 (pending + approved)
--   * the app shows the top 12, sorted by likes with a boost for new photos
--   * one like per account per photo, enforced here; no liking your own photo; likes and uploads rate-limited
--   * Report button; 3 different accounts hide a photo at once and send it to Manny
--   * the app strips EXIF/location and resizes to 1280 px JPEG before upload (bucket also caps size and type)
--   * new photos are 'pending' (only the author sees them) until the moderator approves them
--
-- Files live in a PRIVATE bucket. A file can be read only while its row is approved and not hidden (or by its
-- author or Manny), so hiding a row also hides the file. The app reads files through short signed URLs.
-- Existing moderation functions (mod_queue, mod_decide, mod_on_report, mod_sweep) are left untouched:
-- photos get their own photo_* versions below.

begin;

-- 1) Photos.
create table public.product_photos (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  path text not null unique,
  width int check (width between 1 and 4096),
  height int check (height between 1 and 4096),
  like_count int not null default 0,
  hidden boolean not null default false,
  mod_status text not null default 'pending' check (mod_status in ('pending','approved','held','rejected')),
  mod_rev integer not null default 0,
  mod_pending_since timestamptz not null default now(),
  mod_attempts integer not null default 0,
  created_at timestamptz not null default now()
);
create index product_photos_product_idx on public.product_photos (product_id) where mod_status <> 'rejected';
create index product_photos_user_idx on public.product_photos (user_id);
alter table public.product_photos enable row level security;

-- Others see approved, unhidden photos (anon too, for the Global shelf); authors and Manny see their own/all.
create policy photos_read on public.product_photos for select to anon, authenticated using (
  user_id = (select auth.uid()) or (select public.is_admin())
  or (hidden = false and mod_status = 'approved'
      and ((select auth.uid()) is null or not public.blocked_by_me(user_id))));
create policy photos_insert on public.product_photos for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy photos_delete_own on public.product_photos for delete to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
-- No update policy: app users never change a photo row. Server functions below do.

create or replace function public.photo_guard() returns trigger
language plpgsql security definer set search_path to '' as $$
declare uid uuid := (select auth.uid()); mine int; total int;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if public.is_admin() is not true and public.is_banned() then
    raise exception 'account_banned' using errcode = '42501';
  end if;
  new.user_id := uid;
  new.like_count := 0;
  new.hidden := false;
  new.mod_status := 'pending';
  new.mod_rev := 0;
  new.mod_attempts := 0;
  new.mod_pending_since := now();
  new.created_at := now();
  -- The file must already be uploaded by this account, in its own folder.
  if split_part(new.path, '/', 1) <> uid::text
     or not exists (select 1 from storage.objects o where o.bucket_id = 'jar-photos' and o.name = new.path
                     and o.owner_id = uid::text) then
    raise exception 'upload the photo first' using errcode = '42501';
  end if;
  if not exists (select 1 from public.products p where p.id = new.product_id and p.merged_into is null
                  and p.hidden = false and p.mod_status <> 'rejected') then
    raise exception 'unknown jar' using errcode = '42501';
  end if;
  -- Serialise uploads per jar so the caps can't be raced.
  perform pg_advisory_xact_lock(hashtextextended('product_photos:' || new.product_id::text, 0));
  select count(*) filter (where user_id = uid), count(*) into mine, total
    from public.product_photos where product_id = new.product_id and mod_status <> 'rejected';
  if mine >= 3 then raise exception 'photo_limit_mine' using errcode = '42501'; end if;
  if total >= 30 then raise exception 'photo_limit_jar' using errcode = '42501'; end if;
  return new;
end $$;
revoke execute on function public.photo_guard() from public, anon, authenticated;
create trigger photos_guard before insert on public.product_photos for each row execute function public.photo_guard();
-- 20 uploads a day per account (rate_guard caps by table name).
create trigger zz_photos_rate before insert on public.product_photos for each row execute function public.rate_guard();

-- 2) Likes. One per account per photo (primary key). Count kept by trigger; clients can't write it.
create table public.photo_likes (
  photo_id uuid not null references public.product_photos(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (photo_id, user_id)
);
create index photo_likes_user_idx on public.photo_likes (user_id);
alter table public.photo_likes enable row level security;
create policy likes_read_own on public.photo_likes for select to authenticated using (user_id = (select auth.uid()));
create policy likes_insert_own on public.photo_likes for insert to authenticated with check (user_id = (select auth.uid()));
create policy likes_delete_own on public.photo_likes for delete to authenticated using (user_id = (select auth.uid()));

create or replace function public.like_guard() returns trigger
language plpgsql security definer set search_path to '' as $$
declare uid uuid := (select auth.uid()); owner uuid; n int;
begin
  if uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if public.is_banned() then raise exception 'account_banned' using errcode = '42501'; end if;
  new.user_id := uid;
  new.created_at := now();
  select user_id into owner from public.product_photos
   where id = new.photo_id and hidden = false and mod_status = 'approved';
  if owner is null then raise exception 'photo not found' using errcode = '42501'; end if;
  if owner = uid then raise exception 'cannot like your own photo' using errcode = '42501'; end if;
  -- 200 likes a day; unliking doesn't refund (append-only log), so like/unlike spam can't move counts much.
  select count(*) into n from public.write_log where user_id = uid and kind = 'photo_like' and at > now() - interval '1 day';
  if n >= 200 then raise exception 'rate_limited' using errcode = '42501'; end if;
  insert into public.write_log (user_id, kind, target_id) values (uid, 'photo_like', new.photo_id);
  return new;
end $$;
revoke execute on function public.like_guard() from public, anon, authenticated;
create trigger likes_guard before insert on public.photo_likes for each row execute function public.like_guard();

create or replace function public.like_count_sync() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if tg_op = 'INSERT' then
    update public.product_photos set like_count = like_count + 1 where id = new.photo_id;
  else
    update public.product_photos set like_count = greatest(like_count - 1, 0) where id = old.photo_id;
  end if;
  return null;
end $$;
revoke execute on function public.like_count_sync() from public, anon, authenticated;
create trigger likes_count after insert or delete on public.photo_likes for each row execute function public.like_count_sync();

-- 3) Top photos for jars: likes plus a boost for new ones that fades over about a week.
--    Security invoker, so the read policy above decides what each caller sees (own pending photos included).
create or replace function public.photos_top(p_products uuid[], p_per int default 12)
returns table (id uuid, product_id uuid, path text, width int, height int, like_count int,
               mod_status text, mine boolean, liked boolean, created_at timestamptz)
language sql stable security invoker set search_path to '' as $$
  select q.id, q.product_id, q.path, q.width, q.height, q.like_count, q.mod_status, q.mine, q.liked, q.created_at
    from (
      select ph.*, ph.user_id = (select auth.uid()) as mine,
             exists (select 1 from public.photo_likes l where l.photo_id = ph.id and l.user_id = (select auth.uid())) as liked,
             row_number() over (partition by ph.product_id order by
               ph.like_count + 5 * exp(-extract(epoch from now() - ph.created_at) / 172800.0) desc, ph.created_at desc) rn
        from public.product_photos ph
       where ph.product_id = any (p_products[1:200]) and ph.mod_status <> 'rejected'
         and (ph.hidden = false or ph.user_id = (select auth.uid()))
    ) q
   where q.rn <= least(greatest(p_per, 1), 12)
   order by q.product_id, q.rn
$$;
grant execute on function public.photos_top(uuid[], int) to anon, authenticated;

-- 4) Storage: private bucket, 1 MB, JPEG/WebP only. Upload only into your own folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('jar-photos', 'jar-photos', false, 1048576, array['image/jpeg','image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy jar_photos_upload on storage.objects for insert to authenticated with check (
  bucket_id = 'jar-photos' and (storage.foldername(name))[1] = (select auth.uid())::text
  and not public.is_banned());
create policy jar_photos_read on storage.objects for select to anon, authenticated using (
  bucket_id = 'jar-photos' and (
    owner_id = (select auth.uid())::text or (select public.is_admin())
    or exists (select 1 from public.product_photos ph where ph.path = name
                 and ph.hidden = false and ph.mod_status = 'approved')));
create policy jar_photos_delete_own on storage.objects for delete to authenticated using (
  bucket_id = 'jar-photos' and owner_id = (select auth.uid())::text);

-- 5) Reports. Uses the shared reports table (one per account per item, rate-limited, ban-checked).
--    3 different accounts: hidden at once and sent to Manny. Fewer: the AI looks again.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.reports'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ilike '%target_type%'
  loop
    execute format('alter table public.reports drop constraint %I', c.conname);
  end loop;
  for c in select conname from pg_constraint
            where conrelid = 'public.mod_events'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ilike '%target_type%'
  loop
    execute format('alter table public.mod_events drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.reports add constraint reports_target_type_check
  check (target_type in ('post','comment','product','profile','photo'));
alter table public.mod_events add constraint mod_events_target_type_check
  check (target_type in ('post','comment','product','profile','photo'));

create or replace function public.photo_on_report() returns trigger
language plpgsql security definer set search_path to '' as $$
declare n int; rev int;
begin
  if new.target_type <> 'photo' then return null; end if;
  select count(distinct reporter) into n from public.reports
   where target_type = 'photo' and target_id = new.target_id and resolved = false;
  if n >= 3 then
    update public.product_photos set hidden = true, mod_status = 'held'
     where id = new.target_id and mod_status in ('approved','pending');
    insert into public.mod_events (target_type, target_id, source, ai_reason)
    values ('photo', new.target_id, 'report', n || ' accounts reported it');
    perform public.mod_alert('a reported photo');
  else
    select mod_rev into rev from public.product_photos where id = new.target_id;
    if rev is not null then perform public.mod_send('photo', new.target_id, rev, 'report'); end if;
  end if;
  return null;
end $$;
revoke execute on function public.photo_on_report() from public, anon, authenticated;
create trigger reports_photo after insert on public.reports for each row execute function public.photo_on_report();

-- 6) Moderation: new photos go to the moderator (edge function "moderate", type 'photo').
--    If Manny chooses to approve every photo himself, skip this trigger: photos then wait in photo_queue().
create or replace function public.photo_mod_send() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  perform public.mod_send('photo', new.id, new.mod_rev, 'new');
  return null;
end $$;
revoke execute on function public.photo_mod_send() from public, anon, authenticated;
create trigger photos_mod_send after insert on public.product_photos for each row execute function public.photo_mod_send();

create or replace function public.photo_sweep() returns void
language plpgsql security definer set search_path to '' as $$
declare r record;
begin
  for r in select id, mod_rev from public.product_photos
            where mod_status = 'pending' and mod_pending_since < now() - interval '2 minutes'
            order by mod_pending_since limit 25
  loop
    perform public.mod_send('photo', r.id, r.mod_rev, 'sweep');
  end loop;
end $$;
revoke execute on function public.photo_sweep() from public, anon, authenticated;
select cron.schedule('photo-sweep', '*/5 * * * *', 'select public.photo_sweep()');

-- 7) Manny's tools for photos (admin only). The app shows the image through a signed URL (admins can read all).
create or replace function public.photo_queue()
returns table (id uuid, product_id uuid, title text, path text, author uuid, author_name text, mod_status text,
               rev int, hidden boolean, ai_categories text[], ai_reason text, open_reports int,
               report_reasons text[], since timestamptz)
language sql stable security definer set search_path to '' as $$
  select ph.id, ph.product_id, pr.producer || ' - ' || pr.strain, ph.path, ph.user_id, pf.display_name,
         ph.mod_status, ph.mod_rev, ph.hidden, coalesce(e.ai_categories, '{}'), e.ai_reason,
         (select count(distinct x.reporter)::int from public.reports x where x.target_type = 'photo' and x.target_id = ph.id and not x.resolved),
         (select array_agg(x.reason) from public.reports x where x.target_type = 'photo' and x.target_id = ph.id and not x.resolved),
         ph.mod_pending_since
    from public.product_photos ph
    join public.products pr on pr.id = ph.product_id
    left join public.profiles pf on pf.id = ph.user_id
    left join lateral (select * from public.mod_events m where m.target_type = 'photo' and m.target_id = ph.id
                       order by m.created_at desc limit 1) e on true
   where public.is_admin()
     and (ph.mod_status = 'held'
          or (ph.mod_status = 'pending' and ph.mod_pending_since < now() - interval '10 minutes')
          or (ph.mod_status = 'approved' and exists (select 1 from public.reports x
                where x.target_type = 'photo' and x.target_id = ph.id and not x.resolved)))
   order by case when ph.mod_status = 'approved' then 1 else 0 end, ph.mod_pending_since
$$;
revoke execute on function public.photo_queue() from public, anon;
grant execute on function public.photo_queue() to authenticated;

create or replace function public.photo_decide(p_id uuid, p_keep boolean, p_note text default null)
returns void language plpgsql security definer set search_path to '' as $$
declare st text := case when p_keep then 'approved' else 'rejected' end;
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  update public.product_photos set mod_status = st, hidden = not p_keep where id = p_id;
  update public.reports set resolved = true where target_type = 'photo' and target_id = p_id and not resolved;
  insert into public.mod_events (target_type, target_id, source, final, decided_by, decided_at, note)
  values ('photo', p_id, 'manny', st, (select auth.uid()), now(), p_note);
end $$;
revoke execute on function public.photo_decide(uuid, boolean, text) from public, anon;
grant execute on function public.photo_decide(uuid, boolean, text) to authenticated;

commit;

-- After applying:
--   * Deploy the updated edge function "moderate" (adds type 'photo'; same secrets as before).
--   * Account deletion: rows cascade from auth.users. Storage files do not, so the app removes the user's own
--     files (select path from product_photos where user_id = me; storage remove) before calling delete_account.
--     Rejected and orphaned files stay unreadable (read policy needs an approved row).
--   * Privacy page needs a photos line before any of this is live (photos are public once approved; location data
--     is stripped on the phone before upload; photos are checked by an AI moderator).
