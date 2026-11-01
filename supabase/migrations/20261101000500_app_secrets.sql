-- CONTENT FACTORY: server-side config from Vault (fallback when Edge Function env is not set)
-- Allowed names only; callable by service_role only.
create or replace function public.get_app_secret(p_name text) returns text
language plpgsql security definer set search_path = public, vault as $$
declare v text;
begin
  if p_name not in ('worker_secret','credentials_encryption_key','project_url','anthropic_api_key','telegram_default_bot_token') then
    raise exception 'secret not allowed' using errcode = '42501';
  end if;
  select decrypted_secret into v from vault.decrypted_secrets where name = p_name;
  return v;
end $$;
revoke all on function public.get_app_secret(text) from public, anon, authenticated;
grant execute on function public.get_app_secret(text) to service_role;
