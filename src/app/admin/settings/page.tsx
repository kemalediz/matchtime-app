"use client";

/**
 * /admin/settings (2026-10-28 layout): six tabs of collapsible cards with a
 * "Find a setting" box, and `#<card id>` deep links (ids in
 * src/lib/settings-anchors.ts, layout in components/settings/settings-nav.tsx).
 * Every card keeps the behaviour and permissions it had on the long page;
 * this file only places them.
 *
 *   Club              General, Bot language, WhatsApp bot
 *   Matches           Weekly routine, Reminders, Teams, Monthly squad
 *   Players           Attendance, Bench, Ratings and stats, Man of the Match, Invite link
 *   Payments          Payments (fees, methods, collector, bank), MatchTime club fee
 *   Finding players   Partner clubs, Player pool, Style of play, automatic asking,
 *                     Tell your players, Group invite link
 *   Messages          Quiet hours, Admin messages, Posters
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Armchair,
  BellRing,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  Landmark,
  Languages,
  Link as LinkIcon,
  MessageCircle,
  Repeat,
  Settings,
  Shirt,
  Star,
  Trophy,
  Users,
  Wallet,
} from "lucide-react";
import { renameDraftClub, setOrgFeature, setOrgLanguage, setOrgTeamLabels, setWeeklyRoutine } from "@/app/actions/org";
import { WeeklyDeadlineRows, type DayTimeValue } from "@/components/settings/weekly-deadline-rows";
import { t } from "@/lib/i18n/t";
import { startCollectorOnboarding, refreshCollectorStatus, resetCollectorConnect, openCollectorDashboard, setPaymentHolder } from "@/app/actions/payments";
import { FEATURE_META, OFFERED_FEATURE_META, type ToggleableKey } from "@/lib/org-features-meta";
import { LANGS, LANG_LABELS, normaliseLang, type Lang } from "@/lib/i18n/lang";
import { settingsNavCopy } from "@/lib/i18n/settings-nav";
import {
  benchSummary,
  clubDetailsSummary,
  inviteLinkSummary,
  languageSummary,
  momSummary,
  onOffSummary,
  paymentsSummary,
  ratingsSummary,
  remindersSummary,
  teamsSummary,
  weeklyRoutineSummary,
  whatsappSummary,
} from "@/lib/settings-summaries";
import { AdminChannelSettings } from "@/components/settings/admin-channel-section";
import { PickModeRows } from "@/components/settings/pick-mode-rows";
import { TeamsReadyRow } from "@/components/settings/teams-ready-row";
import { ListAnnouncerRow } from "@/components/settings/list-announcer-row";
import { MomChooserRow } from "@/components/settings/mom-chooser-row";
import { BillingSettingsCard, type BillingCardData } from "@/components/settings/billing-card";
import { SectionInfo } from "@/components/info/section-info";
import { SettingInfo } from "@/components/info/setting-info";
import { useOrgLang } from "@/components/info/org-lang";
import { LearnedSetupPanel } from "@/components/settings/learned-setup-panel";
import { MonthlySquadSection, type MonthlySquadData } from "@/components/settings/monthly-squad-section";
import { PaymentInstructionsRow } from "@/components/settings/payment-instructions-row";
import { GoLiveBanner, type GoLiveSetup } from "@/components/settings/go-live-banner";
import { PostersCard } from "@/components/settings/posters-card";
import { PartnerClubsSection } from "@/components/settings/partner-clubs-section";
import { QuietHoursSection } from "@/components/settings/quiet-hours-section";
import { PlayStyleSection } from "@/components/settings/play-style-section";
import { PoolAutoAskSection } from "@/components/settings/pool-auto-ask-section";
import { PoolClubShareSection } from "@/components/settings/pool-club-share-section";
import { GroupInviteLinkSection } from "@/components/settings/group-invite-link-section";
import { PlayerPoolSection } from "@/components/settings/player-pool-section";
import { FeatureSwitchRow } from "@/components/settings/feature-switch-row";
import { FindSetting, SettingsCard, SettingsNavProvider, SettingsTabPanel, SettingsTabs } from "@/components/settings/settings-nav";

type FeatureKey = ToggleableKey;

interface OrgData {
  id: string;
  name: string;
  slug: string;
  /** Admins only: true while the club is a draft, when the name can
   *  still be changed. */
  nameEditable?: boolean;
  inviteCode: string;
  whatsappGroupId: string | null;
  whatsappBotEnabled: boolean;
  memberCount: number;
  /** Org-level team-name override (raw — [] or empty strings = defaults). */
  teamLabels?: string[];
  /** What the labels resolve to when no override is set (sport defaults). */
  defaultTeamLabels?: [string, string];
  /** The language the bot speaks to this group in ("en" | "tr"). */
  language?: string;
  features: Record<FeatureKey, boolean>;
  stripeConnected?: boolean;
  stripeChargesEnabled?: boolean;
  paymentHolderId?: string | null;
  members?: { id: string; name: string | null }[];
  /** "Weekly routine" (2026-09-30). Slices 2 and 3 add their settings. */
  weeklyRoutine?: {
    rollingSquad: boolean;
    /** Weekly deadlines (slice 3): null when not set. */
    dropOutDeadline?: DayTimeValue | null;
    listPublish?: DayTimeValue | null;
    /** Organiser pick (slice 2b). */
    benchPickMode?: "first-come" | "organiser";
    benchPickFallback?: "bench-offer" | "leave-empty";
    /** 2026-10-14: who announces the list and teams. */
    listAnnouncer?: "matchtime" | "organisers";
    /** 2026-10-18: who chooses Man of the Match. */
    momChosenBy?: "players" | "organisers";
  };
  /** Club fee billing (slice B2): null or absent with billing off and for
   *  an exempt club, so nothing new shows. */
  billing?: BillingCardData | null;
  /** "Monthly squad" (2026-10-05). Admins only; "weekly" unless switched on. */
  monthlySquad?: MonthlySquadData;
  /** Approved but setting up (go-live slice S5). Admins only; `settingUp`
   *  is false for every club that is live. */
  setup?: GoLiveSetup | null;
}

export default function SettingsPage() {
  const layoutLang = useOrgLang();
  const [org, setOrg] = useState<OrgData | null>(null);
  const [loading, setLoading] = useState(true);
  // The Go live banner (slice S5): shown when the club was setting up as
  // the page loaded, and kept after it goes live so its success note
  // stays. `previewKey` is bumped after every save that can change the
  // hello, so the banner fetches its preview again.
  // `goLiveSetup` is the setup as the page loaded it: the banner keeps it
  // if a later refresh comes back without one.
  const [goLiveSetup, setGoLiveSetup] = useState<GoLiveSetup | null>(null);
  // The language the page's own words are in: the club's language as the
  // page loaded. Changing the language here does not re-word the page at
  // once: longer words above the language picker would move it under the
  // finger ("saving a setting never moves the page"). It reads in the new
  // language from the next visit.
  const [pageLang, setPageLang] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState(0);
  // Bumped when the club switches its player pool on or off, so the pool
  // cards under it load again (they show only while it is on).
  const [poolKey, setPoolKey] = useState(0);
  const settingSaved = () => setPreviewKey((k) => k + 1);
  /** Read the settings again. False when that failed (it may also reject). */
  async function reloadSettings(): Promise<boolean> {
    const res = await fetch("/api/org/settings");
    if (!res.ok) return false;
    const data: OrgData | null = await res.json();
    if (!data) return false;
    setOrg(data);
    return true;
  }
  /** The club went live: make the page agree with the banner, with or
   *  without the refresh that follows. */
  function markLive() {
    setOrg((prev) =>
      prev
        ? {
            ...prev,
            whatsappBotEnabled: true,
            setup: prev.setup ? { ...prev.setup, settingUp: false, removedFromGroup: false } : prev.setup,
          }
        : prev,
    );
  }

  useEffect(() => {
    fetch("/api/org/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then(async (data) => {
        setOrg(data);
        // Once shown, the banner stays for this visit: a second load of
        // the settings (React runs this effect twice in development) that
        // lands after the club has gone live must not take the banner, and
        // the outcome it is about to show, off the page.
        setGoLiveSetup((prev) => prev ?? (data?.setup?.settingUp ? data.setup : null));
        setPageLang((prev) => prev ?? data?.language ?? null);
        setClubName(data?.name ?? "");
        setTeamRed(data?.teamLabels?.[0] ?? "");
        setTeamYellow(data?.teamLabels?.[1] ?? "");
        // Returning from Stripe onboarding (?stripe=done|refresh) → auto
        // re-check charges-enabled so the collector doesn't have to hit
        // "Refresh status" and wonder why it still says "Finish setup".
        if (
          data?.id &&
          typeof window !== "undefined" &&
          /[?&]stripe=(done|refresh)/.test(window.location.search)
        ) {
          try {
            const { chargesEnabled } = await refreshCollectorStatus(data.id);
            setOrg((prev) =>
              prev ? { ...prev, stripeChargesEnabled: chargesEnabled, stripeConnected: true } : prev,
            );
            if (chargesEnabled) toast.success(t(data.language).st_bank_connected);
          } catch {
            /* non-fatal — the "Refresh status" button is the fallback */
          }
        }
      })
      .finally(() => setLoading(false));
  }, []);

  // Links to #billing, #payments, #partner-clubs and every other card are
  // followed by the layout (SettingsNavProvider): it opens the card's tab,
  // expands it and scrolls to it once it is drawn.

  async function copyInviteLink() {
    if (!org) return;
    const link = `${window.location.origin}/join/${org.inviteCode}`;
    await navigator.clipboard.writeText(link);
    toast.success(t(org.language).st_invite_copied);
  }

  // Organisation name. Editable only while the club is a draft; the
  // action checks that again. The ref stops a second submit while the
  // first is still running (the busy pattern of /create-org).
  const [clubName, setClubName] = useState("");
  const [savingClubName, setSavingClubName] = useState(false);
  const [clubNameState, setClubNameState] = useState<{ kind: "saved" } | { kind: "error"; message: string } | null>(null);
  const submittingClubName = useRef(false);
  async function saveClubName(e: React.FormEvent) {
    e.preventDefault();
    if (!org || submittingClubName.current) return;
    submittingClubName.current = true;
    setSavingClubName(true);
    setClubNameState(null);
    try {
      const res = await renameDraftClub(org.id, clubName);
      if (res.ok) {
        setOrg((prev) => (prev ? { ...prev, name: res.name } : prev));
        setClubName(res.name);
        setClubNameState({ kind: "saved" });
      } else {
        // The club left draft since the page loaded: show it as locked.
        if (res.reason === "not-draft") setOrg((prev) => (prev ? { ...prev, nameEditable: false } : prev));
        setClubNameState({ kind: "error", message: res.error });
      }
    } catch {
      setClubNameState({ kind: "error", message: t(org.language).st_name_save_failed });
    } finally {
      submittingClubName.current = false;
      setSavingClubName(false);
    }
  }

  // Team names — controlled inputs holding the org OVERRIDE (empty =
  // fall back to the sport defaults shown as placeholders).
  const [teamRed, setTeamRed] = useState("");
  const [teamYellow, setTeamYellow] = useState("");
  const [savingTeamLabels, setSavingTeamLabels] = useState(false);
  async function saveTeamLabels() {
    if (!org) return;
    setSavingTeamLabels(true);
    try {
      const { teamLabels } = await setOrgTeamLabels(org.id, teamRed, teamYellow);
      setOrg((prev) => (prev ? { ...prev, teamLabels } : prev));
      setTeamRed(teamLabels[0] ?? "");
      setTeamYellow(teamLabels[1] ?? "");
      const st = t(org.language);
      toast.success(
        teamLabels.length
          ? st.st_team_names_saved({
              first: teamLabels[0] || org.defaultTeamLabels?.[0] || "Red",
              second: teamLabels[1] || org.defaultTeamLabels?.[1] || "Yellow",
            })
          : st.st_team_names_reset,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(org.language).st_team_names_failed);
    } finally {
      setSavingTeamLabels(false);
    }
  }

  // Bot language. Saved on change; the select is the whole form.
  const [savingLanguage, setSavingLanguage] = useState(false);
  async function saveLanguage(next: Lang) {
    if (!org) return;
    setSavingLanguage(true);
    try {
      const { language } = await setOrgLanguage(org.id, next);
      setOrg((prev) => (prev ? { ...prev, language } : prev));
      settingSaved();
      toast.success(t(language).st_language_saved({ language: LANG_LABELS[normaliseLang(language)] }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(org.language).st_language_failed);
    } finally {
      setSavingLanguage(false);
    }
  }

  const [savingFeature, setSavingFeature] = useState<string | null>(null);
  async function toggleFeature(key: FeatureKey, next: boolean) {
    if (!org) return;
    setSavingFeature(key);
    // Optimistic — flip locally so the switch responds instantly.
    setOrg((prev) =>
      prev ? { ...prev, features: { ...prev.features, [key]: next } } : prev,
    );
    try {
      await setOrgFeature(org.id, key, next);
      settingSaved();
      const st = t(org.language);
      const label =
        key === "badgeAnnouncements"
          ? st.badges_feature_label
          : key === "gearReminder"
            ? st.gear_feature_label
            : st.onbFeatureLabel({ key, englishLabel: (FEATURE_META.find((m) => m.key === key)?.label ?? key).replace(/^\s*↳\s*/, "") });
      toast.success(next ? st.st_feature_on({ label }) : st.st_feature_off({ label }));
    } catch (e) {
      // Roll back on failure.
      setOrg((prev) =>
        prev ? { ...prev, features: { ...prev.features, [key]: !next } } : prev,
      );
      toast.error(e instanceof Error ? e.message : t(org.language).st_save_failed);
    } finally {
      setSavingFeature(null);
    }
  }

  // Weekly routine (2026-09-30). One switch per setting, saved on change
  // through the one `setWeeklyRoutine` action.
  const [savingRoutine, setSavingRoutine] = useState<string | null>(null);
  async function toggleRollingSquad(next: boolean) {
    if (!org) return;
    const s = t(org.language);
    setSavingRoutine("rollingSquad");
    setOrg((prev) => (prev ? { ...prev, weeklyRoutine: { ...prev.weeklyRoutine, rollingSquad: next } } : prev));
    try {
      const res = await setWeeklyRoutine(org.id, { rollingSquad: next });
      if (!res.ok) throw new Error(res.error);
      const { rollingSquad } = res;
      setOrg((prev) => (prev ? { ...prev, weeklyRoutine: { ...prev.weeklyRoutine, rollingSquad } } : prev));
      settingSaved();
      toast.success(rollingSquad ? s.wr_rolling_on : s.wr_rolling_off);
    } catch {
      setOrg((prev) => (prev ? { ...prev, weeklyRoutine: { ...prev.weeklyRoutine, rollingSquad: !next } } : prev));
      toast.error(s.wr_save_failed);
    } finally {
      setSavingRoutine(null);
    }
  }

  const [savingHolder, setSavingHolder] = useState(false);
  async function changeHolder(userId: string) {
    if (!org || !userId) return;
    const prevId = org.paymentHolderId ?? null;
    setSavingHolder(true);
    setOrg((prev) => (prev ? { ...prev, paymentHolderId: userId } : prev)); // optimistic
    try {
      const { name } = await setPaymentHolder(org.id, userId);
      settingSaved();
      toast.success(t(org.language).st_collector_saved({ name: name ?? t(org.language).st_collector_that_member }));
    } catch (e) {
      setOrg((prev) => (prev ? { ...prev, paymentHolderId: prevId } : prev)); // roll back
      toast.error(e instanceof Error ? e.message : t(org.language).st_collector_failed);
    } finally {
      setSavingHolder(false);
    }
  }

  const [connecting, setConnecting] = useState(false);
  async function connectBank() {
    if (!org) return;
    setConnecting(true);
    try {
      const { url } = await startCollectorOnboarding(org.id);
      window.location.href = url; // Stripe-hosted onboarding
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(org.language).st_bank_start_failed);
      setConnecting(false);
    }
  }
  async function refreshBank() {
    if (!org) return;
    try {
      const { chargesEnabled } = await refreshCollectorStatus(org.id);
      setOrg((prev) => (prev ? { ...prev, stripeChargesEnabled: chargesEnabled, stripeConnected: true } : prev));
      toast.success(chargesEnabled ? t(org.language).st_bank_connected : t(org.language).st_bank_not_finished);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(org.language).st_bank_refresh_failed);
    }
  }
  async function manageBank() {
    if (!org) return;
    try {
      const { url } = await openCollectorDashboard(org.id);
      window.open(url, "_blank", "noopener,noreferrer"); // Stripe Express dashboard
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(org.language).st_bank_open_failed);
    }
  }
  const [resetting, setResetting] = useState(false);
  async function resetBank() {
    if (!org) return;
    if (!confirm(t(org.language).st_bank_reset_confirm)) return;
    setResetting(true);
    try {
      await resetCollectorConnect(org.id);
      setOrg((prev) => (prev ? { ...prev, stripeConnected: false, stripeChargesEnabled: false } : prev));
      toast.success(t(org.language).st_bank_reset_done);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(org.language).st_bank_reset_failed);
    } finally {
      setResetting(false);
    }
  }


  // "Ask the player pool automatically", for the Player pool card's summary
  // (its own card loads it).
  const [poolAutoAsk, setPoolAutoAsk] = useState<boolean | null>(null);
  // A row that saves through its own action: the page reads the settings
  // again, so the collapsed card's summary says what is set now.
  const rowSaved = () => {
    settingSaved();
    reloadSettings().catch(() => {});
  };

  if (loading) return <div className="p-10 text-center text-slate-400">{t(layoutLang).st_loading}</div>;
  if (!org) return <div className="p-10 text-center text-slate-400">{t(layoutLang).st_not_found}</div>;

  /** The page's own words, in the club's language. */
  const w = t(pageLang ?? org.language);
  /** The club's language table (the rows that always used it). */
  const s = t(org.language);
  const navLang = pageLang ?? org.language;
  const monthly = org.monthlySquad?.squadMode === "monthly";
  const rollingOn = org.weeklyRoutine?.rollingSquad ?? false;
  const feature = (key: FeatureKey, fallback = false) => org.features?.[key] ?? fallback;

  const inviteLink = `${typeof window !== "undefined" ? window.location.origin : ""}/join/${org.inviteCode}`;

  /** One of the offered feature switches (hidden ones render nothing). */
  const featureRow = (key: FeatureKey) => {
    const m = OFFERED_FEATURE_META.find((x) => x.key === key);
    if (!m) return null;
    const on = feature(key);
    return (
      <FeatureSwitchRow
        key={key}
        settingKey={m.key}
        label={
          // English keeps the menu's own label (the ↳ marks a payment
          // method); other languages read the same words as the in-group menu.
          normaliseLang(org.language) === "en"
            ? m.label
            : `${/^\s*↳/.test(m.label) ? "  ↳ " : ""}${w.onbFeatureLabel({ key: m.key, englishLabel: m.label })}`
        }
        blurb={w.onb_legacy_feature_blurb({ key: m.key, englishBlurb: m.blurb })}
        on={on}
        disabled={savingFeature === key}
        onToggle={() => toggleFeature(key, !on)}
        lang={org.language}
        title={on ? w.st_switch_disable : w.st_switch_enable}
      />
    );
  };
  const rows = "px-4 sm:px-6 divide-y divide-slate-100";
  const bankConnected = !!org.stripeChargesEnabled;

  return (
    <SettingsNavProvider lang={navLang}>
      <div className="space-y-4 min-w-0">
        {/* Go live (slice S5): only for a club that is approved and still
            setting up, and only to its owner and admins (the API sends
            `setup` to nobody else). Above everything else on the page. */}
        {goLiveSetup && (
          <GoLiveBanner
            orgId={org.id}
            club={org.name}
            language={org.language}
            setup={org.setup ?? goLiveSetup}
            refreshKey={previewKey}
            onChanged={reloadSettings}
            onLive={markLive}
          />
        )}

        {/* Posters (2026-10-14): right under the Go live banner, open, while
            the club is setting up, so the owner sees the poster before GO;
            for a live club, on the Messages tab. Owner and admin only: the
            card renders nothing for anyone else. */}
        {goLiveSetup && <PostersCard club={org.name} language={org.language} defaultOpen />}

        {/* F3: what MatchTime set up from the group chat (nothing for a club never read). */}
        {org.inviteCode && <LearnedSetupPanel orgId={org.id} language={org.language} />}

        <FindSetting />
        <SettingsTabs />

        {/* ════ Club ════ */}
        <SettingsTabPanel tab="club">
          <SettingsCard
            id="club-details"
            title={w.st_general_title}
            icon={Settings}
            info={<SectionInfo k="st_general" lang={org.language} />}
            summary={clubDetailsSummary(navLang, { name: org.name, memberCount: org.memberCount })}
            // A draft club comes here to fix its name ("Edit club details"
            // in Finish connecting): the name is open, not one tap away.
            defaultOpen={!!org.nameEditable}
          >
            <div className="p-4 sm:p-6 space-y-4">
              {org.nameEditable ? (
                <form onSubmit={saveClubName} className="space-y-2" data-setting="clubName">
                  <div className="flex items-center gap-1">
                    <label htmlFor="org-name" className="block text-sm font-medium text-slate-700">
                      {w.st_org_name}
                    </label>
                    <SettingInfo k="clubName" lang={org.language} />
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      id="org-name"
                      value={clubName}
                      onChange={(e) => {
                        setClubName(e.target.value);
                        setClubNameState(null);
                      }}
                      required
                      minLength={2}
                      maxLength={60}
                      className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                      type="submit"
                      disabled={savingClubName || clubName.trim().length < 2 || clubName.trim() === org.name}
                      className="shrink-0 inline-flex items-center justify-center px-4 h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {savingClubName ? w.st_saving_name : w.st_save_name}
                    </button>
                  </div>
                  {clubNameState?.kind === "saved" && (
                    <p role="status" data-testid="club-name-saved" className="text-sm text-green-700">
                      {w.st_name_saved}
                    </p>
                  )}
                  {clubNameState?.kind === "error" && (
                    <p role="alert" data-testid="club-name-error" className="text-sm text-red-700">
                      {clubNameState.message}
                    </p>
                  )}
                  <p className="text-sm text-slate-500">{w.st_name_editable_note}</p>
                </form>
              ) : (
                <div data-setting="clubName">
                  <div className="flex items-center gap-1 mb-1.5">
                    <label htmlFor="org-name" className="block text-sm font-medium text-slate-700">
                      {w.st_org_name}
                    </label>
                    <SettingInfo k="clubName" lang={org.language} />
                  </div>
                  <input
                    id="org-name"
                    value={org.name}
                    disabled
                    className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-slate-50 text-slate-700"
                  />
                  {org.nameEditable === false && (
                    <p data-testid="club-name-locked" className="mt-1.5 text-sm text-slate-500">
                      {w.st_name_locked}
                    </p>
                  )}
                </div>
              )}
              <div>
                <label htmlFor="org-slug" className="block text-sm font-medium text-slate-700 mb-1.5">{w.st_url_slug}</label>
                <input
                  id="org-slug"
                  value={org.slug}
                  disabled
                  className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-slate-50 text-slate-700"
                />
              </div>
              <div className="flex items-center gap-1.5 text-sm text-slate-500">
                <Users className="w-4 h-4" />
                {w.st_members({ count: org.memberCount })}
              </div>
            </div>
          </SettingsCard>

          {/* Bot language. The id is where the learned-setup panel's
              "Change the language" button lands (setup-learning/suggestion-action.ts). */}
          <SettingsCard
            id="bot-language"
            title={w.st_language_title}
            icon={Languages}
            info={<SettingInfo k="language" lang={org.language} />}
            summary={languageSummary(org.language)}
            rootProps={{ "data-setting": "language" }}
          >
            <div className="p-4 sm:p-6 space-y-4">
              <p className="text-sm text-slate-500">{w.st_language_lead}</p>
              <select
                value={normaliseLang(org.language)}
                onChange={(e) => saveLanguage(e.target.value as Lang)}
                disabled={savingLanguage}
                className="h-11 px-3 rounded-lg border border-slate-200 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              >
                {LANGS.map((code) => (
                  <option key={code} value={code}>
                    {LANG_LABELS[code]}
                  </option>
                ))}
              </select>
            </div>
          </SettingsCard>

          {/* WhatsApp */}
          <SettingsCard
            id="whatsapp"
            title={w.st_wa_title}
            icon={MessageCircle}
            info={
              <SectionInfo
                k={org.setup?.settingUp ? (org.setup.removedFromGroup ? "st_whatsapp_removed" : "st_whatsapp_setup") : "st_whatsapp"}
                lang={org.language}
              />
            }
            summary={whatsappSummary(navLang, {
              enabled: org.whatsappBotEnabled,
              settingUp: !!org.setup?.settingUp,
              removed: !!org.setup?.removedFromGroup,
            })}
            // While a club sets up, this card says why MatchTime is quiet
            // and points at Go live: open, as the banner above it is.
            defaultOpen={!!org.setup?.settingUp}
          >
            <div className="p-4 sm:p-6 space-y-4">
              {/* A club that is setting up is not "Disabled": it is approved
                  and waiting for its organiser to go live (slice S5). */}
              {org.setup?.settingUp ? (
                <span
                  data-testid="wa-setting-up"
                  data-removed={org.setup.removedFromGroup ? "true" : undefined}
                  className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
                    org.setup.removedFromGroup ? "bg-amber-100 text-amber-900" : "bg-emerald-100 text-emerald-800"
                  }`}
                >
                  {/* Removed from the group while setting up: it is not "in
                      your group, waiting", and the page must not say so. */}
                  {org.setup.removedFromGroup ? s.sj_live_wa_badge_removed : s.sj_live_wa_badge}
                </span>
              ) : (
                <span
                  data-testid="wa-bot-state"
                  className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
                    org.whatsappBotEnabled ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {org.whatsappBotEnabled ? w.st_wa_enabled : w.st_wa_disabled}
                </span>
              )}
              {org.whatsappGroupId && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">{w.st_wa_group_id}</label>
                  <input
                    value={org.whatsappGroupId}
                    disabled
                    className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-slate-50 font-mono text-xs text-slate-700"
                  />
                </div>
              )}
              {org.setup?.settingUp ? (
                <p data-testid="wa-setting-up-body" className="text-sm text-slate-600">
                  {org.setup.removedFromGroup ? s.sj_live_wa_body_removed : s.sj_live_wa_body}{" "}
                  <a href="#go-live" className="font-medium text-emerald-800 underline">
                    {s.sj_live_wa_link}
                  </a>
                </p>
              ) : (
                <p className="text-xs text-slate-500">{w.st_wa_managed}</p>
              )}
            </div>
          </SettingsCard>
        </SettingsTabPanel>

        {/* ════ Matches ════ */}
        <SettingsTabPanel tab="matches">
          {/* Weekly routine (2026-09-30). Words from the club's language table. */}
          <SettingsCard
            id="weekly-routine"
            title={s.wr_section_title}
            icon={Repeat}
            info={<SectionInfo k="st_weekly" lang={org.language} />}
            summary={weeklyRoutineSummary(org.language, {
              rollingSquad: monthly ? null : rollingOn,
              deadlines: [org.weeklyRoutine?.dropOutDeadline, org.weeklyRoutine?.listPublish].filter(Boolean).length,
            })}
            testId="weekly-routine"
          >
            <div className="px-4 sm:px-6 pt-4">
              <p className="text-sm text-slate-500">{s.wr_section_lead}</p>
            </div>
            <div className={`${rows} pb-2`}>
              {/* A monthly club has no rolling squad: the month's regulars
                  take its place (monthly squad, slice 2). */}
              {!monthly && (
                <div className="flex items-center justify-between gap-4 py-3" data-testid="wr-rolling" data-setting="rollingSquad">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
                      {s.wr_rolling_label}
                      <SettingInfo k="rollingSquad" lang={org.language} />
                    </div>
                    <p className="text-xs text-slate-500">{s.wr_rolling_blurb}</p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={rollingOn}
                    aria-label={s.wr_rolling_label}
                    disabled={savingRoutine === "rollingSquad"}
                    onClick={() => toggleRollingSquad(!rollingOn)}
                    className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${
                      rollingOn ? "bg-green-500" : "bg-slate-300"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                        rollingOn ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
              )}
              {/* 2026-10-14: who announces the list and teams. */}
              <ListAnnouncerRow
                orgId={org.id}
                language={org.language}
                listAnnouncer={org.weeklyRoutine?.listAnnouncer ?? "matchtime"}
                onSaved={rowSaved}
              />
              {/* Weekly deadlines (slice 3): its own component. */}
              <WeeklyDeadlineRows
                orgId={org.id}
                language={org.language}
                dropOutDeadline={org.weeklyRoutine?.dropOutDeadline ?? null}
                listPublish={org.weeklyRoutine?.listPublish ?? null}
                onSaved={rowSaved}
              />
            </div>
          </SettingsCard>

          {/* Personal reminders and the match-day kit reminder (2026-10-15). */}
          <SettingsCard
            id="reminders"
            title={settingsNavCopy(navLang).titles.reminders}
            icon={BellRing}
            summary={remindersSummary(org.language, { personal: feature("reminders"), gear: feature("gearReminder") })}
          >
            <div className={rows}>
              {featureRow("reminders")}
              {/* The match-day kit reminder. Off for a new club, on for clubs from before. */}
              <FeatureSwitchRow
                settingKey="gearReminder"
                label={s.gear_feature_label}
                blurb={s.gear_feature_blurb}
                on={feature("gearReminder")}
                disabled={savingFeature === "gearReminder"}
                onToggle={() => toggleFeature("gearReminder", !feature("gearReminder"))}
                lang={org.language}
                title={feature("gearReminder") ? w.st_switch_disable : w.st_switch_enable}
                ariaLabel={s.gear_feature_label}
                testId="feature-gear-reminder"
              />
            </div>
          </SettingsCard>

          {/* Teams: team generation, the team names, and when the teams are ready. */}
          <SettingsCard
            id="teams"
            title={settingsNavCopy(navLang).titles.teams}
            icon={Shirt}
            summary={teamsSummary(org.language, {
              balancing: feature("teamBalancing"),
              first: org.teamLabels?.[0] || org.defaultTeamLabels?.[0] || "Red",
              second: org.teamLabels?.[1] || org.defaultTeamLabels?.[1] || "Yellow",
            })}
          >
            <div className={rows}>
              {featureRow("teamBalancing")}
              <div className="py-4 space-y-4" data-setting="teamNames">
                <div className="flex items-center gap-1">
                  <h3 className="text-sm font-semibold text-slate-800">{w.st_team_names_title}</h3>
                  <SettingInfo k="teamNames" lang={org.language} />
                </div>
                <p className="text-sm text-slate-500">
                  {w.st_team_names_lead({ first: org.defaultTeamLabels?.[0] ?? "Red", second: org.defaultTeamLabels?.[1] ?? "Yellow" })}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700 mb-1.5">
                      <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
                      {w.st_first_team}
                    </label>
                    <input
                      value={teamRed}
                      onChange={(e) => setTeamRed(e.target.value)}
                      placeholder={org.defaultTeamLabels?.[0] ?? "Red"}
                      maxLength={24}
                      className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-white text-slate-700 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700 mb-1.5">
                      <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
                      {w.st_second_team}
                    </label>
                    <input
                      value={teamYellow}
                      onChange={(e) => setTeamYellow(e.target.value)}
                      placeholder={org.defaultTeamLabels?.[1] ?? "Yellow"}
                      maxLength={24}
                      className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-white text-slate-700 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
                <button
                  onClick={saveTeamLabels}
                  disabled={savingTeamLabels}
                  className="inline-flex items-center gap-2 px-4 h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50"
                >
                  {savingTeamLabels ? w.st_saving : w.st_save_team_names}
                </button>
              </div>
              {/* Teams ready (2026-10-14): shown with an admin group linked. */}
              <TeamsReadyRow orgId={org.id} language={org.language} />
            </div>
          </SettingsCard>

          {/* Monthly squad (2026-10-05, slice 2). Admins only (the API sends
              `monthlySquad` to nobody else). Off by default: a weekly club
              sees the one switch. */}
          {org.monthlySquad && (
            <MonthlySquadSection
              orgId={org.id}
              language={org.language}
              initial={org.monthlySquad}
              onSaved={({ rollingSquad, ...monthlySquad }) => {
                setOrg((prev) =>
                  prev ? { ...prev, monthlySquad, weeklyRoutine: { ...prev.weeklyRoutine, rollingSquad } } : prev,
                );
                settingSaved();
              }}
            />
          )}
        </SettingsTabPanel>

        {/* ════ Players ════ */}
        <SettingsTabPanel tab="players">
          <SettingsCard
            id="attendance"
            title={settingsNavCopy(navLang).titles.attendance}
            icon={ClipboardCheck}
            summary={onOffSummary(org.language, feature("attendance"))}
          >
            <div className={rows}>{featureRow("attendance")}</div>
          </SettingsCard>

          <SettingsCard
            id="bench"
            title={settingsNavCopy(navLang).titles.bench}
            icon={Armchair}
            summary={benchSummary(org.language, {
              on: feature("bench"),
              pickMode: org.weeklyRoutine?.benchPickMode ?? "first-come",
            })}
          >
            <div className={rows}>
              {featureRow("bench")}
              {/* Organiser pick (slice 2b): who fills an open place. */}
              <PickModeRows
                orgId={org.id}
                language={org.language}
                benchPickMode={org.weeklyRoutine?.benchPickMode ?? "first-come"}
                benchPickFallback={org.weeklyRoutine?.benchPickFallback ?? "bench-offer"}
                onSaved={rowSaved}
              />
            </div>
          </SettingsCard>

          <SettingsCard
            id="ratings"
            title={settingsNavCopy(navLang).titles.ratings}
            icon={Star}
            summary={ratingsSummary(org.language, {
              ratings: feature("playerRating"),
              badges: feature("badgeAnnouncements", true),
              stats: feature("statsQa"),
            })}
          >
            <div className={rows}>
              {featureRow("playerRating")}
              {/* Badge announcements (2026-10-01). Its own row, not in
                  FEATURE_META (that list is also the numbered in-group
                  setup menu). Words from the club's language table. */}
              <FeatureSwitchRow
                settingKey="badgeAnnouncements"
                label={s.badges_feature_label}
                blurb={s.badges_feature_blurb}
                on={feature("badgeAnnouncements", true)}
                disabled={savingFeature === "badgeAnnouncements"}
                onToggle={() => toggleFeature("badgeAnnouncements", !feature("badgeAnnouncements", true))}
                lang={org.language}
                title={feature("badgeAnnouncements", true) ? w.st_switch_disable : w.st_switch_enable}
                ariaLabel={s.badges_feature_label}
                testId="feature-badge-announcements"
              />
              {featureRow("statsQa")}
            </div>
          </SettingsCard>

          <SettingsCard
            id="mom"
            title={settingsNavCopy(navLang).titles.mom}
            icon={Trophy}
            summary={momSummary(org.language, { on: feature("momVoting"), chosenBy: org.weeklyRoutine?.momChosenBy ?? "players" })}
          >
            <div className={rows}>
              {featureRow("momVoting")}
              {/* Who chooses Man of the Match (2026-10-18, mom-chooser.ts).
                  Admins only: it comes with the weekly routine settings. */}
              {org.weeklyRoutine && (
                <MomChooserRow
                  orgId={org.id}
                  language={org.language}
                  momChosenBy={org.weeklyRoutine.momChosenBy ?? "players"}
                  onSaved={rowSaved}
                />
              )}
            </div>
          </SettingsCard>

          {/* Invite */}
          <SettingsCard
            id="invite-link"
            title={w.st_invite_title}
            icon={LinkIcon}
            info={<SectionInfo k="st_invite" lang={org.language} />}
            summary={inviteLinkSummary(navLang)}
          >
            <div className="p-4 sm:p-6 space-y-4">
              <p className="text-sm text-slate-500">{w.st_invite_lead}</p>
              <div className="flex items-center gap-2 min-w-0">
                <input
                  value={inviteLink}
                  readOnly
                  className="flex-1 min-w-0 h-11 px-3 rounded-lg border border-slate-200 bg-slate-50 font-mono text-xs text-slate-700"
                />
                <button
                  onClick={copyInviteLink}
                  className="shrink-0 inline-flex items-center gap-2 px-4 h-11 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
                >
                  <Copy className="w-4 h-4" />
                  {w.st_copy}
                </button>
              </div>
            </div>
          </SettingsCard>
        </SettingsTabPanel>

        {/* ════ Payments ════ */}
        <SettingsTabPanel tab="payments">
          <SettingsCard
            id="payments"
            title={settingsNavCopy(navLang).titles.payments}
            icon={Wallet}
            summary={paymentsSummary(org.language, { collecting: feature("paymentCollection"), bankConnected })}
          >
            <div className={rows}>
              {featureRow("paymentCollection")}
              {featureRow("payByBank")}
              {featureRow("payCard")}
              {featureRow("payDirect")}
            </div>
            {/* The money collector and the bank, while match fees are collected. */}
            {org.features?.paymentCollection && (
              <div className="border-t border-slate-100 p-4 sm:p-6 space-y-4" data-setting="collectorBank" data-testid="collector-bank">
                <div className="flex items-center gap-1">
                  <Landmark className="w-4 h-4 text-slate-500" aria-hidden />
                  <h3 className="text-sm font-semibold text-slate-800">{w.st_bank_title}</h3>
                  <SettingInfo k="collectorBank" lang={org.language} />
                </div>
                {/* Who collects the money */}
                <div data-setting="moneyCollector">
                  <div className="flex items-center gap-1 mb-1.5">
                    <label className="block text-sm font-medium text-slate-700">{w.st_collector}</label>
                    <SettingInfo k="moneyCollector" lang={org.language} />
                  </div>
                  <select
                    value={org.paymentHolderId ?? ""}
                    onChange={(e) => changeHolder(e.target.value)}
                    disabled={savingHolder}
                    className="w-full h-11 px-3 rounded-lg border border-slate-200 bg-white text-slate-700 disabled:opacity-50"
                  >
                    <option value="" disabled>
                      {w.st_choose_member}
                    </option>
                    {(org.members ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name ?? w.st_unnamed}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-slate-400 mt-1.5">{w.st_collector_help}</p>
                </div>

                {/* Payment instructions for weekly match fees (2026-10-16). A
                    monthly club edits the same field in its Monthly squad
                    section, so it is not shown twice. */}
                {org.monthlySquad && org.monthlySquad.squadMode !== "monthly" && (
                  <>
                    <hr className="border-slate-100" />
                    <PaymentInstructionsRow
                      orgId={org.id}
                      language={org.language}
                      initial={org.monthlySquad.paymentInstructions}
                      onSaved={({ rollingSquad: _rolling, ...monthlySquad }) => {
                        void _rolling;
                        setOrg((prev) => (prev ? { ...prev, monthlySquad } : prev));
                        settingSaved();
                      }}
                    />
                  </>
                )}

                <hr className="border-slate-100" />

                <p className="text-sm text-slate-500">{w.st_bank_lead}</p>
                {!org.stripeChargesEnabled && <p className="text-xs text-slate-400">{w.st_bank_stripe_help}</p>}
                {org.stripeChargesEnabled ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700 text-sm font-medium">
                      <CheckCircle2 className="w-4 h-4" /> {w.st_bank_connected}
                    </div>
                    <button
                      onClick={manageBank}
                      className="inline-flex items-center gap-2 px-4 h-11 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
                    >
                      <Landmark className="w-4 h-4" /> {w.st_manage_bank}
                    </button>
                    <button
                      onClick={resetBank}
                      disabled={resetting}
                      className="inline-flex items-center gap-2 px-4 h-11 rounded-lg border border-slate-200 bg-white hover:bg-red-50 hover:border-red-200 text-slate-600 hover:text-red-600 font-medium disabled:opacity-50"
                    >
                      {resetting ? w.st_disconnecting : w.st_disconnect}
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      onClick={connectBank}
                      disabled={connecting}
                      className="inline-flex items-center gap-2 px-4 h-11 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50"
                    >
                      <Landmark className="w-4 h-4" />
                      {connecting ? w.st_opening_stripe : org.stripeConnected ? w.st_finish_bank : w.st_connect_bank}
                    </button>
                    {org.stripeConnected && (
                      <>
                        <button
                          onClick={refreshBank}
                          className="inline-flex items-center gap-2 px-4 h-11 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
                        >
                          {w.st_refresh_status}
                        </button>
                        <button
                          onClick={resetBank}
                          disabled={resetting}
                          className="inline-flex items-center gap-2 px-4 h-11 rounded-lg border border-slate-200 bg-white hover:bg-red-50 hover:border-red-200 text-slate-600 hover:text-red-600 font-medium disabled:opacity-50"
                        >
                          {resetting ? w.st_resetting : w.st_start_over}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </SettingsCard>

          {/* Club fee billing (slice B2). On the Payments tab: it is money
              too, and its "Choose a money collector" link points at the
              collector picker in the Payments card above, which only exists
              while payment collection is on. */}
          {org.billing && (
            <BillingSettingsCard data={org.billing} lang={org.language} collectorAnchor={org.features?.paymentCollection ? "#payments" : null} />
          )}
        </SettingsTabPanel>

        {/* ════ Finding players ════ */}
        <SettingsTabPanel tab="finding">
          {/* Partner clubs (cross-club ask, 2026-10-16). Shown to every club
              since partner discovery (P1, 2026-10-22). */}
          <PartnerClubsSection orgId={org.id} language={org.language} />
          {/* The club's own player pool switch (2026-10-28): only while the
              platform owner has the pool on. The cards below it show only while
              it is on too (`poolOffersOpenForClub`), and load again on a flip. */}
          <PlayerPoolSection
            orgId={org.id}
            language={org.language}
            autoAsk={poolAutoAsk}
            onChange={() => setPoolKey((k) => k + 1)}
          />
          {/* Style of play (pool L5b): only while the club may ask the player pool. */}
          <PlayStyleSection key={`ps-${poolKey}`} orgId={org.id} language={org.language} />
          <PoolAutoAskSection key={`pa-${poolKey}`} orgId={org.id} language={org.language} onState={setPoolAutoAsk} />
          {/* The club's one share post (pool G3): only while the club has the player pool. */}
          <PoolClubShareSection key={`pcs-${poolKey}`} orgId={org.id} language={org.language} />
          {/* Group invite link (pool L8): only while the club has the player pool. */}
          <GroupInviteLinkSection key={`gil-${poolKey}`} orgId={org.id} language={org.language} />
        </SettingsTabPanel>

        {/* ════ Messages ════ */}
        <SettingsTabPanel tab="messages">
          {/* Quiet hours (2026-10-16): owner and admin only. */}
          <QuietHoursSection orgId={org.id} language={org.language} />
          {/* Slice 2a: where admin messages go. */}
          <AdminChannelSettings orgId={org.id} lang={normaliseLang(org.language)} />
          {!goLiveSetup && <PostersCard club={org.name} language={org.language} />}
        </SettingsTabPanel>
      </div>
    </SettingsNavProvider>
  );
}
