/**
 * MATCHTIME'S LAST DM TO A PLAYER, ONE DEFINITION FOR EVERY DM CLASSIFIER.
 *
 * Lifted out of `payment-claim.ts` on 2026-10-18 so the match-availability
 * classifier reads the same thing the payment-claim classifier reads: the
 * newer of a queued BotJob (its words) and a scheduler DM (key only,
 * described by what it was about).
 */
import { describe, it, expect } from "vitest";
import { lastBotDmLine, loadLastBotDm, pickLastBotDm } from "../last-bot-dm";

describe("MatchTime's last DM includes the scheduler's chasers", () => {
  const at = (iso: string) => new Date(iso);

  it("a newer pay chase (stored as a key, no text) beats an older queued DM", () => {
    const got = pickLastBotDm({
      queued: { text: "💷 Feroz, match fee for *Football 9-a-side* is *£5*.", at: at("2026-10-16T21:46:00Z") },
      scheduled: { key: "m1:pay-chase:u1:2026-10-18", at: at("2026-10-18T17:04:00Z") },
    });
    expect(got).toMatch(/^\(.*pay.*\)$/i);
  });

  it("a newer rating reminder is NOT about paying, so a bare 'done' answers it", () => {
    const got = pickLastBotDm({
      queued: { text: "💷 pay link", at: at("2026-10-16T21:46:00Z") },
      scheduled: { key: "m1:rate-reminder:u1:2026-10-18", at: at("2026-10-18T17:01:00Z") },
    });
    expect(got).toMatch(/rate/i);
    expect(got).not.toMatch(/pay/i);
  });

  it("the tentative follow-up (scheduler, key only) is described as asking whether they can play", () => {
    const got = pickLastBotDm({
      queued: null,
      scheduled: { key: "m1:tentative-followup:u1", at: at("2026-10-18T17:01:00Z") },
    });
    expect(got).toMatch(/^\(.*whether they can play.*\)$/i);
  });

  it("a newer queued DM keeps its real words", () => {
    expect(
      pickLastBotDm({
        queued: { text: "real words", at: at("2026-10-18T18:00:00Z") },
        scheduled: { key: "m1:pay-chase:u1:2026-10-18", at: at("2026-10-18T17:04:00Z") },
      }),
    ).toBe("real words");
  });

  it("a newer scheduler DM we cannot describe is not known, never the stale text", () => {
    expect(
      pickLastBotDm({
        queued: { text: "💷 pay link", at: at("2026-10-16T21:46:00Z") },
        scheduled: { key: "org-x:bot-intro", at: at("2026-10-18T17:04:00Z") },
      }),
    ).toBeNull();
  });

  it("nothing either way is null; one side alone is that side", () => {
    expect(pickLastBotDm({ queued: null, scheduled: null })).toBeNull();
    expect(pickLastBotDm({ queued: { text: "t", at: at("2026-10-18T00:00:00Z") }, scheduled: null })).toBe("t");
  });
});

describe("the line the model reads", () => {
  it("words go in quotes, capped; a description goes in as it is; nothing is 'not known'", () => {
    expect(lastBotDmLine("hi there")).toBe('"hi there"');
    expect(lastBotDmLine("x".repeat(400))).toBe(JSON.stringify("x".repeat(300)));
    expect(lastBotDmLine("(a Man of the Match vote)")).toBe("(a Man of the Match vote)");
    expect(lastBotDmLine(null)).toBe("(not known)");
  });
});

describe("loading it", () => {
  it("reads the player's newest queued DM by phone and newest scheduler DM by user", async () => {
    const seen: unknown[] = [];
    const db = {
      botJob: {
        findFirst: async (q: unknown) => {
          seen.push(q);
          return { text: "invite words", createdAt: new Date("2026-10-18T10:00:00Z"), sentAt: null };
        },
      },
      sentNotification: {
        findFirst: async (q: unknown) => {
          seen.push(q);
          return null;
        },
      },
    };
    expect(await loadLastBotDm(db, { phone: "447700900001", userId: "u1" })).toBe("invite words");
    expect(JSON.stringify(seen[0])).toContain('"phone":"447700900001"');
    expect(JSON.stringify(seen[1])).toContain('"targetUser":"u1"');
  });

  it("no phone: only the scheduler side is read", async () => {
    let botJobRead = false;
    const db = {
      botJob: {
        findFirst: async () => {
          botJobRead = true;
          return null;
        },
      },
      sentNotification: {
        findFirst: async () => ({ key: "m1:tentative-followup:u1", createdAt: new Date() }),
      },
    };
    expect(await loadLastBotDm(db, { phone: null, userId: "u1" })).toMatch(/whether they can play/);
    expect(botJobRead).toBe(false);
  });
});
