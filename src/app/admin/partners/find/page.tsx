import Link from "next/link";
import { redirect } from "next/navigation";
import { MapPin } from "lucide-react";
import { auth } from "@/lib/auth";
import { getUserOrg, isOrgAdmin } from "@/lib/org";
import { t } from "@/lib/i18n/t";
import { loadNearbyClubs } from "@/lib/club-discovery";
import { parsePage, parseRadiusMiles, parseSameDay } from "@/lib/club-discovery-rules";
import { FindClubs } from "@/components/partners/find-clubs";

/**
 * /admin/partners/find: "Find clubs near you" (partner discovery, slice P2,
 * 2026-10-22). Plan: MDs/partner-discovery-plan-2026-10-21.md, sections 2.2
 * and 2.3.
 *
 * OWNERS AND ADMINS of the club. The admin layout already turns anybody
 * else away; this page checks again, because it reads other clubs.
 *
 * The search lives in the URL (`?radius=1|3|5|10&sameDay=1&page=N`), so a
 * reload or a shared link shows the same list. What reaches the browser is
 * the cards only (club-discovery.ts): never a name, a number, a group, a
 * fee, a rating or a coordinate.
 *
 * A club that may not search (D-3) sees why: no venue ("Confirm your
 * venue"), "find us" off, or not live yet.
 */
export const dynamic = "force-dynamic";

type Params = { radius?: string | string[]; sameDay?: string | string[]; page?: string | string[] };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? undefined : v);

export default async function FindClubsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/");
  if (!(await isOrgAdmin(session.user.id, membership.orgId))) redirect("/");

  const sp = await searchParams;
  const lang = membership.org.language;
  const s = t(lang);
  const result = await loadNearbyClubs(membership.orgId, {
    radiusMiles: parseRadiusMiles(one(sp.radius)),
    sameDay: parseSameDay(one(sp.sameDay)),
    page: parsePage(one(sp.page)),
  });

  const notice = (testId: string, title: string, body: string, href: string, link: string) => (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4" data-testid={testId} role="note">
      <p className="flex items-center gap-1 text-sm font-medium text-amber-900">
        <MapPin className="w-4 h-4 shrink-0" aria-hidden="true" />
        {title}
      </p>
      <p className="mt-1 text-sm text-amber-800">{body}</p>
      <Link href={href} className="mt-2 inline-block text-sm font-medium text-amber-900 underline">
        {link}
      </Link>
    </div>
  );

  return (
    <div className="space-y-4" data-testid="find-clubs-page">
      <div>
        <Link href="/admin/settings#partner-clubs" className="text-sm text-slate-500">
          {s.fc_back}
        </Link>
        <h2 className="mt-1 text-lg font-semibold text-slate-800">{s.fc_title}</h2>
        <p className="mt-1 text-sm text-slate-500">{s.fc_lead}</p>
      </div>
      {result?.state === "ok" ? (
        <FindClubs
          lang={lang}
          radiusMiles={result.radiusMiles}
          sameDay={result.sameDay}
          canFilterSameDay={result.canFilterSameDay}
          page={result.page}
          pageCount={result.pageCount}
          total={result.total}
          clubs={result.clubs}
        />
      ) : !result || result.state === "not-live" ? (
        <p className="text-sm text-slate-600" data-testid="find-clubs-not-live">
          {s.fc_not_live}
        </p>
      ) : result.state === "no-venue" ? (
        notice("find-clubs-no-venue", s.pd_venue_prompt_title, s.fc_venue_prompt_body, "/admin/settings#club-venue", s.fc_venue_prompt_link)
      ) : (
        notice("find-clubs-off", s.fc_off_title, s.fc_off_body, "/admin/settings#partner-clubs", s.fc_open_settings)
      )}
    </div>
  );
}
