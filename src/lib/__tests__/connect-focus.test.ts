/**
 * "Finish connecting" mode (2026-10-13): while an organiser's self-join
 * club is not approved yet, the site shows them the connect panel and
 * nothing else. These are the pure rules: who is in the mode, what each
 * admin route does in it, and which step the card is on.
 */
import { describe, expect, it } from "vitest";
import { APPROVAL_STATUSES } from "../club-approval-state";
import {
  CONNECT_FOCUS_STEPS,
  connectFocusAdminView,
  connectFocusStep,
  isConnectFocus,
} from "../connect-focus";

const club = (status: string | null | undefined) => ({ org: { approvalStatus: status } });
const owner = { selfJoinOn: true, isSuperadmin: false, role: "OWNER", ...club("draft") };

describe("isConnectFocus: who sees only the connect panel", () => {
  it("the owner of a draft club, with self-join on", () => {
    expect(isConnectFocus(owner)).toBe(true);
  });

  it("the owner of a club waiting for approval", () => {
    expect(isConnectFocus({ ...owner, ...club("pending") })).toBe(true);
  });

  it("only draft and pending, of every approval status there is", () => {
    const inMode = APPROVAL_STATUSES.filter((status) => isConnectFocus({ ...owner, ...club(status) }));
    expect(inMode).toEqual(["draft", "pending"]);
  });

  it("never an approved club, whether live or still setting up", () => {
    expect(isConnectFocus({ ...owner, ...club("approved") })).toBe(false);
  });

  it("never with self-join off: the card would not render, so the page would be empty", () => {
    expect(isConnectFocus({ ...owner, selfJoinOn: false })).toBe(false);
  });

  it("never a superadmin, who must keep the Clubs tab to approve the club", () => {
    expect(isConnectFocus({ ...owner, isSuperadmin: true })).toBe(false);
  });

  it("never an admin or player of the club: the card is the owner's", () => {
    expect(isConnectFocus({ ...owner, role: "ADMIN" })).toBe(false);
    expect(isConnectFocus({ ...owner, role: "PLAYER" })).toBe(false);
    expect(isConnectFocus({ ...owner, role: null })).toBe(false);
  });

  it("never a club with no status at all", () => {
    expect(isConnectFocus({ ...owner, ...club(null) })).toBe(false);
    expect(isConnectFocus({ ...owner, ...club(undefined) })).toBe(false);
  });
});

describe("connectFocusAdminView: what an admin route does in the mode", () => {
  it("/admin is the panel", () => {
    expect(connectFocusAdminView("/admin")).toBe("panel");
    expect(connectFocusAdminView("/admin/")).toBe("panel");
  });

  it("the two pages that hold what was typed at sign-up still open", () => {
    expect(connectFocusAdminView("/admin/settings")).toBe("edit");
    expect(connectFocusAdminView("/admin/activities")).toBe("edit");
    expect(connectFocusAdminView("/admin/settings/")).toBe("edit");
  });

  it("every other admin page goes back to the panel", () => {
    for (const p of [
      "/admin/players",
      "/admin/players/ratings",
      "/admin/stats",
      "/admin/block-bookings",
      "/admin/block-bookings/new",
      "/admin/unresolved",
      "/admin/roster-survey",
      "/admin/organisations",
      "/admin/months",
      "/admin/clubs",
      "/admin/health",
      "/admin/shadow",
      "/admin/matches/abc/teams",
      "/admin/settings/anything",
      "/admin/activities/anything",
      "/admin/settingsx",
    ]) {
      expect(connectFocusAdminView(p), p).toBe("redirect");
    }
  });

  it("an unknown path is treated as the panel's own (nothing to redirect)", () => {
    expect(connectFocusAdminView(null)).toBe("panel");
    expect(connectFocusAdminView("")).toBe("panel");
  });
});

describe("connectFocusStep: the step the card is on", () => {
  it("there are three real steps", () => {
    expect(CONNECT_FOCUS_STEPS).toBe(3);
  });

  it("sending the message is step 1, before and after the button, and after a code expired", () => {
    expect(connectFocusStep("draft")).toBe(1);
    expect(connectFocusStep("issued")).toBe(1);
    expect(connectFocusStep("expired")).toBe(1);
  });

  it("adding MatchTime to the group is step 2", () => {
    expect(connectFocusStep("dm_verified")).toBe(2);
  });

  it("waiting for approval is step 3", () => {
    expect(connectFocusStep("pending")).toBe(3);
  });

  it("the other cards have no step", () => {
    for (const kind of ["hidden", "approved", "setting_up", "rejected"] as const) {
      expect(connectFocusStep(kind), kind).toBeNull();
    }
  });
});
