"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Dashboard", href: "/admin" },
  { label: "Activities", href: "/admin/activities" },
  { label: "Players", href: "/admin/players" },
  { label: "Stats", href: "/admin/stats" },
  { label: "Roster check-in", href: "/admin/roster-survey" },
  { label: "Organisations", href: "/admin/organisations" },
  { label: "Settings", href: "/admin/settings" },
];

export function AdminSubnav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 p-1 bg-slate-100 rounded-lg w-fit overflow-x-auto">
      {TABS.map((t) => {
        const active =
          t.href === "/admin"
            ? pathname === "/admin"
            : pathname === t.href || pathname?.startsWith(t.href + "/");
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
              active
                ? "bg-white text-slate-800 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
