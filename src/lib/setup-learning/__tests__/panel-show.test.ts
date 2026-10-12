/**
 * F3, learned setup: when may the panel on /admin/settings SHOW what a
 * reload brought back? (2026-10-12.)
 *
 * The panel is at the top of a long page. When a reload changes its
 * height (a suggestion's card goes, or comes back) while the organiser is
 * further down, everything below it moves: the setting they have just
 * saved slides off the screen. So new data is shown only when showing it
 * cannot move what they are looking at. Pure.
 */
import { describe, expect, it } from "vitest";
import { SCROLL_SETTLE_MS, mayShowNow } from "../panel-reload";

const T = 1_000_000;
const settled = { now: T, lastMotionAt: T - 10_000 };

describe("mayShowNow", () => {
  it("the page is still and the panel is on the screen: show (the organiser sees it change)", () => {
    expect(mayShowNow({ ...settled, panelBottom: 400 })).toBe(true);
    expect(mayShowNow({ ...settled, panelBottom: 1 })).toBe(true);
  });

  it("the panel is below the screen: show (nothing they can see moves)", () => {
    expect(mayShowNow({ ...settled, panelBottom: 5_000 })).toBe(true);
  });

  it("the whole panel is above the screen: hold, however long the page has been still", () => {
    expect(mayShowNow({ ...settled, panelBottom: 0 })).toBe(false);
    expect(mayShowNow({ ...settled, panelBottom: -2_400 })).toBe(false);
  });

  it("the page is moving (a scroll, or a jump to another setting that has just begun): hold, wherever the panel is", () => {
    expect(mayShowNow({ now: T, lastMotionAt: T, panelBottom: 400 })).toBe(false);
    expect(mayShowNow({ now: T, lastMotionAt: T - SCROLL_SETTLE_MS + 1, panelBottom: 400 })).toBe(false);
    expect(mayShowNow({ now: T, lastMotionAt: T - SCROLL_SETTLE_MS, panelBottom: 400 })).toBe(true);
  });

  it("the settle time is longer than the gap between two frames of a scroll, and short enough not to be noticed", () => {
    expect(SCROLL_SETTLE_MS).toBeGreaterThanOrEqual(100);
    expect(SCROLL_SETTLE_MS).toBeLessThanOrEqual(250);
  });
});
