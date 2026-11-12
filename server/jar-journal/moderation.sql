-- Jar Journal / Torchless: AI moderation agent (server side). Revision 3, 2026-11-12, after Fable reviews M1-M12 and R1-R8.
-- Manny approved building it ("Okay build agent moderation"). NOT APPLIED. The release thread applies it with his
-- written OK, together with the client change for product_id_for_key (M6).
--
-- Design (Manny, 2026-11-12): the AI approves most items by itself and passes anything questionable to Manny
-- for the final call to block or not. Manny handles appeals and bans himself. The AI never removes anything:
-- its only verdicts are approve or hold.
--
-- Flow:
--   new or edited post / comment / product name -> mod_status 'pending', mod_rev bumped
--   (the author sees it, nobody else) -> trigger calls the edge function "moderate" via pg_net with the rev
--   -> a plain word filter, then Claude -> 'approved' (only if the rev is unchanged) or 'held' (Manny's queue).
--   Held stays held through edits. Reports from 3 different accounts hold an item (busy products: queued only).
--   AI errors retry through a 5-minute sweep, and go to Manny after 3 tries.
--   Public photos are off on the server for v1 (posts.photo_path must stay null).
--
-- Needs before applying: extensions pg_net and pg_cron (available on Presh, not enabled yet), the edge
-- function deployed, and the three REQUIRED Vault secrets at the end of this file.
--
-- SHIP-TOGETHER RULE: the web branch with the product_id_for_key lookup (Torchless claude/project-thread-o262ou,
-- shipped by the release thread) is merged before or in the same step as this apply, and web sign-in is never
-- turned on without it. Native JarSync already has it (with a fallback), from the next Xcode install.

begin;

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- 1) Moderation columns. Existing rows count as approved.
alter table public.posts
  add column mod_status text not null default 'pending' check (mod_status in ('pending','approved','held','rejected')),
  add column mod_rev integer not null default 0,
  add column mod_pending_since timestamptz not null default now(),
  add column mod_attempts integer not null default 0;
alter table public.comments
  add column mod_status text not null default 'pending' check (mod_status in ('pending','approved','held','rejected')),
  add column mod_rev integer not null default 0,
  add column mod_pending_since timestamptz not null default now(),
  add column mod_attempts integer not null default 0;
alter table public.products
  add column mod_status text not null default 'pending' check (mod_status in ('pending','approved','held','rejected')),
  add column mod_rev integer not null default 0,
  add column mod_pending_since timestamptz not null default now(),
  add column mod_attempts integer not null default 0;
update public.posts    set mod_status = 'approved';
update public.comments set mod_status = 'approved';
update public.products set mod_status = 'approved';

-- 2) Guard: app users cannot set moderation fields, created_at, or a photo. A change to the content
--    (posts: body, product, rating, photo; comments: body; products: producer, strain, category)
--    bumps mod_rev and goes back to pending; held and rejected stay as they are (M1, M2, M3).
create or replace function public.mod_content(t text, r jsonb) returns text
language sql immutable set search_path to '' as $$
  select case t
    when 'posts' then concat_ws('|', r->>'body', r->>'product_id', r->>'rating', r->>'photo_path')
    when 'comments' then r->>'body'
    else concat_ws('|', r->>'producer', r->>'strain', r->>'category') end
$$;

create or replace function public.mod_guard() returns trigger
language plpgsql set search_path to '' as $$
declare
  n jsonb := to_jsonb(new);
begin
  -- Not security definer on purpose: current_user is 'authenticated' for app users, and the owner role
  -- inside the definer functions below (mod_decide, report holds) and for the service role.
  if current_user not in ('authenticated', 'anon') or public.is_admin() then
    return new;
  end if;
  if tg_table_name = 'posts' and n->>'photo_path' is not null then
    raise exception 'photos are not public yet' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    new.mod_status := 'pending';
    new.mod_rev := 0;
    new.mod_attempts := 0;
    new.mod_pending_since := now();
    new.created_at := now();
    return new;
  end if;
  new.mod_status := old.mod_status;
  new.mod_rev := old.mod_rev;
  new.mod_attempts := old.mod_attempts;
  new.mod_pending_since := old.mod_pending_since;
  new.created_at := old.created_at;
  if public.mod_content(tg_table_name, n) is distinct from public.mod_content(tg_table_name, to_jsonb(old)) then
    new.mod_rev := old.mod_rev + 1;
    if old.mod_status in ('pending', 'approved') then
      new.mod_status := 'pending';
      new.mod_pending_since := now();
      new.mod_attempts := 0;
    end if;
  end if;
  return new;
end $$;
create trigger posts_mod_guard    before insert or update on public.posts    for each row execute function public.mod_guard();
create trigger comments_mod_guard before insert or update on public.comments for each row execute function public.mod_guard();
create trigger products_mod_guard before insert or update on public.products for each row execute function public.mod_guard();

-- Display names (R7): no @, links or long digit runs, 1-40 characters. Applies to new writes only.
alter table public.profiles add constraint display_name_clean check (
  display_name is null or (char_length(display_name) between 1 and 40
    and display_name !~ '@' and display_name !~* '(https?://|www\.|\.(com|net|org|io|me|co|app|link|gg|ly)\b)'
    and display_name !~ '[0-9]{5,}')) not valid;

-- 3) Bans (Manny only). Checked on every write a user can make (M5), and kept across delete_account
--    by a keyed hash (HMAC with a Vault pepper) of the sign-in id and email, never the raw values.
alter table public.profiles add column banned_at timestamptz, add column ban_reason text;

create table public.banned_subjects (
  subject_hash text primary key,
  reason text,
  created_at timestamptz not null default now()
);
alter table public.banned_subjects enable row level security;  -- no policies: server and definer functions only

-- Keys for a user: one per sign-in identity, plus one per email (R8: Apple and Google share an email).
-- HMAC-SHA256 with a secret pepper from Vault ('ban_pepper'), so a kept key can't be reversed by
-- guessing and hashing emails (the privacy page promises this). No pepper set = no keys = bans by profile only.
create or replace function public.ban_keys(p_user uuid) returns setof text
language sql stable security definer set search_path to '' as $$
  with k as (select decrypted_secret pepper from vault.decrypted_secrets where name = 'ban_pepper')
  select encode(extensions.hmac(i.provider || ':' || i.provider_id, k.pepper, 'sha256'), 'hex')
    from auth.identities i, k where i.user_id = p_user
  union
  select encode(extensions.hmac('email:' || lower(m.e), k.pepper, 'sha256'), 'hex')
    from (select u.email e from auth.users u where u.id = p_user
          union select i.email from auth.identities i where i.user_id = p_user) m, k
   where m.e is not null and m.e <> ''
$$;
revoke execute on function public.ban_keys(uuid) from public, anon, authenticated;

create or replace function public.is_banned() returns boolean
language sql stable security definer set search_path to '' as $$
  select coalesce((select p.banned_at is not null from public.profiles p where p.id = (select auth.uid())), false)
      or exists (select 1 from public.banned_subjects b
                  where b.subject_hash in (select public.ban_keys((select auth.uid()))))
$$;
revoke execute on function public.is_banned() from public, anon;
grant execute on function public.is_banned() to authenticated;

create or replace function public.ban_guard() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if (select auth.uid()) is not null and public.is_banned() then
    raise exception 'account_banned' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
revoke execute on function public.ban_guard() from public, anon, authenticated;
create trigger posts_ban_guard    before insert or update on public.posts    for each row execute function public.ban_guard();
create trigger comments_ban_guard before insert or update on public.comments for each row execute function public.ban_guard();
create trigger products_ban_guard before insert on public.products for each row execute function public.ban_guard();
create trigger reports_ban_guard  before insert on public.reports  for each row execute function public.ban_guard();
create trigger ratings_ban_guard  before insert or update on public.ratings for each row execute function public.ban_guard();
create trigger price_shares_ban_guard before insert or update on public.price_shares for each row execute function public.ban_guard();
create trigger flavor_tags_ban_guard  before insert or update on public.flavor_tags  for each row execute function public.ban_guard();
create trigger profiles_ban_guard before insert on public.profiles for each row execute function public.ban_guard();

-- 4) Rate limits (M10, R6). Counted from an append-only log, so deleting your own posts doesn't reset them.
--    Edits to one post/comment are capped too (each edit is a model call).
create table public.write_log (
  user_id uuid not null,
  kind text not null,
  target_id uuid,
  at timestamptz not null default now()
);
create index write_log_idx on public.write_log (user_id, kind, at);
alter table public.write_log enable row level security;  -- no policies: definer functions only

create or replace function public.edit_guard() returns trigger
language plpgsql security definer set search_path to '' as $$
declare uid uuid := (select auth.uid()); n int;
begin
  if uid is null or public.is_admin() then return new; end if;
  if new.mod_rev is distinct from old.mod_rev then  -- runs after mod_guard ('mod' < 'zz' trigger order)
    select count(*) into n from public.write_log where user_id = uid and kind = tg_table_name || '_edit'
       and target_id = new.id and at > now() - interval '1 day';
    if n >= 5 then raise exception 'rate_limited' using errcode = '42501'; end if;
    insert into public.write_log (user_id, kind, target_id) values (uid, tg_table_name || '_edit', new.id);
  end if;
  return new;
end $$;
revoke execute on function public.edit_guard() from public, anon, authenticated;
create trigger zz_posts_edit_cap    before update on public.posts    for each row execute function public.edit_guard();
create trigger zz_comments_edit_cap before update on public.comments for each row execute function public.edit_guard();

create or replace function public.rate_guard() returns trigger
language plpgsql security definer set search_path to '' as $$
declare uid uuid := (select auth.uid()); n int; cap int; win interval;
begin
  if uid is null or public.is_admin() then return new; end if;
  cap := (case tg_table_name when 'comments' then 30 when 'reports' then 10 else 20 end);
  win := (case tg_table_name when 'comments' then interval '1 hour' else interval '1 day' end);
  select count(*) into n from public.write_log where user_id = uid and kind = tg_table_name
     and at > now() - win;
  if n >= cap then
    raise exception 'rate_limited' using errcode = '42501';
  end if;
  insert into public.write_log (user_id, kind) values (uid, tg_table_name);
  return new;
end $$;
revoke execute on function public.rate_guard() from public, anon, authenticated;
create trigger products_rate before insert on public.products for each row execute function public.rate_guard();
create trigger posts_rate    before insert on public.posts    for each row execute function public.rate_guard();
create trigger comments_rate before insert on public.comments for each row execute function public.rate_guard();
create trigger reports_rate  before insert on public.reports  for each row execute function public.rate_guard();

-- 5) Read policies: other people only see approved items.
drop policy posts_read on public.posts;
create policy posts_read on public.posts for select to authenticated using (
  user_id = (select auth.uid()) or (select public.is_admin())
  or (hidden = false and mod_status = 'approved' and not public.blocked_by_me(user_id)));

drop policy comments_read on public.comments;
create policy comments_read on public.comments for select to authenticated using (
  user_id = (select auth.uid()) or (select public.is_admin())
  or (hidden = false and mod_status = 'approved' and not public.blocked_by_me(user_id)
      and exists (select 1 from public.posts p where p.id = comments.post_id)));

drop policy products_read on public.products;
create policy products_read on public.products for select to anon, authenticated using (
  (hidden = false and mod_status = 'approved')
  or created_by = (select auth.uid()) or (select public.is_admin()));

-- M6: a second person adding the same jar while its name is pending or held still needs the id to rate it.
-- Clients (JarSync, web app) look products up with this instead of a select on products.
create or replace function public.product_id_for_key(p_norm_key text) returns uuid
language sql stable security definer set search_path to '' as $$
  select coalesce(p.merged_into, p.id) from public.products p
   where p.norm_key = p_norm_key and p.mod_status <> 'rejected' and p.hidden = false
   limit 1
$$;
revoke execute on function public.product_id_for_key(text) from public, anon;
grant execute on function public.product_id_for_key(text) to authenticated;

-- 6) What the AI and Manny decided. Readable by Manny only; written by the server.
create table public.mod_events (
  id uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('post','comment','product','profile')),
  target_id uuid not null,
  rev integer,
  source text not null check (source in ('new','edit','report','appeal','sweep','manny','filter')),
  ai_verdict text check (ai_verdict in ('approve','hold','error')),
  ai_categories text[] not null default '{}',
  ai_reason text,
  model text,
  final text check (final in ('approved','rejected','banned','unbanned')),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);
create index mod_events_target_idx on public.mod_events (target_type, target_id, created_at desc);
alter table public.mod_events enable row level security;
create policy mod_events_admin_read on public.mod_events for select to authenticated using ((select public.is_admin()));

-- 7) Appeals: the author of a removed item can ask once; Manny decides.
create table public.appeals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  target_type text not null check (target_type in ('post','comment','product')),
  target_id uuid not null,
  message text not null default '' check (char_length(message) <= 500),
  status text not null default 'open' check (status in ('open','upheld','overturned')),
  decided_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  unique (user_id, target_type, target_id)
);
alter table public.appeals enable row level security;
create policy appeals_read on public.appeals for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy appeals_insert on public.appeals for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'open');

create or replace function public.appeal_check() returns trigger
language plpgsql security definer set search_path to '' as $$
declare owner uuid; st text;
begin
  if public.is_banned() then raise exception 'account_banned' using errcode = '42501'; end if;
  if new.target_type = 'post' then select user_id, mod_status into owner, st from public.posts where id = new.target_id;
  elsif new.target_type = 'comment' then select user_id, mod_status into owner, st from public.comments where id = new.target_id;
  else select created_by, mod_status into owner, st from public.products where id = new.target_id;
  end if;
  if owner is distinct from new.user_id or st is distinct from 'rejected' then
    raise exception 'only the author can appeal a removed item' using errcode = '42501';
  end if;
  new.status := 'open';
  perform public.mod_alert('an appeal');
  return new;
end $$;
revoke execute on function public.appeal_check() from public, anon, authenticated;
create trigger appeals_check before insert on public.appeals for each row execute function public.appeal_check();

-- 8) Calling the edge function. URL and shared secret live in Vault, never in this file.
create or replace function public.mod_send(p_type text, p_id uuid, p_rev integer, p_source text) returns void
language plpgsql security definer set search_path to '' as $$
declare url text; secret text;
begin
  select decrypted_secret into url from vault.decrypted_secrets where name = 'moderate_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'moderate_hook_secret';
  if url is null or secret is null then
    return;  -- not set up yet: the item stays pending (hidden from others) and the sweep retries
  end if;
  perform net.http_post(
    url := url,
    headers := jsonb_build_object('Content-Type','application/json','x-moderate-secret', secret),
    body := jsonb_build_object('type', p_type, 'id', p_id, 'rev', p_rev, 'source', p_source),
    timeout_milliseconds := 30000);
end $$;
revoke execute on function public.mod_send(text, uuid, integer, text) from public, anon, authenticated;

create or replace function public.mod_on_write() returns trigger
language plpgsql security definer set search_path to '' as $$
declare t text := case tg_table_name when 'posts' then 'post' when 'comments' then 'comment' else 'product' end;
begin
  if new.mod_status = 'pending' and (tg_op = 'INSERT' or new.mod_rev is distinct from old.mod_rev
                                     or old.mod_status is distinct from 'pending') then
    perform public.mod_send(t, new.id, new.mod_rev, case when tg_op = 'INSERT' then 'new' else 'edit' end);
  end if;
  return null;
end $$;
revoke execute on function public.mod_on_write() from public, anon, authenticated;
create trigger posts_mod_send    after insert or update on public.posts    for each row execute function public.mod_on_write();
create trigger comments_mod_send after insert or update on public.comments for each row execute function public.mod_on_write();
create trigger products_mod_send after insert or update on public.products for each row execute function public.mod_on_write();

-- Push to Manny (R3): content-free POST to an optional Vault URL (e.g. an ntfy topic) when something waits.
create or replace function public.mod_alert(p_what text) returns void
language plpgsql security definer set search_path to '' as $$
declare url text;
begin
  select decrypted_secret into url from vault.decrypted_secrets where name = 'moderate_alert_url';
  if url is null then return; end if;
  perform net.http_post(url := url, headers := '{"Content-Type":"text/plain"}'::jsonb,
                        body := to_jsonb('Jar Journal: ' || p_what || ' is waiting for your review.'),
                        timeout_milliseconds := 10000);
end $$;
revoke execute on function public.mod_alert(text) from public, anon, authenticated;

-- 9) Reports (M4). One report per account per item. 3 different accounts hold the item, except a product
--    with 10+ ratings, which goes to Manny's queue without being hidden. Profile reports go to the queue.
--    Fewer than 3: the AI looks again with the report reasons as extra data.
create unique index if not exists reports_one_per_reporter on public.reports (reporter, target_type, target_id);

create or replace function public.mod_on_report() returns trigger
language plpgsql security definer set search_path to '' as $$
declare n int; busy boolean := false; rev int;
begin
  if new.target_type = 'profile' then
    insert into public.mod_events (target_type, target_id, source, ai_reason)
    values ('profile', new.target_id, 'report', left(new.reason, 300));
    perform public.mod_alert('a reported profile');
    return null;
  end if;
  if new.target_type not in ('post','comment','product') then
    return null;
  end if;
  select count(distinct reporter) into n from public.reports
   where target_type = new.target_type and target_id = new.target_id and resolved = false;
  if new.target_type = 'product' then
    select coalesce(s.rating_count, 0) >= 10 into busy from public.product_stats s where s.product_id = new.target_id;
    busy := coalesce(busy, false);
  end if;
  if n >= 3 then
    if new.target_type = 'post' then update public.posts set mod_status = 'held' where id = new.target_id and mod_status in ('approved','pending');
    elsif new.target_type = 'comment' then update public.comments set mod_status = 'held' where id = new.target_id and mod_status in ('approved','pending');
    elsif not busy then update public.products set mod_status = 'held' where id = new.target_id and mod_status in ('approved','pending');
    end if;
    insert into public.mod_events (target_type, target_id, source, ai_reason)
    values (new.target_type, new.target_id, 'report',
            n || ' accounts reported it' || case when busy then ' (busy product: still shown)' else '' end);
    perform public.mod_alert('a reported ' || new.target_type);
  else
    if new.target_type = 'post' then select mod_rev into rev from public.posts where id = new.target_id;
    elsif new.target_type = 'comment' then select mod_rev into rev from public.comments where id = new.target_id;
    else select mod_rev into rev from public.products where id = new.target_id;
    end if;
    perform public.mod_send(new.target_type, new.target_id, rev, 'report');
  end if;
  return null;
end $$;
revoke execute on function public.mod_on_report() from public, anon, authenticated;
create trigger reports_mod after insert on public.reports for each row execute function public.mod_on_report();

-- 10) Manny's tools. Each checks is_admin() itself. The queue screen lives in Jar Journal (admin only).
create or replace function public.mod_queue()
returns table (target_type text, target_id uuid, author uuid, author_name text, body text, title text,
               mod_status text, rev int, ai_categories text[], ai_reason text,
               open_reports int, report_reasons text[], appeal_message text, appeal_id uuid, since timestamptz)
language sql stable security definer set search_path to '' as $$
  with items as (
    -- prio 0: held, stuck pending, appeals. prio 1: still shown but has open reports (R5).
    select 'post'::text tt, p.id, p.user_id author, p.body, null::text title, p.mod_status, p.mod_rev rev,
           p.mod_pending_since since, case when p.mod_status = 'approved' then 1 else 0 end prio
      from public.posts p where p.mod_status = 'held'
         or (p.mod_status = 'pending' and p.mod_pending_since < now() - interval '10 minutes')
         or (p.mod_status = 'approved' and exists (select 1 from public.reports x
               where x.target_type = 'post' and x.target_id = p.id and not x.resolved))
    union all
    select 'comment', c.id, c.user_id, c.body, null, c.mod_status, c.mod_rev, c.mod_pending_since,
           case when c.mod_status = 'approved' then 1 else 0 end
      from public.comments c where c.mod_status = 'held'
         or (c.mod_status = 'pending' and c.mod_pending_since < now() - interval '10 minutes')
         or (c.mod_status = 'approved' and exists (select 1 from public.reports x
               where x.target_type = 'comment' and x.target_id = c.id and not x.resolved))
    union all
    select 'product', r.id, r.created_by, null, r.producer || ' - ' || r.strain, r.mod_status, r.mod_rev, r.mod_pending_since, 0
      from public.products r where r.mod_status = 'held'
         or (r.mod_status = 'pending' and r.mod_pending_since < now() - interval '10 minutes')
    union all  -- busy products and profiles with open reports (still shown)
    select x.target_type, x.target_id, coalesce(r.created_by, x.target_id), null,
           coalesce(r.producer || ' - ' || r.strain, pf.display_name), coalesce(r.mod_status, 'approved'),
           r.mod_rev, min(x.created_at), 1
      from public.reports x
      left join public.products r on x.target_type = 'product' and r.id = x.target_id
      left join public.profiles pf on x.target_type = 'profile' and pf.id = x.target_id
     where not x.resolved and (x.target_type = 'profile' or (x.target_type = 'product' and r.mod_status = 'approved'))
     group by x.target_type, x.target_id, r.created_by, r.producer, r.strain, pf.display_name, r.mod_status, r.mod_rev
    union all  -- removed items with an open appeal
    select a.target_type, a.target_id, a.user_id, coalesce(p.body, c.body),
           case when r.id is not null then r.producer || ' - ' || r.strain end, 'rejected',
           coalesce(p.mod_rev, c.mod_rev, r.mod_rev), a.created_at, 0
      from public.appeals a
      left join public.posts p on a.target_type = 'post' and p.id = a.target_id
      left join public.comments c on a.target_type = 'comment' and c.id = a.target_id
      left join public.products r on a.target_type = 'product' and r.id = a.target_id
     where a.status = 'open'
  )
  select i.tt, i.id, i.author, pr.display_name, i.body, i.title, i.mod_status, i.rev,
         coalesce(e.ai_categories, '{}'), e.ai_reason,
         (select count(distinct x.reporter)::int from public.reports x where x.target_type = i.tt and x.target_id = i.id and not x.resolved),
         (select array_agg(x.reason) from public.reports x where x.target_type = i.tt and x.target_id = i.id and not x.resolved),
         ap.message, ap.id, i.since
    from items i
    left join public.profiles pr on pr.id = i.author
    left join lateral (select * from public.mod_events m where m.target_type = i.tt and m.target_id = i.id
                       order by m.created_at desc limit 1) e on true
    left join public.appeals ap on ap.target_type = i.tt and ap.target_id = i.id and ap.status = 'open'
   where public.is_admin()
   order by i.prio, i.since
$$;
revoke execute on function public.mod_queue() from public, anon;
grant execute on function public.mod_queue() to authenticated;

create or replace function public.mod_queue_count() returns int
language sql stable security definer set search_path to '' as $$
  select case when public.is_admin() then (select count(*)::int from public.mod_queue()) else 0 end
$$;
revoke execute on function public.mod_queue_count() from public, anon;
grant execute on function public.mod_queue_count() to authenticated;

-- keep = true approves (or overturns a removal, or clears reports); keep = false removes it for everyone
-- but the author. For a profile, keep = false resets the display name.
-- p_rev is the rev Manny was shown (mod_queue.rev); if the author edited since, it refuses (R1).
create or replace function public.mod_decide(p_type text, p_id uuid, p_keep boolean, p_note text default null, p_rev int default null)
returns void language plpgsql security definer set search_path to '' as $$
declare st text := case when p_keep then 'approved' else 'rejected' end; cur int;
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  if p_type = 'post' then select mod_rev into cur from public.posts where id = p_id;
  elsif p_type = 'comment' then select mod_rev into cur from public.comments where id = p_id;
  elsif p_type = 'product' then select mod_rev into cur from public.products where id = p_id;
  end if;
  if p_keep and p_type <> 'profile' and (p_rev is null or cur is distinct from p_rev) then
    raise exception 'changed since you read it, reload' using errcode = '40001';
  end if;
  if p_type = 'post' then update public.posts set mod_status = st where id = p_id;
  elsif p_type = 'comment' then update public.comments set mod_status = st where id = p_id;
  elsif p_type = 'product' then update public.products set mod_status = st where id = p_id;
  elsif p_type = 'profile' then
    if not p_keep then update public.profiles set display_name = 'member' where id = p_id; end if;
  else raise exception 'bad type';
  end if;
  update public.reports set resolved = true where target_type = p_type and target_id = p_id and not resolved;
  update public.appeals set status = case when p_keep then 'overturned' else 'upheld' end, decided_at = now(), note = p_note
   where target_type = p_type and target_id = p_id and status = 'open';
  insert into public.mod_events (target_type, target_id, source, final, decided_by, decided_at, note)
  values (p_type, p_id, 'manny', st, (select auth.uid()), now(), p_note);
end $$;
revoke execute on function public.mod_decide(text, uuid, boolean, text, int) from public, anon;
grant execute on function public.mod_decide(text, uuid, boolean, text, int) to authenticated;

create or replace function public.mod_ban(p_user uuid, p_reason text default null, p_remove_content boolean default false)
returns void language plpgsql security definer set search_path to '' as $$
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  if p_user = (select auth.uid()) then raise exception 'cannot ban yourself'; end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'ban_pepper') then
    raise exception 'ban_pepper is not set in Vault; bans would not hold across re-signup';
  end if;
  update public.profiles set banned_at = now(), ban_reason = p_reason where id = p_user;
  insert into public.banned_subjects (subject_hash, reason)
  select k, p_reason from public.ban_keys(p_user) k
  on conflict (subject_hash) do nothing;
  if p_remove_content then
    update public.posts set mod_status = 'rejected' where user_id = p_user;
    update public.comments set mod_status = 'rejected' where user_id = p_user;
  end if;
  insert into public.mod_events (target_type, target_id, source, final, decided_by, decided_at, note)
  values ('profile', p_user, 'manny', 'banned', (select auth.uid()), now(), p_reason);
end $$;
create or replace function public.mod_unban(p_user uuid)
returns void language plpgsql security definer set search_path to '' as $$
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  update public.profiles set banned_at = null, ban_reason = null where id = p_user;
  delete from public.banned_subjects where subject_hash in (select public.ban_keys(p_user));
  insert into public.mod_events (target_type, target_id, source, final, decided_by, decided_at)
  values ('profile', p_user, 'manny', 'unbanned', (select auth.uid()), now());
end $$;
revoke execute on function public.mod_ban(uuid, text, boolean) from public, anon;
revoke execute on function public.mod_unban(uuid) from public, anon;
grant execute on function public.mod_ban(uuid, text, boolean), public.mod_unban(uuid) to authenticated;

-- 11) Safety net (M9): every 5 minutes, re-send the oldest items still pending after 2 minutes, at most
--     50 per run. The edge function counts attempts and holds an item for Manny after 3 failures.
create or replace function public.mod_sweep() returns void
language plpgsql security definer set search_path to '' as $$
declare r record;
begin
  for r in
    select * from (
      select 'post' t, id, mod_rev rev, mod_pending_since s from public.posts
       where mod_status = 'pending' and mod_pending_since < now() - interval '2 minutes'
      union all select 'comment', id, mod_rev, mod_pending_since from public.comments
       where mod_status = 'pending' and mod_pending_since < now() - interval '2 minutes'
      union all select 'product', id, mod_rev, mod_pending_since from public.products
       where mod_status = 'pending' and mod_pending_since < now() - interval '2 minutes'
    ) q order by s limit 50
  loop
    perform public.mod_send(r.t, r.id, r.rev, 'sweep');
  end loop;
end $$;
revoke execute on function public.mod_sweep() from public, anon, authenticated;
select cron.schedule('mod-sweep', '*/5 * * * *', 'select public.mod_sweep()');

commit;

-- After applying (release thread; values never written to files or chat). All three are REQUIRED:
--   select vault.create_secret('<project url>/functions/v1/moderate', 'moderate_url');
--   select vault.create_secret('<random 32+ char string>', 'moderate_hook_secret');
--   select vault.create_secret('<another random 32+ char string, never changed>', 'ban_pepper');
-- Edge function secrets: ANTHROPIC_API_KEY (Manny's key), MODERATE_HOOK_SECRET (same random string),
-- optional ALERT_URL (for example an ntfy.sh topic URL that pushes to Manny's phone when an item is held);
-- put the same URL in Vault as 'moderate_alert_url' so report holds, profile reports and appeals alert too.
-- Deploy the function with verify_jwt = false (it checks x-moderate-secret instead).
