import nodeAssert from "node:assert/strict";
export function assert(cond: unknown, msg?: string): asserts cond { nodeAssert.ok(cond, msg); }
export function assertEquals<T>(a: T, b: T) { nodeAssert.deepStrictEqual(a, b); }
