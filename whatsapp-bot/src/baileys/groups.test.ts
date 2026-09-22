/**
 * Groups, participants and the LID-to-phone bridge (Phase 4), as pure
 * functions. The driver-level proof, against a fake socket and Baileys'
 * REAL mapping store, is `drivers/baileys.groups.test.ts`.
 *
 * Participant shapes are exactly what rc14's `extractGroupMetadata`
 * builds (`lib/Socket/groups.js`): `phoneNumber` only when the id is a
 * LID, `lid` only when the id is a phone, and no names at all.
 */
import { describe, it, expect } from "vitest";
import { jidDecode, isLidUser, isPnUser } from "baileys";
import {
  GROUP_SWEEP_INTERVAL_MS,
  createGroupCache,
  lidPnPairs,
  membershipEvent,
  participantPhone,
  snapshotFromMetadata,
  type GroupMetaLike,
  type ParticipantLike,
} from "./groups.js";

const GROUP = "120363000000000000@g.us";
const BOT = { id: "158000000000001@lid", phoneNumber: "447700900001@s.whatsapp.net", admin: null };
const LID_WITH_PHONE = { id: "158055467598020@lid", phoneNumber: "447700900123@s.whatsapp.net", admin: null };
const LID_ONLY = { id: "158099999999999@lid", admin: null };
const PN_WITH_LID = { id: "447700900555@s.whatsapp.net", lid: "158077777777777@lid", admin: "admin" };
const PN_ONLY = { id: "447700900666@s.whatsapp.net", admin: "superadmin" };

function meta(participants: ParticipantLike[], extra: Partial<GroupMetaLike> = {}): GroupMetaLike {
  return { id: GROUP, subject: "Sutton FC", addressingMode: "lid", participants, ...extra };
}

describe("lidPnPairs: what goes to storeLIDPNMappings", () => {
  it("pairs a LID-addressed member with the phone WhatsApp returned, in FULL wire JIDs", () => {
    expect(lidPnPairs([LID_WITH_PHONE])).toEqual([
      { lid: "158055467598020@lid", pn: "447700900123@s.whatsapp.net" },
    ]);
  });

  it("pairs a phone-addressed member with its lid too (either direction)", () => {
    expect(lidPnPairs([PN_WITH_LID])).toEqual([
      { lid: "158077777777777@lid", pn: "447700900555@s.whatsapp.net" },
    ]);
  });

  it("every pair passes Baileys' OWN isLidUser / isPnUser, or the store would silently skip it", () => {
    // The Phase 1 bug class: a bare user part or an @c.us phone is dropped
    // by lid-mapping.js with only a warn line. Check with the real predicates.
    const pairs = lidPnPairs([LID_WITH_PHONE, PN_WITH_LID, BOT]);
    expect(pairs).toHaveLength(3);
    for (const { lid, pn } of pairs) {
      expect(isLidUser(lid), lid).toBe(true);
      expect(isPnUser(pn), pn).toBe(true);
      expect(jidDecode(lid)?.device, lid).toBeUndefined();
      expect(jidDecode(pn)?.device, pn).toBeUndefined();
    }
  });

  it("strips device suffixes and rewrites an @c.us phone into the wire form", () => {
    expect(lidPnPairs([{ id: "158055467598020:7@lid", phoneNumber: "447700900123:3@c.us" }])).toEqual([
      { lid: "158055467598020@lid", pn: "447700900123@s.whatsapp.net" },
    ]);
  });

  it("gives no pair for a LID-only member, a phone-only member, or junk, and never guesses", () => {
    expect(lidPnPairs([LID_ONLY, PN_ONLY, { id: null }, "not-a-jid" as never])).toEqual([]);
    expect(JSON.stringify(lidPnPairs([LID_ONLY]))).not.toContain("158099999999999@s.whatsapp.net");
  });

  it("refuses hosted forms, which Baileys' store rejects anyway", () => {
    expect(lidPnPairs([{ id: "12345@hosted.lid", phoneNumber: "447700900123@hosted" }])).toEqual([]);
  });

  it("refuses WhatsApp's own PSA account as a phone", () => {
    expect(lidPnPairs([{ id: "158055467598020@lid", phoneNumber: "0@s.whatsapp.net" }])).toEqual([]);
  });

  it("dedupes, so a participant seen twice is stored once", () => {
    expect(lidPnPairs([LID_WITH_PHONE, { ...LID_WITH_PHONE }])).toHaveLength(1);
  });

  it("accepts the older string-only participant shape without inventing a pair", () => {
    expect(lidPnPairs(["447700900123@s.whatsapp.net" as never])).toEqual([]);
  });
});

describe("participantPhone: the phone a participant record itself carries", () => {
  it("reads a phone-addressed id, or the phoneNumber beside a LID", () => {
    expect(participantPhone(PN_ONLY)).toBe("447700900666");
    expect(participantPhone(LID_WITH_PHONE)).toBe("447700900123");
  });

  it("is null for a LID-only record: the digits of a LID are not a phone", () => {
    expect(participantPhone(LID_ONLY)).toBeNull();
  });
});

describe("the group cache and the sweep interval", () => {
  function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it("serves a verified read only while it is younger than the sweep interval", () => {
    const c = clock();
    const cache = createGroupCache({ now: c.now });
    cache.putVerified(meta([LID_WITH_PHONE]), 1);
    expect(cache.verified(GROUP)?.participants).toHaveLength(1);
    c.advance(GROUP_SWEEP_INTERVAL_MS - 1);
    expect(cache.verified(GROUP)).not.toBeNull();
    c.advance(1);
    expect(cache.verified(GROUP)).toBeNull();
  });

  it("uses a 15 minute interval", () => {
    expect(GROUP_SWEEP_INTERVAL_MS).toBe(15 * 60 * 1000);
  });

  it("never treats the participating listing as a verified roster", () => {
    // The listing may lack phones (Baileys' TODO), so a sweep must not be
    // answered from it.
    const cache = createGroupCache({ now: () => 0 });
    cache.putListing([meta([LID_WITH_PHONE])]);
    expect(cache.verified(GROUP)).toBeNull();
    expect(cache.listing()).toEqual([{ id: GROUP, name: "Sutton FC" }]);
  });

  it("expires the listing on the same interval", () => {
    const c = clock();
    const cache = createGroupCache({ now: c.now });
    cache.putListing([meta([])]);
    c.advance(GROUP_SWEEP_INTERVAL_MS);
    expect(cache.listing()).toBeNull();
  });

  it("answers Baileys' cachedGroupMetadata only for a read in the CURRENT connection", () => {
    // Across a reconnect we may have missed a join; encrypting a group send
    // for a stale roster leaves the new member on "waiting for this
    // message". Returning undefined makes Baileys fetch fresh itself.
    const cache = createGroupCache({ now: () => 0 });
    cache.putVerified(meta([LID_WITH_PHONE]), 1);
    expect(cache.forSend(GROUP, 1)?.participants).toHaveLength(1);
    expect(cache.forSend(GROUP, 2)).toBeUndefined();
  });

  it("keeps the roster exact from group-participants.update: add, remove, promote, demote", () => {
    const cache = createGroupCache({ now: () => 0 });
    cache.putVerified(meta([LID_WITH_PHONE, PN_ONLY]), 1);
    cache.applyParticipants({ id: GROUP, action: "add", participants: [LID_ONLY] }, new Set());
    expect(cache.verified(GROUP)?.participants).toHaveLength(3);
    cache.applyParticipants({ id: GROUP, action: "add", participants: [LID_ONLY] }, new Set());
    expect(cache.verified(GROUP)?.participants).toHaveLength(3);
    cache.applyParticipants(
      { id: GROUP, action: "remove", participants: [{ id: "447700900123@s.whatsapp.net" }] },
      new Set(),
    );
    // Removed by its PHONE even though the roster held it under its LID.
    expect(cache.verified(GROUP)?.participants.map((p) => (p as ParticipantLike).id)).toEqual([
      PN_ONLY.id,
      LID_ONLY.id,
    ]);
    cache.applyParticipants({ id: GROUP, action: "promote", participants: [LID_ONLY] }, new Set());
    expect((cache.verified(GROUP)?.participants[1] as ParticipantLike).admin).toBe("admin");
    cache.applyParticipants({ id: GROUP, action: "demote", participants: [LID_ONLY] }, new Set());
    expect((cache.verified(GROUP)?.participants[1] as ParticipantLike).admin).toBeNull();
  });

  it("forgets a group the bot was removed from, and invalidates the listing", () => {
    const cache = createGroupCache({ now: () => 0 });
    cache.putListing([meta([BOT])]);
    cache.putVerified(meta([BOT, PN_ONLY]), 1);
    cache.applyParticipants({ id: GROUP, action: "remove", participants: [BOT] }, new Set(["447700900001@c.us"]));
    expect(cache.verified(GROUP)).toBeNull();
    expect(cache.listing()).toBeNull();
  });

  it("drops the roster on a number change it cannot apply, rather than keep a wrong one", () => {
    const cache = createGroupCache({ now: () => 0 });
    cache.putVerified(meta([PN_ONLY]), 1);
    cache.applyParticipants({ id: GROUP, action: "modify", participants: [PN_ONLY] }, new Set());
    expect(cache.verified(GROUP)).toBeNull();
  });

  it("knows each group's addressing mode from either kind of read", () => {
    const cache = createGroupCache({ now: () => 0 });
    cache.putListing([meta([], { id: "1@g.us", addressingMode: "pn" })]);
    cache.putVerified(meta([]), 1);
    expect(cache.addressingMode("1@g.us")).toBe("pn");
    expect(cache.addressingMode(GROUP)).toBe("lid");
    expect(cache.addressingMode("2@g.us")).toBeUndefined();
  });

  it("merges a groups.update subject change without trusting its roster", () => {
    const cache = createGroupCache({ now: () => 0 });
    cache.putListing([meta([])]);
    cache.putVerified(meta([PN_ONLY]), 1);
    cache.applyGroupUpdate({ id: GROUP, subject: "Sutton FC Tuesdays", participants: [] });
    expect(cache.listing()).toEqual([{ id: GROUP, name: "Sutton FC Tuesdays" }]);
    expect(cache.verified(GROUP)?.participants).toHaveLength(1);
  });
});

describe("membershipEvent: group-participants.update as the bot's join and leave", () => {
  const noLookup = { phoneForLid: async () => null };

  it("maps add to a join with phone-form recipients the index.ts handler can read", async () => {
    const out = await membershipEvent(
      {
        id: GROUP,
        action: "add",
        author: "158077777777777@lid",
        authorPn: "447700900555@s.whatsapp.net",
        participants: [LID_WITH_PHONE, PN_ONLY],
      },
      noLookup,
    );
    expect(out).toEqual({
      kind: "join",
      event: {
        chatId: GROUP,
        recipientIds: ["447700900123@c.us", "447700900666@c.us"],
        author: "447700900555@c.us",
      },
    });
  });

  it("maps remove to a leave", async () => {
    const out = await membershipEvent({ id: GROUP, action: "remove", author: "", participants: [PN_ONLY] }, noLookup);
    expect(out?.kind).toBe("leave");
    expect(out?.event.recipientIds).toEqual(["447700900666@c.us"]);
  });

  it("resolves a LID-only participant from local knowledge, and keeps the LID when there is none", async () => {
    const out = await membershipEvent(
      { id: GROUP, action: "add", author: "", participants: [LID_ONLY, { id: "158011111111111@lid" }] },
      {
        phoneForLid: async (lid) => (lid === "158099999999999@lid" ? "447700900777" : null),
      },
    );
    expect(out?.event.recipientIds).toEqual(["447700900777@c.us", "158011111111111@lid"]);
  });

  it("ignores promote, demote and modify: they are not joins or leaves", async () => {
    for (const action of ["promote", "demote", "modify"] as const) {
      expect(await membershipEvent({ id: GROUP, action, author: "", participants: [PN_ONLY] }, noLookup)).toBeNull();
    }
  });

  it("survives a throwing lookup by keeping the LID", async () => {
    const out = await membershipEvent(
      { id: GROUP, action: "add", author: "", participants: [LID_ONLY] },
      { phoneForLid: async () => Promise.reject(new Error("store down")) },
    );
    expect(out?.event.recipientIds).toEqual(["158099999999999@lid"]);
  });
});

describe("snapshotFromMetadata: the self-setup POST's roster", () => {
  it("skips the bot under any of its ids, keeps phones, and reports LID-only members as lidId", async () => {
    const snap = await snapshotFromMetadata(meta([BOT, LID_WITH_PHONE, LID_ONLY, PN_WITH_LID]), ["447700900001@c.us", "158000000000001@lid"], {
      phoneForLid: async () => null,
      pushnameFor: (ids) => (ids.includes("447700900123@c.us") ? "Sam" : undefined),
    });
    expect(snap.source).toBe("groupMetadata");
    expect(snap.subject).toBe("Sutton FC");
    expect(snap.participants).toEqual([
      { phone: "447700900123", pushname: "Sam", isAdmin: false },
      { lidId: "158099999999999@lid", isAdmin: false },
      { phone: "447700900555", isAdmin: true },
    ]);
    expect(snap.notes.join(" ")).toMatch(/1 participant.*only a LID/);
  });
});
