/**
 * "Getting <club> ready" at GO (admin-onboarding.ts `queueGettingReady`)
 * and the mark script's helper (`markAdminOnboardingSent`), with Prisma
 * and the admin channel mocked. The real path against Postgres is
 * e2e/api/admin-onboarding.spec.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const claims = new Set<string>();
const state = {
  org: null as Record<string, unknown> | null,
  matches: [] as Array<{ id: string; date: Date; status: string }>,
  activities: [] as Array<{ dayOfWeek: number }>,
  channelMode: "admin-group",
  adminGroupId: "admins@g.us" as string | null,
  postable: true,
  queued: 1,
};
const sent: Array<{ text: string; nextPath: string | null | undefined; link: string; audience: "dm" | "group" }> = [];

vi.mock("@/lib/db", () => ({
  db: {
    organisation: {
      findUnique: async () => state.org,
      findFirst: async (a: { where: { OR: Array<{ id?: string; slug?: string }> } }) =>
        a.where.OR.some((w) => w.id === "org-fnf" || w.slug === "fnf") ? { id: "org-fnf", name: "FNF" } : null,
    },
    match: { findMany: async () => state.matches },
    activity: { findMany: async () => state.activities },
    sentNotification: {
      createMany: async (a: { data: Array<{ key: string }>; skipDuplicates: boolean }) => {
        let count = 0;
        for (const d of a.data) if (!claims.has(d.key)) (claims.add(d.key), count++);
        return { count };
      },
      deleteMany: async (a: { where: { key: string } }) => ({ count: claims.delete(a.where.key) ? 1 : 0 }),
      findMany: async (a: { where: { key: { in: string[] } } }) => a.where.key.in.filter((k) => claims.has(k)).map((key) => ({ key })),
    },
  },
}));

vi.mock("@/lib/admin-channel", async (orig) => ({
  ...(await orig<object>()),
  loadAdminChannel: async () => ({
    orgId: "org-fnf",
    orgName: "FNF",
    language: "en",
    cfg: { mode: state.channelMode, channelUserId: null, adminGroupId: state.adminGroupId },
    admins: [],
    adminGroupPostable: state.postable,
  }),
  sendAdminNotice: async (req: { text: (link: string, aud: "dm" | "group") => string; nextPath?: string | null }) => {
    const group = state.channelMode === "admin-group" && !!state.adminGroupId && state.postable;
    const audience = group ? "group" : "dm";
    const link = req.nextPath ? `https://link.example${req.nextPath}` : "";
    if (state.queued > 0) sent.push({ text: req.text(link, audience), nextPath: req.nextPath, link, audience });
    return { channel: group ? "admin-group" : "dm", queued: state.queued };
  },
}));

import { markAdminOnboardingSent, queueGettingReady } from "../admin-onboarding";

const NOW = new Date("2026-10-15T19:00:00.000Z"); // Thu 20:00 London
const FRI = new Date("2026-10-16T20:00:00.000Z");

const FNF_ROW = {
  name: "FNF",
  language: "en",
  squadMode: "weekly",
  featureAttendance: true,
  listAnnouncer: "organisers",
  benchPickMode: "organiser",
  paymentCollectionEnabled: false,
  paymentHolderId: null,
};

beforeEach(() => {
  claims.clear();
  sent.length = 0;
  Object.assign(state, {
    org: { ...FNF_ROW },
    matches: [{ id: "m1", date: FRI, status: "UPCOMING" }],
    activities: [{ dayOfWeek: 5 }],
    channelMode: "admin-group",
    adminGroupId: "admins@g.us",
    postable: true,
    queued: 1,
  });
});

describe("queueGettingReady", () => {
  it("FNF at GO: claims the key and queues the checklist to the admin group, once", async () => {
    const r = await queueGettingReady("org-fnf", NOW);
    expect(r).toMatchObject({ status: "queued", channel: "admin-group", queued: 1 });
    expect(claims.has("org-org-fnf:getting-ready")).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("🧰 *Getting FNF ready*");
    expect(sent[0].text).toContain("Paste the squad list for Friday's game here now.");
    expect(sent[0].nextPath).toBeNull();

    expect(await queueGettingReady("org-fnf", NOW)).toEqual({ status: "already" });
    expect(sent).toHaveLength(1);
  });

  it("the collector line carries the Settings link (signed in by DM, plain in the group)", async () => {
    state.org = { ...FNF_ROW, paymentCollectionEnabled: true };
    await queueGettingReady("org-fnf", NOW);
    expect(sent[0].nextPath).toBe("/admin/settings");
    expect(sent[0].text).toContain("Pick your *Money collector* in Settings, so I know who to ask how much each player owes after a match:\nhttps://link.example/admin/settings");
  });

  it("by DM with nothing to do: no message and no claim", async () => {
    state.channelMode = "each-admin";
    state.adminGroupId = null;
    expect(await queueGettingReady("org-fnf", NOW)).toEqual({ status: "nothing-to-say" });
    expect(claims.size).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("an admin group MatchTime cannot post in counts as DM", async () => {
    state.postable = false;
    state.org = { ...FNF_ROW, paymentCollectionEnabled: true };
    const r = await queueGettingReady("org-fnf", NOW);
    expect(r).toMatchObject({ status: "queued", channel: "dm" });
    expect(sent[0].audience).toBe("dm");
    expect(sent[0].text).not.toContain("Paste");
    expect(sent[0].text).toContain("Message me *help*");
  });

  it("nobody to tell: the claim is released", async () => {
    state.queued = 0;
    expect(await queueGettingReady("org-fnf", NOW)).toEqual({ status: "no-recipient" });
    expect(claims.size).toBe(0);
  });

  it("never throws", async () => {
    state.org = null;
    expect(await queueGettingReady("org-missing", NOW)).toEqual({ status: "no-club" });
  });
});

describe("markAdminOnboardingSent", () => {
  it("dry run by default writes nothing; apply claims both keys; a second apply changes nothing", async () => {
    const dry = await markAdminOnboardingSent({ arg: "fnf", apply: false });
    expect(dry).toEqual({
      status: "dry-run",
      orgId: "org-fnf",
      club: "FNF",
      keys: ["org-org-fnf:getting-ready", "org-org-fnf:first-teams"],
      alreadyClaimed: [],
    });
    expect(claims.size).toBe(0);
    const applied = await markAdminOnboardingSent({ arg: "org-fnf", apply: true });
    expect(applied.status).toBe("marked");
    expect([...claims].sort()).toEqual(["org-org-fnf:first-teams", "org-org-fnf:getting-ready"]);
    const again = await markAdminOnboardingSent({ arg: "fnf", apply: true });
    expect(again).toMatchObject({ status: "marked", alreadyClaimed: ["org-org-fnf:getting-ready", "org-org-fnf:first-teams"] });
    // Claimed, so GO would not send A.
    expect(await queueGettingReady("org-fnf", NOW)).toEqual({ status: "already" });
  });

  it("an unknown club", async () => {
    expect(await markAdminOnboardingSent({ arg: "nope", apply: true })).toEqual({ status: "no-club", arg: "nope" });
  });
});
