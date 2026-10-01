/**
 * THE ADMIN NOTICE WHEN A CLUB REACHES ITS DAILY AI CAP (Kemal, 2026-10-01).
 *
 *   - once per club per London day, claimed by `<orgId>:ai-cap:<YYYY-MM-DD>`
 *     (a SentNotification unique key), so any number of refused calls in
 *     the same flush, or in racing flushes, queue ONE notice;
 *   - through `sendAdminNotice`, the admin channel's one door (one person,
 *     the admin group, or each admin), never the platform owner;
 *   - never for a club that is unapproved, dormant, muted or has no group;
 *   - never after 22:00 London: it would be held to 08:00 and arrive the
 *     next day talking about a day that is over;
 *   - a failed queue releases the claim so a later trip can try again.
 *
 * Prisma and the admin channel are mocked: no live DB. The real SQL path is
 * in `e2e/api/ai-daily-cap.spec.ts`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  state: {
    org: null as Record<string, unknown> | null,
    claimed: new Set<string>(),
    claimsDeleted: [] as string[],
    notices: [] as Array<{ orgId: string; text: unknown; now?: Date }>,
    noticeFails: false,
  },
}));

vi.mock("../db", () => ({
  db: {
    organisation: { findUnique: async () => h.state.org },
    sentNotification: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        h.state.claimed.has(where.key) ? { id: "x", key: where.key } : null,
      create: async ({ data }: { data: { key: string } }) => {
        // A real unique index: yield first so racing callers interleave.
        await Promise.resolve();
        if (h.state.claimed.has(data.key)) throw Object.assign(new Error("unique"), { code: "P2002" });
        h.state.claimed.add(data.key);
        return data;
      },
      deleteMany: async ({ where }: { where: { key: string } }) => {
        h.state.claimed.delete(where.key);
        h.state.claimsDeleted.push(where.key);
        return { count: 1 };
      },
    },
  },
}));
vi.mock("../admin-channel", () => ({
  sendAdminNotice: async (a: { orgId: string; text: unknown; now?: Date }) => {
    if (h.state.noticeFails) throw new Error("db down");
    h.state.notices.push(a);
    return { channel: "dm", queued: 1 };
  },
}));

import { aiCapNoticeKey, aiCapNoticeTooLate, buildAiCapAdminNotice, notifyAdminsOfAiCap } from "../ai-cap-notice";
import { en } from "../i18n/strings.en";
import { tr } from "../i18n/strings.tr";

// 14:00 London (BST) on 2026-10-01.
const NOW = new Date("2026-10-01T13:00:00Z");

const liveOrg = {
  id: "org-1",
  name: "Sutton FC",
  language: "en",
  approvalStatus: "approved",
  dormantAt: null,
  whatsappBotEnabled: true,
  whatsappGroupId: "120363000000000000@g.us",
};

beforeEach(() => {
  h.state.org = { ...liveOrg };
  h.state.claimed = new Set();
  h.state.claimsDeleted = [];
  h.state.notices = [];
  h.state.noticeFails = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("aiCapNoticeKey: one key per club per London day", () => {
  it("is <orgId>:ai-cap:<YYYY-MM-DD> on London's day, not UTC's", () => {
    expect(aiCapNoticeKey("org-1", NOW)).toBe("org-1:ai-cap:2026-10-01");
    // 23:30 UTC on the 1st is 00:30 London on the 2nd (BST).
    expect(aiCapNoticeKey("org-1", new Date("2026-10-01T23:30:00Z"))).toBe("org-1:ai-cap:2026-10-02");
  });
});

describe("aiCapNoticeTooLate: no notice from 22:00 London (it would arrive tomorrow)", () => {
  it("21:59 London is fine, 22:00 and 23:59 are too late, 00:00 is a new day", () => {
    expect(aiCapNoticeTooLate(new Date("2026-10-01T20:59:00Z"))).toBe(false);
    expect(aiCapNoticeTooLate(new Date("2026-10-01T21:00:00Z"))).toBe(true);
    expect(aiCapNoticeTooLate(new Date("2026-10-01T22:59:00Z"))).toBe(true);
    expect(aiCapNoticeTooLate(new Date("2026-10-01T23:00:00Z"))).toBe(false);
  });
});

describe("notifyAdminsOfAiCap", () => {
  it("queues ONE admin notice for a live club, in the club's language, through sendAdminNotice", async () => {
    expect(await notifyAdminsOfAiCap("org-1", NOW)).toBe("sent");
    expect(h.state.notices).toHaveLength(1);
    expect(h.state.notices[0].orgId).toBe("org-1");
    expect(h.state.notices[0].text).toBe(buildAiCapAdminNotice({ clubName: "Sutton FC", lang: "en" }));
    expect(h.state.claimed.has("org-1:ai-cap:2026-10-01")).toBe(true);
  });

  it("a second trip the same day sends nothing", async () => {
    await notifyAdminsOfAiCap("org-1", NOW);
    expect(await notifyAdminsOfAiCap("org-1", new Date(NOW.getTime() + 60 * 60 * 1000))).toBe("already");
    expect(h.state.notices).toHaveLength(1);
  });

  it("CONCURRENCY: twenty refusals racing in the same flush queue exactly one notice", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => notifyAdminsOfAiCap("org-1", NOW)));
    expect(h.state.notices).toHaveLength(1);
    expect(results.filter((r) => r === "sent")).toHaveLength(1);
  });

  it("the next London day gets its own notice", async () => {
    await notifyAdminsOfAiCap("org-1", NOW);
    expect(await notifyAdminsOfAiCap("org-1", new Date("2026-10-02T09:00:00Z"))).toBe("sent");
    expect(h.state.notices).toHaveLength(2);
  });

  it("speaks Turkish for a Turkish club", async () => {
    h.state.org = { ...liveOrg, name: "Erdal FC", language: "tr" };
    await notifyAdminsOfAiCap("org-1", NOW);
    expect(h.state.notices[0].text).toBe(buildAiCapAdminNotice({ clubName: "Erdal FC", lang: "tr" }));
  });

  it.each([
    ["unapproved", { approvalStatus: "pending" }],
    ["suspended", { approvalStatus: "suspended" }],
    ["dormant", { dormantAt: new Date("2026-06-18T00:00:00Z") }],
    ["muted", { whatsappBotEnabled: false }],
    ["without a group", { whatsappGroupId: null }],
  ])("a club that is %s gets nothing, and nothing is claimed", async (_label, patch) => {
    h.state.org = { ...liveOrg, ...patch };
    expect(await notifyAdminsOfAiCap("org-1", NOW)).toBe("skipped");
    expect(h.state.notices).toHaveLength(0);
    expect(h.state.claimed.size).toBe(0);
  });

  it("an org that does not exist gets nothing", async () => {
    h.state.org = null;
    expect(await notifyAdminsOfAiCap("org-x", NOW)).toBe("skipped");
    expect(h.state.notices).toHaveLength(0);
  });

  it("from 22:00 London nothing is queued and nothing is claimed", async () => {
    expect(await notifyAdminsOfAiCap("org-1", new Date("2026-10-01T21:30:00Z"))).toBe("skipped");
    expect(h.state.notices).toHaveLength(0);
    expect(h.state.claimed.size).toBe(0);
  });

  it("a failed queue releases the claim and never throws, so a later trip can try again", async () => {
    h.state.noticeFails = true;
    expect(await notifyAdminsOfAiCap("org-1", NOW)).toBe("failed");
    expect(h.state.claimsDeleted).toEqual(["org-1:ai-cap:2026-10-01"]);
    h.state.noticeFails = false;
    expect(await notifyAdminsOfAiCap("org-1", NOW)).toBe("sent");
    expect(h.state.notices).toHaveLength(1);
  });
});

describe("the notice copy (EN and TR)", () => {
  const enText = buildAiCapAdminNotice({ clubName: "Sutton FC", lang: "en" });
  const trText = buildAiCapAdminNotice({ clubName: "Erdal FC", lang: "tr" });

  it("English: names the club, says what still works, when it resets, and how to get more", () => {
    expect(enText).toBe(
      "⚠️ MatchTime has used today's AI allowance for *Sutton FC*. " +
        "Until midnight (UK time) I'll still record a plain In or Out in the group, but I won't answer questions " +
        "or other requests that need the AI. Scheduled posts carry on as normal. " +
        "The allowance resets at midnight. " +
        "Need more? Email hello@matchtime.ai and we can raise your club's daily allowance.",
    );
  });

  it("Turkish: the same message, with the Turkish In and Out words", () => {
    expect(trText).toBe(
      "⚠️ MatchTime, *Erdal FC* için bugünkü yapay zekâ kullanım hakkını doldurdu. " +
        "Gece yarısına kadar (İngiltere saati) grupta düz bir \"varım\" ya da \"yokum\" mesajını yine kaydederim, " +
        "ama soruları ve yapay zekâ gerektiren diğer istekleri yanıtlamam. Planlı paylaşımlar her zamanki gibi devam eder. " +
        "Kullanım hakkı gece yarısı sıfırlanır. " +
        "Daha fazlası mı gerekiyor? hello@matchtime.ai adresine yazın, kulübünüzün günlük hakkını artıralım.",
    );
  });

  it("a future Buy more link drops in place of the email line, in both languages", () => {
    const url = "https://matchtime.ai/billing/org-1/ai";
    expect(buildAiCapAdminNotice({ clubName: "Sutton FC", lang: "en", buyMoreUrl: url })).toContain(
      `Need more? Buy extra AI allowance here: ${url}`,
    );
    expect(buildAiCapAdminNotice({ clubName: "Sutton FC", lang: "en", buyMoreUrl: url })).not.toContain("hello@");
    expect(buildAiCapAdminNotice({ clubName: "Erdal FC", lang: "tr", buyMoreUrl: url })).toContain(url);
  });

  it("no em or en dashes, in either language or variant", () => {
    for (const s of [
      enText,
      trText,
      en.ai_cap_more_contact,
      tr.ai_cap_more_contact,
      en.ai_cap_more_buy({ url: "u" }),
      tr.ai_cap_more_buy({ url: "u" }),
    ]) {
      expect(s).not.toMatch(/[—–]/);
    }
  });
});
