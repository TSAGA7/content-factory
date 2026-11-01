import { assert, assertEquals } from "./_assert.ts";
Deno.env.set("SUPABASE_URL", "http://x"); Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "x"); Deno.env.set("SUPABASE_ANON_KEY", "x");
const { redact } = await import("../_shared/edge.ts");
Deno.test("redact secrets", () => {
  const s = redact("call https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ/sendMessage failed, key sk-ant-api03-abcdefghijklmnop");
  assert(!s.includes("AAHdq") && !s.includes("sk-ant-api03-abc"));
  assertEquals(redact({ bot_token: "x", nested: { Authorization: "Bearer y", ok: "fine" } }), { bot_token: "[redacted]", nested: { Authorization: "[redacted]", ok: "fine" } });
});
