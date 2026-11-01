-- fix: version snapshots written via owner-checked definer helper (RLS on content_versions is read-only)
create or replace function public.save_post_version(p_post uuid, p_owner uuid, p_version int, p_snapshot jsonb, p_by text) returns void
language sql security definer set search_path = public as $$
  insert into content_versions(post_id, owner_id, version, snapshot, created_by)
  select p.id, p.owner_id, p_version, p_snapshot, p_by from content_posts p
  where p.id = p_post and p.owner_id = p_owner
    and (p_owner = auth.uid() or coalesce(auth.jwt()->>'role','') = 'service_role' or auth.uid() is null)
  on conflict (post_id, version) do nothing;
$$;
revoke all on function public.save_post_version(uuid,uuid,int,jsonb,text) from public, anon;
grant execute on function public.save_post_version(uuid,uuid,int,jsonb,text) to authenticated, service_role;

create or replace function public.content_posts_guard() returns trigger language plpgsql set search_path = public as $$
declare
  engine_statuses post_status[] := array['scheduled','publishing','platform_scheduled','published','unknown_result','awaiting_credentials']::post_status[];
  content_changed boolean;
begin
  if new.brand_id is not null and not exists (select 1 from brands b where b.id = new.brand_id and b.owner_id = new.owner_id) then
    raise exception 'brand belongs to another owner' using errcode = '42501';
  end if;
  if new.account_id is not null and not exists (select 1 from social_accounts a where a.id = new.account_id and a.owner_id = new.owner_id) then
    raise exception 'account belongs to another owner' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if not public.is_server() then
      if new.status = any(engine_statuses) then new.status := 'draft'; end if;
      if new.approved_by = 'autopilot' then new.approved_by := null; new.approved_at := null; end if;
      if new.status = 'approved' then new.approved_by := 'user'; new.approved_at := now(); end if;
      new.external_id := null; new.external_url := null; new.published_at := null;
      new.quality_score := null; new.quality_passed := null; new.quality_report := null;
    end if;
    new.version := 1;
    return new;
  end if;

  content_changed := (new.body, new.title, new.hashtags, new.format, new.account_id, new.platform_options)
            is distinct from (old.body, old.title, old.hashtags, old.format, old.account_id, old.platform_options);

  if not public.is_server() then
    if old.status in ('publishing') and content_changed then
      raise exception 'post is being published' using errcode = '55000';
    end if;
    if new.status is distinct from old.status then
      if new.status = any(engine_statuses) then
        raise exception 'status % is set by server only', new.status using errcode = '42501';
      end if;
      if old.status = any(engine_statuses) then
        raise exception 'Сначала снимите материал с расписания' using errcode = '55000';
      end if;
    end if;
    new.external_id := old.external_id; new.external_url := old.external_url; new.published_at := old.published_at;
    new.quality_score := old.quality_score; new.quality_passed := old.quality_passed; new.quality_report := old.quality_report;
    new.scheduled_at := case when new.status in ('draft','generated','review_required','approved','paused','cancelled') then new.scheduled_at else old.scheduled_at end;
    if new.approved_by = 'autopilot' and old.approved_by is distinct from 'autopilot' then
      new.approved_by := old.approved_by; new.approved_at := old.approved_at;
    end if;
    if new.status = 'approved' and old.status <> 'approved' then
      new.approved_by := 'user'; new.approved_at := now();
    end if;
    if content_changed and old.approved_by = 'autopilot' then
      new.approved_by := null; new.approved_at := null;
      if new.status = 'approved' then new.status := 'review_required'; end if;
    end if;
    if content_changed then
      new.quality_score := null; new.quality_passed := null; new.quality_report := null;
    end if;
  end if;

  if content_changed then
    perform public.save_post_version(old.id, old.owner_id, old.version,
      jsonb_build_object('title',old.title,'body',old.body,'hashtags',old.hashtags,'format',old.format,
        'account_id',old.account_id,'platform_options',old.platform_options,'rubric',old.rubric),
      case when public.is_server() then 'server' else 'user' end);
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end $$;
