/**
 * THE LATE RATING DM FOLLOWS THE CLUB'S MAN OF THE MATCH MODE (2026-10-18).
 *
 * A player added to a match after it was played gets a late rating DM
 * (addPlayerToMatch). It is the same message as the scheduler's rating DM
 * (bot-scheduler.ts, 6b), so it must take the same option: in a club where
 * the organisers pick Man of the Match (mom-chooser.ts, #317) it asks for
 * ratings only; in a club where the players vote it is unchanged.
 *
 * auth / db / next are mocked. No live DB, no model.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const botJobCreate = vi.fn();
const features = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "admin" } }) }));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/lib/player-account-guard", async () => {
  const { t } = await import("@/lib/i18n/t");
  return {
    playerEditContext: async () => ({ s: t("en"), refusal: null }),
    isClubOwnedUser: vi.fn(),
    loadOwnershipFacts: vi.fn(),
    clubOwnsUser: vi.fn(),
  };
});
vi.mock("@/lib/attendance-events", () => ({ recordAttendanceEvent: vi.fn() }));
vi.mock("@/lib/org-features", () => ({ getOrgFeatures: async () => features() }));
vi.mock("@/lib/magic-link", () => ({
  signMagicLinkToken: () => "tok",
  MAGIC_LINK_TTL: { rateMatch: 1, bookmark: 1 },
}));
vi.mock("@/lib/short-link", () => ({ buildShortMagicLinkUrl: async () => "https://mt.example/s/x" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const MATCH_DATE = new Date("2026-10-16T19:00:00Z");

vi.mock("@/lib/db", () => {
  const db = {
    match: {
      findUnique: async () => ({
        id: "m1",
        date: MATCH_DATE,
        status: "COMPLETED",
        activity: { name: "Friday Football", orgId: "o1", matchDurationMins: 60, sport: { mvpLabel: "Man of the Match" } },
      }),
    },
    user: { findUnique: async () => ({ id: "p1", phoneNumber: "+447700900001" }) },
    membership: { findUnique: async () => ({ id: "mem1", guestFromOrgId: null, leftAt: null }), create: vi.fn(), update: vi.fn() },
    attendance: {
      findFirst: async () => null,
      findUnique: async () => null,
      upsert: async () => ({ status: "CONFIRMED", position: 1 }),
    },
    sentNotification: { findUnique: async () => null, create: vi.fn() },
    botJob: { create: (a: unknown) => botJobCreate(a) },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { db };
});

import { addPlayerToMatch } from "../players";

async function lateDmText(): Promise<string> {
  const res = await addPlayerToMatch("m1", { userId: "p1" });
  expect(res).toMatchObject({ ok: true, ratingDmSent: true });
  expect(botJobCreate).toHaveBeenCalledTimes(1);
  return (botJobCreate.mock.calls[0][0] as { data: { text: string } }).data.text;
}

/** Only the fields the late DM reads (getOrgFeatures is mocked). */
const base = { playerRating: true };

describe("late rating DM (addPlayerToMatch) and the Man of the Match mode", () => {
  beforeEach(() => {
    botJobCreate.mockReset();
    features.mockReset();
  });

  it("organisers pick MoM, English: ratings only, no MoM ask", async () => {
    features.mockReturnValue({ ...base, language: "en", momChosenBy: "organisers" });
    const text = await lateDmText();
    expect(text).toContain("Rate your teammates. Takes ~1 minute.");
    expect(text).not.toContain("pick Man of the Match");
  });

  it("organisers pick MoM, Turkish: ratings only, no MoM vote ask", async () => {
    features.mockReturnValue({ ...base, language: "tr", momChosenBy: "organisers" });
    const text = await lateDmText();
    expect(text).toContain("Takım arkadaşlarına puan ver. Yaklaşık 1 dakika sürer.");
    expect(text).not.toContain("için de oyunu kullan");
  });

  it("players vote, English: unchanged, still asks to pick Man of the Match", async () => {
    features.mockReturnValue({ ...base, language: "en", momChosenBy: "players" });
    const text = await lateDmText();
    expect(text).toContain("Rate your teammates and pick Man of the Match. Takes ~1 minute.");
  });

  it("players vote, Turkish: unchanged, still asks for the MoM vote", async () => {
    features.mockReturnValue({ ...base, language: "tr", momChosenBy: "players" });
    const text = await lateDmText();
    expect(text).toContain("Takım arkadaşlarına puan ver, Man of the Match için de oyunu kullan.");
  });
});
