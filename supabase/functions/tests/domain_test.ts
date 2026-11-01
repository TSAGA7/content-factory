import { assert, assertEquals } from "./_assert.ts";
import { evaluatePublish, parseRules, validatePostForPlatform, zonedToUtc, localParts, nextAllowedTime, canAutoApprove, backoffMs, jaccard, programmaticChecks } from "../_shared/domain.ts";

Deno.test("zonedToUtc Moscow", () => {
  assertEquals(zonedToUtc(2026, 11, 1, 12, 0, "Europe/Moscow").toISOString(), "2026-11-01T09:00:00.000Z");
  const p = localParts(new Date("2026-11-01T21:30:00Z"), "Europe/Moscow");
  assertEquals([p.day, p.hour, p.minute, p.weekday], [2, 0, 30, 1]);
});

Deno.test("telegram validation limits", () => {
  assertEquals(validatePostForPlatform("telegram", { format: "text", body: "hi" }, []).length, 0);
  const long = validatePostForPlatform("telegram", { format: "photo", body: "x".repeat(1100) }, [{ id: "1", kind: "image", mime_type: "image/jpeg", size_bytes: 10 }]);
  assert(long.some((i) => i.field === "body"));
  assert(validatePostForPlatform("telegram", { format: "album", body: "" }, [{ id: "1", kind: "image", mime_type: "image/jpeg", size_bytes: 10 }]).some((i) => i.field === "media"));
  assert(validatePostForPlatform("telegram", { format: "reel", body: "a" }, []).some((i) => i.field === "format"));
  assert(validatePostForPlatform("instagram", { format: "photo", body: "a" }, [{ id: "1", kind: "image", mime_type: "image/png", size_bytes: 1 }]).length > 0);
});

Deno.test("rules: invalid → manual; windows & limits defer", () => {
  assertEquals(parseRules({ mode: "bogus" }).mode, "manual");
  const r = parseRules({ mode: "limited", timeWindows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: "10:00", to: "20:00" }], maxPerDay: 2, minIntervalMinutes: 60 });
  const night = new Date("2026-11-01T03:00:00Z"); // 06:00 MSK
  const d = evaluatePublish(r, { approved_by: "user" }, { now: night, tz: "Europe/Moscow", publishedToday: 0, publishedThisWeek: 0, lastPublishedAt: null });
  assert(!d.ok && d.retryAt?.toISOString() === "2026-11-01T07:00:00.000Z");
  const day = new Date("2026-11-01T09:00:00Z");
  const lim = evaluatePublish(r, { approved_by: "user" }, { now: day, tz: "Europe/Moscow", publishedToday: 2, publishedThisWeek: 2, lastPublishedAt: null });
  assert(!lim.ok && lim.retryAt!.toISOString() === "2026-11-02T07:00:00.000Z");
  const gap = evaluatePublish(r, { approved_by: "user" }, { now: day, tz: "Europe/Moscow", publishedToday: 1, publishedThisWeek: 1, lastPublishedAt: new Date(day.getTime() - 30 * 60000) });
  assert(!gap.ok && gap.retryAt!.getTime() === day.getTime() + 30 * 60000);
  const manual = evaluatePublish(parseRules({ mode: "approval" }), { approved_by: "autopilot" }, { now: day, tz: "Europe/Moscow", publishedToday: 0, publishedThisWeek: 0, lastPublishedAt: null });
  assert(!manual.ok && manual.retryAt === null);
  assert(!evaluatePublish(r, { approved_by: null }, { now: day, tz: "Europe/Moscow", publishedToday: 0, publishedThisWeek: 0, lastPublishedAt: null }).ok);
  assert(nextAllowedTime(parseRules({ blackoutDates: ["2026-11-01"] }), night, "Europe/Moscow")!.toISOString() >= "2026-11-01T21:00:00.000Z");
});

Deno.test("auto approve", () => {
  const r = parseRules({ mode: "limited", allowedFormats: ["text"], minQualityScore: 70 });
  assert(canAutoApprove(r, { format: "text", quality_passed: true, quality_score: 80 }));
  assert(!canAutoApprove(r, { format: "photo", quality_passed: true, quality_score: 80 }));
  assert(!canAutoApprove(r, { format: "text", quality_passed: false, quality_score: 80 }));
  assert(!canAutoApprove(parseRules({ mode: "approval", allowedFormats: ["text"] }), { format: "text", quality_passed: true, quality_score: 99 }));
});

Deno.test("backoff & similarity", () => {
  assertEquals(backoffMs(1, () => 0.5), 60000);
  assertEquals(backoffMs(3, () => 0.5), 240000);
  assert(jaccard("один два три четыре пять", "один два три четыре пять") === 1);
  assert(programmaticChecks("Купи крипту сейчас", { forbidden_phrases: ["крипт"] }, []).length === 1);
});
