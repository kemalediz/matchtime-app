"use client";

import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { Sidebar } from "./sidebar";
import { shouldShowSidebar } from "@/lib/app-shell-sidebar";
import { PoolBanner } from "@/components/pool/pool-banner";
import { poolBannerPathShown } from "@/lib/pool/banner-rules";

/**
 * Shell that decides whether to render the app's Sidebar and how much
 * left-padding the main content needs.
 *
 * - Auth routes (`/login`, `/signup`, `/verify-email`) are always
 *   full-bleed — they have their own background.
 * - The marketing landing (`/`) and the help guides are full-bleed for
 *   signed-out visitors so the Sidebar doesn't leak behind them.
 *   Rules live in src/lib/app-shell-sidebar.ts.
 * - Everything else gets the sidebar + the `lg:pl-64` offset so content
 *   doesn't slide underneath the 16rem fixed sidebar on desktop.
 * - The player pool banner (2026-10-28) sits at the top of the content,
 *   under the nav, on the signed-in app's pages only
 *   (`poolBannerPathShown`); the server decides whether he gets one.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { status } = useSession();
  const showSidebar = shouldShowSidebar(pathname, status);
  const showPoolBanner = status === "authenticated" && showSidebar && poolBannerPathShown(pathname);

  return (
    <>
      {showSidebar && <Sidebar />}
      <main className={`min-h-screen ${showSidebar ? "lg:pl-64" : ""}`}>
        {showPoolBanner && <PoolBanner />}
        {children}
      </main>
    </>
  );
}
