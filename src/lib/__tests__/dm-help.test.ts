/**
 * "help" by DM (2026-09-30).
 *
 * Kemal DMed MatchTime "help payments" after the first real self-setup and
 * got nothing useful: DM help did not exist. It now returns the SAME
 * deterministic help as the group (one builder, `buildHelpReply`), with no
 * model call, for the sender's club:
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

import { readHelpRequest, handleDmHelp } from "@/lib/dm-help";
import { buildHelpReply } from "@/lib/onboarding-conversation";

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
  buildAdminLink.mockImplementation(async ({ nextPath }: { nextPath: string }) => `https://mt.example/r/${nextPath.replace(/\W+/g, "-")}`);
});

describe("readHelpRequest", () => {
  it.each([
    ["help", null],
    ["Help", null],
    ["HELP PAYMENTS", "payments"],
    ["help payments", "payments"],
    ["@Match Time help teams", "teams"],
    ["yardım ödeme", "payments"],
    ["YARDIM", null],
    ["help ratings", "ratings"],
  ])("DM %j → a help request, topic %j", (body, topic) => {
    expect(readHelpRequest(body, { dm: true })).toEqual({ topic });
  });

  it.each([
    "help me I can't make Tuesday",
    "can you help",
    "Paid",
    "help, I paid but it says I owe",
    "help me out",
  ])("DM %j is NOT a help request (it goes to the handlers below)", (body) => {
    expect(readHelpRequest(body, { dm: true })).toBeNull();
  });

  it("in the group the wider shape still reads as help (the tag gate is the caller's)", () => {
    expect(readHelpRequest("@Match Time help me out", { dm: false })).toEqual({ topic: null });
  });
});

describe("handleDmHelp", () => {
  const args = (text: string) => ({ userId: "u1", text, envelopePhone: "+447700900001" });

  it("not a help request → null, nothing written", async () => {
    expect(await handleDmHelp(args("I'm in"))).toBeNull();
    expect(botJobCreate).not.toHaveBeenCalled();
  });

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
      expect.objectContaining({ userId: "u1", orgId: "org-mt", nextPath: "/admin/settings" }),
    );
    const job = botJobCreate.mock.calls[0][0].data;
    expect(job).toMatchObject({ orgId: "org-mt", kind: "dm", phone: "447700900001" });
    expect(job.text).toBe(
      buildHelpReply("payments", FEATS_PAY_OFF, "en", {
        audience: "admin",
        links: { settings: "https://mt.example/r/-admin-settings" },
      }),
    );
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
    expect(await handleDmHelp({ userId: "u1", text: "help", envelopePhone: "" })).toBeNull();
    expect(botJobCreate).not.toHaveBeenCalled();
  });
});
