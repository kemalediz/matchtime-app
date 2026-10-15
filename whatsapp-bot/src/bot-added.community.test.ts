/**
 * THE FNF INCIDENT on the Pi (prod, 2026-10-15 18:31 UTC).
 *
 * MatchTime joined the organiser's main chat, which sits inside a WhatsApp
 * community, and so landed in the community's PARENT group and its
 * ANNOUNCEMENTS group too. The parent group's join was authored by
 * MatchTime's OWN number, and the Pi sent that number to the server as the
 * adder ("adder: phone=447575534985 ... via=event"). The server could not
 * tell the parent from a club's group either: the Pi sent no community
 * facts. And the main chat's history bundle landed after its add post and
 * was never sent at all.
 *
 * Here: the community facts go with every add (and every sweep post), an
 * add authored by MatchTime itself names no adder, and a late bundle is
 * posted on its own once the add has been answered.
 */
import { describe, it, expect, vi } from "vitest";
import {
  handleGroupJoinForSelfAdd,
  handleLateJoinHistory,
  isOwnAdder,
  sweepForMissedSelfAdds,
  type BotAddedDeps,
} from "./bot-added.js";
import type { GroupSnapshot } from "./driver.js";
import { makeWwebjsDriver, type WwebjsClientLike } from "./drivers/wwebjs.js";

const MAIN = "447961000000-1596025435@g.us";
const PARENT = "120363409700000000@g.us";
const ANNOUNCE = "120363428200000000@g.us";
/** MatchTime's own ids, as `driver.selfIds()` gives them. */
const SELF_PN = "447700900975@c.us";
const SELF_LID = "158055467598020@lid";
const ORGANISER = "447700900970";
const ORGANISER_LID = "156345466617992";

function snapshot(over: Partial<GroupSnapshot> = {}): GroupSnapshot {
  return {
    subject: "Friday Night Football 🏟",
    participants: [{ phone: ORGANISER }, { phone: "447700900001" }],
    source: "groupMetadata",
    notes: [],
    ...over,
  };
}

function deps(over: Partial<BotAddedDeps> = {}) {
  const driver = makeWwebjsDriver({
    sendMessage: vi.fn(async () => ({})),
    getContactById: vi.fn(async () => {
      throw new Error("r");
    }),
  } as unknown as WwebjsClientLike);
  const postBotAdded = vi.fn(async () => ({ silent: true, ignored: "self-join-pending", selfJoin: "linked" }));
  const lines: string[] = [];
  const d: BotAddedDeps = {
    driver,
    isMonitoredGroup: () => false,
    addMonitoredGroup: () => undefined,
    addOnboardingGroup: () => undefined,
    addSilentGroup: () => undefined,
    resolveSelfIds: async () => [SELF_PN, SELF_LID],
    readGroupSnapshot: async () => snapshot(),
    fetchHistory: async () => [],
    postBotAdded,
    log: (l) => void lines.push(l),
    error: (l) => void lines.push(l),
    ...over,
  };
  return { d, postBotAdded, lines };
}

const body = (m: ReturnType<typeof deps>["postBotAdded"]) => (m.mock.calls[0] as unknown as [Record<string, unknown>])[0];

describe("isOwnAdder", () => {
  it("MatchTime's own phone or LID, in any spelling the event gives", () => {
    const self = [SELF_PN, SELF_LID];
    expect(isOwnAdder({ addedByPhone: "447700900975" }, self)).toBe(true);
    expect(isOwnAdder({ addedByLid: "158055467598020" }, self)).toBe(true);
    expect(isOwnAdder({ addedByPhone: ORGANISER, addedByLid: ORGANISER_LID }, self)).toBe(false);
    expect(isOwnAdder({}, self)).toBe(false);
    expect(isOwnAdder({ addedByPhone: "447700900975" }, [])).toBe(false);
  });
});

describe("the three joins of that day, as the fixed Pi reports them", () => {
  it("THE PARENT GROUP: the join authored by MatchTime itself names NO adder, and the community facts go up", async () => {
    const { d, postBotAdded, lines } = deps({
      readGroupSnapshot: async () =>
        snapshot({
          subject: "FNF ⚽️",
          community: { isCommunity: true, isCommunityAnnounce: false, linkedParent: null },
        }),
    });
    await handleGroupJoinForSelfAdd(d, {
      chatId: PARENT,
      recipientIds: [SELF_PN],
      author: SELF_PN,
      authorLid: "158055467598020",
    });
    const sent = body(postBotAdded);
    expect(sent.addedByPhone).toBeUndefined();
    expect(sent.addedByLid).toBeUndefined();
    expect(sent.community).toEqual({ isCommunity: true, isCommunityAnnounce: false, linkedParent: null });
    expect(lines.some((l) => l.includes(`${PARENT} adder: MatchTime's own account`))).toBe(true);
  });

  it("THE MAIN CHAT: the organiser's add, with the community it sits in", async () => {
    const { d, postBotAdded } = deps({
      readGroupSnapshot: async () =>
        snapshot({ community: { isCommunity: false, isCommunityAnnounce: false, linkedParent: PARENT } }),
    });
    await handleGroupJoinForSelfAdd(d, {
      chatId: MAIN,
      recipientIds: [SELF_PN],
      author: `${ORGANISER}@c.us`,
      authorLid: ORGANISER_LID,
    });
    const sent = body(postBotAdded);
    expect(sent).toMatchObject({ addedByPhone: ORGANISER, addedByLid: ORGANISER_LID });
    expect(sent.community).toEqual({ isCommunity: false, isCommunityAnnounce: false, linkedParent: PARENT });
  });

  it("THE ANNOUNCEMENTS GROUP: its community facts go up beside the postability reading", async () => {
    const { d, postBotAdded } = deps({
      readGroupSnapshot: async () =>
        snapshot({
          subject: "FNF ⚽️",
          community: { isCommunity: false, isCommunityAnnounce: true, linkedParent: PARENT },
        }),
    });
    await handleGroupJoinForSelfAdd(d, { chatId: ANNOUNCE, recipientIds: [SELF_PN] });
    expect(body(postBotAdded).community).toEqual({ isCommunity: false, isCommunityAnnounce: true, linkedParent: PARENT });
  });

  it("a snapshot with no community reading (whatsapp-web.js) sends no community field", async () => {
    const { d, postBotAdded } = deps();
    await handleGroupJoinForSelfAdd(d, { chatId: MAIN, recipientIds: [SELF_PN], author: `${ORGANISER}@c.us` });
    expect("community" in body(postBotAdded)).toBe(false);
  });

  it("the reconnect sweep sends the community facts too", async () => {
    const postBotAdded = vi.fn(async () => ({ silent: true, selfJoin: "community-group", ignored: "community-group" }));
    await sweepForMissedSelfAdds({
      listGroups: async () => [{ id: PARENT, name: "FNF ⚽️" }],
      knownGroups: new Set(),
      isMonitoredGroup: () => false,
      isSilentGroup: () => false,
      addSilentGroup: () => undefined,
      resolveSelfIds: async () => [SELF_PN],
      readGroupSnapshot: async () =>
        snapshot({ community: { isCommunity: true, isCommunityAnnounce: false, linkedParent: null } }),
      postBotAdded,
      alreadySwept: new Set(),
      log: () => undefined,
      error: () => undefined,
    });
    expect((postBotAdded.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({
      discovered: true,
      community: { isCommunity: true, isCommunityAnnounce: false, linkedParent: null },
    });
  });
});

describe("handleLateJoinHistory: the main chat's bundle, read after its add post had gone", () => {
  const rows = [{ author: "P1", authorPhone: null, text: "who's in friday", timestamp: "2026-10-15T18:00:00.000Z" }];

  it("waits for the add post to be answered, then posts the bundle on its own (no adder, no roster)", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const addSettled = new Promise<void>((r) => (release = r));
    const postBotAdded = vi.fn(async (b: Record<string, unknown>) => {
      order.push(`post ${String(b.groupId)}`);
      return { ok: true, ignored: "late-history" } as never;
    });
    const p = handleLateJoinHistory(
      {
        resolveSelfIds: async () => [SELF_PN, SELF_LID],
        readJoinHistory: async () => {
          order.push("read");
          return rows;
        },
        awaitAddSettled: async () => {
          order.push("wait");
          await addSettled;
          order.push("settled");
        },
        isMonitoredGroup: () => false,
        postBotAdded,
        log: () => undefined,
      },
      MAIN,
    );
    await Promise.resolve();
    expect(postBotAdded).not.toHaveBeenCalled();
    release();
    expect(await p).toBe("posted");
    expect(order).toEqual(["wait", "settled", "read", `post ${MAIN}`]);
    expect(postBotAdded).toHaveBeenCalledWith({ groupId: MAIN, lateHistory: true, enrichmentHistory: rows });
  });

  it("nothing to post when the bundle was already handed to the add (a re-read finds nothing)", async () => {
    const postBotAdded = vi.fn();
    const out = await handleLateJoinHistory(
      {
        resolveSelfIds: async () => [SELF_PN],
        readJoinHistory: async () => [],
        isMonitoredGroup: () => false,
        postBotAdded,
        log: () => undefined,
      },
      MAIN,
    );
    expect(out).toBe("empty");
    expect(postBotAdded).not.toHaveBeenCalled();
  });

  it("never for a club's own (monitored) group", async () => {
    const postBotAdded = vi.fn();
    const out = await handleLateJoinHistory(
      {
        resolveSelfIds: async () => [SELF_PN],
        readJoinHistory: async () => rows,
        isMonitoredGroup: () => true,
        postBotAdded,
        log: () => undefined,
      },
      MAIN,
    );
    expect(out).toBe("monitored");
    expect(postBotAdded).not.toHaveBeenCalled();
  });

  it("never throws: a failed post is logged", async () => {
    const lines: string[] = [];
    const out = await handleLateJoinHistory(
      {
        resolveSelfIds: async () => [SELF_PN],
        readJoinHistory: async () => rows,
        isMonitoredGroup: () => false,
        postBotAdded: async () => {
          throw new Error("server down");
        },
        log: (l) => void lines.push(l),
      },
      MAIN,
    );
    expect(out).toBe("failed");
    expect(lines.join("\n")).toContain("server down");
    // The chat itself is never logged.
    expect(lines.join("\n")).not.toContain("who's in friday");
  });
});
