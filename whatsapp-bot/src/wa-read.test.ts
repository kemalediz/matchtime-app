/**
 * RED-first spec for the shared "read a whatsapp-web.js object without
 * trusting it" layer.
 *
 * Every one of these cases is a shape the Pi actually saw (or could see)
 * while whatsapp-web.js's injected page code was out of step with the live
 * WhatsApp Web build: throwing getters, missing `_data`, a `body` that is
 * empty while `_data.body` carries the text, and so on. Before this module
 * the same three-line "safeRead" was copy-pasted into message-id.ts and
 * smart-analysis.ts and NOT used at all in index.ts — which is why the
 * `message` handler could still lose a message on a throwing `msg.type`.
 */
import { describe, it, expect } from "vitest";
import {
  safeRead,
  safePath,
  readMessageBody,
  readNotifyName,
  firstUsableName,
} from "./wa-read.js";

const booby = (props: Record<string, unknown>, throwing: string[] = []) => {
  const o: Record<string, unknown> = { ...props };
  for (const k of throwing) {
    Object.defineProperty(o, k, {
      get() {
        throw new Error("r");
      },
      enumerable: true,
    });
  }
  return o;
};

describe("safeRead", () => {
  it("reads a normal property", () => {
    expect(safeRead({ a: 1 }, "a")).toBe(1);
  });
  it("returns undefined for a throwing getter instead of throwing", () => {
    expect(safeRead(booby({}, ["a"]), "a")).toBeUndefined();
  });
  it("returns undefined for null / primitives", () => {
    expect(safeRead(null, "a")).toBeUndefined();
    expect(safeRead(undefined, "a")).toBeUndefined();
    expect(safeRead("str", "a")).toBeUndefined();
    expect(safeRead(7, "a")).toBeUndefined();
  });
});

describe("safePath", () => {
  it("walks a nested path", () => {
    expect(safePath({ a: { b: { c: 3 } } }, "a", "b", "c")).toBe(3);
  });
  it("stops at the first throwing getter without throwing", () => {
    expect(safePath({ a: booby({}, ["b"]) }, "a", "b", "c")).toBeUndefined();
  });
  it("returns undefined for a missing middle segment", () => {
    expect(safePath({ a: {} }, "a", "b", "c")).toBeUndefined();
  });
});

describe("readMessageBody", () => {
  it("prefers a non-empty msg.body", () => {
    expect(readMessageBody({ body: "in", _data: { body: "other" } })).toBe("in");
  });
  it("falls back to _data.body when body is empty (unsynced chats)", () => {
    expect(readMessageBody({ body: "", _data: { body: "im in" } })).toBe("im in");
  });
  it("falls back to _data.body when msg.body THROWS", () => {
    expect(readMessageBody(booby({ _data: { body: "im in" } }, ["body"]))).toBe("im in");
  });
  it("returns '' when everything is unreadable", () => {
    expect(readMessageBody(booby({}, ["body", "_data"]))).toBe("");
  });
  it("returns '' for null", () => {
    expect(readMessageBody(null)).toBe("");
  });
});

describe("readNotifyName", () => {
  it("reads the pushname WhatsApp puts on the raw payload", () => {
    expect(readNotifyName({ _data: { notifyName: "Kemal Ediz" } })).toBe("Kemal Ediz");
  });
  it("trims whitespace", () => {
    expect(readNotifyName({ _data: { notifyName: "  Baki  " } })).toBe("Baki");
  });
  it("returns null for a blank / missing / unreadable notifyName", () => {
    expect(readNotifyName({ _data: { notifyName: "   " } })).toBeNull();
    expect(readNotifyName({ _data: {} })).toBeNull();
    expect(readNotifyName(booby({}, ["_data"]))).toBeNull();
    expect(readNotifyName(null)).toBeNull();
  });
  it("does NOT go through the injected page code (plain _data read)", () => {
    // A Message whose every method throws still yields its notifyName —
    // this is exactly why notifyName is the right degraded-path identity.
    const msg = {
      _data: { notifyName: "Ibrahim" },
      getContact: () => {
        throw new Error("r");
      },
    };
    expect(readNotifyName(msg)).toBe("Ibrahim");
  });
});

describe("firstUsableName", () => {
  it("takes the first non-blank trimmed candidate", () => {
    expect(firstUsableName(null, "  ", "Kemal", "Other")).toBe("Kemal");
  });
  it("returns null when nothing is usable", () => {
    expect(firstUsableName(null, undefined, "", "   ")).toBeNull();
  });
  it("keeps a single-character name (the server decides what is too short)", () => {
    expect(firstUsableName("K")).toBe("K");
  });
});

// ─────────────────────────────────────────────────────────────────────
// The OUTERMOST layer: index.ts's `message` handler.
//
// Everything inside `enqueueForAnalysis` was made total by PR #11/#13, but
// the handler that CALLS it still read `msg.body`, `msg._data.body`,
// `msg.from`, `msg.type` and `msg.hasMedia` directly, several statements
// before the enqueue. On the broken build any one of those is a throwing
// getter, and a throw there lands in the handler's outer
// `catch { console.error("message handler failed") }` — which loses the
// message just as completely as the id guard did, only one frame earlier.
//
// So the handler reads its headline fields through ONE total helper.
// ─────────────────────────────────────────────────────────────────────
import { readInboundHeadline } from "./wa-read.js";

describe("readInboundHeadline", () => {
  it("reads a healthy message", () => {
    const h = readInboundHeadline({
      from: "120363@g.us",
      fromMe: false,
      type: "chat",
      body: "in",
      hasMedia: false,
      timestamp: 1_756_000_000,
      _data: { body: "in", notifyName: "Kemal" },
    });
    expect(h).toEqual({
      from: "120363@g.us",
      fromMe: false,
      type: "chat",
      body: "in",
      hasMedia: false,
      timestampSec: 1_756_000_000,
      notifyName: "Kemal",
    });
  });

  it("does not throw when EVERY field is a throwing getter", () => {
    const msg = booby({}, ["from", "fromMe", "type", "body", "hasMedia", "timestamp", "_data"]);
    expect(() => readInboundHeadline(msg)).not.toThrow();
    const h = readInboundHeadline(msg);
    expect(h.from).toBe("");
    expect(h.body).toBe("");
    expect(h.notifyName).toBeNull();
    // fromMe must default to FALSE: defaulting to true would make the
    // handler skip an inbound player message as if the bot had sent it.
    expect(h.fromMe).toBe(false);
    expect(h.hasMedia).toBe(false);
  });

  it("falls back to _data.body when msg.body is empty", () => {
    const h = readInboundHeadline({ body: "", _data: { body: "im in" } });
    expect(h.body).toBe("im in");
  });

  it("falls back to _data.body when msg.body throws", () => {
    const msg = booby({ _data: { body: "im in" } }, ["body"]);
    expect(readInboundHeadline(msg).body).toBe("im in");
  });

  it("defaults the timestamp to now rather than 0 when unreadable", () => {
    const nowSec = Date.now() / 1000;
    const h = readInboundHeadline(booby({}, ["timestamp"]));
    expect(h.timestampSec).toBeGreaterThan(nowSec - 5);
  });

  it("coerces a non-string type to a string so callers can compare it", () => {
    expect(readInboundHeadline({ type: 7 }).type).toBe("");
    expect(readInboundHeadline({ type: "ptt" }).type).toBe("ptt");
  });

  it("treats a truthy-but-not-true hasMedia as false", () => {
    // whatsapp-web.js types it as boolean; only an exact `true` should make
    // the handler take the media branch.
    expect(readInboundHeadline({ hasMedia: 1 }).hasMedia).toBe(false);
    expect(readInboundHeadline({ hasMedia: true }).hasMedia).toBe(true);
  });

  it("survives being handed null / a primitive", () => {
    expect(() => readInboundHeadline(null)).not.toThrow();
    expect(readInboundHeadline(null).from).toBe("");
    expect(readInboundHeadline("nope").body).toBe("");
  });
});
