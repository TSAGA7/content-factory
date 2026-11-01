# Развёртывание

Текущий production: Supabase-проект `gpnpqwyniqmdinwazegh` (eu-central-1), фронтенд — GitHub Pages.

## 1. База данных

Миграции в `supabase/migrations` уже применены. Для нового проекта:

```bash
supabase link --project-ref <ref>
supabase db push
```

Затем в SQL Editor создайте секреты Vault (значения — свои):

```sql
select vault.create_secret('https://<ref>.supabase.co', 'project_url');
select vault.create_secret('<openssl rand -hex 32>', 'worker_secret');
select vault.create_secret('<openssl rand -base64 32>', 'credentials_encryption_key');
```

> ⚠️ `credentials_encryption_key` нельзя менять после подключения аккаунтов — токены станут нечитаемыми.

`pg_cron` вызывает `public.invoke_worker('publish-worker')` каждую минуту и `maintenance` ежечасно.

## 2. Edge Function

```bash
supabase functions deploy cf --no-verify-jwt
```

Функция сама проверяет JWT пользователя (`requireUser`) или `x-worker-secret` (`requireWorker`).
Необязательные переменные: `ANTHROPIC_MODEL`, `ANTHROPIC_MAX_TOKENS`, `AI_PRICING_JSON` (цены за 1M токенов, например `{"claude-sonnet-5-5":{"input":3,"output":15}}`), `APP_ORIGINS`.

## 3. Фронтенд

GitHub → Settings → Pages → Source: **GitHub Actions**. Push в `main` запускает проверки и деплой.
Публичные значения Supabase лежат в `.env.production` (publishable key безопасен для браузера: доступ ограничен RLS).

Supabase → Authentication → URL Configuration: Site URL и Redirect URLs = адрес GitHub Pages.

## 4. Первый запуск

1. Откройте сайт, зарегистрируйтесь — первый пользователь становится владельцем, дальше регистрация закрыта.
2. Настройки → вставьте ключ Anthropic (`sk-ant-…`).
3. Бренды → создайте бренд. Аккаунты → «Подключить Telegram»: токен бота из @BotFather + @канал, бот — админ с правом публикации.
4. Создайте материал → «Утвердить» → «Запланировать». Обзор → карточка «Фоновый worker» должна показывать «Работает».

## Проверка worker'а вручную

```bash
curl -X POST https://<ref>.supabase.co/functions/v1/cf/publish-worker -H "x-worker-secret: <worker_secret>"
```
