"use client";

/**
 * Marks this browser as MatchTime staff's (2026-11-12; staff means
 * `User.isSuperadmin` only since 2026-11-16): rendered by the admin layout
 * once it has let a club's owner or admin in, and told by it whether he is
 * MatchTime staff. For staff it sets the staff cookie (`poolStaffCookie`,
 * a year long): the /play beacon then counts nothing for this browser,
 * signed in or not, and a sign-up from it is a staff test, so Kemal's
 * tests and QA checks of /play stop showing up as people in the funnel.
 * For any other organiser it clears the cookie, the year-long one every
 * organiser got until 2026-11-16 included. Set from the page because a
 * layout cannot set a cookie; it holds no secret, and a visitor who set it
 * by hand would only hide his own visit and sign-up from the counts.
 */
import { useEffect } from "react";
import { poolStaffCookie, poolStaffCookieCleared } from "@/lib/pool/visit-rules";

/** `staff` null: the check failed, so the cookie is left as it is. */
export function StaffMark({ staff }: { staff: boolean | null }) {
  useEffect(() => {
    if (staff === null) return;
    const secure = window.location.protocol === "https:";
    document.cookie = staff ? poolStaffCookie({ secure }) : poolStaffCookieCleared({ secure });
  }, [staff]);
  return null;
}
