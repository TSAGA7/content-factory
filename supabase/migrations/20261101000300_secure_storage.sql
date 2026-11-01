-- CONTENT FACTORY: encrypted credentials, OAuth state, storage

create schema if not exists secure;
revoke all on schema secure from public, anon, authenticated;

create table if not exists secure.account_credentials (
  account_id uuid primary key references public.social_accounts(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  ciphertext text not null,      -- base64(iv || AES-256-GCM ciphertext), AAD = 'account:<id>'
  key_version int not null default 1,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists secure.oauth_states (
  state text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  platform public.platform not null,
  account_id uuid references public.social_accounts(id) on delete cascade,
  code_verifier text,
  redirect_to text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes'
);
alter table secure.account_credentials enable row level security;
alter table secure.oauth_states enable row level security;

create or replace function public.cred_get(p_account uuid) returns table(ciphertext text, key_version int, expires_at timestamptz)
language sql security definer set search_path = secure, public as $$
  select ciphertext, key_version, expires_at from secure.account_credentials where account_id = p_account;
$$;
create or replace function public.cred_put(p_account uuid, p_owner uuid, p_ciphertext text, p_expires timestamptz default null) returns void
language sql security definer set search_path = secure, public as $$
  insert into secure.account_credentials(account_id, owner_id, ciphertext, expires_at)
  values (p_account, p_owner, p_ciphertext, p_expires)
  on conflict (account_id) do update set ciphertext = excluded.ciphertext, expires_at = excluded.expires_at, updated_at = now();
$$;
create or replace function public.cred_delete(p_account uuid) returns void
language sql security definer set search_path = secure, public as $$
  delete from secure.account_credentials where account_id = p_account;
$$;
create or replace function public.oauth_state_put(p_state text, p_owner uuid, p_platform public.platform, p_account uuid, p_verifier text, p_redirect text) returns void
language sql security definer set search_path = secure, public as $$
  delete from secure.oauth_states where expires_at < now();
  insert into secure.oauth_states(state, owner_id, platform, account_id, code_verifier, redirect_to) values (p_state, p_owner, p_platform, p_account, p_verifier, p_redirect);
$$;
create or replace function public.oauth_state_take(p_state text)
returns table(owner_id uuid, platform public.platform, account_id uuid, code_verifier text, redirect_to text)
language sql security definer set search_path = secure, public as $$
  delete from secure.oauth_states where state = p_state and expires_at > now()
  returning owner_id, platform, account_id, code_verifier, redirect_to;
$$;
do $$ declare f text; begin
  foreach f in array array['cred_get(uuid)','cred_put(uuid,uuid,text,timestamptz)','cred_delete(uuid)',
    'oauth_state_put(text,uuid,platform,uuid,text,text)','oauth_state_take(text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ───────── storage ─────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 52428800,
  array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm'])
on conflict (id) do update set public = false, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists media_own_select on storage.objects;
create policy media_own_select on storage.objects for select to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists media_own_insert on storage.objects;
create policy media_own_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists media_own_update on storage.objects;
create policy media_own_update on storage.objects for update to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists media_own_delete on storage.objects;
create policy media_own_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
