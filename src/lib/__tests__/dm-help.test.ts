/**
 * "help" by DM (2026-09-30).
 *
 * Kemal DMed MatchTime "help payments" after the first real self-setup and
 * got nothing useful: DM help did not exist. It now returns the SAME help
 * as the group (one builder, `buildHelpReply`), for the sender's club.
 * Whether a DM asks for help, and about what, is the shared question
 * extractor's (`readDmHelp`, 2026-10-28; the regex reader is gone):
 *
 *   - one club: that club;
 *   - several: the club they run, when they run exactly one; otherwise the
 *     club with the most recent match among the ones they run (or, running
 *     none, among all of them). The reply then names the club at the top.
 *
 * An organiser gets the admin lines with links that sign them straight in;
 * a player gets the player-facing text and no link.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const membershipFindMany = vi.fn();
const matchFindFirst = vi.fn();
const userFindUnique = vi.fn();
const botJobCreate = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    membership: { findMany: (...a: unknown[]) => membershipFindMany(...a) },
    match: { findFirst: (...a: unknown[]) => matchFindFirst(...a) },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    botJob: { create: (...a: unknown[]) => botJobCreate(...a) },
  },
}));

const getOrgFeatures = vi.fn();
vi.mock("@/lib/org-features", () => ({ getOrgFeatures: (...a: unknown[]) => getOrgFeatures(...a) }));

const buildAdminLink = vi.fn();
vi.mock("@/lib/admin-link", async (orig) => ({
  ...(await orig<typeof import("@/lib/admin-link")>()),
  buildAdminLink: (...a: unknown[]) => buildAdminLink(...a),
}));

const queuePlatformDm = vi.fn();
vi.mock("@/lib/platform-jobs", () => ({ queuePlatformDm: (...a: unknown[]) => queuePlatformDm(...a) }));

// The club's pool and partner clubs: both off unless a test says so.
const loadHelpClubFacts = vi.fn();
vi.mock("@/lib/help-club-facts", async (orig) => ({
  ...(await orig<typeof import("@/lib/help-club-facts")>()),
  loadHelpClubFacts: (...a: unknown[]) => loadHelpClubFacts(...a),
}));

import { readDmHelp, handleDmHelp } from "@/lib/dm-help";
import { buildHelpReply } from "@/lib/onboarding-conversation";
import { HELP_CLUB_FACTS_OFF } from "@/lib/help-club-facts";
import type { PipelineModel } from "@/lib/pipeline/llm";
import type { HelpRequest } from "@/lib/pipeline/types";

const FEATS_PAY_OFF = {
  botEnabled: true,
  attendance: true,
  bench: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  reminders: true,
  statsQa: true,
  paymentTracking: false,
  paymentCollection: false,
  squadFromList: false,
  language: "en" as const,
};

function mem(orgId: string, role: "OWNER" | "ADMIN" | "PLAYER", name = orgId, language = "en") {
  return { orgId, role, org: { id: orgId, name, language } };
}

beforeEach(() => {
  vi.clearAllMocks();
  userFindUnique.mockResolvedValue({ phoneNumber: "+447700900001" });
  getOrgFeatures.mockResolvedValue(FEATS_PAY_OFF);
  matchFindFirst.mockResolvedValue(null);
  loadHelpClubFacts.mockResolvedValue(HELP_CLUB_FACTS_OFF);
  buildAdminLink.mockImplementation(async ({ nextPath }: { nextPath: string }) => `https://mt.example/r/${nextPath.replace(/\W+/g, "-")}`);
});

/** A model that answers the question extractor with these fields. */
function questionModel(fields: Record<string, unknown> | Error): PipelineModel & { calls: number } {
  const m = {
    name: "fake",
    calls: 0,
    async complete() {
      m.calls++;
      if (fields instanceof Error) throw fields;
      const raw = { topic: "other", personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top", period: "none", periodCount: -1, periodUnit: "none", feature: "none", badge: "none", ...fields };
      return { text: JSON.stringify(raw), stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
    },
  };
  return m as PipelineModel & { calls: number };
}

describe("readDmHelp: the question extractor reads it (2026-10-28)", () => {
  const read = (text: string, model: PipelineModel) => readDmHelp({ text, authorName: "Kemal", now: new Date(), model });

  it("how_it_works with a topic: that topic", async () => {
    expect(await read("how do I turn on the player pool?", questionModel({ topic: "how_it_works", feature: "pool" }))).toEqual({ topic: "pool" });
    expect(await read("havuz nasıl açılır", questionModel({ topic: "how_it_works", feature: "pool" }))).toEqual({ topic: "pool" });
  });

  it("how_it_works with no part: the menu", async () => {
    expect(await read("help", questionModel({ topic: "how_it_works" }))).toEqual({ topic: null });
  });

  it("a badge question carries the badge", async () => {
    expect(await read("help badges Mr Reliable", questionModel({ topic: "how_it_works", feature: "badges", badge: "reliable" }))).toEqual({ topic: "badges", badge: "reliable" });
  });

  it("any other question is not help: null, and the DM carries on", async () => {
    expect(await read("who's in?", questionModel({ topic: "squad" }))).toBeNull();
    expect(await read("Paid", questionModel({ topic: "other" }))).toBeNull();
  });

  it("a failed call is not help: null", async () => {
    expect(await read("help", questionModel(new Error("529 Overloaded")))).toBeNull();
  });

  it("an empty DM makes no call", async () => {
    const m = questionModel({ topic: "how_it_works" });
    expect(await read("   ", m)).toBeNull();
    expect(m.calls).toBe(0);
  });
});

describe("handleDmHelp", () => {
  // What the extractor read from each DM (readDmHelp, above).
  const READ: Record<string, HelpRequest> = {
    help: { topic: null },
    yardım: { topic: null },
    "help payments": { topic: "payments" },
    "yardım ödeme": { topic: "payments" },
    "help teams": { topic: "teams" },
    "help badges": { topic: "badges" },
    "help badges Mr Reliable": { topic: "badges", badge: "reliable" },
  };
  const args = (text: string) => ({ userId: "u1", req: READ[text], envelopePhone: "+447700900001" });

  it("no active approved club → null (falls through)", async () => {
    membershipFindMany.mockResolvedValue([]);
    expect(await handleDmHelp(args("help"))).toBeNull();
    expect(botJobCreate).not.toHaveBeenCalled();
  });

  it("an organiser asking 'help payments' with payments off: the admin text with a signed-in settings link", async () => {
    membershipFindMany.mockResolvedValue([mem("org-mt", "OWNER", "MT Test")]);
    const out = await handleDmHelp(args("help payments"));
    expect(out).toMatchObject({ handled: "dm-help", topic: "payments", orgId: "org-mt", audience: "admin" });
    expect(buildAdminLink).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", orgId: "org-mt", nextPath: "/admin/settings#payments" }),
    );
    const job = botJobCreate.mock.calls[0][0].data;
    expect(job).toMatchObject({ orgId: "org-mt", kind: "dm", phone: "447700900001" });
    expect(job.text).toBe(
      buildHelpReply("payments", FEATS_PAY_OFF, "en", {
        audience: "admin",
        links: { topic: "https://mt.example/r/-admin-settings-payments" },
      }),
    );
  });

  // Item 4: the help says "tag me" and "say In or Out", and the group of a
  // club that is setting up is one MatchTime is not listening to yet.
  it("deliver: 'platform' (a club that is setting up): the SAME help, under one paragraph saying nothing below works until GO; nothing on the club's channel", async () => {
    membershipFindMany.mockResolvedValue([mem("org-mt", "OWNER", "MT Test")]);
    const out = await handleDmHelp({ ...args("help payments"), deliver: "platform" });
    expect(out).toMatchObject({ handled: "dm-help", topic: "payments", orgId: "org-mt", audience: "admin" });
    expect(botJobCreate).not.toHaveBeenCalled();
    expect(queuePlatformDm).toHaveBeenCalledTimes(1);
    const job = queuePlatformDm.mock.calls[0][0];
    expect(job).toMatchObject({ phone: "+447700900001", purpose: "setup-reply", refId: "org-mt:help" });
    expect(job.sendAfter).toBeUndefined();
    const help = buildHelpReply("payments", FEATS_PAY_OFF, "en", {
      audience: "admin",
      links: { topic: "https://mt.example/r/-admin-settings-payments" },
    });
    expect(job.text).toBe(
      "MatchTime hasn't started in your group yet. Nothing below works there until you reply *GO* here or press *Go live* on your settings page." +
        `\n\n${help}`,
    );
  });

  it("that paragraph is in the club's language (Turkish: BAŞLA), and still a prefix, not a replacement", async () => {
    getOrgFeatures.mockResolvedValue({ ...FEATS_PAY_OFF, language: "tr" });
    membershipFindMany.mockResolvedValue([mem("org-tr", "OWNER", "Kıyı SK", "tr")]);
    await handleDmHelp({ ...args("yardım"), deliver: "platform" });
    const text = queuePlatformDm.mock.calls[0][0].text as string;
    const prefix =
      "MatchTime grubunuzda henüz başlamadı. Buraya *BAŞLA* yazana ya da ayarlar sayfanızdaki *Yayına al* düğmesine basana kadar aşağıdakilerin hiçbiri grupta çalışmaz.";
    expect(text.startsWith(`${prefix}\n\n`)).toBe(true);
    expect(text.length).toBeGreaterThan(prefix.length + 80);
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  it("the default is still the club's own channel, never the platform one, and has no such paragraph", async () => {
    membershipFindMany.mockResolvedValue([mem("org-mt", "OWNER", "MT Test")]);
    await handleDmHelp(args("help"));
    expect(botJobCreate).toHaveBeenCalledTimes(1);
    expect(botJobCreate.mock.calls[0][0].data.text).not.toContain("hasn't started in your group");
    expect(queuePlatformDm).not.toHaveBeenCalled();
  });

  it("a player asking 'help payments': the player text, no link minted", async () => {
    membershipFindMany.mockResolvedValue([mem("org-mt", "PLAYER", "MT Test")]);
    const out = await handleDmHelp(args("help payments"));
    expect(out).toMatchObject({ audience: "player" });
    expect(buildAdminLink).not.toHaveBeenCalled();
    const text = botJobCreate.mock.calls[0][0].data.text as string;
    expect(text).toBe(buildHelpReply("payments", FEATS_PAY_OFF, "en", { audience: "player" }));
    expect(text).not.toMatch(/https?:\/\//);
  });

  // 2026-10-15: a club whose organisers announce the list and teams.
  describe("an organisers-mode club (listAnnouncer 'organisers', organiser pick)", () => {
    const FNF = { ...FEATS_PAY_OFF, listAnnouncer: "organisers", benchPickMode: "organiser" };
    const POINTER = "In your admin group, tag me and ask what I can do there, in your own words (for example *@Match Time what can you do?*).";

    it("an organiser's bare help points at the admin group's commands, and keeps the settings link", async () => {
      getOrgFeatures.mockResolvedValue(FNF);
      membershipFindMany.mockResolvedValue([{ ...mem("org-fnf", "OWNER", "FNF"), org: { id: "org-fnf", name: "FNF", language: "en", adminGroupId: "hq@g.us" } }]);
      await handleDmHelp(args("help"));
      const text = botJobCreate.mock.calls[0][0].data.text as string;
      expect(text).toContain(POINTER);
      expect(text.endsWith("⚙️ Your club's settings, signed in:\nhttps://mt.example/r/-admin-settings")).toBe(true);
      expect(membershipFindMany.mock.calls[0][0].select.org.select).toMatchObject({ adminGroupId: true });
    });

    it("no admin group linked: no pointer to one", async () => {
      getOrgFeatures.mockResolvedValue(FNF);
      membershipFindMany.mockResolvedValue([mem("org-fnf", "OWNER", "FNF")]);
      await handleDmHelp(args("help"));
      expect(botJobCreate.mock.calls[0][0].data.text).not.toContain(POINTER);
    });

    it("a player's DM help never gets it, and says the organisers share the teams", async () => {
      getOrgFeatures.mockResolvedValue(FNF);
      membershipFindMany.mockResolvedValue([{ ...mem("org-fnf", "PLAYER", "FNF"), org: { id: "org-fnf", name: "FNF", language: "en", adminGroupId: "hq@g.us" } }]);
      await handleDmHelp(args("help teams"));
      const text = botJobCreate.mock.calls[0][0].data.text as string;
      expect(text).not.toContain(POINTER);
      expect(text).toContain("The organisers sort out the teams");
    });
  });

  it("group and DM agree: a player's bare help is the group's bare help", async () => {
    membershipFindMany.mockResolvedValue([mem("org-mt", "PLAYER")]);
    await handleDmHelp(args("help"));
    expect(botJobCreate.mock.calls[0][0].data.text).toBe(buildHelpReply(null, FEATS_PAY_OFF, "en"));
  });

  it("'help badges Mr Reliable' (an admin too): that badge's rules, plain drill-down, no link minted", async () => {
    membershipFindMany.mockResolvedValue([mem("org-mt", "OWNER", "MT Test")]);
    const out = await handleDmHelp(args("help badges Mr Reliable"));
    expect(out).toMatchObject({ handled: "dm-help", topic: "badges", audience: "admin" });
    expect(buildAdminLink).not.toHaveBeenCalled();
    const text = botJobCreate.mock.calls[0][0].data.text as string;
    expect(text.startsWith("🧱 *Mr Reliable*")).toBe(true);
    expect(text).toContain("1. Rated in at least 4 games.");
    await handleDmHelp(args("help badges"));
    expect(botJobCreate.mock.calls[1][0].data.text).toContain("*help badges Mr Reliable*");
  });

  it("the club's language decides the reply's language", async () => {
    membershipFindMany.mockResolvedValue([mem("org-tr", "PLAYER", "Cuma", "tr")]);
    getOrgFeatures.mockResolvedValue({ ...FEATS_PAY_OFF, language: "tr" });
    await handleDmHelp(args("yardım ödeme"));
    expect(botJobCreate.mock.calls[0][0].data.text).toContain("Maç ücretleri nasıl çalışır");
  });

  it("several clubs, runs exactly one: answers for that one and names it", async () => {
    membershipFindMany.mockResolvedValue([mem("org-a", "PLAYER", "Sutton FC"), mem("org-b", "OWNER", "MT Test")]);
    const out = await handleDmHelp(args("help"));
    expect(out).toMatchObject({ orgId: "org-b", audience: "admin" });
    expect(botJobCreate.mock.calls[0][0].data.text.startsWith("🏟️ For *MT Test*:\n\n")).toBe(true);
  });

  it("review fix 2: runs a club that is still SETTING UP and plays in a live one: the answer is for the LIVE club", async () => {
    const held = { ...mem("org-held", "OWNER", "Harbour FC"), org: { id: "org-held", name: "Harbour FC", language: "en", approvalStatus: "approved", setupStage: "setting-up" } };
    const liveClub = { ...mem("org-a", "PLAYER", "Sutton FC"), org: { id: "org-a", name: "Sutton FC", language: "en", approvalStatus: "approved", setupStage: "live" } };
    membershipFindMany.mockResolvedValue([held, liveClub]);
    const out = await handleDmHelp(args("help"));
    expect(out).toMatchObject({ orgId: "org-a", audience: "player" });
    expect(botJobCreate.mock.calls[0][0].data.orgId).toBe("org-a");
    // The stage is selected with the membership: no extra query.
    expect(membershipFindMany.mock.calls[0][0].select.org.select).toMatchObject({ approvalStatus: true, setupStage: true });
  });

  it("review fix 2: someone whose ONLY club is setting up still gets the help for it (slice S4 delivers it)", async () => {
    membershipFindMany.mockResolvedValue([
      { ...mem("org-held", "OWNER", "Harbour FC"), org: { id: "org-held", name: "Harbour FC", language: "en", approvalStatus: "approved", setupStage: "setting-up" } },
    ]);
    expect(await handleDmHelp(args("help"))).toMatchObject({ orgId: "org-held", audience: "admin" });
  });

  it("several clubs, runs none: the club with the most recent match, named", async () => {
    membershipFindMany.mockResolvedValue([mem("org-a", "PLAYER", "Sutton FC"), mem("org-b", "PLAYER", "MT Test")]);
    matchFindFirst.mockResolvedValue({ activity: { orgId: "org-a" } });
    const out = await handleDmHelp(args("help"));
    expect(out).toMatchObject({ orgId: "org-a", audience: "player" });
    expect(botJobCreate.mock.calls[0][0].data.text.startsWith("🏟️ For *Sutton FC*:")).toBe(true);
  });

  it("replies to the envelope phone; a signed-in link only when that IS the account's own phone", async () => {
    membershipFindMany.mockResolvedValue([mem("org-mt", "OWNER")]);
    userFindUnique.mockResolvedValue({ phoneNumber: "+447700999999" });
    const out = await handleDmHelp(args("help payments"));
    expect(out).toMatchObject({ audience: "admin" });
    expect(buildAdminLink).not.toHaveBeenCalled();
    const job = botJobCreate.mock.calls[0][0].data;
    expect(job.phone).toBe("447700900001");
    expect(job.text).toContain("https://matchtime.ai/admin/settings");
    expect(job.text).not.toContain("mt.example/r/");
  });

  it("no phone to reply to → null", async () => {
    membershipFindMany.mockResolvedValue([mem("org-mt", "PLAYER")]);
    userFindUnique.mockResolvedValue({ phoneNumber: null });
    expect(await handleDmHelp({ userId: "u1", req: { topic: null }, envelopePhone: "" })).toBeNull();
    expect(botJobCreate).not.toHaveBeenCalled();
  });
});
