-- CONTENT FACTORY: RLS, integrity guards, RPC

create or replace function public.is_server() returns boolean language sql stable set search_path = public as $$
  select coalesce(auth.jwt()->>'role','') = 'service_role'
      or current_user in ('postgres','service_role','supabase_admin');
$$;

-- ───────── RLS ─────────
do $$ declare t text; begin
  foreach t in array array['profiles','system_settings','brands','social_accounts','media_assets','content_ideas',
    'content_posts','post_media','content_versions','post_comments','automation_rules','publishing_jobs',
    'publishing_attempts','publishing_results','ai_runs','audit_logs','notifications','worker_heartbeats'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- full CRUD on own rows
do $$ declare t text; begin
  foreach t in array array['brands','social_accounts','media_assets','content_ideas','content_posts','post_media','post_comments','automation_rules'] loop
    execute format('drop policy if exists own_all on public.%I', t);
    execute format('create policy own_all on public.%I for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()))', t);
  end loop;
end $$;

-- read-only own rows
do $$ declare t text; begin
  foreach t in array array['content_versions','publishing_jobs','publishing_attempts','publishing_results','ai_runs','audit_logs'] loop
    execute format('drop policy if exists own_read on public.%I', t);
    execute format('create policy own_read on public.%I for select to authenticated using (owner_id = (select auth.uid()))', t);
  end loop;
end $$;

drop policy if exists own_profile on public.profiles;
create policy own_profile on public.profiles for all to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
drop policy if exists own_settings_read on public.system_settings;
create policy own_settings_read on public.system_settings for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists own_settings_update on public.system_settings;
create policy own_settings_update on public.system_settings for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists own_notif_read on public.notifications;
create policy own_notif_read on public.notifications for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists own_notif_update on public.notifications;
create policy own_notif_update on public.notifications for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists heartbeat_read on public.worker_heartbeats;
create policy heartbeat_read on public.worker_heartbeats for select to authenticated using (true);

-- ───────── guards ─────────
create or replace function public.system_settings_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if not public.is_server() then
    -- emergency stop only through RPC
    new.emergency_stop := old.emergency_stop;
    new.emergency_stop_at := old.emergency_stop_at;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists system_settings_guard on public.system_settings;
create trigger system_settings_guard before update on public.system_settings for each row execute function public.system_settings_guard();

create or replace function public.social_accounts_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if public.is_server() then return new; end if;
  if new.brand_id is not null and not exists (select 1 from brands b where b.id = new.brand_id and b.owner_id = new.owner_id) then
    raise exception 'brand belongs to another owner' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    -- client may only create mock accounts; real ones go through accounts-connect / oauth
    if new.connection_status <> 'mock' then new.connection_status := 'pending'; end if;
    new.external_id := case when new.connection_status = 'mock' then coalesce(new.external_id, 'mock-' || gen_random_uuid()) else null end;
    new.scopes := '{}';
    new.consecutive_failures := 0;
    return new;
  end if;
  new.platform := old.platform;
  new.external_id := old.external_id;
  new.connection_status := old.connection_status;
  new.capabilities := old.capabilities;
  new.scopes := old.scopes;
  new.consecutive_failures := old.consecutive_failures;
  new.last_error := old.last_error;
  new.last_error_at := old.last_error_at;
  new.last_checked_at := old.last_checked_at;
  new.last_published_at := old.last_published_at;
  new.is_paused := old.is_paused; -- via set_account_paused
  return new;
end $$;
drop trigger if exists social_accounts_guard on public.social_accounts;
create trigger social_accounts_guard before insert or update on public.social_accounts for each row execute function public.social_accounts_guard();

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
drop trigger if exists content_posts_guard on public.content_posts;
create trigger content_posts_guard before insert or update on public.content_posts for each row execute function public.content_posts_guard();

create or replace function public.automation_rules_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is null or auth.uid() <> new.owner_id then
    raise exception 'automation rules can be changed only by owner' using errcode = '42501';
  end if;
  if not exists (select 1 from social_accounts a where a.id = new.account_id and a.owner_id = new.owner_id) then
    raise exception 'account belongs to another owner' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists automation_rules_guard on public.automation_rules;
create trigger automation_rules_guard before insert or update on public.automation_rules for each row execute function public.automation_rules_guard();

create or replace function public.post_media_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from content_posts p where p.id = new.post_id and p.owner_id = new.owner_id)
     or not exists (select 1 from media_assets m where m.id = new.media_id and m.owner_id = new.owner_id) then
    raise exception 'post/media belongs to another owner' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists post_media_guard on public.post_media;
create trigger post_media_guard before insert or update on public.post_media for each row execute function public.post_media_guard();

-- ───────── audit helper ─────────
create or replace function public.log_event(p_owner uuid, p_level text, p_event text, p_entity_type text, p_entity_id uuid, p_message text, p_details jsonb default '{}')
returns void language sql security definer set search_path = public as $$
  insert into audit_logs(owner_id, level, event, entity_type, entity_id, message, details)
  values (p_owner, p_level, p_event, p_entity_type, p_entity_id, p_message, coalesce(p_details,'{}'));
$$;
revoke all on function public.log_event from public, anon, authenticated;

-- ───────── engine RPC (service_role only) ─────────
create or replace function public.claim_publishing_jobs(p_worker text, p_limit int default 5, p_lease_seconds int default 600)
returns setof public.publishing_jobs language plpgsql security definer set search_path = public as $$
begin
  return query
  with c as (
    select j.id, (j.status = 'running') as recovered
    from publishing_jobs j
    join system_settings s on s.owner_id = j.owner_id
    where s.emergency_stop = false
      and (
        (j.status in ('queued','retry_wait','continuing','reconcile') and j.run_at <= now())
        or (j.status = 'running' and j.locked_until < now())
      )
    order by j.run_at
    limit p_limit
    for update of j skip locked
  )
  update publishing_jobs j set
    status = case when c.recovered and j.external_call_started then 'reconcile'::job_status else 'running'::job_status end,
    locked_by = p_worker,
    locked_until = now() + make_interval(secs => p_lease_seconds),
    checkpoint = case when c.recovered then j.checkpoint || '{"recovered":true}'::jsonb else j.checkpoint end
  from c where j.id = c.id
  returning j.*;
end $$;

create or replace function public.schedule_post_job(p_owner uuid, p_post uuid, p_run_at timestamptz, p_expected_version int, p_approve_by text default null)
returns public.publishing_jobs language plpgsql security definer set search_path = public as $$
declare p content_posts; a social_accounts; j publishing_jobs;
begin
  select * into p from content_posts where id = p_post and owner_id = p_owner for update;
  if not found then raise exception 'post not found' using errcode = 'P0002'; end if;
  if p_expected_version is not null and p.version <> p_expected_version then
    raise exception 'version conflict' using errcode = '40001';
  end if;
  if p.account_id is null then raise exception 'account required' using errcode = '22023'; end if;
  select * into a from social_accounts where id = p.account_id;
  if p_approve_by = 'autopilot' and p.approved_by is null then
    update content_posts set approved_by = 'autopilot', approved_at = now() where id = p.id;
  elsif p.approved_by is null and p.status <> 'approved' then
    raise exception 'post is not approved' using errcode = '22023';
  end if;

  select * into j from publishing_jobs where post_id = p.id and status not in ('succeeded','failed','cancelled') for update;
  if found then
    if j.status in ('running') or j.external_call_started then
      raise exception 'job already in progress' using errcode = '55000';
    end if;
    update publishing_jobs set run_at = p_run_at, status = 'queued', account_id = p.account_id, platform = a.platform, last_error = null
      where id = j.id returning * into j;
  else
    insert into publishing_jobs(owner_id, post_id, account_id, platform, run_at, idempotency_key)
    values (p_owner, p.id, p.account_id, a.platform, p_run_at, p.id::text || ':' || gen_random_uuid()::text)
    returning * into j;
  end if;
  update content_posts set status = 'scheduled', scheduled_at = p_run_at, last_error = null where id = p.id;
  perform log_event(p_owner, 'info', 'post_scheduled', 'content_post', p.id, 'Запланировано на ' || to_char(p_run_at at time zone a.timezone, 'DD.MM.YYYY HH24:MI') || ' (' || a.timezone || ')', jsonb_build_object('job_id', j.id));
  return j;
end $$;

revoke all on function public.claim_publishing_jobs from public, anon, authenticated;
revoke all on function public.schedule_post_job from public, anon, authenticated;
grant execute on function public.claim_publishing_jobs to service_role;
grant execute on function public.schedule_post_job to service_role;

-- ───────── user RPC ─────────
create or replace function public.cancel_post_job(p_post uuid) returns void language plpgsql security definer set search_path = public as $$
declare j publishing_jobs;
begin
  if not exists (select 1 from content_posts where id = p_post and owner_id = auth.uid()) then
    raise exception 'not found' using errcode = 'P0002'; end if;
  select * into j from publishing_jobs where post_id = p_post and status not in ('succeeded','failed','cancelled') for update;
  if found then
    if j.status = 'running' or j.external_call_started then
      raise exception 'Публикация уже передана площадке — отменить нельзя' using errcode = '55000';
    end if;
    update publishing_jobs set status = 'cancelled', finished_at = now() where id = j.id;
  end if;
  update content_posts set status = case when approved_by is not null then 'approved'::post_status else 'draft'::post_status end, scheduled_at = null
    where id = p_post and status in ('scheduled','awaiting_credentials','failed','paused');
  perform log_event(auth.uid(), 'info', 'post_unscheduled', 'content_post', p_post, 'Снято с расписания', '{}');
end $$;

create or replace function public.retry_post_job(p_post uuid) returns void language plpgsql security definer set search_path = public as $$
declare j publishing_jobs;
begin
  select * into j from publishing_jobs where post_id = p_post and owner_id = auth.uid() order by created_at desc limit 1 for update;
  if not found then raise exception 'no job' using errcode = 'P0002'; end if;
  if j.status not in ('failed','blocked') then raise exception 'job is not failed/blocked' using errcode = '55000'; end if;
  if (j.checkpoint->>'unknown_result')::boolean then raise exception 'unknown result: use resolve' using errcode = '55000'; end if;
  if j.status = 'failed' then
    insert into publishing_jobs(owner_id, post_id, account_id, platform, run_at, idempotency_key)
    values (j.owner_id, j.post_id, j.account_id, j.platform, now(), p_post::text || ':' || gen_random_uuid()::text);
  else
    update publishing_jobs set status = 'queued', run_at = now(), last_error = null where id = j.id;
  end if;
  update content_posts set status = 'scheduled', last_error = null where id = p_post;
  perform log_event(auth.uid(), 'info', 'job_retry', 'content_post', p_post, 'Повтор публикации запрошен пользователем', '{}');
end $$;

create or replace function public.resolve_unknown_result(p_post uuid, p_resolution text, p_url text default null) returns void
language plpgsql security definer set search_path = public as $$
declare j publishing_jobs; p content_posts;
begin
  select * into p from content_posts where id = p_post and owner_id = auth.uid() for update;
  if not found or p.status <> 'unknown_result' then raise exception 'post is not in unknown_result' using errcode = '55000'; end if;
  select * into j from publishing_jobs where post_id = p_post order by created_at desc limit 1 for update;
  if p_resolution = 'published' then
    update publishing_jobs set status = 'succeeded', phase = 'done', finished_at = now() where id = j.id;
    update content_posts set status = 'published', published_at = now(), external_url = p_url where id = p_post;
    insert into publishing_results(job_id, post_id, account_id, owner_id, external_id, external_url)
      values (j.id, p_post, j.account_id, j.owner_id, 'manual:' || j.id, p_url) on conflict do nothing;
  elsif p_resolution = 'retry' then
    update publishing_jobs set status = 'failed', finished_at = now() where id = j.id;
    insert into publishing_jobs(owner_id, post_id, account_id, platform, run_at, idempotency_key)
    values (j.owner_id, j.post_id, j.account_id, j.platform, now(), p_post::text || ':' || gen_random_uuid()::text);
    update content_posts set status = 'scheduled' where id = p_post;
  elsif p_resolution = 'failed' then
    update publishing_jobs set status = 'failed', finished_at = now() where id = j.id;
    update content_posts set status = 'failed', last_error = 'Отмечено пользователем как не опубликованное' where id = p_post;
  else
    raise exception 'bad resolution' using errcode = '22023';
  end if;
  perform log_event(auth.uid(), 'info', 'unknown_result_resolved', 'content_post', p_post, 'Решение: ' || p_resolution, '{}');
end $$;

create or replace function public.set_account_paused(p_account uuid, p_paused boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  update social_accounts set is_paused = p_paused where id = p_account and owner_id = auth.uid();
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  perform log_event(auth.uid(), 'info', case when p_paused then 'account_paused' else 'account_resumed' end, 'social_account', p_account,
    case when p_paused then 'Аккаунт приостановлен' else 'Аккаунт возобновлён' end, '{}');
end $$;

create or replace function public.set_emergency_stop(p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  update system_settings set emergency_stop = p_on, emergency_stop_at = case when p_on then now() else null end where owner_id = auth.uid();
  perform log_event(auth.uid(), case when p_on then 'warn' else 'info' end, case when p_on then 'emergency_stop_on' else 'emergency_stop_off' end, null, null,
    case when p_on then 'Все публикации остановлены. Уже отправленные на площадку запросы не отменяются.' else 'Публикации возобновлены' end, '{}');
end $$;

create or replace function public.dashboard_stats() returns jsonb language sql stable security definer set search_path = public as $$
  with u as (select auth.uid() as id)
  select jsonb_build_object(
    'accounts_total', (select count(*) from social_accounts, u where owner_id = u.id),
    'accounts_connected', (select count(*) from social_accounts, u where owner_id = u.id and connection_status in ('connected','mock') and not is_paused),
    'accounts_problem', (select count(*) from social_accounts, u where owner_id = u.id and connection_status in ('expired','insufficient_permissions','revoked','error')),
    'brands_active', (select count(*) from brands, u where owner_id = u.id and is_active),
    'posts_today', (select count(*) from content_posts, u where owner_id = u.id and status in ('scheduled','publishing','platform_scheduled','published')
                     and scheduled_at >= date_trunc('day', now() at time zone 'Europe/Moscow') at time zone 'Europe/Moscow'
                     and scheduled_at < (date_trunc('day', now() at time zone 'Europe/Moscow') + interval '1 day') at time zone 'Europe/Moscow'),
    'posts_7d', (select count(*) from content_posts, u where owner_id = u.id and status in ('scheduled','platform_scheduled') and scheduled_at between now() and now() + interval '7 days'),
    'drafts', (select count(*) from content_posts, u where owner_id = u.id and status in ('draft','generated')),
    'review_required', (select count(*) from content_posts, u where owner_id = u.id and status = 'review_required'),
    'jobs_queued', (select count(*) from publishing_jobs, u where owner_id = u.id and status in ('queued','retry_wait','continuing','reconcile','running')),
    'jobs_blocked', (select count(*) from publishing_jobs, u where owner_id = u.id and status = 'blocked'),
    'jobs_overdue', (select count(*) from publishing_jobs, u where owner_id = u.id and status in ('queued','retry_wait') and run_at < now() - interval '5 minutes'),
    'published_total', (select count(*) from content_posts, u where owner_id = u.id and status = 'published'),
    'published_30d', (select count(*) from content_posts, u where owner_id = u.id and status = 'published' and published_at > now() - interval '30 days'),
    'failed', (select count(*) from content_posts, u where owner_id = u.id and status in ('failed','unknown_result')),
    'ai_runs_month', (select count(*) from ai_runs, u where owner_id = u.id and created_at >= date_trunc('month', now())),
    'ai_cost_month', (select sum(cost_usd) from ai_runs, u where owner_id = u.id and created_at >= date_trunc('month', now())),
    'ai_unpriced_month', (select count(*) from ai_runs, u where owner_id = u.id and created_at >= date_trunc('month', now()) and cost_usd is null and status = 'ok'),
    'worker_last_tick', (select last_tick_at from worker_heartbeats where worker = 'publish-worker'),
    'emergency_stop', (select emergency_stop from system_settings, u where owner_id = u.id)
  );
$$;

do $$ declare f text; begin
  foreach f in array array['cancel_post_job(uuid)','retry_post_job(uuid)','resolve_unknown_result(uuid,text,text)','set_account_paused(uuid,boolean)','set_emergency_stop(boolean)','dashboard_stats()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
