-- CONTENT FACTORY: core schema
create extension if not exists pgcrypto;

-- ───────── enums ─────────
do $$ begin
  create type platform as enum ('telegram','instagram','youtube','threads');
exception when duplicate_object then null; end $$;
do $$ begin
  create type connection_status as enum ('pending','connected','expired','insufficient_permissions','revoked','error','paused','mock');
exception when duplicate_object then null; end $$;
do $$ begin
  create type post_status as enum ('draft','generated','review_required','approved','scheduled','publishing','platform_scheduled','published','unknown_result','awaiting_credentials','failed','paused','cancelled');
exception when duplicate_object then null; end $$;
do $$ begin
  create type post_format as enum ('text','photo','video','album','carousel','reel','story','short','long_video','thread');
exception when duplicate_object then null; end $$;
do $$ begin
  create type job_status as enum ('queued','running','continuing','retry_wait','reconcile','blocked','succeeded','failed','cancelled');
exception when duplicate_object then null; end $$;

-- ───────── helpers ─────────
create or replace function public.touch_updated_at() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;

-- ───────── profiles / settings ─────────
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  timezone text not null default 'Europe/Moscow',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.system_settings (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  emergency_stop boolean not null default false,
  emergency_stop_at timestamptz,
  ai_monthly_budget_usd numeric(10,2) not null default 20 check (ai_monthly_budget_usd >= 0 and ai_monthly_budget_usd <= 10000),
  ai_model text,
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, display_name) values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)))
  on conflict do nothing;
  insert into public.system_settings(owner_id) values (new.id) on conflict do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ───────── brands ─────────
create table if not exists public.brands (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  description text,
  niche text,
  audience text,
  positioning text,
  tone text,
  style text,
  visual_concept text,
  rubrics text[] not null default '{}',
  forbidden_topics text[] not null default '{}',
  forbidden_phrases text[] not null default '{}',
  required_elements text[] not null default '{}',
  goals text,
  posting_frequency text,
  preferred_slots text[] not null default '{}',
  hashtag_rules text,
  cta_rules text,
  examples text,
  links text[] not null default '{}',
  color text not null default '#6366f1',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name)
);

-- ───────── social accounts ─────────
create table if not exists public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete set null,
  platform platform not null,
  external_id text,
  name text not null,
  handle text,
  url text,
  connection_status connection_status not null default 'pending',
  capabilities jsonb not null default '{}',
  scopes text[] not null default '{}',
  timezone text not null default 'Europe/Moscow',
  is_paused boolean not null default false,
  consecutive_failures int not null default 0,
  last_error text,
  last_error_at timestamptz,
  last_checked_at timestamptz,
  last_published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists social_accounts_ext_uq on public.social_accounts(owner_id, platform, external_id) where external_id is not null;
create index if not exists social_accounts_brand_idx on public.social_accounts(brand_id);

-- ───────── media ─────────
create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete set null,
  storage_path text not null unique,
  file_name text not null,
  kind text not null check (kind in ('image','video')),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  width int, height int, duration_sec numeric,
  sha256 text,
  tags text[] not null default '{}',
  status text not null default 'ready' check (status in ('ready','missing')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (split_part(storage_path,'/',1) = owner_id::text)
);

-- ───────── ideas ─────────
create table if not exists public.content_ideas (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete cascade,
  account_id uuid references public.social_accounts(id) on delete set null,
  title text not null,
  angle text,
  rubric text,
  format post_format,
  planned_at timestamptz,
  source text not null default 'manual' check (source in ('manual','ai_plan','intel')),
  status text not null default 'new' check (status in ('new','in_progress','used','rejected')),
  post_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ───────── posts ─────────
create table if not exists public.content_posts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete set null,
  account_id uuid references public.social_accounts(id) on delete set null,
  parent_post_id uuid references public.content_posts(id) on delete set null,
  idea_id uuid references public.content_ideas(id) on delete set null,
  format post_format not null default 'text',
  title text,
  body text not null default '',
  hashtags text[] not null default '{}',
  rubric text,
  tags text[] not null default '{}',
  platform_options jsonb not null default '{}',
  status post_status not null default 'draft',
  scheduled_at timestamptz,
  timezone text not null default 'Europe/Moscow',
  approved_by text check (approved_by in ('user','autopilot')),
  approved_at timestamptz,
  quality_score int check (quality_score between 0 and 100),
  quality_passed boolean,
  quality_report jsonb,
  external_id text,
  external_url text,
  published_at timestamptz,
  last_error text,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists content_posts_sched_idx on public.content_posts(owner_id, scheduled_at);
create index if not exists content_posts_account_idx on public.content_posts(account_id);
create index if not exists content_posts_brand_idx on public.content_posts(brand_id);
create index if not exists content_posts_parent_idx on public.content_posts(parent_post_id);
create index if not exists content_posts_idea_idx on public.content_posts(idea_id);
alter table public.content_ideas drop constraint if exists content_ideas_post_fk;
alter table public.content_ideas add constraint content_ideas_post_fk foreign key (post_id) references public.content_posts(id) on delete set null;
create index if not exists content_ideas_owner_idx on public.content_ideas(owner_id);
create index if not exists content_ideas_brand_idx on public.content_ideas(brand_id);
create index if not exists content_ideas_account_idx on public.content_ideas(account_id);
create index if not exists content_ideas_post_idx on public.content_ideas(post_id);

create table if not exists public.post_media (
  post_id uuid not null references public.content_posts(id) on delete cascade,
  media_id uuid not null references public.media_assets(id) on delete restrict,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  position int not null default 0,
  role text not null default 'main' check (role in ('main','cover','thumbnail')),
  primary key (post_id, media_id)
);
create index if not exists post_media_media_idx on public.post_media(media_id);
create index if not exists post_media_owner_idx on public.post_media(owner_id);

create table if not exists public.content_versions (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.content_posts(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  version int not null,
  snapshot jsonb not null,
  created_by text not null default 'user',
  created_at timestamptz not null default now(),
  unique (post_id, version)
);
create index if not exists content_versions_owner_idx on public.content_versions(owner_id);

create table if not exists public.post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.content_posts(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body text not null check (length(body) between 1 and 5000),
  created_at timestamptz not null default now()
);
create index if not exists post_comments_post_idx on public.post_comments(post_id);
create index if not exists post_comments_owner_idx on public.post_comments(owner_id);

-- ───────── automation ─────────
create table if not exists public.automation_rules (
  account_id uuid primary key references public.social_accounts(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  rules jsonb not null default '{"mode":"approval"}',
  updated_at timestamptz not null default now(),
  check (coalesce((rules->>'maxPerDay')::int, 0) between 0 and 100),
  check (coalesce((rules->>'maxPerWeek')::int, 0) between 0 and 700),
  check (coalesce((rules->>'monthlyAiBudgetUsd')::numeric, 0) between 0 and 10000)
);
create index if not exists automation_rules_owner_idx on public.automation_rules(owner_id);

-- ───────── publishing ─────────
create table if not exists public.publishing_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  post_id uuid not null references public.content_posts(id) on delete cascade,
  account_id uuid not null references public.social_accounts(id) on delete cascade,
  platform platform not null,
  status job_status not null default 'queued',
  phase text not null default 'pending',
  run_at timestamptz not null,
  attempts int not null default 0,
  max_attempts int not null default 5,
  locked_by text,
  locked_until timestamptz,
  external_call_started boolean not null default false,
  reconcile_count int not null default 0,
  checkpoint jsonb not null default '{}',
  last_error text,
  last_error_category text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index if not exists publishing_jobs_one_active on public.publishing_jobs(post_id)
  where status not in ('succeeded','failed','cancelled');
create index if not exists publishing_jobs_due on public.publishing_jobs(run_at) where status in ('queued','retry_wait','continuing','reconcile','running');
create index if not exists publishing_jobs_owner_idx on public.publishing_jobs(owner_id);
create index if not exists publishing_jobs_post_idx on public.publishing_jobs(post_id);
create index if not exists publishing_jobs_account_idx on public.publishing_jobs(account_id);

create table if not exists public.publishing_attempts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.publishing_jobs(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  worker_id text,
  step text,
  outcome text,
  error_category text,
  error_message text,
  http_status int,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists publishing_attempts_job_idx on public.publishing_attempts(job_id);
create index if not exists publishing_attempts_owner_idx on public.publishing_attempts(owner_id);

create table if not exists public.publishing_results (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references public.publishing_jobs(id) on delete cascade,
  post_id uuid not null references public.content_posts(id) on delete cascade,
  account_id uuid not null references public.social_accounts(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  external_id text not null,
  external_url text,
  is_mock boolean not null default false,
  metrics jsonb not null default '{}',
  metrics_updated_at timestamptz,
  published_at timestamptz not null default now(),
  unique (account_id, external_id)
);
create index if not exists publishing_results_post_idx on public.publishing_results(post_id);
create index if not exists publishing_results_owner_idx on public.publishing_results(owner_id);

-- ───────── AI, audit, notifications ─────────
create table if not exists public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete set null,
  post_id uuid references public.content_posts(id) on delete set null,
  task text not null,
  prompt_version text not null,
  model text,
  status text not null check (status in ('ok','error','invalid_output','budget_exceeded')),
  input_tokens int, output_tokens int, cache_read_tokens int, cache_write_tokens int,
  cost_usd numeric(12,6),
  cost_usd_confirmed numeric(12,6),
  duration_ms int,
  request_id text,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists ai_runs_owner_month on public.ai_runs(owner_id, created_at);
create index if not exists ai_runs_brand_idx on public.ai_runs(brand_id);
create index if not exists ai_runs_post_idx on public.ai_runs(post_id);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  level text not null default 'info' check (level in ('info','warn','error')),
  event text not null,
  entity_type text,
  entity_id uuid,
  message text,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_owner_idx on public.audit_logs(owner_id, created_at desc);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  level text not null default 'info' check (level in ('info','warn','error')),
  title text not null,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_owner_idx on public.notifications(owner_id, created_at desc);

create table if not exists public.worker_heartbeats (
  worker text primary key,
  last_tick_at timestamptz not null default now(),
  last_result jsonb not null default '{}'
);

create index if not exists brands_owner_idx on public.brands(owner_id);
create index if not exists media_assets_owner_idx on public.media_assets(owner_id);
create index if not exists media_assets_brand_idx on public.media_assets(brand_id);

-- ───────── updated_at triggers ─────────
do $$ declare t text; begin
  foreach t in array array['profiles','brands','social_accounts','media_assets','content_ideas','content_posts','publishing_jobs'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I for each row execute function public.touch_updated_at()', t, t);
  end loop;
end $$;
