import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The organiser guide's schedule section (/help/admin#schedule) is a
 * step-by-step through the real admin screens: schedule changes are done
 * there, not by WhatsApp commands (Kemal, 2026-09-30).
 *
 * Every button, tab or field the guide tells an organiser to press is
 * checked against the source of the screen it lives on, so a renamed
 * button fails here instead of leaving the guide pointing at nothing.
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

const GUIDE = read("src/app/help/admin/page.tsx");
const SCHEDULE = (() => {
  const start = GUIDE.indexOf('id="schedule"');
  const next = GUIDE.indexOf("<h2", start + 1);
  return start === -1 ? "" : GUIDE.slice(start, next === -1 ? undefined : next);
})();

const SUBNAV = "src/components/layout/admin-subnav.tsx";
const ACTIVITIES = "src/app/admin/activities/page.tsx";
const BLOCKS = "src/app/admin/block-bookings/page.tsx";
const BLOCK_ACTIONS = "src/app/admin/block-bookings/block-actions.tsx";
const NEW_BLOCK = "src/app/admin/block-bookings/new/new-block-form.tsx";
const BULK_PAGE = "src/app/admin/matches/bulk/page.tsx";
const BULK_FORM = "src/app/admin/matches/bulk/bulk-confirm-form.tsx";
const MATCH_PAGE = "src/app/matches/[matchId]/page.tsx";
const TEAMS = "src/app/admin/matches/[matchId]/teams/page.tsx";
const CANCEL = "src/app/admin/matches/[matchId]/cancel/page.tsx";
const SWITCH = "src/app/admin/matches/[matchId]/switch-format/page.tsx";
const SIDEBAR = "src/components/layout/sidebar.tsx";

/** [label as the guide prints it inside <strong>, screen it must exist on] */
const LABELS: Array<[string, string]> = [
  ["Admin", SIDEBAR],
  ["Matches", SIDEBAR],
  ["Activities", SUBNAV],
  ["Create activity", ACTIVITIES],
  ["Edit", ACTIVITIES],
  ["Save changes", ACTIVITIES],
  ["Block bookings", SUBNAV],
  ["New block booking", BLOCKS],
  ["Preview dates", NEW_BLOCK],
  ["Create block", NEW_BLOCK],
  ["Bulk cancel / restore", BLOCKS],
  ["Find matches", BULK_PAGE],
  ["Cancel matches", BULK_PAGE],
  ["Restore cancelled matches", BULK_PAGE],
  ["Announce to the group", BULK_FORM],
  ["Cancel remaining", BLOCK_ACTIONS],
  ["Restore cancelled", BLOCK_ACTIONS],
  ["Manage teams", MATCH_PAGE],
  ["Generate teams", MATCH_PAGE],
  ["Cancel match", TEAMS],
  ["Switch format", MATCH_PAGE],
  ["Switch to", SWITCH],
  ["Confirm switch", SWITCH],
];

describe("organiser guide: schedule section", () => {
  it("has a schedule section", () => {
    expect(SCHEDULE).not.toBe("");
  });

  it.each(LABELS)("names %s, and that label exists in the UI", (label, file) => {
    // `&apos;`-free labels only, so a plain substring check is exact.
    expect(SCHEDULE).toContain(`<strong>${label}</strong>`);
    expect(read(file)).toContain(label);
  });

  it("walks through each task as numbered steps", () => {
    for (const task of [
      "Add or change your weekly game",
      "Book a run of weeks",
      "Cancel or restore a range of dates",
      "Cancel one match",
      "Switch one match to a smaller format",
    ]) {
      expect(SCHEDULE).toContain(task);
    }
    expect((SCHEDULE.match(/<ol>/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it("says what the group is told, quoting the real messages", () => {
    // The words the bot posts (src/lib/i18n/strings.en.ts).
    expect(SCHEDULE).toContain("Match cancelled");
    expect(SCHEDULE).toContain("Match switched");
    expect(SCHEDULE).toContain("Schedule update");
    expect(SCHEDULE).toMatch(/Nothing is posted/);
  });

  it("does not claim the fee is set on the activity (it is asked after each match)", () => {
    expect(GUIDE).not.toMatch(/The match fee, if you collect one/);
  });

  it("does not send organisers to a Cancel button on the match page (there is none)", () => {
    expect(GUIDE).not.toMatch(/Match page, then <strong>Cancel<\/strong>/);
    expect(read(MATCH_PAGE)).not.toContain("/cancel`");
  });
});
