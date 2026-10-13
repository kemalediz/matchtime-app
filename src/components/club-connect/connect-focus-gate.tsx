"use client";

/**
 * The admin area in "finish connecting" mode (src/lib/connect-focus.ts).
 *
 * The admin layout renders this INSTEAD of the tabs while the organiser's
 * club is a draft or pending. It decides by the path, on the client,
 * because a layout is not rendered again when the organiser moves between
 * admin pages (the layout's own server redirect only sees a full load):
 *
 *   /admin                              the panel, alone and centred
 *   /admin/settings, /admin/activities  the page, under a way back and
 *                                       the two edit pages (no tabs)
 *   anything else under /admin          back to the panel, nothing drawn
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import {
  CONNECT_FOCUS_GAME_PATH,
  CONNECT_FOCUS_HOME,
  CONNECT_FOCUS_SETTINGS_PATH,
  connectFocusAdminView,
} from "@/lib/connect-focus";

export function ConnectFocusGate({
  children,
  lang,
  labels,
}: {
  children: React.ReactNode;
  lang: string;
  labels: { back: string; club: string; game: string };
}) {
  const pathname = usePathname();
  const router = useRouter();
  const view = connectFocusAdminView(pathname);

  useEffect(() => {
    if (view === "redirect") router.replace(CONNECT_FOCUS_HOME);
  }, [view, router]);

  if (view === "redirect") return null;

  if (view === "panel") {
    return (
      <div data-testid="connect-focus" data-view="panel" className="mx-auto max-w-xl px-4 py-10 sm:py-16">
        {children}
      </div>
    );
  }

  const here = pathname?.replace(/\/+$/, "");
  const tabs = [
    { href: CONNECT_FOCUS_SETTINGS_PATH, label: labels.club },
    { href: CONNECT_FOCUS_GAME_PATH, label: labels.game },
  ];
  return (
    <div data-testid="connect-focus" data-view="edit" className="mx-auto max-w-6xl p-6 sm:p-8">
      <div lang={lang} className="mb-6 space-y-4">
        <Link
          href={CONNECT_FOCUS_HOME}
          data-testid="connect-focus-back"
          className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-blue-700 hover:text-blue-800"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {labels.back}
        </Link>
        <nav
          data-testid="connect-focus-edit-nav"
          className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1 sm:w-fit"
        >
          {tabs.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={here === tab.href ? "page" : undefined}
              className={`whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                here === tab.href ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </div>
      {children}
    </div>
  );
}
