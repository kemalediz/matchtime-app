"use client";

/**
 * Marks this browser as our own staff's (2026-11-12): rendered by the admin
 * layout, so only once the layout has let an owner or admin in, and it
 * sets the staff cookie (`poolStaffCookie`, a year long). The /play beacon
 * then counts nothing for this browser, signed in or not, so Kemal's tests
 * and QA checks of /play stop showing up as people in the funnel. Set from
 * the page because a layout cannot set a cookie; it holds no secret, only
 * "1", and a visitor who set it by hand would only hide his own visit.
 */
import { useEffect } from "react";
import { poolStaffCookie } from "@/lib/pool/visit-rules";

export function StaffMark() {
  useEffect(() => {
    document.cookie = poolStaffCookie({ secure: window.location.protocol === "https:" });
  }, []);
  return null;
}
