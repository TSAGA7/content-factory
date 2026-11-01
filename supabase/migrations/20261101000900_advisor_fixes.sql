-- Advisor fixes: trigger-only functions must not be callable via /rest/v1/rpc; FK indexes.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.single_owner_guard() from public, anon, authenticated;
create index if not exists app_owner_user_idx on public.app_owner(user_id);
create index if not exists account_credentials_owner_idx on secure.account_credentials(owner_id);
create index if not exists oauth_states_account_idx on secure.oauth_states(account_id);
create index if not exists oauth_states_owner_idx on secure.oauth_states(owner_id);
