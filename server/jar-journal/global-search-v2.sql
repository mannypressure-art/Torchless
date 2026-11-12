-- Jar Journal / Torchless: search_products v2 (Fable review #15, #16, #19). Written 2026-11-12. NOT APPLIED.
-- Same signature and columns as v1, so apps need no change. Changes:
--   'top' sort uses a weighted score with a fixed neutral prior (C = 7.0, m = 10; Fable),
--   so one 10.0 no longer outranks 200 ratings at 9.4. avg_score shown is still the plain average.
--   flavor filter matches only a product's top 3 flavors (one stray tag no longer counts).
--   q is escaped, so % and _ are literal.
-- Also adds merge-safety notes for merge_product (#18) below.

create or replace function public.search_products(
  q text default null,
  producer_in text default null,
  category_in text default null,
  flavors_in text[] default null,
  max_ppg numeric default null,
  min_score numeric default null,
  sort text default 'top',
  lim integer default 30,
  off integer default 0
) returns table (
  id uuid, producer text, strain text, category text,
  rating_count integer, avg_score numeric, price_count integer, avg_ppg numeric,
  top_flavors text[]
)
language sql stable security invoker set search_path to '' as $$
  with base as (
    select p.id, p.producer, p.strain, p.category, p.created_at,
           coalesce(s.rating_count, 0) rc, s.avg_score, coalesce(s.price_count, 0) pc, s.avg_ppg,
           (coalesce(s.rating_sum, 0) + 10 * 7.0) / (coalesce(s.rating_count, 0) + 10) as weighted,
           coalesce((select array_agg(f.flavor order by f.votes desc, f.flavor)
                       from (select fs.flavor, fs.votes from public.product_flavor_stats fs
                              where fs.product_id = p.id and fs.votes > 0
                              order by fs.votes desc, fs.flavor limit 3) f), '{}') as tf
      from public.products p
      left join public.product_stats s on s.product_id = p.id
     where p.hidden = false and p.merged_into is null
       and (q is null or p.strain ilike '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
                      or p.producer ilike '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%')
       and (producer_in is null or lower(p.producer) = lower(producer_in))
       and (category_in is null or p.category = category_in)
       and (max_ppg is null or s.avg_ppg <= max_ppg)
       and (min_score is null or s.avg_score >= min_score)
  )
  select b.id, b.producer, b.strain, b.category, b.rc, b.avg_score, b.pc, b.avg_ppg, b.tf
    from base b
   where flavors_in is null or b.tf @> flavors_in
   order by
     case when sort = 'cheap' then b.avg_ppg end asc nulls last,
     case when sort = 'most' then b.rc end desc nulls last,
     case when sort = 'new' then b.created_at end desc,
     case when b.rc > 0 then b.weighted end desc nulls last, b.rc desc, b.strain
   limit least(greatest(lim, 1), 100) offset greatest(off, 0)
$$;
grant execute on function public.search_products(text, text, text, text[], numeric, numeric, text, integer, integer) to anon, authenticated;

-- #18 for whoever writes merge_product: it must also move price_shares and flavor_tags
-- (insert ... on conflict do nothing into the target, delete from the source, which the
-- stats triggers count down/up), so product_stats.price_count/ppg_sum and product_flavor_stats stay right.
