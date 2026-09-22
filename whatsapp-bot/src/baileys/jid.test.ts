import { describe, it, expect, vi } from "vitest";
import { jidDecode } from "baileys";
// Deep import on purpose: the class is not re-exported from the package
// root, and the test must run the REAL lookup rather than a fake of it.
import { LIDMappingStore } from "baileys/lib/Signal/lid-mapping.js";
import {
  parseJid,
  isPhoneJid,
  isLidJid,
  isGroupJid,
  bareUser,
  phoneFromJid,
  toUserJid,
  toLegacyUserJid,
  inboundDropReason,
  resolveInboundSender,
} from "./jid.js";

describe("parseJid", () => {
  // The point of a hand-written parser is that the module stays pure and
  // Baileys-free. The point of THIS test is that it may not drift from the
  // real one while doing so.
  it("agrees with Baileys' own jidDecode on user, server and device", () => {
    const samples = [
      "447700900123@s.whatsapp.net",
      "447700900123:12@s.whatsapp.net",
      "447700900123@c.us",
      "158055467598020@lid",
      "158055467598020:99@lid",
      "12345@hosted",
      "12345@hosted.lid",
      "120363000000000000@g.us",
      "status@broadcast",
      "0@s.whatsapp.net",
    ];
    for (const jid of samples) {
      const mine = parseJid(jid);
      const theirs = jidDecode(jid);
      expect(mine, jid).not.toBeNull();
      expect(mine!.user, jid).toBe(theirs!.user);
      expect(mine!.server, jid).toBe(theirs!.server);
      expect(mine!.device, jid).toBe(theirs!.device);
    }
  });

  it("returns null for anything without an @", () => {
    expect(parseJid("447700900123")).toBeNull();
    expect(parseJid("")).toBeNull();
    expect(parseJid(undefined)).toBeNull();
    expect(parseJid(null)).toBeNull();
  });

  it("strips the agent suffix from the user, as jidDecode does", () => {
    expect(parseJid("447700900123_1:12@s.whatsapp.net")?.user).toBe("447700900123");
  });
});

describe("classification", () => {
  it("treats s.whatsapp.net, c.us and hosted as phone JIDs", () => {
    expect(isPhoneJid("447700900123@s.whatsapp.net")).toBe(true);
    expect(isPhoneJid("447700900123@c.us")).toBe(true);
    expect(isPhoneJid("447700900123@hosted")).toBe(true);
    expect(isPhoneJid("447700900123:12@s.whatsapp.net")).toBe(true);
  });

  it("treats lid and hosted.lid as LID JIDs, and not as phone JIDs", () => {
    expect(isLidJid("158055467598020@lid")).toBe(true);
    // hosted.lid device 99 is real; missing it silently loses a sender.
    expect(isLidJid("158055467598020:99@hosted.lid")).toBe(true);
    expect(isPhoneJid("158055467598020@lid")).toBe(false);
  });

  it("recognises groups, and nothing else as a group", () => {
    expect(isGroupJid("120363000000000000@g.us")).toBe(true);
    expect(isGroupJid("447700900123@s.whatsapp.net")).toBe(false);
    expect(isGroupJid("status@broadcast")).toBe(false);
  });
});

describe("bareUser", () => {
  it("drops the device suffix so a self-comparison can succeed", () => {
    // sock.user.id arrives as "447700900123:12@s.whatsapp.net". Comparing
    // that against a mentioned JID is always false, which is the classic
    // Baileys first-week bug.
    expect(bareUser("447700900123:12@s.whatsapp.net")).toBe("447700900123@s.whatsapp.net");
    expect(bareUser("158055467598020:99@lid")).toBe("158055467598020@lid");
  });

  it("leaves a JID with no device suffix alone", () => {
    expect(bareUser("447700900123@s.whatsapp.net")).toBe("447700900123@s.whatsapp.net");
  });

  it("returns null for a non-JID", () => {
    expect(bareUser("447700900123")).toBeNull();
    expect(bareUser(undefined)).toBeNull();
  });
});

describe("phoneFromJid", () => {
  it("extracts the digits from either phone-JID form", () => {
    expect(phoneFromJid("447700900123@s.whatsapp.net")).toBe("447700900123");
    expect(phoneFromJid("447700900123@c.us")).toBe("447700900123");
    expect(phoneFromJid("447700900123:12@s.whatsapp.net")).toBe("447700900123");
  });

  it("refuses a LID: its digits are NOT a phone number", () => {
    // Guessing a phone from LID digits can match somebody else's record.
    expect(phoneFromJid("158055467598020@lid")).toBeNull();
    expect(phoneFromJid("158055467598020@hosted.lid")).toBeNull();
  });

  it("refuses WhatsApp's own 0@s.whatsapp.net PSA account", () => {
    expect(phoneFromJid("0@s.whatsapp.net")).toBeNull();
  });

  it("refuses a group and anything unparseable", () => {
    expect(phoneFromJid("120363000000000000@g.us")).toBeNull();
    expect(phoneFromJid("status@broadcast")).toBeNull();
    expect(phoneFromJid(undefined)).toBeNull();
  });
});

describe("toUserJid / toLegacyUserJid", () => {
  it("builds the Baileys form, and tolerates a leading + or spacing", () => {
    expect(toUserJid("447700900123")).toBe("447700900123@s.whatsapp.net");
    expect(toUserJid("+44 7700 900123")).toBe("447700900123@s.whatsapp.net");
  });

  it("builds the whatsapp-web.js form, which the id serialiser still needs", () => {
    expect(toLegacyUserJid("447700900123")).toBe("447700900123@c.us");
  });
});

describe("inboundDropReason", () => {
  const group = "120363000000000000@g.us";
  const dm = "447700900123@s.whatsapp.net";

  it("KEEPS groups and direct chats: MatchTime lives in both", () => {
    expect(inboundDropReason({ remoteJid: group, fromMe: false, id: "A" })).toBeNull();
    expect(inboundDropReason({ remoteJid: dm, fromMe: false, id: "A" })).toBeNull();
    expect(inboundDropReason({ remoteJid: "158055467598020@lid", fromMe: false, id: "A" })).toBeNull();
  });

  it("drops our own messages", () => {
    expect(inboundDropReason({ remoteJid: group, fromMe: true, id: "A" })).toBe("own message");
  });

  it("drops status, broadcast lists and newsletters", () => {
    expect(inboundDropReason({ remoteJid: "status@broadcast", fromMe: false, id: "A" })).toBe(
      "status update",
    );
    expect(inboundDropReason({ remoteJid: "12345@broadcast", fromMe: false, id: "A" })).toBe(
      "broadcast list",
    );
    expect(inboundDropReason({ remoteJid: "12345@newsletter", fromMe: false, id: "A" })).toBe(
      "newsletter",
    );
  });

  it("keeps our own messages when asked to, and still filters everything else", () => {
    // The driver's onMessage contract is "including our own"; index.ts
    // does the fromMe skip itself. Phase 1's observer still drops them.
    expect(inboundDropReason({ remoteJid: group, fromMe: true, id: "A" }, { keepOwn: true })).toBeNull();
    expect(inboundDropReason({ remoteJid: group, fromMe: true, id: "A" })).toBe("own message");
    expect(
      inboundDropReason({ remoteJid: "status@broadcast", fromMe: true, id: "A" }, { keepOwn: true }),
    ).toBe("status update");
  });

  it("drops anything with no chat or no id", () => {
    expect(inboundDropReason({ fromMe: false, id: "A" })).toBe("no remoteJid");
    expect(inboundDropReason({ remoteJid: group, fromMe: false })).toBe("no message id");
  });

  it("drops servers we do not understand rather than guessing", () => {
    // @bot (Meta AI) and @call are real and neither is a person.
    expect(inboundDropReason({ remoteJid: "1234@bot", fromMe: false, id: "A" })).toMatch(/not a chat/);
    expect(inboundDropReason({ remoteJid: "1234@call", fromMe: false, id: "A" })).toMatch(/not a chat/);
  });
});

describe("resolveInboundSender", () => {
  const never = vi.fn(async () => null);

  it("takes the phone straight off a phone-JID sender", async () => {
    const got = await resolveInboundSender(
      { remoteJid: "120363000000000000@g.us", participant: "447700900123@s.whatsapp.net" },
      never,
    );
    expect(got).toEqual({ phone: "447700900123", source: "jid" });
    expect(never).not.toHaveBeenCalled();
  });

  it("falls back to participantAlt, which the SERVER puts on the stanza", async () => {
    // This is the path that works for a player we have never seen before:
    // no local state is required, the phone rides on the envelope.
    const got = await resolveInboundSender(
      {
        remoteJid: "120363000000000000@g.us",
        participant: "158055467598020@lid",
        participantAlt: "447700900123@s.whatsapp.net",
      },
      never,
    );
    expect(got).toEqual({ phone: "447700900123", source: "alt" });
    expect(never).not.toHaveBeenCalled();
  });

  it("uses remoteJidAlt for a DM whose remoteJid is a LID", async () => {
    const got = await resolveInboundSender(
      { remoteJid: "158055467598020@lid", remoteJidAlt: "447700900123@s.whatsapp.net" },
      never,
    );
    expect(got).toEqual({ phone: "447700900123", source: "alt" });
  });

  it("falls back to the local LID mapping store, asking with the full LID JID", async () => {
    const store = vi.fn(async (lid: string) =>
      lid === "158055467598020@lid" ? "447700900123@s.whatsapp.net" : null,
    );
    const got = await resolveInboundSender({ remoteJid: "158055467598020:3@lid" }, store);
    expect(got).toEqual({ phone: "447700900123", source: "lid-mapping" });
    // The FULL JID, device suffix stripped. Phase 1 passed the bare user
    // part ("158055467598020"), and Baileys' getPNForLID opens with
    // `if (!isLidUser(lid)) continue`, which is `jid.endsWith("@lid")`, so
    // the store path returned null for every LID ever asked about. The
    // test below proves this against Baileys' own store, not a fake.
    expect(store).toHaveBeenCalledWith("158055467598020@lid");
  });

  it("finds a stored mapping through Baileys' REAL LIDMappingStore", async () => {
    // The real class, over an in-memory key store: no socket, no network.
    // This is the test that would have caught Phase 1's bare-user key.
    const data: Record<string, Record<string, unknown>> = {};
    const keys = {
      get: async (type: string, ids: string[]) =>
        Object.fromEntries(ids.filter((id) => data[type]?.[id]).map((id) => [id, data[type][id]])),
      set: async (patch: Record<string, Record<string, unknown>>) => {
        for (const [type, rows] of Object.entries(patch)) data[type] = { ...data[type], ...rows };
      },
      transaction: async <T>(fn: () => Promise<T>) => fn(),
      isInTransaction: () => false,
    };
    const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child: () => quiet, level: "silent" };
    const store = new LIDMappingStore(keys as never, quiet as never);
    await store.storeLIDPNMappings([{ lid: "158055467598020@lid", pn: "447700900123@s.whatsapp.net" }]);

    const got = await resolveInboundSender({ remoteJid: "158055467598020@lid" }, (lid) =>
      store.getPNForLID(lid),
    );
    expect(got).toEqual({ phone: "447700900123", source: "lid-mapping" });
  });

  it("gives up with the lid recorded, and NEVER guesses a phone from LID digits", async () => {
    const got = await resolveInboundSender({ remoteJid: "158055467598020@lid" }, never);
    expect(got.phone).toBeNull();
    expect(got).toMatchObject({ lid: "158055467598020" });
    // The whole point: 158055467598020 must not surface as a phone number.
    expect(JSON.stringify(got)).not.toMatch(/"phone":"158055467598020"/);
  });

  it("survives a throwing mapping store rather than losing the message", async () => {
    const boom = vi.fn(async () => {
      throw new Error("store is broken");
    });
    const got = await resolveInboundSender({ remoteJid: "158055467598020@lid" }, boom);
    expect(got.phone).toBeNull();
    expect(got).toMatchObject({ reason: expect.stringContaining("store is broken") });
  });
});
