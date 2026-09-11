/**
 * THE 2026-09-10 NEAR-MISS — 69 mass DMs off three unrelated words.
 *
 * Kemal posted this to the live Sutton FC group at 18:38, an ordinary
 * reminder to his players:
 *
 *   "please do not forget to rate the players via the link from
 *    Matchtime DM'ed to you. the more accurate ratings, the more
 *    balanced teams next time"
 *
 * MatchTime recorded `by=fast-path intent=stats_blast
 * action=dm-stats-blast:69` and queued 69 personal stats-link DMs. One
 * was delivered before the queue was killed; 68 were deleted unsent.
 *
 * These tests pin the pieces of the replacement that are PURE: the copy,
 * the recipient rule, and the two constants that carry the policy. The
 * DECISION (who may fire a blast, and when) is pinned in
 * `pipeline/__tests__/engine-write-routes.test.ts`; the end-to-end "no
 * DM was queued" is `e2e/sim/stats-blast.spec.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  STATS_BLAST_REQUIRES_TAG,
  STATS_BLAST_TAG_MUST_BE_EXPLICIT,
  composeStatsBlastDm,
  composeStatsBlastReply,
  runStatsBlast,
  type StatsBlastRecipient,
} from "../stats-blast";

const RECIPIENTS: StatsBlastRecipient[] = [
  { userId: "u-1", name: "Kemal Ediz", phone: "+447700900001" },
  { userId: "u-2", name: "Elvin Aliyev", phone: "447700900002" },
  { userId: "u-3", name: null, phone: "+447700900003" },
];

describe("the policy constants", () => {
  it("requires a tag, exactly as the recruit blast does", () => {
    expect(STATS_BLAST_REQUIRES_TAG).toBe(true);
  });

  it("requires that tag to be an EXPLICIT @-mention", () => {
    // `messageTagsBot` counts the bare word "matchtime" ANYWHERE in a
    // message as a tag, and the incident sentence contains it ("the link
    // from Matchtime DM'ed to you"). A gate the incident message walks
    // straight through is not a gate.
    expect(STATS_BLAST_TAG_MUST_BE_EXPLICIT).toBe(true);
  });
});

describe("the copy is unchanged from the fast path it replaces", () => {
  it("addresses the player by first name and carries the link", () => {
    const text = composeStatsBlastDm("Kemal Ediz", "https://mt.link/abc");
    expect(text).toContain("Hi Kemal —");
    expect(text).toContain("https://mt.link/abc");
    expect(text).toContain("doesn't expire");
  });

  it("falls back to 'there' for a member with no name on record", () => {
    expect(composeStatsBlastDm(null, "https://mt.link/abc")).toContain("Hi there —");
  });

  it("counts the DMs in the group reply, singular and plural", () => {
    expect(composeStatsBlastReply(1)).toContain("DM'd 1 player");
    expect(composeStatsBlastReply(12)).toContain("DM'd 12 players");
  });
});

describe("runStatsBlast — the deterministic action", () => {
  const spy = () => {
    const sent: Array<{ phone: string; text: string }> = [];
    return {
      sent,
      deps: {
        recipients: async () => RECIPIENTS,
        linkFor: async (userId: string) => `https://mt.link/${userId}`,
        queueDm: async (args: { phone: string; text: string }) => {
          sent.push(args);
        },
      },
    };
  };

  it("queues one DM per recipient, with their OWN link", async () => {
    const s = spy();
    const r = await runStatsBlast(s.deps);
    expect(r.queued).toBe(3);
    expect(s.sent.map((x) => x.text)).toEqual([
      expect.stringContaining("https://mt.link/u-1"),
      expect.stringContaining("https://mt.link/u-2"),
      expect.stringContaining("https://mt.link/u-3"),
    ]);
  });

  it("strips the leading + from a phone, as the bot job queue expects", async () => {
    const s = spy();
    await runStatsBlast(s.deps);
    expect(s.sent.map((x) => x.phone)).toEqual([
      "447700900001",
      "447700900002",
      "447700900003",
    ]);
  });

  it("one failure does not take the rest of the blast with it", async () => {
    const sent: string[] = [];
    const r = await runStatsBlast({
      recipients: async () => RECIPIENTS,
      linkFor: async (userId: string) => {
        if (userId === "u-2") throw new Error("token signing failed");
        return `https://mt.link/${userId}`;
      },
      queueDm: async (args) => {
        sent.push(args.phone);
      },
    });
    expect(r.queued).toBe(2);
    expect(r.failed).toBe(1);
    expect(sent).toEqual(["447700900001", "447700900003"]);
  });

  it("queues nothing, and says so, when there is nobody to DM", async () => {
    const r = await runStatsBlast({
      recipients: async () => [],
      linkFor: async () => "https://mt.link/x",
      queueDm: async () => {
        throw new Error("must not be called");
      },
    });
    expect(r.queued).toBe(0);
  });
});
