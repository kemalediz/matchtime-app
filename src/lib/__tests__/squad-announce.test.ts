/**
 * The "Squad complete" post, and the bench invitation it now ends with.
 *
 * WHY THIS TEST EXISTS (2026-09-16, Sutton FC, live): the bot posted
 *
 *   ✅ *Squad complete — 14/14* for *Tuesday 7-a-side* on Tue 22 Sept 21:30 🙌
 *
 * with the line-up, and then the OWNER had to post "can we have more
 * players for bench please?" himself. His words: "i shouldn't be asking
 * this. When squad complete, MT should just show the squad and ask for
 * benchers to continue the INs flowing."
 *
 * So with `featureBench` on, the post ends with the bench invitation, in
 * the SAME message (the group has had too many bot messages; a second
 * post is not an option). With the feature off the post is byte-identical
 * to what it was, pinned here against the exact string.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const matchFindUnique = vi.fn();
const sentCreate = vi.fn();
const botJobCreate = vi.fn();
const getOrgFeatures = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    match: { findUnique: (...a: unknown[]) => matchFindUnique(...a) },
    sentNotification: { create: (...a: unknown[]) => sentCreate(...a) },
    botJob: { create: (...a: unknown[]) => botJobCreate(...a) },
  },
}));
vi.mock("@/lib/org-features", () => ({
  getOrgFeatures: (...a: unknown[]) => getOrgFeatures(...a),
}));

import { announceSquadFullIfJustFilled } from "@/lib/squad-announce";
import {
  BENCH_PROMPT_MENTION_REACTIONS,
  buildSquadCompleteBenchInvite,
} from "@/lib/bench-offer-copy";

const ORG = "org-sutton";
const NAMES = [
  "Elvin Aliyev", "Sait Demir", "Mustafa Kaya", "Abid Hussain", "Idris Bello",
  "Faris Nasser", "Shaz Iqbal", "Adam Osman", "Efat Rahman", "Usama Tariq",
  "Karahan Yildiz", "Zair Malik", "Wasim Akhtar", "Habib Rahimi",
];

function matchRow(bench: string[] = []) {
  return {
    id: "m1",
    maxPlayers: 14,
    // Tue 22 Sept 2026, 21:30 London (BST, UTC+1).
    date: new Date("2026-09-22T20:30:00Z"),
    activity: { name: "Tuesday 7-a-side", orgId: ORG },
    attendances: [
      ...NAMES.map((name, i) => ({ status: "CONFIRMED", position: i + 1, user: { name } })),
      ...bench.map((name, i) => ({ status: "BENCH", position: 20 + i, user: { name } })),
    ],
    // No team sheet: every case in THIS file is the squad filling before
    // the teams are generated, which is the only time this function has
    // ever spoken. The 2026-09-15 rule ("once the teams are out, nobody
    // posts the roster") is exercised in
    // `no-roster-after-teams.test.ts`, where this array is non-empty.
    teamAssignments: [],
  };
}

const ROSTER = NAMES.map((n, i) => `${i + 1}. ${n}`).join("\n");

/** The post as it was before this change, byte for byte. */
const TODAY =
  `✅ *Squad complete — 14/14* for *Tuesday 7-a-side* on Tue 22 Sept 21:30 🙌\n\n` +
  `*Playing:*\n${ROSTER}\n\nSee you all there ⚽`;

const INVITE_NO_REACTIONS =
  "🪑 *Bench is open.* Say *IN* and I'll put you on the bench. " +
  "If someone drops out I tag the bench here and the first to reply *IN* takes the slot.";

function features(bench: boolean) {
  return { botEnabled: true, attendance: true, bench };
}

async function postedText(): Promise<string> {
  expect(botJobCreate).toHaveBeenCalledTimes(1);
  return botJobCreate.mock.calls[0][0].data.text as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  sentCreate.mockResolvedValue({});
  botJobCreate.mockResolvedValue({});
});

describe("announceSquadFullIfJustFilled: bench feature OFF", () => {
  it("posts exactly today's text, byte for byte", async () => {
    matchFindUnique.mockResolvedValue(matchRow());
    getOrgFeatures.mockResolvedValue(features(false));
    await announceSquadFullIfJustFilled("m1");
    expect(await postedText()).toBe(TODAY);
  });

  it("stays byte-identical with a bench block too", async () => {
    matchFindUnique.mockResolvedValue(matchRow(["Najib Ahmadi"]));
    getOrgFeatures.mockResolvedValue(features(false));
    await announceSquadFullIfJustFilled("m1");
    expect(await postedText()).toBe(
      `✅ *Squad complete — 14/14* for *Tuesday 7-a-side* on Tue 22 Sept 21:30 🙌\n\n` +
        `*Playing:*\n${ROSTER}\n\n*Bench (1):*\n1. Najib Ahmadi\n\nSee you all there ⚽`,
    );
  });

  it("falls back to today's text when the feature lookup fails", async () => {
    // The announcement is claimed atomically and never retried, so a
    // failed lookup must not cost the group its squad post.
    matchFindUnique.mockResolvedValue(matchRow());
    getOrgFeatures.mockRejectedValue(new Error("db down"));
    await announceSquadFullIfJustFilled("m1");
    expect(await postedText()).toBe(TODAY);
  });
});

describe("announceSquadFullIfJustFilled: bench feature ON", () => {
  it("ends with the bench invitation, in the SAME message", async () => {
    matchFindUnique.mockResolvedValue(matchRow());
    getOrgFeatures.mockResolvedValue(features(true));
    await announceSquadFullIfJustFilled("m1");
    const text = await postedText();
    expect(text).toBe(`${TODAY}\n\n${buildSquadCompleteBenchInvite()}`);
    expect(text.endsWith(buildSquadCompleteBenchInvite())).toBe(true);
    // Exactly one post: no second message for the invite.
    expect(botJobCreate).toHaveBeenCalledTimes(1);
  });

  it("renders Sutton's current post (reactions gate OFF) exactly", async () => {
    expect(BENCH_PROMPT_MENTION_REACTIONS).toBe(false);
    matchFindUnique.mockResolvedValue(matchRow());
    getOrgFeatures.mockResolvedValue(features(true));
    await announceSquadFullIfJustFilled("m1");
    expect(await postedText()).toBe(`${TODAY}\n\n${INVITE_NO_REACTIONS}`);
  });

  it("still reads naturally after an existing Bench block", async () => {
    matchFindUnique.mockResolvedValue(matchRow(["Najib Ahmadi", "Mojib Sadat"]));
    getOrgFeatures.mockResolvedValue(features(true));
    await announceSquadFullIfJustFilled("m1");
    expect(await postedText()).toBe(
      `✅ *Squad complete — 14/14* for *Tuesday 7-a-side* on Tue 22 Sept 21:30 🙌\n\n` +
        `*Playing:*\n${ROSTER}\n\n*Bench (2):*\n1. Najib Ahmadi\n2. Mojib Sadat\n\n` +
        `See you all there ⚽\n\n${INVITE_NO_REACTIONS}`,
    );
  });

  it("does not repeat the count: the roster header already states it", async () => {
    matchFindUnique.mockResolvedValue(matchRow());
    getOrgFeatures.mockResolvedValue(features(true));
    await announceSquadFullIfJustFilled("m1");
    const text = await postedText();
    expect(text.match(/14\/14/g)).toHaveLength(1);
    expect(text).not.toContain("14 of 14");
  });

  it("posts nothing, and checks nothing, while the squad is still short", async () => {
    const row = matchRow();
    row.attendances = row.attendances.slice(1);
    matchFindUnique.mockResolvedValue(row);
    getOrgFeatures.mockResolvedValue(features(true));
    await announceSquadFullIfJustFilled("m1");
    expect(botJobCreate).not.toHaveBeenCalled();
    expect(sentCreate).not.toHaveBeenCalled();
  });

  it("posts nothing when another confirm already announced this fill", async () => {
    matchFindUnique.mockResolvedValue(matchRow());
    getOrgFeatures.mockResolvedValue(features(true));
    sentCreate.mockRejectedValue(new Error("P2002"));
    await announceSquadFullIfJustFilled("m1");
    expect(botJobCreate).not.toHaveBeenCalled();
  });
});

describe("buildSquadCompleteBenchInvite: the closing line", () => {
  it("never tells anyone to react while the gate is off", () => {
    const text = buildSquadCompleteBenchInvite({ mentionReactions: false });
    expect(text).toBe(INVITE_NO_REACTIONS);
    expect(text).not.toMatch(/\breact\b/i);
    expect(text).not.toMatch(/\btap\b/i);
    expect(text).not.toContain("👍");
  });

  it("offers the 👍 again the moment the gate is flipped back on", () => {
    expect(buildSquadCompleteBenchInvite({ mentionReactions: true })).toBe(
      "🪑 *Bench is open.* Say *IN* and I'll put you on the bench. " +
        "If someone drops out I tag the bench here and the first to react 👍 or reply *IN* takes the slot.",
    );
  });

  it("defaults to the flag, so production copy cannot drift from it", () => {
    expect(buildSquadCompleteBenchInvite()).toBe(
      buildSquadCompleteBenchInvite({ mentionReactions: BENCH_PROMPT_MENTION_REACTIONS }),
    );
  });

  it("uses no em dashes, en dashes or slashes (house style)", () => {
    for (const on of [false, true]) {
      const text = buildSquadCompleteBenchInvite({ mentionReactions: on });
      expect(text).not.toContain("—");
      expect(text).not.toContain("–");
      expect(text).not.toContain("/");
    }
  });
});
