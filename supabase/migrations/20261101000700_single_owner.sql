-- CONTENT FACTORY: personal app — only the first registered user may sign up; owner-managed server secrets.
create table if not exists public.app_owner (
  id boolean primary key default true check (id),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.app_owner enable row level security;
drop policy if exists app_owner_read on public.app_owner;
create policy app_owner_read on public.app_owner for select to authenticated using (user_id = (select auth.uid()));

create or replace function public.single_owner_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.app_owner) then
    raise exception 'Регистрация закрыта: у приложения уже есть владелец' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists single_owner_guard on auth.users;
create trigger single_owner_guard before insert on auth.users for each row execute function public.single_owner_guard();

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, display_name) values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)))
  on conflict do nothing;
  insert into public.system_settings(owner_id) values (new.id) on conflict do nothing;
  insert into public.app_owner(user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

create or replace function public.is_app_owner(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_owner where user_id = p_user);
$$;
revoke all on function public.is_app_owner(uuid) from public, anon, authenticated;
grant execute on function public.is_app_owner(uuid) to service_role;

create or replace function public.set_app_secret(p_name text, p_value text) returns void
language plpgsql security definer set search_path = public, vault as $$
declare sid uuid;
begin
  if p_name not in ('anthropic_api_key') then raise exception 'secret not allowed' using errcode = '42501'; end if;
  select id into sid from vault.secrets where name = p_name;
  if p_value is null then
    if sid is not null then delete from vault.secrets where id = sid; end if;
  elsif sid is null then
    perform vault.create_secret(p_value, p_name);
  else
    perform vault.update_secret(sid, p_value);
  end if;
end $$;
revoke all on function public.set_app_secret(text, text) from public, anon, authenticated;
grant execute on function public.set_app_secret(text, text) to service_role;
