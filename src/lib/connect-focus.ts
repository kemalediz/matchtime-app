/**
 * "FINISH CONNECTING" MODE (2026-10-13): the pure rules.
 *
 * Kemal: "the page should only show connect MT to Whatsapp panel as
 * without that nothing works and no point showing everything else ...
 * Let's say they do not press the button, leave the tab and come back
 * and login later, again this panel should be shown only to remind them."
 *
 * While an organiser's self-join club is not approved yet, every page of
 * the site leads to ONE thing: the connect card on /admin. No admin tabs,
 * no stat tiles, no Manage buttons. The moment the club is approved
 * (setting up under the hold included) everything is as it was.
 *
 * WHO IS IN THE MODE: exactly the person the connect card is drawn for
 * (components/club-connect/club-connect-card.tsx) while the club is a
 * draft or pending. So: self-join on, the club's OWNER, the club's
 * `approvalStatus` "draft" or "pending". Never a superadmin: the platform
 * owner approves clubs from /admin/clubs, and must reach it even while a
 * test club of their own is the selected one.
 *
 * WHICH CLUB: the one `getUserOrg` (org.ts) returns, i.e. the `orgId`
 * cookie the sidebar's switcher sets, else the first membership. Someone
 * who admins an approved club and owns a draft one is in the mode only
 * while the draft one is selected, and the switcher stays in the sidebar.
 *
 * No database, no request: connect-focus-server.ts does the reading.
 */
import { DRAFT_CLUB_WHERE, PENDING_CLUB_WHERE } from "./club-approval-state";
import type { ConnectCard } from "./club-connect-rules";

/** The approval statuses the mode covers. */
const FOCUS_STATUSES: readonly string[] = [DRAFT_CLUB_WHERE.approvalStatus, PENDING_CLUB_WHERE.approvalStatus];

export function isConnectFocus(args: {
  /** `selfJoinEnabledForRequest()`: with it off the card is not drawn. */
  selfJoinOn: boolean;
  isSuperadmin: boolean;
  /** The viewer's role in the selected club. */
  role: string | null | undefined;
  /** The selected club. */
  org: { approvalStatus: string | null | undefined };
}): boolean {
  if (!args.selfJoinOn || args.isSuperadmin) return false;
  if (args.role !== "OWNER") return false;
  const status = args.org.approvalStatus;
  return typeof status === "string" && FOCUS_STATUSES.includes(status);
}

/** Where the panel lives. */
export const CONNECT_FOCUS_HOME = "/admin";

/**
 * The pages that hold what the organiser typed at sign-up, which they
 * must still be able to correct before connecting: the club's name and
 * language (settings, PR #226) and the weekly game's day, time and venue
 * (activities). Exact paths only.
 */
export const CONNECT_FOCUS_SETTINGS_PATH = "/admin/settings";
export const CONNECT_FOCUS_GAME_PATH = "/admin/activities";
const EDIT_PATHS: readonly string[] = [CONNECT_FOCUS_SETTINGS_PATH, CONNECT_FOCUS_GAME_PATH];

/** The request header the middleware copies the pathname into, so the
 *  admin layout (which Next gives no pathname) can redirect on the server. */
export const PATHNAME_HEADER = "x-mt-pathname";

export type ConnectFocusView = "panel" | "edit" | "redirect";

/**
 * What a path under /admin does while the mode is on: the panel itself,
 * one of the two edit pages, or a redirect back to the panel. A missing
 * pathname is "panel": nothing to redirect on, and the client gate in the
 * layout (which always knows the path) decides instead.
 */
export function connectFocusAdminView(pathname: string | null | undefined): ConnectFocusView {
  if (!pathname) return "panel";
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (p === CONNECT_FOCUS_HOME) return "panel";
  if (EDIT_PATHS.includes(p)) return "edit";
  return "redirect";
}

/** The card's own copy counts three steps (sj_card_issued, _dm_verified,
 *  _pending): send the message, add MatchTime to the group, approval. */
export const CONNECT_FOCUS_STEPS = 3;

/** The step a card is on, or null for a card that is not a step. */
export function connectFocusStep(kind: ConnectCard["kind"]): 1 | 2 | 3 | null {
  switch (kind) {
    case "draft":
    case "issued":
    case "expired":
      return 1;
    case "dm_verified":
      return 2;
    case "pending":
      return 3;
    default:
      return null;
  }
}
