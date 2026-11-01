// AES-256-GCM encryption for platform credentials. AAD binds ciphertext to the account id.
import { config, serviceClient } from "./edge.ts";

let keyPromise: Promise<CryptoKey> | null = null;
function key(): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = (async () => {
      const b64 = await config("CREDENTIALS_ENCRYPTION_KEY", "credentials_encryption_key");
      if (!b64) throw new Error("CREDENTIALS_ENCRYPTION_KEY is not configured");
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      if (raw.length !== 32) throw new Error("CREDENTIALS_ENCRYPTION_KEY must be 32 bytes (base64)");
      return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    })();
  }
  return keyPromise;
}

const aad = (accountId: string) => new TextEncoder().encode(`account:${accountId}`);

export async function encryptFor(accountId: string, data: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(accountId) }, await key(),
    new TextEncoder().encode(JSON.stringify(data))));
  const buf = new Uint8Array(iv.length + ct.length);
  buf.set(iv); buf.set(ct, iv.length);
  return btoa(String.fromCharCode(...buf));
}

export async function decryptFor<T>(accountId: string, b64: string): Promise<T> {
  const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12), additionalData: aad(accountId) }, await key(), buf.slice(12));
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

export async function saveCredentials(accountId: string, ownerId: string, data: unknown, expiresAt?: string | null) {
  const ct = await encryptFor(accountId, data);
  const { error } = await serviceClient().rpc("cred_put", { p_account: accountId, p_owner: ownerId, p_ciphertext: ct, p_expires: expiresAt ?? null });
  if (error) throw new Error(`cred_put: ${error.message}`);
}

export async function loadCredentials<T>(accountId: string): Promise<T | null> {
  const { data, error } = await serviceClient().rpc("cred_get", { p_account: accountId });
  if (error) throw new Error(`cred_get: ${error.message}`);
  const row = (data as { ciphertext: string }[] | null)?.[0];
  if (!row) return null;
  return decryptFor<T>(accountId, row.ciphertext);
}

export async function deleteCredentials(accountId: string) {
  await serviceClient().rpc("cred_delete", { p_account: accountId });
}
