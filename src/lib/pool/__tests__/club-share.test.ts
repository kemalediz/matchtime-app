/**
 * A club's ONE share post (slice G3): the thin I/O half, with the database
 * stubbed. What it reads, what it claims, what it queues. The real
 * database, the real settings card and the scheduler poll are
 * e2e/sim/pool/club-share.spec.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  org: null as Row | null,
  campaigns: [] as Row[],
  claims: [] as Row[],
  jobs: [] as Row[],
}));

const p2002 = () => Object.assign(new Error("unique"), { code: "P2002" });

vi.mock("../../db", () => {
  const sentNotification = {
    findUnique: async ({ where }: { where: { key: string } }) => state.claims.find((c) => c.key === where.key) ?? null,
    create: async ({ data }: { data: Row }) => {
      if (state.claims.some((c) => c.key === data.key)) throw p2002();
      const row = { ...data, createdAt: new Date("2026-10-24T11:00:00Z") };
      state.claims.push(row);
      return row;
    },
  };
  const botJob = {
    create: async ({ data }: { data: Row }) => (state.jobs.push(data), { id: `job${state.jobs.length}` }),
    findFirst: async ({ where }: { where: Row }) =>
      state.jobs.find((j) => j.orgId === where.orgId && j.aboutKey === where.aboutKey) ?? null,
  };
  const poolCampaign = {
    findFirst: async ({ where }: { where: Row }) => state.campaigns.find((c) => c.source === where.source && c.orgId === where.orgId) ?? null,
    findUnique: async ({ where }: { where: { code: string } }) => state.campaigns.find((c) => c.code === where.code) ?? null,
    create: async ({ data }: { data: Row }) => {
      if (state.campaigns.some((c) => c.code === data.code)) throw p2002();
      state.campaigns.push(data);
      return data;
    },
  };
  return {
    db: {
      organisation: { findUnique: async () => state.org },
      sentNotification,
      botJob,
      poolCampaign,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        // All or nothing, as the database would: this transaction's own rows
        // are taken back if it fails, nobody else's.
        const mine: Row[] = [];
        const track = <T extends Row>(r: T) => (mine.push(r), r);
        try {
          return await fn({
            sentNotification: { create: async (a: { data: Row }) => track(await sentNotification.create(a)) },
            botJob: { create: async (a: { data: Row }) => (await botJob.create(a), track(state.jobs[state.jobs.length - 1])) },
          });
        } catch (err) {
          state.claims = state.claims.filter((r) => !mine.includes(r));
          state.jobs = state.jobs.filter((r) => !mine.includes(r));
          throw err;
        }
      },
    },
  };
});
vi.mock("../../app-url", () => ({ appBaseUrl: () => "https://matchtime.test" }));

import { ensureClubPoolCampaign } from "../campaigns";
import { loadClubShare, sendClubShare } from "../club-share";
import { poolSwitchEnv } from "../flags";

/** The platform switch on, as a request resolves it. */
const OPEN = poolSwitchEnv(true);

const ORG = {
  id: "org1",
  name: "FNF",
  slug: "fnf",
  language: "en",
  featurePlayerPool: true,
  whatsappGroupId: "120@g.us",
  whatsappBotEnabled: true,
  quietHoursEnabled: true,
  quietHoursFrom: "23:00",
  quietHoursTo: "09:00",
};
const NOON = new Date("2026-10-24T11:00:00Z"); // 12:00 London (BST)
const NIGHT = new Date("2026-10-24T22:30:00Z"); // 23:30 London

beforeEach(() => {
  state.org = { ...ORG };
  state.campaigns = [];
  state.claims = [];
  state.jobs = [];
});

describe("the club's campaign code (the G1 module)", () => {
  it("made once, source club, the club on it, its name as the label", async () => {
    expect(await ensureClubPoolCampaign(ORG)).toBe("https://matchtime.test/play?src=club-fnf");
    expect(await ensureClubPoolCampaign(ORG)).toBe("https://matchtime.test/play?src=club-fnf");
    expect(state.campaigns).toEqual([{ code: "club-fnf", source: "club", label: "FNF share post", orgId: "org1" }]);
  });

  it("a code someone else holds: the next number", async () => {
    state.campaigns.push({ code: "club-fnf", source: "other", label: "Kemal's", orgId: null });
    expect(await ensureClubPoolCampaign(ORG)).toBe("https://matchtime.test/play?src=club-fnf-2");
    expect(state.campaigns.find((c) => c.orgId === "org1")).toMatchObject({ code: "club-fnf-2", source: "club" });
  });
});

describe("sendClubShare", () => {
  it("in posting hours: one claim, one players' group post at once, in the club's language", async () => {
    expect(await sendClubShare("org1", NOON, OPEN)).toEqual({ ok: true, sendAfter: null });
    expect(state.claims.map((c) => [c.key, c.kind])).toEqual([["org-org1:pool-club-share", "pool-club-share"]]);
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toMatchObject({ orgId: "org1", kind: "group", sendAfter: null });
    // The post carries the claim's key, so the card can find it again.
    expect(state.jobs[0].aboutKey).toBe("org-org1:pool-club-share");
    expect(state.jobs[0].text).toContain("https://matchtime.test/play?src=club-fnf");
    expect(state.jobs[0].text).toContain("Play elsewhere too");
  });

  it("a Turkish club: the Turkish post", async () => {
    state.org = { ...ORG, language: "tr" };
    await sendClubShare("org1", NOON, OPEN);
    expect(state.jobs[0].text).toContain("Başka yerlerde de oyna");
  });

  it("inside the club's quiet hours: held until they end", async () => {
    const r = await sendClubShare("org1", NIGHT, OPEN);
    expect(r).toEqual({ ok: true, sendAfter: new Date("2026-10-25T09:00:00Z") }); // 09:00 London, GMT from 25 Oct
    expect(state.jobs[0].sendAfter).toEqual(new Date("2026-10-25T09:00:00Z"));
  });

  it("quiet hours off: at once, even at night", async () => {
    state.org = { ...ORG, quietHoursEnabled: false };
    expect(await sendClubShare("org1", NIGHT, OPEN)).toEqual({ ok: true, sendAfter: null });
  });

  it("a second tap, and two taps at once: nothing more", async () => {
    await sendClubShare("org1", NOON, OPEN);
    expect(await sendClubShare("org1", NOON, OPEN)).toEqual({ ok: false, reason: "already-sent" });
    state.claims = [];
    state.jobs = [];
    const both = await Promise.all([sendClubShare("org1", NOON, OPEN), sendClubShare("org1", NOON, OPEN)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(state.jobs).toHaveLength(1);
    expect(state.claims).toHaveLength(1);
  });

  it("the pool off: nothing claimed, nothing queued, no code made", async () => {
    state.org = { ...ORG, featurePlayerPool: false };
    expect(await sendClubShare("org1", NOON, OPEN)).toEqual({ ok: false, reason: "not-shown" });
    expect([state.claims, state.jobs, state.campaigns]).toEqual([[], [], []]);
  });

  it("no players' group, or the bot off for it: nothing claimed, so it can be sent once it is", async () => {
    for (const org of [{ ...ORG, whatsappGroupId: null }, { ...ORG, whatsappBotEnabled: false }]) {
      state.org = org;
      expect(await sendClubShare("org1", NOON, OPEN)).toEqual({ ok: false, reason: "no-group" });
    }
    expect([state.claims, state.jobs]).toEqual([[], []]);
    state.org = { ...ORG };
    expect((await sendClubShare("org1", NOON, OPEN)).ok).toBe(true);
  });

  it("no such club", async () => {
    state.org = null;
    expect(await sendClubShare("org1", NOON, OPEN)).toEqual({ ok: false, reason: "not-shown" });
  });

  it("the platform switch off: nothing claimed, nothing queued, even with the club's flag on", async () => {
    expect(await sendClubShare("org1", NOON, poolSwitchEnv(false))).toEqual({ ok: false, reason: "not-shown" });
    expect(await sendClubShare("org1", NOON, {})).toEqual({ ok: false, reason: "not-shown" });
    expect([state.claims, state.jobs]).toEqual([[], []]);
  });
});

describe("loadClubShare", () => {
  it("the pool off: no card", async () => {
    state.org = { ...ORG, featurePlayerPool: false };
    expect(await loadClubShare("org1", OPEN)).toBeNull();
  });

  it("ready: the exact post and its link, in the club's language", async () => {
    state.org = { ...ORG, language: "tr" };
    const card = await loadClubShare("org1", OPEN);
    expect(card).toMatchObject({ kind: "ready", url: "https://matchtime.test/play?src=club-fnf", language: "tr" });
    expect(card!.text).toContain("Başka yerlerde de oyna");
    expect(card!.statusLine).toBeNull();
  });

  it("no group: the post, and why it cannot be sent", async () => {
    state.org = { ...ORG, whatsappGroupId: null };
    expect(await loadClubShare("org1", OPEN)).toMatchObject({ kind: "no-group" });
  });

  it("tapped, the post not out yet: queued, and when it goes out", async () => {
    await sendClubShare("org1", NOON, OPEN);
    expect(await loadClubShare("org1", OPEN, NOON)).toMatchObject({ kind: "queued", statusLine: "Queued: goes out in a minute or two." });
  });

  it("tapped in quiet hours: queued until they end, with the date when that is another day", async () => {
    await sendClubShare("org1", NIGHT, OPEN);
    const card = await loadClubShare("org1", OPEN, NIGHT);
    expect(card).toMatchObject({ kind: "queued", statusLine: "Queued: goes out on 25 Oct 2026 at 09:00." });
    state.org = { ...ORG, language: "tr" };
    expect((await loadClubShare("org1", OPEN, new Date("2026-10-25T01:00:00Z")))!.statusLine).toBe("Sırada: 09:00'da gönderilecek.");
  });

  it("sent: the day the post went out, the same post", async () => {
    await sendClubShare("org1", NOON, OPEN);
    state.jobs[0].sentAt = new Date("2026-10-24T11:01:00Z");
    const card = await loadClubShare("org1", OPEN, NOON);
    expect(card).toMatchObject({ kind: "sent", statusLine: "Sent to your players' group on 24 Oct 2026." });
    expect(card!.text).toBe(state.jobs[0].text);
  });

  it("a claim from before the post carried its key: sent, on the claim's day", async () => {
    state.claims.push({ key: "org-org1:pool-club-share", kind: "pool-club-share", createdAt: new Date("2026-10-24T11:00:00Z") });
    expect(await loadClubShare("org1", OPEN, NOON)).toMatchObject({ kind: "sent", statusLine: "Sent to your players' group on 24 Oct 2026." });
  });
});
