/**
 * The self-add in a group MatchTime cannot post in (2026-10-14,
 * group-postability.ts): the reading goes to the server, and no intro is
 * ever posted there.
 */
import { describe, it, expect, vi } from "vitest";
import { handleGroupJoinForSelfAdd, sweepForMissedSelfAdds, type BotAddedDeps } from "./bot-added.js";
import type { GroupSnapshot } from "./driver.js";
import { makeWwebjsDriver, type WwebjsClientLike } from "./drivers/wwebjs.js";

const GID = "120363999999999999@g.us";
const PN = "447525334985@c.us";

const BLOCKED = { announce: true, communityAnnounce: false, botIsAdmin: false, canPost: false, reason: "admin-only" as const };
const COMMUNITY = { announce: true, communityAnnounce: true, botIsAdmin: false, canPost: false, reason: "community-announce" as const };
const ADMIN = { announce: true, communityAnnounce: false, botIsAdmin: true, canPost: true, reason: "ok" as const };

function snapshot(over: Partial<GroupSnapshot> = {}): GroupSnapshot {
  return { subject: "Cuma Halı Saha", participants: [{ phone: "447700900001" }], source: "groupMetadata", notes: [], ...over };
}

function deps(over: Partial<BotAddedDeps> = {}) {
  const monitored = new Set<string>();
  const onboarding = new Set<string>();
  const sendMessage = vi.fn(async () => ({}));
  const driver = makeWwebjsDriver({
    sendMessage,
    getContactById: vi.fn(async () => {
      throw new Error("r");
    }),
  } as unknown as WwebjsClientLike);
  const postBotAdded = vi.fn(async () => ({ introText: "👋 Merhaba", language: "tr" }));
  const d: BotAddedDeps = {
    driver,
    isMonitoredGroup: (g) => monitored.has(g),
    addMonitoredGroup: (g) => void monitored.add(g),
    addOnboardingGroup: (g) => void onboarding.add(g),
    resolveSelfIds: async () => [PN],
    readGroupSnapshot: async () => snapshot(),
    fetchHistory: async () => [],
    postBotAdded,
    log: () => undefined,
    error: () => undefined,
    ...over,
  };
  return { d, monitored, onboarding, sendMessage, postBotAdded };
}

const ADD = { chatId: GID, recipientIds: [PN], author: "447700900001@c.us" };

describe("handleGroupJoinForSelfAdd: a group MatchTime cannot post in", () => {
  it("tells the server what it found: only admins can send, community announcements, MatchTime's admin flag", async () => {
    const { d, postBotAdded } = deps({ readGroupSnapshot: async () => snapshot({ postability: COMMUNITY }) });
    await handleGroupJoinForSelfAdd(d, ADD);
    expect(postBotAdded).toHaveBeenCalledWith(
      expect.objectContaining({ postability: { announce: true, communityAnnounce: true, botIsAdmin: false } }),
    );
  });

  it("never posts an intro into it, even when a server hands one back, and does not start monitoring it", async () => {
    const { d, sendMessage, monitored, onboarding } = deps({ readGroupSnapshot: async () => snapshot({ postability: BLOCKED }) });
    const out = await handleGroupJoinForSelfAdd(d, ADD);
    expect(out).toEqual({ kind: "silent", reason: "not-postable" });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(monitored.has(GID)).toBe(false);
    expect(onboarding.has(GID)).toBe(false);
  });

  it("an admin-only group where MatchTime IS an admin is posted in as before", async () => {
    const { d, sendMessage } = deps({ readGroupSnapshot: async () => snapshot({ postability: ADMIN }) });
    const out = await handleGroupJoinForSelfAdd(d, ADD);
    expect(out.kind).toBe("posted");
    expect(sendMessage).toHaveBeenCalled();
  });

  it("no reading (whatsapp-web.js, or MatchTime not in the roster): no postability sent, today's behaviour", async () => {
    const { d, postBotAdded, sendMessage } = deps();
    await handleGroupJoinForSelfAdd(d, ADD);
    expect((postBotAdded.mock.calls[0] as unknown[])[0]).not.toHaveProperty("postability");
    expect(sendMessage).toHaveBeenCalled();
  });

  it("the reconnect sweep sends the reading too", async () => {
    const postBotAdded = vi.fn(async () => ({ ignored: "discovered-no-match" }));
    await sweepForMissedSelfAdds({
      listGroups: async () => [{ id: GID, name: "x" }],
      knownGroups: new Set(),
      isMonitoredGroup: () => false,
      isSilentGroup: () => false,
      addSilentGroup: () => undefined,
      resolveSelfIds: async () => [PN],
      readGroupSnapshot: async () => snapshot({ postability: BLOCKED }),
      postBotAdded,
      alreadySwept: new Set(),
      log: () => undefined,
      error: () => undefined,
    });
    expect(postBotAdded).toHaveBeenCalledWith(
      expect.objectContaining({ discovered: true, postability: { announce: true, communityAnnounce: false, botIsAdmin: false } }),
    );
  });
});
