"use client";

/**
 * TEMPORARY (2026-11-10): starts the /play funnel diagnostic
 * (`funnel-debug.ts`). page.tsx renders this only with `?mtdebug=1`, and
 * `installFunnelDebug` checks the URL again, so without the flag it does
 * nothing even if this module is loaded. It installs when the module first
 * runs in the browser, before React hydrates, so "boot" arrives even if
 * hydration never finishes; its effect ("r:effect") says React committed.
 * Renders nothing.
 */
import { useEffect } from "react";
import { funnelDebugNote, installFunnelDebug, type DebugWindow } from "./funnel-debug";

if (typeof window !== "undefined") {
  try {
    installFunnelDebug(window as unknown as DebugWindow);
  } catch {
    // A diagnostic never breaks the page.
  }
}

export function FunnelDebugRecorder() {
  useEffect(() => funnelDebugNote({ k: "r:effect" }), []);
  return null;
}
