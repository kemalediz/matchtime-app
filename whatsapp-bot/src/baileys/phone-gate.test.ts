/**
 * The pre-cutover phone gate, offline.
 *
 * Agreed with Kemal: the migration stops if Sutton's group does not return
 * a usable phone for effectively all 69 members who have one on record.
 * The measurement reads ONE `groupMetadata` and nothing else: no send, no
 * database write, no directory lookup, no mapping write. These tests pin
 * the arithmetic and the report, and drive the read against a fake socket.
 */
import { describe, it, expect } from "vitest";
import { FakeSocket } from "./fake-socket.js";
import {
  formatPhoneGateReport,
  maskPhone,
  parseKnownPhones,
  runPhoneGate,
  summarisePhoneGate,
} from "./phone-gate.js";

const GROUP = "120363000000000000@g.us";

const META = {
  id: GROUP,
  subject: "Sutton FC",
  addressingMode: "lid",
  participants: [
    { id: "158000000000001@lid", phoneNumber: "447700900001@s.whatsapp.net" }, // the bot
    { id: "158055467598020@lid", phoneNumber: "447700900123@s.whatsapp.net" },
    { id: "158055467598021@lid", phoneNumber: "447700900124@s.whatsapp.net" },
    { id: "447700900555@s.whatsapp.net", lid: "158077777777777@lid" },
    { id: "158099999999999@lid" }, // LID only
    { id: "158088888888888@lid" }, // LID only, but in the local store
  ],
};

describe("parseKnownPhones", () => {
  it("takes one phone per line, digits only, ignoring blanks, comments and short junk", () => {
    expect(parseKnownPhones("447700900123\n+44 7700 900124\n\n# Sutton\n12\n447700900555,Sam\n")).toEqual([
      "447700900123",
      "447700900124",
      "447700900555",
    ]);
  });

  it("dedupes", () => {
    expect(parseKnownPhones("447700900123\n447700900123")).toEqual(["447700900123"]);
  });
});

describe("summarisePhoneGate", () => {
  const summary = summarisePhoneGate(META, {
    selfJids: ["447700900001:12@s.whatsapp.net", "158000000000001:12@lid"],
    knownPhones: ["447700900123", "447700900124", "447700900555", "447700900999"],
    localPhones: new Map([["158088888888888@lid", "447700900888"]]),
  });

  it("excludes the bot itself and classifies everyone else once", () => {
    expect(summary).toMatchObject({
      participantsReturned: 6,
      selfExcluded: 1,
      counted: 5,
      phoneAddressed: 1,
      lidWithPhone: 2,
      lidOnlyLocal: 1,
      lidOnly: 1,
      usable: 4,
    });
  });

  it("matches the org's known phones against what WhatsApp returned", () => {
    expect(summary.knownSupplied).toBe(4);
    expect(summary.knownFound).toBe(3);
    expect(summary.knownMissing).toEqual(["447700900999"]);
    expect(summary.groupPhonesNotKnown).toBe(1);
  });

  it("does not count a phone that only the LOCAL store knew as returned by the group read", () => {
    // The gate is about the network path (§2.7 path 2). The local store is
    // reported on its own line so nobody mistakes one for the other.
    expect(summary.returnedPhones).toBe(3);
  });
});

describe("formatPhoneGateReport", () => {
  const summary = summarisePhoneGate(META, {
    selfJids: ["447700900001@s.whatsapp.net"],
    knownPhones: ["447700900123", "447700900999"],
    localPhones: new Map(),
  });
  const text = formatPhoneGateReport(summary);

  it("prints the fixed lines the gate is read from", () => {
    expect(text).toMatch(/^MatchTime phone gate: group 120363000000000000@g\.us "Sutton FC" \(addressing: lid\)$/m);
    expect(text).toMatch(/^participants returned: +6$/m);
    expect(text).toMatch(/^ {2}excluded \(this bot\): +1$/m);
    expect(text).toMatch(/^ {2}LID with phoneNumber: +2$/m);
    expect(text).toMatch(/^ {2}LID only, no phone: +2$/m);
    expect(text).toMatch(/^usable phone: +3 \/ 5 \(60\.0%\)$/m);
    expect(text).toMatch(/^known org phones supplied: +2$/m);
    expect(text).toMatch(/^ {2}found in the group: +1 \/ 2 \(50\.0%\)$/m);
    expect(text).toMatch(/^VERDICT: REVIEW \(1 known phone not found\)$/m);
  });

  it("masks phone numbers in the human lines", () => {
    expect(text).toContain(maskPhone("447700900999"));
    expect(text.split("\nRESULT ")[0]).not.toContain("447700900999");
    expect(maskPhone("447700900999")).toBe("4477*****999");
  });

  it("ends with one machine-readable RESULT line", () => {
    const last = text.trim().split("\n").at(-1) ?? "";
    expect(last.startsWith("RESULT ")).toBe(true);
    const parsed = JSON.parse(last.slice("RESULT ".length));
    expect(parsed).toMatchObject({ group: GROUP, counted: 5, usable: 3, knownFound: 1, verdict: "REVIEW" });
  });

  it("says PASS only when every known phone was found", () => {
    const pass = summarisePhoneGate(META, {
      selfJids: [],
      knownPhones: ["447700900123", "447700900555"],
      localPhones: new Map(),
    });
    expect(formatPhoneGateReport(pass)).toMatch(/^VERDICT: PASS \(all 2 known phones found\)$/m);
  });

  it("gives no verdict when no known phones were supplied", () => {
    const none = summarisePhoneGate(META, { selfJids: [], knownPhones: [], localPhones: new Map() });
    expect(formatPhoneGateReport(none)).toMatch(/^VERDICT: NONE \(no known phones supplied/m);
  });
});

describe("runPhoneGate against a fake socket", () => {
  it("makes exactly one group read and nothing else: no send, no mapping write", async () => {
    const sock = new FakeSocket();
    sock.groups[GROUP] = structuredClone(META) as never;
    sock.storedPnForLid.set("158088888888888@lid", "447700900888@s.whatsapp.net");
    const summary = await runPhoneGate(sock, { groupJid: GROUP, knownPhones: ["447700900123"] });
    expect(sock.metadataCalls).toEqual([GROUP]);
    expect(sock.fetchAllCalls).toBe(0);
    expect(sock.sent).toEqual([]);
    expect(sock.storedPairBatches).toEqual([]);
    expect(sock.loggedOut).toBe(0);
    // The local store is asked with the FULL LID JID, never the bare digits.
    expect(sock.pnLookups).toEqual(["158099999999999@lid", "158088888888888@lid"]);
    expect(summary).toMatchObject({ selfExcluded: 1, lidOnlyLocal: 1, knownFound: 1 });
  });

  it("lets a failed group read throw: a gate that cannot read the group must not report a pass", async () => {
    const sock = new FakeSocket();
    sock.groupError = new Error("forbidden");
    await expect(runPhoneGate(sock, { groupJid: GROUP, knownPhones: [] })).rejects.toThrow(/forbidden/);
  });
});
