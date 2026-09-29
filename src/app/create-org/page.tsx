import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { selfJoinEnabledForRequest } from "@/lib/self-join-flag";
import { selfJoinEligibility } from "@/lib/self-join-club";
import { langFromAcceptLanguage, PLAYERS_PER_SIDE_OPTIONS } from "@/lib/club-connect-rules";
import { LANGS, LANG_LABELS } from "@/lib/i18n/lang";
import { t } from "@/lib/i18n/t";
import { LegacyCreateOrgForm } from "./legacy-form";
import { SelfJoinForm, type SelfJoinFormCopy } from "./self-join-form";

/**
 * /create-org.
 *
 * SELF_JOIN_ENABLED off: today's form, unchanged (legacy-form.tsx).
 *
 * SELF_JOIN_ENABLED on (self-join slice 4, plan section 5.1 and
 * decision 2): the club setup form. Club name, the language MatchTime
 * speaks in the group, and the weekly game (day, kick-off, venue,
 * players per side). The club is created as a draft; the "Add MatchTime
 * to WhatsApp" button appears on the club's admin home only after that.
 *
 * Nothing on this page carries the MatchTime number: the club does not
 * exist yet.
 */
export default async function CreateOrgPage() {
  if (!(await selfJoinEnabledForRequest())) return <LegacyCreateOrgForm />;

  const session = await auth();
  if (!session?.user?.id) redirect("/login?callbackUrl=/create-org");

  const refusal = await selfJoinEligibility(session.user.id, new Date());
  const defaultLang = langFromAcceptLanguage((await headers()).get("accept-language"));

  const copy = Object.fromEntries(
    LANGS.map((lang) => {
      const s = t(lang);
      const c: SelfJoinFormCopy = {
        title: s.sj_form_title,
        lead: s.sj_form_lead,
        clubName: s.sj_form_club_name,
        clubNamePlaceholder: s.sj_form_club_name_placeholder,
        language: s.sj_form_language,
        gameHeading: s.sj_form_game_heading,
        day: s.sj_form_day,
        time: s.sj_form_time,
        venue: s.sj_form_venue,
        venuePlaceholder: s.sj_form_venue_placeholder,
        perSide: s.sj_form_per_side,
        submit: s.sj_form_submit,
        submitting: s.sj_form_submitting,
        generic: s.sj_err_generic,
        verifyPhone: s.sj_err_verify_phone,
        verifyPhoneLink: s.sj_verify_phone_link,
        oneClub: s.sj_err_one_club,
        openMyClub: s.sj_open_my_club,
        siteCap: s.sj_err_site_cap,
        days: [0, 1, 2, 3, 4, 5, 6].map((dow) => s.onbDayName({ dow })),
        perSideOptions: PLAYERS_PER_SIDE_OPTIONS.map((perSide) => s.sj_per_side_option({ perSide })),
      };
      return [lang, c];
    }),
  ) as Record<(typeof LANGS)[number], SelfJoinFormCopy>;

  return (
    <SelfJoinForm
      copy={copy}
      defaultLang={defaultLang}
      langLabels={LANG_LABELS}
      perSideValues={[...PLAYERS_PER_SIDE_OPTIONS]}
      refusal={refusal}
    />
  );
}
