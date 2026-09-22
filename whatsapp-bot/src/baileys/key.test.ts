/**
 * serializeKey / parseKey: the one piece of the Baileys migration that has
 * to be right on the first day, because it is what keeps every
 * `waMessageId` already in the production database valid after cutover.
 *
 * `SentNotification.waMessageId`, `BenchSlotOffer.waMessageId` and
 * `AnalyzedMessage.waMessageId` all hold whatsapp-web.js strings, and the
 * server joins on them by EXACT string match (`reaction/route.ts`). A
 * serialiser that is off by one character is a reaction join that silently
 * never matches, with no error anywhere. Plan §2.5.
 *
 * The samples below marked "repo" are copied from real ids quoted in this
 * repo's own MDs and tests, so the format is the one production wrote, not
 * the one we remember.
 */
import { describe, it, expect } from "vitest";
import { jidNormalizedUser } from "baileys";
import { legacyJid, parseKey, serializeKey, type ParsedKey } from "./key.js";

describe("serializeKey: the whatsapp-web.js string, from a Baileys key", () => {
  it("writes a DM key as fromMe_remote_id, with the person in @c.us form", () => {
    expect(
      serializeKey({ remoteJid: "447700900123@s.whatsapp.net", fromMe: false, id: "3EB0ABC" }),
    ).toBe("false_447700900123@c.us_3EB0ABC");
  });

  it("writes a group key with the participant as a fourth part", () => {
    expect(
      serializeKey({
        remoteJid: "120363000000000000@g.us",
        fromMe: false,
        id: "3EB0ABC",
        participant: "447700900123@s.whatsapp.net",
      }),
    ).toBe("false_120363000000000000@g.us_3EB0ABC_447700900123@c.us");
  });

  it("keeps a @lid participant as @lid: there is no phone to convert it to", () => {
    expect(
      serializeKey({
        remoteJid: "120363000@g.us",
        fromMe: false,
        id: "3EB0ABC",
        participant: "99@lid",
      }),
    ).toBe("false_120363000@g.us_3EB0ABC_99@lid");
  });

  it("writes our own DM as true_", () => {
    expect(
      serializeKey({ remoteJid: "447700900009@s.whatsapp.net", fromMe: true, id: "3EB0ABC" }),
    ).toBe("true_447700900009@c.us_3EB0ABC");
  });

  it("treats a missing or null fromMe as false, as protobuf does", () => {
    expect(serializeKey({ remoteJid: "447700900123@s.whatsapp.net", id: "X1" })).toBe(
      "false_447700900123@c.us_X1",
    );
    expect(
      serializeKey({ remoteJid: "447700900123@s.whatsapp.net", fromMe: null, id: "X1" }),
    ).toBe("false_447700900123@c.us_X1");
  });

  it("drops a device suffix: a message id names a user, never one of their devices", () => {
    // whatsapp-web.js never wrote a device into a message id. Baileys
    // normalises keys before emitting them, but a suffix that slipped
    // through would otherwise be a different string for the same message.
    expect(
      serializeKey({
        remoteJid: "120363000@g.us",
        fromMe: false,
        id: "ID1",
        participant: "447700900123:12@s.whatsapp.net",
      }),
    ).toBe("false_120363000@g.us_ID1_447700900123@c.us");
  });

  it("ignores the Alt fields: the id is keyed on the primary addressing, as it always was", () => {
    expect(
      serializeKey({
        remoteJid: "120363000@g.us",
        fromMe: false,
        id: "ID1",
        participant: "99@lid",
        participantAlt: "447700900123@s.whatsapp.net",
      } as Parameters<typeof serializeKey>[0]),
    ).toBe("false_120363000@g.us_ID1_99@lid");
  });

  it("leaves hosted and hosted.lid servers as they are", () => {
    expect(serializeKey({ remoteJid: "12345@hosted", fromMe: false, id: "A" })).toBe(
      "false_12345@hosted_A",
    );
    expect(
      serializeKey({ remoteJid: "120363@g.us", fromMe: false, id: "A", participant: "7@hosted.lid" }),
    ).toBe("false_120363@g.us_A_7@hosted.lid");
  });

  it("refuses a key with no remoteJid or no id, rather than writing a partial id", () => {
    // Same rule message-id.ts follows: a wrong id is worse than none,
    // because the server dedupes and joins on it.
    expect(serializeKey({ fromMe: false, id: "A" })).toBeNull();
    expect(serializeKey({ remoteJid: "447700900123@s.whatsapp.net", fromMe: false })).toBeNull();
    expect(serializeKey({ remoteJid: "447700900123@s.whatsapp.net", id: "" })).toBeNull();
    expect(serializeKey({ remoteJid: "not-a-jid", id: "A" })).toBeNull();
    expect(serializeKey(null)).toBeNull();
    expect(serializeKey(undefined)).toBeNull();
  });

  it("refuses an id containing '@', the one id that could not be read back unambiguously", () => {
    // `false_X@c.us_AB_C@lid` would parse as id AB with participant C@lid.
    // WhatsApp ids are hex or alphanumeric and never carry '@', so this
    // costs nothing real, and refusing it keeps the mapping a bijection.
    expect(serializeKey({ remoteJid: "447700900123@s.whatsapp.net", id: "AB_C@lid" })).toBeNull();
  });
});

describe("parseKey: a Baileys key, from a stored whatsapp-web.js string", () => {
  it("reads the ids production actually wrote (repo samples)", () => {
    const cases: Array<[string, ParsedKey]> = [
      [
        // MDs/emoji-reactions-silent-no-op-2026-08-31.md, a real group message.
        "false_447525334985-1607872139@g.us_3B0B7E9",
        { remoteJid: "447525334985-1607872139@g.us", fromMe: false, id: "3B0B7E9" },
      ],
      [
        "false_447525334985-1607872139@g.us_ACD62BCA47B2B0B1",
        { remoteJid: "447525334985-1607872139@g.us", fromMe: false, id: "ACD62BCA47B2B0B1" },
      ],
      [
        // message-id.test.ts, a LID-addressed group member.
        "false_120363000@g.us_3EB0ABC_99@lid",
        { remoteJid: "120363000@g.us", fromMe: false, id: "3EB0ABC", participant: "99@lid" },
      ],
      [
        // e2e/api/recruit-reaction.spec.ts, the bot's own DM.
        "true_447700900009@c.us_3EB0ABC",
        { remoteJid: "447700900009@s.whatsapp.net", fromMe: true, id: "3EB0ABC" },
      ],
      [
        // What whatsapp-web.js 1.34.7 writes for a group post by the bot:
        // participant is our own JID (Injected/Utils.js sendMessage).
        "true_120363000@g.us_3EB0FF_447700900001@c.us",
        {
          remoteJid: "120363000@g.us",
          fromMe: true,
          id: "3EB0FF",
          participant: "447700900001@s.whatsapp.net",
        },
      ],
    ];
    for (const [s, key] of cases) {
      expect(parseKey(s), s).toEqual(key);
    }
  });

  it("hands back a key Baileys' own normaliser leaves unchanged", () => {
    // If jidNormalizedUser would rewrite what we produce, the key we pass
    // to sendMessage({ react }) is not the key WhatsApp knows.
    const k = parseKey("false_120363000@g.us_3EB0ABC_447700900123@c.us")!;
    expect(jidNormalizedUser(k.remoteJid)).toBe(k.remoteJid);
    expect(jidNormalizedUser(k.participant!)).toBe(k.participant);
    const lid = parseKey("false_120363000@g.us_3EB0ABC_99@lid")!;
    expect(jidNormalizedUser(lid.participant!)).toBe(lid.participant);
  });

  it("reads a trailing underscore as part of the id, since that is what serializeKey wrote", () => {
    expect(parseKey("true_123@g.us_ID_")).toEqual({ remoteJid: "123@g.us", fromMe: true, id: "ID_" });
  });

  it("reads an id that contains underscores, with and without a participant", () => {
    expect(parseKey("false_447700900123@c.us_AB_CD")).toEqual({
      remoteJid: "447700900123@s.whatsapp.net",
      fromMe: false,
      id: "AB_CD",
    });
    expect(parseKey("false_120363000@g.us_AB_CD_99@lid")).toEqual({
      remoteJid: "120363000@g.us",
      fromMe: false,
      id: "AB_CD",
      participant: "99@lid",
    });
  });

  it("refuses anything that is not a whatsapp-web.js key string", () => {
    for (const bad of [
      "",
      "synthetic:0123456789abcdef", // ours, never WhatsApp's (message-id.ts)
      "garbage",
      "maybe_447700900123@c.us_ID",
      "true_123@g.us_", // no id
      "true_123@g.us", // no id at all
      "true__ID", // no remote
      "true_123_ID", // remote is not a JID
      "true_447700900123:3@c.us_ID", // device in a stored id: never written
      "true_447700900123@s.whatsapp.net_ID", // never written: stored ids use @c.us
      "true_123@g.us_ID_notajid@", // participant with no server
    ]) {
      expect(parseKey(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseKey(undefined)).toBeNull();
    expect(parseKey(null)).toBeNull();
    expect(parseKey(42)).toBeNull();
  });
});

// ─── Round trips ────────────────────────────────────────────────────

/** A small seeded PRNG, so a failure is reproducible from the seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)];
}

function digits(r: () => number, min: number, max: number): string {
  const n = min + Math.floor(r() * (max - min + 1));
  let out = String(1 + Math.floor(r() * 9));
  while (out.length < n) out += String(Math.floor(r() * 10));
  return out;
}

/** WhatsApp ids are hex or alphanumeric. Underscores are thrown in to prove we cope. */
function messageId(r: () => number): string {
  const alphabet = "0123456789ABCDEF3EB0abcdefXYZ_";
  const n = 4 + Math.floor(r() * 28);
  let out = "";
  for (let i = 0; i < n; i++) out += pick(r, alphabet.split(""));
  return out;
}

function personJid(r: () => number): string {
  return pick(r, [
    () => `${digits(r, 10, 13)}@s.whatsapp.net`,
    () => `${digits(r, 13, 15)}@lid`,
    () => `${digits(r, 5, 8)}@hosted`,
    () => `${digits(r, 5, 8)}@hosted.lid`,
  ])();
}

function groupJid(r: () => number): string {
  return pick(r, [
    () => `120363${digits(r, 12, 12)}@g.us`,
    () => `${digits(r, 12, 12)}-${digits(r, 10, 10)}@g.us`, // the old creator-timestamp form
  ])();
}

function randomKey(r: () => number): ParsedKey {
  const inGroup = r() < 0.6;
  const key: ParsedKey = {
    remoteJid: inGroup ? groupJid(r) : personJid(r),
    fromMe: r() < 0.5,
    id: messageId(r),
  };
  // A group key may or may not carry a participant: Baileys' own sent
  // keys do not, inbound ones do.
  if (inGroup && r() < 0.8) key.participant = personJid(r);
  return key;
}

describe("round trips", () => {
  it("parseKey(serializeKey(key)) gives the key back, for 5000 generated keys", () => {
    const r = rng(20260922);
    for (let i = 0; i < 5000; i++) {
      const key = randomKey(r);
      const s = serializeKey(key);
      expect(s, JSON.stringify(key)).not.toBeNull();
      expect(parseKey(s!), s!).toEqual(key);
    }
  });

  it("serializeKey(parseKey(s)) gives the string back byte for byte, for 5000 generated strings", () => {
    const r = rng(7);
    for (let i = 0; i < 5000; i++) {
      const s = serializeKey(randomKey(r))!;
      const k = parseKey(s);
      expect(k, s).not.toBeNull();
      expect(serializeKey(k), s).toBe(s);
    }
  });

  it("round-trips every repo sample byte for byte", () => {
    for (const s of [
      "false_447525334985-1607872139@g.us_3B0B7E9",
      "false_447525334985-1607872139@g.us_ACD62BCA47B2B0B1",
      "false_120363000@g.us_3EB0ABC_99@lid",
      "false_1203@g.us_ABCDEF_99@lid",
      "true_447700900009@c.us_3EB0ABC",
      "true_447700900003@c.us_SOMETHINGELSE",
      "true_123@g.us_ABC",
      "false_1203@g.us_ZZZ",
      "true_120363000@g.us_3EB0FF_447700900001@c.us",
    ]) {
      expect(serializeKey(parseKey(s)), s).toBe(s);
    }
  });
});

describe("where the mapping is NOT a round trip, named rather than hidden", () => {
  it("a device suffix does not survive: it is dropped on the way out", () => {
    const withDevice = {
      remoteJid: "120363000@g.us",
      fromMe: false,
      id: "ID",
      participant: "447700900123:7@s.whatsapp.net",
    };
    expect(parseKey(serializeKey(withDevice))).toEqual({
      ...withDevice,
      participant: "447700900123@s.whatsapp.net",
    });
  });

  it("the same person as a phone and as a LID are two different ids, and no pure function can join them", () => {
    // This is the §2.5 partial break. A message whatsapp-web.js stored with
    // a phone participant, whose reaction Baileys delivers with a LID
    // participant (or the reverse), will not match by string. Resolving it
    // needs the LID-to-phone mapping, which is state, not syntax: the
    // inbound side (Phase 4) has to canonicalise before it serialises.
    const asPhone = serializeKey({
      remoteJid: "120363000@g.us",
      id: "ID",
      participant: "447700900123@s.whatsapp.net",
    });
    const asLid = serializeKey({ remoteJid: "120363000@g.us", id: "ID", participant: "99@lid" });
    expect(asPhone).not.toBe(asLid);
  });
});

describe("legacyJid: one JID in the spelling everything above the seam compares", () => {
  // The inbound view, the identity members and the reaction payload all
  // hand JIDs up to code written against whatsapp-web.js, which compares
  // them as strings (`.endsWith("@c.us")`, `mentionedIds.includes(selfId)`).
  // They must use the SAME rule the stored ids use, so it is this one.
  it("spells a person @c.us and drops the device suffix", () => {
    expect(legacyJid("447700900123@s.whatsapp.net")).toBe("447700900123@c.us");
    expect(legacyJid("447700900123:12@s.whatsapp.net")).toBe("447700900123@c.us");
    expect(legacyJid("447700900123@c.us")).toBe("447700900123@c.us");
  });

  it("leaves LIDs and groups in their own spelling, minus any device", () => {
    expect(legacyJid("158055467598020:12@lid")).toBe("158055467598020@lid");
    expect(legacyJid("120363000000000000@g.us")).toBe("120363000000000000@g.us");
  });

  it("returns null for anything that is not a JID", () => {
    expect(legacyJid("")).toBeNull();
    expect(legacyJid(undefined)).toBeNull();
    expect(legacyJid("447700900123")).toBeNull();
  });

  it("agrees with serializeKey on the remote it writes", () => {
    const id = serializeKey({ remoteJid: "447700900123:4@s.whatsapp.net", fromMe: true, id: "ABC" });
    expect(id).toBe(`true_${legacyJid("447700900123:4@s.whatsapp.net")}_ABC`);
  });
});
