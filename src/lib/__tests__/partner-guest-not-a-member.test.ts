/**
 * M6 (review): a CURRENT guest is not the asking club's member either.
 * Every reader the plan excludes past guests from leaves current guests
 * out too: the club switcher and the club a page opens in, the DM Q&A's
 * club, and the monthly squad's rosters. (His own match, its pick list,
 * pay link, ratings and MoM read the match's attendances, not these.)
 *
 * Since the local player pool (L5a) every one reads the shared definition
 * (src/lib/guest-membership.ts, `guestMatchId`), so a POOL guest, who has
 * no home club, is left out the same way.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (p: string) => readFileSync(join(__dirname, "..", "..", "..", p), "utf8");

describe("current guests are left out", () => {
  it.each([
    ["src/lib/org.ts", /where: \{ userId, leftAt: null, \.\.\.ORDINARY_MEMBER_WHERE \}/],
    ["src/lib/org.ts", /membership\.leftAt === null && !isGuestMembership\(membership\)/],
    ["src/app/actions/org.ts", /membership\.leftAt !== null \|\| isGuestMembership\(membership\)/],
    ["src/app/api/memberships/route.ts", /leftAt: null, \.\.\.ORDINARY_MEMBER_WHERE \}/],
    ["src/lib/dm-qa.ts", /leftAt: null, \.\.\.ORDINARY_MEMBER_WHERE, \.\.\.IN_LIVE_STAGE_CLUB_WHERE/],
    ["src/lib/squad-month.ts", /leftAt: null, \.\.\.ORDINARY_MEMBER_WHERE, user: \{ isActive: true \}/],
    ["src/lib/month-signup.ts", /leftAt: null, \.\.\.ORDINARY_MEMBER_WHERE, user: \{ isActive: true \}/],
    ["src/lib/monthly-week.ts", /leftAt: null, \.\.\.ORDINARY_MEMBER_WHERE, user: \{ isActive: true \}/],
  ])("%s", (file, re) => {
    expect(src(file)).toMatch(re);
  });
});
