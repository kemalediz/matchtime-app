/**
 * The scheduler's admin nudges open the page they name, in the right club
 * (2026-09-30).
 *
 * The day-before "Low numbers" and "Match in trouble" DMs said "Tap to
 * open the cancel page" over a sign-in link that had NO destination, so
 * the tap landed on the dashboard; and every one of the three ended in
 * "Or navigate manually: /admin/...", a bare path WhatsApp does not make
 * tappable. They are built inline in the 2,000-line scheduler, so this
 * reads its source, the same way `tr-team-commands.test.ts` does.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(path.resolve(__dirname, "../bot-scheduler.ts"), "utf8");

describe("bot-scheduler admin nudges", () => {
  it("no DM text carries a bare /admin path", () => {
    expect(src).not.toMatch(/navigate manually: \/admin/);
    expect(src).not.toMatch(/`[^`]*(?:\\n|: )\/admin\/[^`]*`/);
  });

  it("the switch-format and cancel nudges link to their pages, signed in, in the club", () => {
    expect(src).toContain("nextPath: `/admin/matches/${matchId}/switch-format`");
    expect(src).toContain("nextPath: `/admin/matches/${matchId}/cancel`");
    expect(src).toContain('nextPath: "/admin/players"');
    // Since slice 2a (2026-09-30) all three go through the admin channel,
    // whose DMs are built with buildAdminLink, which pins the club (orgId)
    // at sign-in. Covered by behaviour in admin-channel.test.ts too.
    const nudges = src.split("adminNoticeInstructions({").length - 1;
    expect(nudges).toBeGreaterThanOrEqual(3);
    const channel = readFileSync(path.resolve(__dirname, "../admin-channel.ts"), "utf8");
    expect(channel).toContain("buildAdminLink({ userId, orgId: ch.orgId, nextPath: notice.nextPath })");
  });
});
