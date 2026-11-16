"use client";

/**
 * Asks the server to mark this browser as MatchTime staff's, or to clear
 * the mark (2026-11-12; staff means `User.isSuperadmin` only, and the
 * SERVER sets the cookie, since 2026-11-16). Rendered by the admin layout
 * once it has let a club's owner or admin in; on mount it posts to
 * `/admin/staff-mark` (`route.ts` next to this file), which decides from
 * the session: staff get the year-long staff cookie, any other organiser
 * has it cleared. The /play beacon then counts nothing for a staff browser,
 * signed in or not. (A staff TEST sign-up needs the staff session itself,
 * never this cookie.)
 *
 * Not set from script any more: WebKit caps a cookie a page script sets at
 * 7 days, so Kemal's iPhone lost the mark every week. Fire and forget: a
 * failure changes nothing on the page.
 */
import { useEffect } from "react";

export function StaffMark() {
  useEffect(() => {
    void fetch("/admin/staff-mark", { method: "POST", credentials: "same-origin" }).catch(() => {});
  }, []);
  return null;
}
