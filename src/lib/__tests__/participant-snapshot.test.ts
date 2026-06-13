/**
 * Unit tests for the pure half of the shared participant-sync lib:
 * snapshot parsing (untrusted Json column → clean list) and phone
 * canonicalisation (bot-stripped "447…" JIDs → "+447…" E.164). The
 * DB upsert loop itself is covered by the e2e onboarding spec.
 */
import { describe, it, expect } from "vitest";
import {
  parseParticipantSnapshot,
  snapshotPhone,
} from "@/lib/participant-snapshot";

describe("snapshotPhone — JID-derived phone canonicalisation", () => {
  it('bot-stripped UK JID "447…" gains the "+"', () => {
    expect(snapshotPhone({ phone: "447700900001" })).toBe("+447700900001");
  });

  it("already-plussed numbers pass through normalisation", () => {
    expect(snapshotPhone({ phone: "+447700900001" })).toBe("+447700900001");
  });

  it("non-UK numbers keep their country code", () => {
    expect(snapshotPhone({ phone: "905551112233" })).toBe("+905551112233");
  });

  it("missing/junk phones → null (lurker stays lid-resolved later)", () => {
    expect(snapshotPhone({})).toBeNull();
    expect(snapshotPhone({ phone: null })).toBeNull();
    expect(snapshotPhone({ phone: "not-a-phone" })).toBeNull();
    expect(snapshotPhone({ lidId: "12345@lid", pushname: "Privacy Pete" })).toBeNull();
  });
});

describe("parseParticipantSnapshot — untrusted Json → clean roster input", () => {
  it("passes through a well-formed snapshot", () => {
    const raw = [
      { phone: "447700900001", pushname: "Ana" },
      { lidId: "999@lid", pushname: "Privacy Pete" },
      { phone: "447700900002" },
    ];
    const out = parseParticipantSnapshot(raw);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ phone: "447700900001", lidId: null, pushname: "Ana" });
    expect(out[1]).toEqual({ phone: null, lidId: "999@lid", pushname: "Privacy Pete" });
  });

  it("drops junk entries and empty objects", () => {
    const out = parseParticipantSnapshot([
      null,
      42,
      "nope",
      {},
      { phone: "  " },
      { phone: "447700900003" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].phone).toBe("447700900003");
  });

  it("non-arrays collapse to []", () => {
    expect(parseParticipantSnapshot(null)).toEqual([]);
    expect(parseParticipantSnapshot(undefined)).toEqual([]);
    expect(parseParticipantSnapshot({ phone: "447700900001" })).toEqual([]);
    expect(parseParticipantSnapshot("[]")).toEqual([]);
  });

  it("roster-extraction shape: phones resolvable vs lid-only split", () => {
    const out = parseParticipantSnapshot([
      { phone: "447700900001", pushname: "Ana" },
      { lidId: "999@lid", pushname: "Privacy Pete" },
    ]);
    const phones = out.map(snapshotPhone);
    expect(phones).toEqual(["+447700900001", null]);
  });
});
