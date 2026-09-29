"use client";

/**
 * Keeps the status card current while the organiser is between steps
 * (waiting for their DM, the group add, or approval): a server refresh
 * every 15 seconds while the tab is visible. Renders nothing.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";

const EVERY_MS = 15_000;

export function CardRefresher() {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, EVERY_MS);
    return () => clearInterval(id);
  }, [router]);
  return null;
}
