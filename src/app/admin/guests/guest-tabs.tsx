/**
 * The Guest players page's three tabs (pool slice L5b), as links, so each
 * tab has its own URL and works without JavaScript. The current one is
 * marked `aria-current="page"`.
 */
import Link from "next/link";
import { GUEST_PAGE_TABS, type GuestPageTab } from "@/lib/pool/guest-report";
import type { Strings } from "@/lib/i18n/t";

export function GuestTabs({ s, current }: { s: Strings; current: GuestPageTab }) {
  const label: Record<GuestPageTab, string> = { upcoming: s.gst_tab_upcoming, history: s.gst_tab_history, report: s.gst_tab_report };
  return (
    <nav aria-label={s.gst_title} className="flex gap-1 p-1 bg-slate-100 rounded-lg w-fit max-w-full overflow-x-auto">
      {GUEST_PAGE_TABS.map((tab) => {
        const active = tab === current;
        return (
          <Link
            key={tab}
            href={`/admin/guests?tab=${tab}`}
            aria-current={active ? "page" : undefined}
            data-testid={`guest-tab-${tab}`}
            className={`px-4 py-2 rounded-md text-sm font-medium whitespace-nowrap ${active ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
          >
            {label[tab]}
          </Link>
        );
      })}
    </nav>
  );
}

export function EmptyState({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <p data-testid={testId} className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center text-sm text-slate-500">
      {children}
    </p>
  );
}
