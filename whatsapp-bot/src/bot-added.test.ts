/**
 * Self-add detection and the bot-added flow, against a client whose
 * page calls throw the way the live build's do (2026-09-17).
 */
import { describe, it, expect, vi } from "vitest";
import {
  handleGroupJoinForSelfAdd,
  handleGroupLeaveForSelfRemoval,
  handleMonitoredGroupSelfRemoval,
  isSelfAdd,
  normaliseRecipientIds,
  resolveAdder,
  sweepForMissedSelfAdds,
  type BotAddedDeps,
  type SweepDeps,
} from "./bot-added.js";
import type { GroupSnapshot, WaDriver } from "./driver.js";
import { makeWwebjsDriver, type WwebjsClientLike } from "./drivers/wwebjs.js";

const asDriver = (c: unknown) => makeWwebjsDriver(c as unknown as WwebjsClientLike);
const GID = "120363999999999999@g.us";
const PN = "447525334985@c.us";
const LID = "88813579246810@lid";

describe("normaliseRecipientIds: the page hands over strings or wid objects", () => {
  it("accepts both shapes and drops junk", () => {
    expect(normaliseRecipientIds([PN, { _serialized: LID }, null, 42, {}])).toEqual([PN, LID]);
  });
  it("non-arrays are empty", () => {
    expect(normaliseRecipientIds(undefined)).toEqual([]);
    expect(normaliseRecipientIds("447525334985@c.us")).toEqual([]);
  });
});

describe("isSelfAdd: the bot is matched by ANY of its ids", () => {
  it("matches the phone JID (a pn-addressed group)", () => {
    expect(isSelfAdd([PN], [PN, LID])).toBe(true);
  });
  it("matches the LID (a lid-addressed group, the default now)", () => {
    expect(isSelfAdd([LID], [PN, LID])).toBe(true);
  });
  it("the old comparison would have missed this: LID recipient, phone-only self id", () => {
    expect(isSelfAdd([LID], [PN])).toBe(false);
  });
  it("a human join is not a self add", () => {
    expect(isSelfAdd(["447700900001@c.us"], [PN, LID])).toBe(false);
  });
  it("no self ids known → never a self add (never post into a stranger's group)", () => {
    expect(isSelfAdd([PN], [])).toBe(false);
  });
});

// `resolveSelfIds` moved to the whatsapp-web.js driver in Phase 2 of
// MDs/baileys-migration-plan-2026-09-21.md (it was `client.info.wid` plus a
// `pupPage.evaluate`, i.e. all library and no rule). Its four cases moved with
// it, unchanged, to `drivers/wwebjs.test.ts` under "selfIds". What stayed
// here is the RULE it serves: `isSelfAdd`, above.

// ── The handler ────────────────────────────────────────────────────────

function snapshot(over: Partial<GroupSnapshot> = {}): GroupSnapshot {
  return {
    subject: "Cuma Halı Saha",
    participants: [{ phone: "447700900001", pushname: "Erdal" }],
    source: "page",
    notes: [],
    ...over,
  };
}

function deps(over: Partial<BotAddedDeps> = {}) {
  const monitored = new Set<string>();
  const onboarding = new Set<string>();
  const sendMessage = vi.fn(async () => ({}));
  const client = {
    sendMessage,
    getContactById: vi.fn(async () => {
      throw new Error("r");
    }),
  };
  const driver = asDriver(client);
  const postBotAdded = vi.fn(async () => ({ introText: "👋 Merhaba", language: "tr" }));
  const d: BotAddedDeps = {
    driver,
    isMonitoredGroup: (g) => monitored.has(g),
    addMonitoredGroup: (g) => void monitored.add(g),
    addOnboardingGroup: (g) => void onboarding.add(g),
    resolveSelfIds: async () => [PN, LID],
    readGroupSnapshot: async () => snapshot(),
    fetchHistory: async () => [{ author: "Erdal", authorPhone: "447700900001", text: "ben varım", timestamp: "2026-09-17T10:00:00.000Z" }],
    postBotAdded,
    log: () => undefined,
    error: () => undefined,
    ...over,
  };
  return { d, monitored, onboarding, sendMessage, postBotAdded };
}

describe("handleGroupJoinForSelfAdd", () => {
  it("a lid-addressed self add: snapshot + history reach the server, the intro is posted, the group is monitored and onboarding", async () => {
    const { d, monitored, onboarding, sendMessage, postBotAdded } = deps();
    const out = await handleGroupJoinForSelfAdd(d, { chatId: GID, recipientIds: [{ _serialized: LID }], author: "447700900001@c.us" });
    expect(out.kind).toBe("posted");
    expect(postBotAdded).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: GID,
        groupSubject: "Cuma Halı Saha",
        addedByPhone: "447700900001",
        participants: [{ phone: "447700900001", lidId: null, pushname: "Erdal" }],
        enrichmentHistory: [expect.objectContaining({ text: "ben varım" })],
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(GID, "👋 Merhaba");
    expect(monitored.has(GID)).toBe(true);
    expect(onboarding.has(GID)).toBe(true);
  });

  it("a human join in an unmonitored group is not a self add and touches nothing", async () => {
    const { d, postBotAdded } = deps();
    const out = await handleGroupJoinForSelfAdd(d, { chatId: GID, recipientIds: ["447700900002@c.us"] });
    expect(out.kind).toBe("not-self-add");
    expect(postBotAdded).not.toHaveBeenCalled();
  });

  it("a re-add to a monitored group (a live org) is left to the human-join path", async () => {
    const { d, postBotAdded } = deps();
    d.addMonitoredGroup(GID);
    const out = await handleGroupJoinForSelfAdd(d, { chatId: GID, recipientIds: [PN] });
    expect(out.kind).toBe("already-monitored");
    expect(postBotAdded).not.toHaveBeenCalled();
  });

  it("the server saying stay silent posts nothing and monitors nothing", async () => {
    const { d, monitored, sendMessage } = deps({
      postBotAdded: vi.fn(async () => ({ introText: null, ignored: "live-org" })),
    });
    const out = await handleGroupJoinForSelfAdd(d, { chatId: GID, recipientIds: [PN] });
    expect(out).toEqual({ kind: "silent", reason: "live-org" });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(monitored.has(GID)).toBe(false);
  });

  it("a snapshot and history that both fail still reach the server with a bare groupId", async () => {
    const { d, postBotAdded } = deps({
      readGroupSnapshot: async () => {
        throw new Error("r");
      },
      fetchHistory: async () => {
        throw new Error("r");
      },
    });
    const out = await handleGroupJoinForSelfAdd(d, { chatId: GID, recipientIds: [LID], author: "999@lid" });
    expect(out.kind).toBe("posted");
    expect(postBotAdded).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: GID, groupSubject: null, participants: [], enrichmentHistory: undefined }),
    );
  });

  it("a failed server call is silent, not a crash", async () => {
    const { d } = deps({
      postBotAdded: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    });
    const out = await handleGroupJoinForSelfAdd(d, { chatId: GID, recipientIds: [PN] });
    expect(out).toEqual({ kind: "silent", reason: "server-call-failed" });
  });
});

describe("handleGroupJoinForSelfAdd: silent groups (self-join slice 1)", () => {
  it("still tells the server (it decides), but NEVER posts in a silent group, even if handed an intro", async () => {
    const { d, monitored, onboarding, sendMessage, postBotAdded } = deps({ isSilentGroup: (g) => g === GID });
    const out = await handleGroupJoinForSelfAdd(d, { chatId: GID, recipientIds: [LID], author: "447700900001@c.us" });
    expect(postBotAdded).toHaveBeenCalledOnce();
    expect(out).toEqual({ kind: "silent", reason: "silent-group" });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(monitored.has(GID)).toBe(false);
    expect(onboarding.has(GID)).toBe(false);
  });

  it("a Pi wired without the check (or a group not silent) behaves exactly as before", async () => {
    const { d, sendMessage } = deps({ isSilentGroup: () => false });
    const out = await handleGroupJoinForSelfAdd(d, { chatId: GID, recipientIds: [LID], author: "447700900001@c.us" });
    expect(out.kind).toBe("posted");
    expect(sendMessage).toHaveBeenCalledOnce();
  });
});


// ── Self-join slice 6: the adder, the silent answer, removal, the sweep ──

const ADDER_LID = "158055467598961";

describe("resolveAdder: the adder's phone AND LID (self-join slice 6)", () => {
  const driverWith = (getContact: (jid: string) => Promise<unknown>) => ({ getContact: vi.fn(getContact) }) as unknown as WaDriver;

  it("a phone author with the LID it was addressed by: both, straight off the event", async () => {
    const driver = driverWith(async () => ({}));
    expect(await resolveAdder(driver, { author: "447700900123@c.us", authorLid: ADDER_LID })).toEqual({
      addedByPhone: "447700900123",
      addedByLid: ADDER_LID,
      via: "event",
    });
    expect(driver.getContact).not.toHaveBeenCalled();
  });

  it("a LID author with no phone on the event: re-resolved locally (the snapshot seeded the pair)", async () => {
    const driver = driverWith(async (jid) => (jid === `${ADDER_LID}@lid` ? { number: "447700900123" } : {}));
    expect(await resolveAdder(driver, { author: `${ADDER_LID}@lid` })).toEqual({
      addedByPhone: "447700900123",
      addedByLid: ADDER_LID,
      via: "re-resolve",
    });
  });

  it("a LID nobody can map: the LID alone, never its digits as a phone", async () => {
    const driver = driverWith(async () => {
      throw new Error("r");
    });
    expect(await resolveAdder(driver, { author: `${ADDER_LID}:4@lid` })).toEqual({ addedByLid: ADDER_LID, via: "none" });
  });

  it("no author at all (a discovered group, a notification without one)", async () => {
    expect(await resolveAdder(driverWith(async () => ({})), {})).toEqual({ via: "none" });
  });
});

describe("handleGroupJoinForSelfAdd: the self-join answer (slice 6)", () => {
  it("forwards addedByLid, re-resolves AFTER the snapshot, and treats a silent answer as silent at once", async () => {
    const order: string[] = [];
    const silent = new Set<string>();
    const getContact = vi.fn(async () => {
      order.push("getContact");
      return { number: "447700900123" };
    });
    const postBotAdded = vi.fn(async () => ({ introText: null, ignored: "self-join-pending", silent: true }));
    const { d, sendMessage, monitored } = deps({
      readGroupSnapshot: async () => {
        order.push("snapshot");
        return snapshot();
      },
      postBotAdded,
      addSilentGroup: (g) => void silent.add(g),
    });
    d.driver = { ...d.driver, getContact } as unknown as WaDriver;
    const out = await handleGroupJoinForSelfAdd(d, { chatId: GID, recipientIds: [LID], author: `${ADDER_LID}@lid` });
    expect(order).toEqual(["snapshot", "getContact"]);
    expect(postBotAdded).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: GID, addedByPhone: "447700900123", addedByLid: ADDER_LID }),
    );
    expect(out).toEqual({ kind: "silent", reason: "self-join-pending" });
    expect(silent.has(GID)).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(monitored.has(GID)).toBe(false);
  });

  it("an answer that is not silent (Sutton FC's own group) does not silence the group", async () => {
    const silent = new Set<string>();
    const { d } = deps({
      postBotAdded: vi.fn(async () => ({ introText: null, ignored: "live-org", silent: false })),
      addSilentGroup: (g) => void silent.add(g),
    });
    await handleGroupJoinForSelfAdd(d, { chatId: GID, recipientIds: [PN], author: "447700900001@c.us" });
    expect(silent.size).toBe(0);
  });
});

describe("handleGroupLeaveForSelfRemoval (plan 5.7)", () => {
  function leaveDeps(over: Partial<Parameters<typeof handleGroupLeaveForSelfRemoval>[0]> = {}) {
    const postBotRemoved = vi.fn(async () => true);
    return {
      d: {
        isSilentGroup: (g: string) => g === GID,
        resolveSelfIds: async () => [PN, LID],
        postBotRemoved,
        log: () => undefined,
        ...over,
      },
      postBotRemoved,
    };
  }

  it("MatchTime removed from a silent group: the server is told", async () => {
    const { d, postBotRemoved } = leaveDeps();
    expect(await handleGroupLeaveForSelfRemoval(d, { chatId: GID, recipientIds: [LID] })).toBe("forwarded");
    expect(postBotRemoved).toHaveBeenCalledWith({ groupId: GID });
  });

  it("somebody else leaving a silent group: nothing", async () => {
    const { d, postBotRemoved } = leaveDeps();
    expect(await handleGroupLeaveForSelfRemoval(d, { chatId: GID, recipientIds: ["447700900002@c.us"] })).toBe("not-self");
    expect(postBotRemoved).not.toHaveBeenCalled();
  });

  it("a group that is not silent (Sutton FC's) is never forwarded from here", async () => {
    const { d, postBotRemoved } = leaveDeps({ isSilentGroup: () => false });
    expect(await handleGroupLeaveForSelfRemoval(d, { chatId: GID, recipientIds: [PN] })).toBe("not-silent");
    expect(postBotRemoved).not.toHaveBeenCalled();
  });

  it("a failed post is logged, never thrown", async () => {
    const { d } = leaveDeps({
      postBotRemoved: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    });
    expect(await handleGroupLeaveForSelfRemoval(d, { chatId: GID, recipientIds: [PN] })).toBe("failed");
  });
});

describe("handleMonitoredGroupSelfRemoval (club fee billing, slice B5)", () => {
  // Baileys' `group-participants.update` with action "remove", as
  // membershipEvent (baileys/groups.ts) hands it up: recipientIds are the
  // REMOVED participants (phone form when known, else the LID), author is
  // whoever removed them.
  const ADMIN = "447700900001@c.us";

  function deps(over: Partial<Parameters<typeof handleMonitoredGroupSelfRemoval>[0]> = {}) {
    const postBotRemoved = vi.fn(async (): Promise<{ ok: boolean; billing?: string } | null> => ({ ok: true, billing: "paused" }));
    const stopped: string[] = [];
    return {
      d: {
        isMonitoredGroup: (g: string) => g === GID,
        resolveSelfIds: async () => [PN, LID],
        postBotRemoved,
        stopMonitoringGroup: (g: string) => void stopped.push(g),
        log: () => undefined,
        ...over,
      },
      postBotRemoved,
      stopped,
    };
  }

  it("MatchTime removed from a live group by an admin: the server is told, by phone id", async () => {
    const { d, postBotRemoved } = deps();
    expect(await handleMonitoredGroupSelfRemoval(d, { chatId: GID, recipientIds: [PN], author: ADMIN })).toBe("paused");
    expect(postBotRemoved).toHaveBeenCalledWith({ groupId: GID });
  });

  it("matches the bot by its LID too (a lid-addressed group)", async () => {
    const { d, postBotRemoved } = deps();
    expect(await handleMonitoredGroupSelfRemoval(d, { chatId: GID, recipientIds: [LID], author: ADMIN })).toBe("paused");
    expect(postBotRemoved).toHaveBeenCalledTimes(1);
  });

  it("a PLAYER removed or leaving is never forwarded as MatchTime's removal", async () => {
    const { d, postBotRemoved, stopped } = deps();
    expect(
      await handleMonitoredGroupSelfRemoval(d, { chatId: GID, recipientIds: ["447700900002@c.us", "99999999999999@lid"], author: ADMIN }),
    ).toBe("not-self");
    expect(postBotRemoved).not.toHaveBeenCalled();
    expect(stopped).toEqual([]);
  });

  it("no recipients, or junk recipients: nothing", async () => {
    const { d, postBotRemoved } = deps();
    expect(await handleMonitoredGroupSelfRemoval(d, { chatId: GID, recipientIds: undefined, author: ADMIN })).toBe("not-self");
    expect(await handleMonitoredGroupSelfRemoval(d, { chatId: GID, recipientIds: [null, 42, {}], author: ADMIN })).toBe("not-self");
    expect(postBotRemoved).not.toHaveBeenCalled();
  });

  it("the bot's own ids unknown (not connected yet): never forwarded", async () => {
    const { d, postBotRemoved } = deps({ resolveSelfIds: async () => [] });
    expect(await handleMonitoredGroupSelfRemoval(d, { chatId: GID, recipientIds: [PN], author: ADMIN })).toBe("not-self");
    expect(postBotRemoved).not.toHaveBeenCalled();
  });

  it("MatchTime leaving by itself (author is the bot, e.g. a platform leave job) is not a removal", async () => {
    const { d, postBotRemoved } = deps();
    expect(await handleMonitoredGroupSelfRemoval(d, { chatId: GID, recipientIds: [PN], author: PN })).toBe("own-leave");
    expect(await handleMonitoredGroupSelfRemoval(d, { chatId: GID, recipientIds: [LID], author: LID })).toBe("own-leave");
    expect(
      await handleMonitoredGroupSelfRemoval(d, { chatId: GID, recipientIds: [PN], author: "x@c.us", authorLid: "88813579246810" }),
    ).toBe("own-leave");
    expect(postBotRemoved).not.toHaveBeenCalled();
  });

  it("a group the Pi does not monitor is not handled here (silent and admin groups have their own paths)", async () => {
    const { d, postBotRemoved } = deps({ isMonitoredGroup: () => false });
    expect(await handleMonitoredGroupSelfRemoval(d, { chatId: GID, recipientIds: [PN], author: ADMIN })).toBe("not-monitored");
    expect(await handleMonitoredGroupSelfRemoval(d, { recipientIds: [PN] })).toBe("not-monitored");
    expect(postBotRemoved).not.toHaveBeenCalled();
  });

  it("the server paused the club: the group stops being monitored, so a re-add reaches the server", async () => {
    const { d, stopped } = deps();
    await handleMonitoredGroupSelfRemoval(d, { chatId: GID, recipientIds: [PN], author: ADMIN });
    expect(stopped).toEqual([GID]);
  });

  it("a repeated event for a club already paused stops monitoring too", async () => {
    const { d, stopped } = deps({ postBotRemoved: vi.fn(async () => ({ ok: true, billing: "already-paused" })) });
    expect(await handleMonitoredGroupSelfRemoval(d, { chatId: GID, recipientIds: [PN], author: ADMIN })).toBe("paused");
    expect(stopped).toEqual([GID]);
  });

  for (const billing of ["exempt", "flag-off", "not-billed", "paused-other", undefined]) {
    it(`the server only logged it (${billing ?? "an older server"}): the group stays monitored (Sutton FC)`, async () => {
      const { d, stopped } = deps({ postBotRemoved: vi.fn(async () => ({ ok: true, ...(billing ? { billing } : {}) })) });
      expect(await handleMonitoredGroupSelfRemoval(d, { chatId: GID, recipientIds: [PN], author: ADMIN })).toBe("forwarded");
      expect(stopped).toEqual([]);
    });
  }

  it("a failed post (null) or a throw is logged, never thrown, and monitoring is kept", async () => {
    const a = deps({ postBotRemoved: vi.fn(async () => null) });
    expect(await handleMonitoredGroupSelfRemoval(a.d, { chatId: GID, recipientIds: [PN], author: ADMIN })).toBe("failed");
    expect(a.stopped).toEqual([]);
    const b = deps({
      postBotRemoved: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    });
    expect(await handleMonitoredGroupSelfRemoval(b.d, { chatId: GID, recipientIds: [PN], author: ADMIN })).toBe("failed");
    const c = deps({
      resolveSelfIds: async () => {
        throw new Error("not connected");
      },
    });
    expect(await handleMonitoredGroupSelfRemoval(c.d, { chatId: GID, recipientIds: [PN], author: ADMIN })).toBe("failed");
    expect(c.postBotRemoved).not.toHaveBeenCalled();
  });
});

describe("sweepForMissedSelfAdds: the reconnect sweep (plan 8)", () => {
  const G = (n: number) => `12036340000000000${n}@g.us`;

  function sweepDeps(over: Partial<SweepDeps> = {}) {
    const silent = new Set<string>([G(3)]);
    const monitored = new Set<string>([G(2)]);
    const sendText = vi.fn();
    const readGroupSnapshot = vi.fn(async () => snapshot({ subject: "Riverside Tuesday 5s" }));
    const postBotAdded = vi.fn(async () => ({ introText: "never posted", ignored: "self-join-pending", selfJoin: "linked", silent: true }));
    const d: SweepDeps = {
      listGroups: async () => [1, 2, 3, 4, 5].map((n) => ({ id: G(n), name: `Group ${n}` })),
      knownGroups: new Set([G(1)]),
      isMonitoredGroup: (g) => monitored.has(g),
      isSilentGroup: (g) => silent.has(g),
      addSilentGroup: (g) => void silent.add(g),
      resolveSelfIds: async () => [PN, LID],
      readGroupSnapshot,
      postBotAdded,
      alreadySwept: new Set([G(5)]),
      log: () => undefined,
      error: () => undefined,
      ...over,
    };
    return { d, silent, sendText, readGroupSnapshot, postBotAdded };
  }

  it("reads only groups the server does not know, posts them as discovered, and never speaks", async () => {
    const { d, silent, readGroupSnapshot, postBotAdded } = sweepDeps();
    const out = await sweepForMissedSelfAdds(d);
    expect(out).toEqual({ checked: 1, linked: 1 });
    expect(readGroupSnapshot).toHaveBeenCalledTimes(1);
    expect(readGroupSnapshot).toHaveBeenCalledWith(G(4), [PN, LID]);
    expect(postBotAdded).toHaveBeenCalledWith({
      groupId: G(4),
      groupSubject: "Riverside Tuesday 5s",
      participants: [{ phone: "447700900001", lidId: null, pushname: "Erdal" }],
      discovered: true,
    });
    expect(silent.has(G(4))).toBe(true);
    expect(d.alreadySwept.has(G(4))).toBe(true);
  });

  it("a group that matched nothing is looked at again on the next reconnect", async () => {
    const { d } = sweepDeps({
      postBotAdded: vi.fn(async () => ({ introText: null, ignored: "discovered-no-match", silent: false })),
    });
    await sweepForMissedSelfAdds(d);
    expect(d.alreadySwept.has(G(4))).toBe(false);
  });

  it("caps how many groups one reconnect reads", async () => {
    const { d, readGroupSnapshot } = sweepDeps({
      listGroups: async () => Array.from({ length: 30 }, (_, i) => ({ id: `1203634${String(i).padStart(11, "0")}@g.us`, name: "" })),
      knownGroups: new Set(),
      alreadySwept: new Set(),
    });
    await sweepForMissedSelfAdds(d);
    expect(readGroupSnapshot).toHaveBeenCalledTimes(10);
  });

  it("a group listing that throws ends the sweep quietly", async () => {
    const { d, postBotAdded } = sweepDeps({
      listGroups: async () => {
        throw new Error("not connected");
      },
    });
    expect(await sweepForMissedSelfAdds(d)).toEqual({ checked: 0, linked: 0 });
    expect(postBotAdded).not.toHaveBeenCalled();
  });
});
