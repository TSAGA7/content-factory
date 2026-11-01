import { assert, assertEquals } from "./_assert.ts";
import { telegramAdapter, type PublishCtx } from "../_shared/adapters.ts";
import { PublishError } from "../_shared/domain.ts";

function ctx(over: Partial<PublishCtx> = {}): PublishCtx & { saved: unknown[] } {
  const saved: unknown[] = [];
  return {
    jobId: "j1",
    post: { id: "p", format: "text", title: null, body: "Привет", hashtags: ["тест"], platform_options: {} },
    account: { id: "a", external_id: "-1001234567890", handle: "@chan", connection_status: "connected" },
    media: [], credentials: { bot_token: "1:x" }, checkpoint: {},
    saveCheckpoint: async (cp) => { saved.push(cp); },
    saved, ...over,
  } as PublishCtx & { saved: unknown[] };
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const orig = globalThis.fetch;
  globalThis.fetch = ((u: string | URL | Request, i?: RequestInit) => Promise.resolve(handler(String(u), i))) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

Deno.test("text publish → link, checkpoint before send", async () => {
  let body: Record<string, unknown> = {};
  const restore = mockFetch((u, i) => { body = JSON.parse(String(i?.body)); assert(u.endsWith("/sendMessage")); return Response.json({ ok: true, result: { message_id: 42 } }); });
  try {
    const c = ctx();
    const out = await telegramAdapter.publish(c);
    assertEquals(out, { kind: "published", externalId: "-1001234567890:42", url: "https://t.me/chan/42" });
    assertEquals(body.text, "Привет\n\n#тест");
    assertEquals(c.saved.length, 1);
  } finally { restore(); }
});

Deno.test("5xx after send → unknown_result; 429 → rate_limit; 403 → permission", async () => {
  for (const [resp, cat] of [[new Response("oops", { status: 502 }), "unknown_result"], [Response.json({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } }, { status: 429 }), "rate_limit"], [Response.json({ ok: false, error_code: 403, description: "Forbidden: bot is not a member of the channel chat" }, { status: 403 }), "permission"]] as const) {
    const restore = mockFetch(() => resp.clone());
    try {
      await telegramAdapter.publish(ctx());
      throw new Error("should fail");
    } catch (e) {
      assert(e instanceof PublishError, String(e));
      assertEquals(e.category, cat);
    } finally { restore(); }
  }
});

Deno.test("media download failure happens before send (safe retry)", async () => {
  const calls: string[] = [];
  const restore = mockFetch((u) => { calls.push(u); return new Response("no", { status: 404 }); });
  try {
    const c = ctx({ post: { id: "p", format: "photo", title: null, body: "", hashtags: [], platform_options: {} }, media: [{ id: "m", kind: "image", mime_type: "image/jpeg", size_bytes: 1, file_name: "a.jpg", signedUrl: "https://storage/a.jpg" }] });
    await telegramAdapter.publish(c).then(() => { throw new Error("should fail"); }, (e) => assertEquals((e as PublishError).category, "media"));
    assertEquals(c.saved.length, 0);
    assert(!calls.some((u) => u.includes("api.telegram.org")));
  } finally { restore(); }
});
