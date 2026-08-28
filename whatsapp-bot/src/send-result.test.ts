import { describe, it, expect } from "vitest";
import {
  waMessageIdFrom,
  isMissingSendResult,
  missingSendResultMessage,
} from "./send-result.js";

describe("waMessageIdFrom", () => {
  it("returns the serialized id for a normal send result", () => {
    expect(waMessageIdFrom({ id: { _serialized: "true_123@g.us_ABC" } })).toBe(
      "true_123@g.us_ABC",
    );
  });

  it("returns undefined — and does NOT throw — when sendMessage resolved to undefined", () => {
    // This is the prod breakage: whatsapp-web.js Client.sendMessage returns
    // `undefined` when its injected page code can't build a Message model,
    // even though the message itself was delivered. `msg.id?._serialized`
    // threw a TypeError here, which aborted the ACK.
    expect(() => waMessageIdFrom(undefined)).not.toThrow();
    expect(waMessageIdFrom(undefined)).toBeUndefined();
  });

  it("returns undefined for null (the channel/status early-return path)", () => {
    expect(waMessageIdFrom(null)).toBeUndefined();
  });

  it("returns undefined when the result has no id", () => {
    expect(waMessageIdFrom({})).toBeUndefined();
    expect(waMessageIdFrom({ id: null })).toBeUndefined();
    expect(waMessageIdFrom({ id: undefined })).toBeUndefined();
  });

  it("returns undefined when _serialized is missing, empty or not a string", () => {
    expect(waMessageIdFrom({ id: {} })).toBeUndefined();
    expect(waMessageIdFrom({ id: { _serialized: "" } })).toBeUndefined();
    expect(waMessageIdFrom({ id: { _serialized: 12345 } })).toBeUndefined();
    expect(waMessageIdFrom({ id: { _serialized: null } })).toBeUndefined();
  });

  it("never throws on hostile shapes (throwing getters, primitives)", () => {
    const hostile = {
      get id(): never {
        throw new Error("boom");
      },
    };
    expect(() => waMessageIdFrom(hostile)).not.toThrow();
    expect(waMessageIdFrom(hostile)).toBeUndefined();
    expect(waMessageIdFrom("string")).toBeUndefined();
    expect(waMessageIdFrom(0)).toBeUndefined();
    expect(waMessageIdFrom(false)).toBeUndefined();
  });
});

describe("isMissingSendResult", () => {
  it("is true only when the library handed back nothing at all", () => {
    expect(isMissingSendResult(undefined)).toBe(true);
    expect(isMissingSendResult(null)).toBe(true);
    expect(isMissingSendResult({ id: { _serialized: "x" } })).toBe(false);
    // A Message object with an unusable id is still a Message — the send
    // demonstrably produced a model, so it isn't the "returned nothing" case.
    expect(isMissingSendResult({})).toBe(false);
  });
});

describe("missingSendResultMessage", () => {
  it("names the instruction and warns loudly", () => {
    const line = missingSendResultMessage("group-message", "botjob-42:announce-match");
    expect(line).toContain("CRITICAL");
    expect(line).toContain("sendMessage returned undefined");
    expect(line).toContain("botjob-42:announce-match");
    expect(line).toContain("group-message");
    expect(line.toLowerCase()).toContain("may have been delivered");
  });
});
