-- CONTENT FACTORY: background schedule (pg_cron → Edge Functions)
-- Requires Vault secrets 'project_url' and 'worker_secret'.
create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.invoke_worker(p_fn text) returns bigint
language plpgsql security definer set search_path = public, vault as $$
declare url text; secret text;
begin
  select decrypted_secret into url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'worker_secret';
  if url is null or secret is null then
    raise warning 'vault secrets project_url/worker_secret are missing';
    return null;
  end if;
  return net.http_post(
    url := url || '/functions/v1/' || p_fn,
    headers := jsonb_build_object('Content-Type','application/json','x-worker-secret', secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
end $$;
revoke all on function public.invoke_worker(text) from public, anon, authenticated;

do $$ begin perform cron.unschedule('cf-publish-worker'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('cf-maintenance'); exception when others then null; end $$;
select cron.schedule('cf-publish-worker', '* * * * *', $$select public.invoke_worker('publish-worker')$$);
select cron.schedule('cf-maintenance', '7 * * * *', $$select public.invoke_worker('maintenance')$$);
