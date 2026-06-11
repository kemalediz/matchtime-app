"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const TABS = [
  { label: "Dashboard", href: "/admin" },
  { label: "Activities", href: "/admin/activities" },
  { label: "Players", href: "/admin/players" },
  { label: "Unresolved", href: "/admin/unresolved" },
  { label: "Stats", href: "/admin/stats" },
  { label: "Roster check-in", href: "/admin/roster-survey" },
  { label: "Organisations", href: "/admin/organisations" },
  { label: "Settings", href: "/admin/settings" },
];

export function AdminSubnav() {
  const pathname = usePathname();
  // Live count of unresolved attendance messages — the whole point of
  // #1 is that silent drops are impossible to MISS, so the badge sits
  // in the nav on every admin page.
  const [unresolved, setUnresolved] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/admin/unresolved-count")
        .then((r) => r.json())
        .then((d) => alive && setUnresolved(d.count ?? 0))
        .catch(() => {});
    load();
    // Re-check on navigation so it clears promptly after an admin links a name.
  }, [pathname]);

  return (
    <nav className="flex gap-1 p-1 bg-slate-100 rounded-lg max-w-full overflow-x-auto">
      {TABS.map((t) => {
        const active =
          t.href === "/admin"
            ? pathname === "/admin"
            : pathname === t.href || pathname?.startsWith(t.href + "/");
        const badge = t.href === "/admin/unresolved" && unresolved > 0;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap inline-flex items-center gap-1.5 ${
              active
                ? "bg-white text-slate-800 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
            {badge && (
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[11px] font-bold leading-none">
                {unresolved}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
