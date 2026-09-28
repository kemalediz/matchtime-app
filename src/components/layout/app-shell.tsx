"use client";

import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { Sidebar } from "./sidebar";
import { shouldShowSidebar } from "@/lib/app-shell-sidebar";

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
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { status } = useSession();
  const showSidebar = shouldShowSidebar(pathname, status);

  return (
    <>
      {showSidebar && <Sidebar />}
      <main className={`min-h-screen ${showSidebar ? "lg:pl-64" : ""}`}>
        {children}
      </main>
    </>
  );
}
