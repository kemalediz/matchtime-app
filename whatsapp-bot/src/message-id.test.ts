/**
 * Tests for inbound WhatsApp message-id resolution.
 *
 * Regression cover for the 2026-08-30 outage: `enqueueForAnalysis` did
 * `if (!waMessageId) return;`, so once whatsapp-web.js's injected page code
 * fell out of step with the live WhatsApp Web build and inbound Message
 * objects stopped exposing a readable `id._serialized`, EVERY inbound group
 * message was silently dropped before it was buffered. Nothing reached
 * /api/whatsapp/analyze for days and no attendance was recorded.
 */
import { describe, it, expect } from "vitest";
import {
  SYNTHETIC_WA_ID_PREFIX,
  isSyntheticWaMessageId,
  missingMessageIdMessage,
  resolveWaMessageId,
  shouldLogSyntheticId,
  synthesizeWaMessageId,
} from "./message-id.js";

const baseMsg = {
  from: "120363000000000001@g.us",
  author: "447700900001@c.us",
  timestamp: 1_756_000_000,
  body: "im in",
  _data: { body: "im in" },
};

describe("resolveWaMessageId — happy path", () => {
  it("returns the real id unchanged and does NOT synthesise", () => {
    const r = resolveWaMessageId({ ...baseMsg, id: { _serialized: "false_1203@g.us_ABC" } });
    expect(r).toEqual({
      waMessageId: "false_1203@g.us_ABC",
      synthetic: false,
      source: "serialized",
    });
    expect(isSyntheticWaMessageId(r.waMessageId)).toBe(false);
  });
});

describe("resolveWaMessageId — degraded paths never drop the message", () => {
  it("synthesises when `id` is undefined", () => {
    const r = resolveWaMessageId({ ...baseMsg });
    expect(r.synthetic).toBe(true);
    expect(r.waMessageId.startsWith(SYNTHETIC_WA_ID_PREFIX)).toBe(true);
    expect(isSyntheticWaMessageId(r.waMessageId)).toBe(true);
  });

  it("synthesises when `id._serialized` is missing or empty", () => {
    expect(resolveWaMessageId({ ...baseMsg, id: {} }).synthetic).toBe(true);
    expect(resolveWaMessageId({ ...baseMsg, id: { _serialized: "" } }).synthetic).toBe(true);
    expect(resolveWaMessageId({ ...baseMsg, id: { _serialized: 42 } }).synthetic).toBe(true);
    expect(resolveWaMessageId({ ...baseMsg, id: null }).synthetic).toBe(true);
  });

  it("does not throw when `id` is a throwing getter (the live `r: r` failure)", () => {
    const msg = {
      ...baseMsg,
      get id(): never {
        throw new Error("r");
      },
    };
    let r: ReturnType<typeof resolveWaMessageId> | undefined;
    expect(() => {
      r = resolveWaMessageId(msg);
    }).not.toThrow();
    expect(r!.synthetic).toBe(true);
    expect(r!.waMessageId.startsWith(SYNTHETIC_WA_ID_PREFIX)).toBe(true);
  });

  it("does not throw when `_serialized` itself is a throwing getter", () => {
    const msg = {
      ...baseMsg,
      id: {
        get _serialized(): never {
          throw new Error("r");
        },
      },
    };
    expect(resolveWaMessageId(msg).synthetic).toBe(true);
  });

  it("survives every field being a throwing getter", () => {
    const boom = {
      get from(): never {
        throw new Error("r");
      },
      get author(): never {
        throw new Error("r");
      },
      get timestamp(): never {
        throw new Error("r");
      },
      get body(): never {
        throw new Error("r");
      },
      get id(): never {
        throw new Error("r");
      },
      get _data(): never {
        throw new Error("r");
      },
    };
    const r = resolveWaMessageId(boom);
    expect(r.synthetic).toBe(true);
    expect(r.waMessageId.startsWith(SYNTHETIC_WA_ID_PREFIX)).toBe(true);
  });

  it("handles non-objects without throwing", () => {
    for (const junk of [undefined, null, 0, "", "str", true]) {
      const r = resolveWaMessageId(junk);
      expect(r.synthetic).toBe(true);
      expect(r.waMessageId.length).toBeGreaterThan(SYNTHETIC_WA_ID_PREFIX.length);
    }
  });
});

describe("synthetic ids are DETERMINISTIC (the correctness property)", () => {
  // The server dedupes on AnalyzedMessage.waMessageId (unique). An unstable
  // id would make recoverGroupMessages' 2h re-feed look like brand-new
  // messages and register attendance twice.
  it("the same message shape twice yields the same id", () => {
    const a = resolveWaMessageId({ ...baseMsg });
    const b = resolveWaMessageId({ ...baseMsg });
    expect(a.waMessageId).toBe(b.waMessageId);
  });

  it("is stable across calls separated in time (no Date.now / counter / randomness)", async () => {
    const a = resolveWaMessageId({ ...baseMsg });
    await new Promise((res) => setTimeout(res, 25));
    const b = resolveWaMessageId({ ...baseMsg });
    expect(a.waMessageId).toBe(b.waMessageId);
  });

  it("is stable when the body only reachable via _data.body", () => {
    const viaBody = resolveWaMessageId({ ...baseMsg, body: "", _data: { body: "im in" } });
    const viaBody2 = resolveWaMessageId({ ...baseMsg, body: "", _data: { body: "im in" } });
    expect(viaBody.waMessageId).toBe(viaBody2.waMessageId);
  });

  it("synthesizeWaMessageId is a pure function of its parts", () => {
    const parts = { from: "g@g.us", author: "a@c.us", timestamp: 100, body: "hi" };
    expect(synthesizeWaMessageId(parts)).toBe(synthesizeWaMessageId({ ...parts }));
  });
});

describe("synthetic ids are DISTINCT for different messages", () => {
  const id = (o: Record<string, unknown>) => resolveWaMessageId({ ...baseMsg, ...o }).waMessageId;
  const ref = id({});

  it("differs by author", () => {
    expect(id({ author: "447700900002@c.us" })).not.toBe(ref);
  });
  it("differs by timestamp", () => {
    expect(id({ timestamp: 1_756_000_001 })).not.toBe(ref);
  });
  it("differs by body", () => {
    expect(id({ body: "out", _data: { body: "out" } })).not.toBe(ref);
  });
  it("differs by group", () => {
    expect(id({ from: "120363000000000002@g.us" })).not.toBe(ref);
  });
  it("does not collide across a fan of realistic messages", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      ids.add(
        synthesizeWaMessageId({
          from: `120363${i % 7}@g.us`,
          author: `4477009000${i % 13}@c.us`,
          timestamp: 1_756_000_000 + (i % 11),
          body: `msg ${i}`,
        }),
      );
    }
    expect(ids.size).toBe(200);
  });
});

describe("synthetic id format", () => {
  it("is clearly prefixed so it is obvious in the DB and logs", () => {
    expect(SYNTHETIC_WA_ID_PREFIX).toBe("synthetic:");
    const wa = resolveWaMessageId({ ...baseMsg }).waMessageId;
    expect(wa).toMatch(/^synthetic:[0-9a-f]{16}$/);
  });

  it("never returns an empty id (the server 400s on empty waMessageId)", () => {
    expect(resolveWaMessageId(undefined).waMessageId.length).toBeGreaterThan(10);
  });

  it("isSyntheticWaMessageId rejects real WhatsApp ids", () => {
    expect(isSyntheticWaMessageId("false_1203@g.us_ABC")).toBe(false);
    expect(isSyntheticWaMessageId("")).toBe(false);
  });
});

describe("log rate limiting", () => {
  it("logs the FIRST occurrence loudly", () => {
    expect(shouldLogSyntheticId(1)).toBe(true);
  });

  it("does not log every message (that would spam the log)", () => {
    const logged = [];
    for (let n = 1; n <= 500; n++) if (shouldLogSyntheticId(n)) logged.push(n);
    expect(logged.length).toBeLessThan(10);
    expect(logged[0]).toBe(1);
  });

  it("keeps logging occasionally at high volume so it can't go quiet forever", () => {
    const logged = [];
    for (let n = 1; n <= 5000; n++) if (shouldLogSyntheticId(n)) logged.push(n);
    expect(logged.length).toBeGreaterThan(3);
    expect(logged[logged.length - 1]).toBeGreaterThan(1000);
  });

  it("never logs for a non-positive count", () => {
    expect(shouldLogSyntheticId(0)).toBe(false);
    expect(shouldLogSyntheticId(-1)).toBe(false);
  });
});

describe("missingMessageIdMessage", () => {
  it("is CRITICAL-prefixed and names the likely cause", () => {
    const m = missingMessageIdMessage(1, "synthetic:abc");
    expect(m.startsWith("CRITICAL:")).toBe(true);
    expect(m).toContain("injected");
    expect(m).toContain("synthetic:abc");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Reconstructing a REAL id when `id._serialized` is gone but the parts
// that compose it are still there (added 2026-08-30 hardening audit).
//
// Why this matters more than the synthetic fallback: a synthetic id keeps
// attendance working but permanently loses reaction tracking, because
// `message_reaction` events carry the REAL WhatsApp id and nothing can be
// joined to `synthetic:…`. If the id's component parts survive on the
// object (they are plain data on `_data`, not injected-code calls), we can
// rebuild the exact string WhatsApp itself uses and keep reactions alive.
//
// WhatsApp's own MsgKey serialisation is
//   `${fromMe}_${remote}_${id}`                       (1:1 chats)
//   `${fromMe}_${remote}_${id}_${participant}`        (group chats)
// ─────────────────────────────────────────────────────────────────────
describe("resolveWaMessageId — real-id recovery before synthesising", () => {
  it("uses `id` directly when the library hands back the serialized STRING", () => {
    // Observed shape: getMessageModel's serialize() no longer nests the key,
    // so `msg.id` is the "false_…@g.us_ABC_…@lid" string itself.
    const r = resolveWaMessageId({ id: "false_1203@g.us_ABCDEF_99@lid" });
    expect(r.waMessageId).toBe("false_1203@g.us_ABCDEF_99@lid");
    expect(r.synthetic).toBe(false);
    expect(r.source).toBe("serialized");
  });

  it("reconstructs a group id from fromMe/remote/id/participant", () => {
    const r = resolveWaMessageId({
      id: { fromMe: false, remote: "120363000@g.us", id: "3EB0ABC", participant: "99@lid" },
    });
    expect(r.waMessageId).toBe("false_120363000@g.us_3EB0ABC_99@lid");
    expect(r.synthetic).toBe(false);
    expect(r.source).toBe("reconstructed");
  });

  it("reconstructs a 1:1 id (no participant segment)", () => {
    const r = resolveWaMessageId({
      id: { fromMe: true, remote: "447700900123@c.us", id: "3EB0XYZ" },
    });
    expect(r.waMessageId).toBe("true_447700900123@c.us_3EB0XYZ");
    expect(r.source).toBe("reconstructed");
  });

  it("handles a `remote` that is itself an object carrying _serialized", () => {
    const r = resolveWaMessageId({
      id: {
        fromMe: false,
        remote: { _serialized: "120363000@g.us" },
        id: "3EB0ABC",
        participant: { _serialized: "99@lid" },
      },
    });
    expect(r.waMessageId).toBe("false_120363000@g.us_3EB0ABC_99@lid");
    expect(r.source).toBe("reconstructed");
  });

  it("falls back to _data.id when msg.id is unreadable", () => {
    const msg: Record<string, unknown> = { _data: { id: "false_1203@g.us_ZZZ" } };
    Object.defineProperty(msg, "id", {
      get() {
        throw new Error("r");
      },
      enumerable: true,
    });
    const r = resolveWaMessageId(msg);
    expect(r.waMessageId).toBe("false_1203@g.us_ZZZ");
    expect(r.source).toBe("serialized");
  });

  it("prefers the true _serialized over reconstruction when both are present", () => {
    const r = resolveWaMessageId({
      id: { _serialized: "REAL", fromMe: false, remote: "g@g.us", id: "X" },
    });
    expect(r.waMessageId).toBe("REAL");
    expect(r.source).toBe("serialized");
  });

  it("refuses to reconstruct from partial parts (no remote) and synthesises instead", () => {
    const r = resolveWaMessageId({
      id: { fromMe: false, id: "3EB0ABC" },
      from: "g@g.us",
      author: "99@lid",
      timestamp: 1,
      body: "in",
    });
    expect(r.synthetic).toBe(true);
    expect(r.source).toBe("synthetic");
    expect(r.waMessageId.startsWith("synthetic:")).toBe(true);
  });

  it("still synthesises — deterministically — when nothing is readable", () => {
    const a = resolveWaMessageId({ from: "g@g.us", author: "99@lid", timestamp: 5, body: "in" });
    const b = resolveWaMessageId({ from: "g@g.us", author: "99@lid", timestamp: 5, body: "in" });
    expect(a.source).toBe("synthetic");
    expect(a.waMessageId).toBe(b.waMessageId);
  });

  it("never throws on a reconstruction path booby-trapped with throwing getters", () => {
    const id: Record<string, unknown> = { fromMe: false, id: "X" };
    Object.defineProperty(id, "remote", {
      get() {
        throw new Error("r");
      },
      enumerable: true,
    });
    expect(() => resolveWaMessageId({ id })).not.toThrow();
    expect(resolveWaMessageId({ id }).source).toBe("synthetic");
  });
});
