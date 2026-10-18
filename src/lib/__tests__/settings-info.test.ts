/**
 * THE SETTINGS EXPLANATIONS (2026-10-15), src/lib/settings-info.ts.
 *
 * Three things are pinned here:
 *   1. COVERAGE. Every setting rendered on /admin/settings (the page and
 *      src/components/settings/*) has an explanation in both languages,
 *      and every explanation is used. A new setting row without one fails
 *      here: a file that renders a form control must mark its rows with
 *      `data-setting` and give each one a `<SettingInfo>`.
 *   2. THE HOUSE RULES. Same shape in both languages, no em or en dashes,
 *      no slash used for "or", the choice names are the words the page
 *      shows, the titles are the row labels.
 *   3. THE FACTS. Where a sentence states a number or a default, it is
 *      checked against the code that decides it (schema defaults, fees,
 *      code lifetimes, limits), so the copy cannot drift silently.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS_INFO, SETTING_INFO_KEYS, settingInfo, settingInfoLabels, type SettingInfoCopy, type SettingInfoKey } from "../settings-info";
import { OFFERED_FEATURE_META as FEATURE_META } from "../org-features-meta";
import { LANGS, type Lang } from "../i18n/lang";
import { t } from "../i18n/t";
import { totalForMethod, PLATFORM_FEE_RATE } from "../payments";
import { ADMIN_GROUP_CODE_TTL_MS, ADMIN_GROUP_DM_CODE_TTL_MS } from "../admin-channel-rules";
import { LIST_OPENS_DAYS_MAX, LIST_OPENS_DAYS_MIN, MAX_PER_GAME_PENCE, PAYMENT_INSTRUCTIONS_MAX } from "../squad-month-rules";
import { REMINDER_LEAD_MS, effectiveTeamsReadyTime } from "../team-proposal-rules";
import { pickFallbackAt } from "../organiser-pick-rules";
import { DEFAULT_QUIET_HOURS } from "../message-hours";
import {
  PARTNER_ASK_CUTOFF_DEFAULT_HOURS,
  PARTNER_ASK_CUTOFF_MAX_HOURS,
  PARTNER_ASK_CUTOFF_MIN_HOURS,
  PARTNER_ASK_TIME_DEFAULT,
} from "../club-partnership-rules";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const SETTINGS_DIR = "src/components/settings";
const PAGE = "src/app/admin/settings/page.tsx";
const SOURCES = [PAGE, ...readdirSync(join(ROOT, SETTINGS_DIR)).filter((f) => f.endsWith(".tsx")).map((f) => `${SETTINGS_DIR}/${f}`)];

/** Every string in one explanation, for the house-rule checks. */
function allText(c: SettingInfoCopy): string[] {
  return [c.title, ...c.what, c.example ?? "", ...(c.choices ?? []).flatMap((x) => [x.name, x.text]), c.newClubs, c.suits ?? "", ...(c.together ?? [])].filter(Boolean);
}
const joined = (c: SettingInfoCopy) => allText(c).join("\n");

/** The Organisation model's column defaults, read from the schema. */
function orgDefaults(): Record<string, string> {
  const schema = read("prisma/schema.prisma");
  const block = schema.slice(schema.indexOf("model Organisation {"));
  const body = block.slice(0, block.indexOf("\n}"));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s+(\w+)\s+\w+\??\s+@default\(([^)]*)\)/gm)) out[m[1]] = m[2].replace(/"/g, "");
  return out;
}

describe("settings explanations: coverage", () => {
  it("every key has an English and a Turkish explanation with a title, what it does and the new-club default", () => {
    for (const k of SETTING_INFO_KEYS) {
      for (const lang of LANGS) {
        const c = SETTINGS_INFO[k][lang];
        expect(c, `${k} ${lang}`).toBeTruthy();
        expect(c.title.trim(), `${k} ${lang} title`).not.toBe("");
        expect(c.what.length, `${k} ${lang} what`).toBeGreaterThan(0);
        for (const p of c.what) expect(p.trim(), `${k} ${lang} what`).not.toBe("");
        expect(c.newClubs.trim(), `${k} ${lang} newClubs`).not.toBe("");
      }
    }
    expect(Object.keys(SETTINGS_INFO).sort()).toEqual([...SETTING_INFO_KEYS].sort());
  });

  it("every Bot features switch, Badge announcements included, has an explanation", () => {
    for (const m of FEATURE_META) expect(SETTING_INFO_KEYS, m.key).toContain(m.key);
    expect(SETTING_INFO_KEYS).toContain("badgeAnnouncements");
    expect(SETTING_INFO_KEYS).toContain("gearReminder");
  });

  it("badges post in the players' group whoever announces the list (Kemal, 2026-10-16)", () => {
    const en = (SETTINGS_INFO.badgeAnnouncements.en.together ?? []).join(" ");
    const tr = (SETTINGS_INFO.badgeAnnouncements.tr.together ?? []).join(" ");
    expect(en).not.toMatch(/admin messages/);
    expect(tr).not.toMatch(/yönetici mesajlarınıza/);
    expect(en).toContain("The badge post goes in the players' group whoever announces the list.");
    expect(tr).toContain("Rozet mesajı, listeyi kim duyurursa duyursun oyuncu grubunda paylaşılır.");
  });

  it("every setting row on the page has an ⓘ, and every explanation is shown somewhere", () => {
    const used = new Set<string>();
    const rows = new Set<string>();
    for (const file of SOURCES) {
      const src = read(file);
      for (const m of src.matchAll(/<SettingInfo k="(\w+)"/g)) used.add(m[1]);
      for (const m of src.matchAll(/data-setting="(\w+)"/g)) rows.add(m[1]);
    }
    // The three rows whose key is a variable: the OFFERED_FEATURE_META loop on the
    // page (`k={key}`) and the two weekly-deadline rows (`k={props.rowKey}`).
    expect(read(PAGE)).toMatch(/<SettingInfo k=\{key\}/);
    expect(read(PAGE)).toMatch(/data-setting=\{key\}/);
    for (const m of FEATURE_META) used.add(m.key), rows.add(m.key);
    const deadlines = read(`${SETTINGS_DIR}/weekly-deadline-rows.tsx`);
    expect(deadlines).toMatch(/<SettingInfo k=\{props\.rowKey\}/);
    expect(deadlines).toMatch(/data-setting=\{props\.rowKey\}/);
    for (const k of ["dropOutDeadline", "listPublish"]) used.add(k), rows.add(k);

    for (const k of used) expect(SETTING_INFO_KEYS as readonly string[], `<SettingInfo k="${k}">`).toContain(k);
    for (const k of rows) expect(used, `data-setting="${k}" has no <SettingInfo>`).toContain(k);
    for (const k of SETTING_INFO_KEYS) expect(used, `${k} is never shown`).toContain(k);
  });

  it("a settings component that renders a form control marks its rows and gives them an ⓘ", () => {
    const CONTROL = /role="switch"|<select|<textarea|<input/;
    for (const file of SOURCES) {
      const src = read(file);
      if (!CONTROL.test(src)) continue;
      expect(src, `${file}: a control without data-setting`).toMatch(/data-setting=/);
      expect(src, `${file}: a control without <SettingInfo>`).toMatch(/<SettingInfo /);
    }
  });
});

describe("settings explanations: house rules", () => {
  it("both languages have the same shape", () => {
    for (const k of SETTING_INFO_KEYS) {
      const en = SETTINGS_INFO[k].en;
      const tr = SETTINGS_INFO[k].tr;
      expect(tr.what.length, `${k} what`).toBe(en.what.length);
      expect(!!tr.example, `${k} example`).toBe(!!en.example);
      expect(tr.choices?.length ?? 0, `${k} choices`).toBe(en.choices?.length ?? 0);
      expect(!!tr.suits, `${k} suits`).toBe(!!en.suits);
      expect(tr.together?.length ?? 0, `${k} together`).toBe(en.together?.length ?? 0);
    }
  });

  it("no em or en dash, and no slash between words", () => {
    for (const k of SETTING_INFO_KEYS) {
      for (const lang of LANGS) {
        for (const s of allText(SETTINGS_INFO[k][lang])) {
          expect(s, `${k} ${lang}`).not.toMatch(/[—–]/);
          expect(s, `${k} ${lang}`).not.toMatch(/\p{L}\s*\/\s*\p{L}/u);
        }
      }
    }
    for (const lang of LANGS) for (const v of Object.values(settingInfoLabels(lang))) expect(v).not.toMatch(/[—–/]/);
  });

  it("each popup's title is the label the organiser sees beside it", () => {
    for (const lang of LANGS) {
      const s = t(lang);
      const titles: Partial<Record<SettingInfoKey, string>> = {
        goLive: s.sj_go_button,
        rollingSquad: s.wr_rolling_label,
        benchPickMode: s.wr_pick_label,
        benchPickFallback: s.wr_fallback_label,
        listAnnouncer: s.wr_announce_label,
        momChosenBy: s.mom_chooser_label,
        dropOutDeadline: s.wd_dropout_label,
        listPublish: s.wd_publish_label,
        adminChannel: s.settings_admin_channel_heading,
        adminGroupLink: s.settings_admin_channel_link_button,
        teamsReady: s.tp_settings_label,
        quietHours: s.qh_settings_label,
        posters: s.gp_title,
        posterDesign: s.gp_design_heading,
        posterBackground: s.gp_upload_heading,
        squadMode: s.msq_mode_label,
        monthCreditRule: s.msq_credit_label,
        paygPrice: s.msq_payg_label.replace(/\s*\(£\)$/, ""),
        monthListOpens: s.msq_opens_label,
        paymentInstructions: s.msq_instructions_label,
        badgeAnnouncements: s.badges_feature_label,
        gearReminder: s.gear_feature_label,
        partnerClubs: s.pc_list_label,
        partnerAskWhen: s.pc_when_label,
        partnerAskTime: s.pc_time_label,
        partnerAskCutoff: s.pc_cutoff_label,
        partnerApproval: s.pc_approval_label,
      };
      for (const [k, label] of Object.entries(titles)) expect(settingInfo(lang, k as SettingInfoKey).title, `${k} ${lang}`).toBe(label);
    }
    // The page's own English labels.
    expect(settingInfo("en", "clubName").title).toBe("Organisation name");
    expect(settingInfo("en", "moneyCollector").title).toBe("Money collector");
    expect(settingInfo("en", "collectorBank").title).toBe("Money collector's bank");
    for (const m of FEATURE_META) expect(m.label.replace(/^\s*↳\s*/, "")).toContain(settingInfo("en", m.key).title.split(" and ")[0]);
  });

  it("the choices are named with the words on the page", () => {
    for (const lang of LANGS) {
      const s = t(lang);
      const names = (k: SettingInfoKey) => settingInfo(lang, k).choices!.map((c) => c.name);
      expect(names("benchPickMode")).toEqual([s.wr_pick_first_come, s.wr_pick_organiser]);
      expect(names("benchPickFallback")).toEqual([s.wr_fallback_offer, s.wr_fallback_leave]);
      expect(names("listAnnouncer")).toEqual([s.wr_announce_matchtime, s.wr_announce_organisers]);
      expect(names("momChosenBy")).toEqual([s.mom_chooser_players, s.mom_chooser_organisers]);
      expect(names("adminChannel")).toEqual([
        s.settings_admin_channel_mode_one_person,
        s.settings_admin_channel_mode_admin_group,
        s.settings_admin_channel_mode_each_admin,
      ]);
      expect(names("monthCreditRule")).toEqual([s.msq_credit_any, s.msq_credit_filled, s.msq_credit_none]);
      const [weekly, monthly] = names("squadMode");
      expect(s.msq_mode_weekly.startsWith(weekly)).toBe(true);
      expect(s.msq_mode_monthly.startsWith(monthly)).toBe(true);
      expect(names("teamsReady")[1]).toBe(s.tp_settings_off);
      expect(names("partnerAskWhen")).toEqual([s.pc_when_off, s.pc_when_on_request, s.pc_when_auto]);
      expect(names("partnerApproval")).toEqual([s.pc_approval_each, s.pc_approval_standing]);
    }
  });

  it("unknown languages read English", () => {
    expect(settingInfo("xx", "rollingSquad")).toBe(SETTINGS_INFO.rollingSquad.en);
    expect(settingInfo(null, "rollingSquad")).toBe(SETTINGS_INFO.rollingSquad.en);
    expect(settingInfo("tr", "rollingSquad")).toBe(SETTINGS_INFO.rollingSquad.tr);
  });
});

describe("settings explanations: the facts match the code", () => {
  const d = orgDefaults();
  const newClubs = (k: SettingInfoKey, lang: Lang = "en") => settingInfo(lang, k).newClubs;

  it("quiet hours: the default stated is the schema's and the code's (On, 23:00 to 09:00)", () => {
    expect(d.quietHoursEnabled).toBe("true");
    expect(d.quietHoursFrom).toBe(DEFAULT_QUIET_HOURS.from);
    expect(d.quietHoursTo).toBe(DEFAULT_QUIET_HOURS.to);
    expect(newClubs("quietHours")).toBe(`On, ${DEFAULT_QUIET_HOURS.from} to ${DEFAULT_QUIET_HOURS.to}.`);
    expect(newClubs("quietHours", "tr")).toBe(`Açık, ${DEFAULT_QUIET_HOURS.from} ile ${DEFAULT_QUIET_HOURS.to} arası.`);
    for (const lang of LANGS) {
      const c = settingInfo(lang, "quietHours");
      expect(c.choices!.map((x) => x.name)).toEqual(lang === "en" ? ["On", "Off"] : ["Açık", "Kapalı"]);
      // The platform's own setup and fee DMs keep the default window.
      expect(c.together!.join(" ")).toContain(`${DEFAULT_QUIET_HOURS.from}`);
    }
    // The gates named in the popup are the ones message-hours.ts lists as club gates.
    const doc = read("src/lib/message-hours.ts");
    for (const f of ["admin-channel.ts", "organiser-pick-rules.ts", "bot-scheduler.ts", "recruit-chase.ts", "weekly-deadlines.ts", "seed-nudge-rules.ts", "month-signup-rules.ts", "ai-cap-notice.ts"]) {
      expect(doc).toContain(f);
    }
  });

  it("each switch's new-club default is the schema default", () => {
    const columns: Partial<Record<SettingInfoKey, string>> = {
      attendance: "featureAttendance",
      bench: "featureBench",
      teamBalancing: "featureTeamBalancing",
      momVoting: "featureMomVoting",
      playerRating: "featurePlayerRating",
      reminders: "featureReminders",
      statsQa: "featureStatsQa",
      paymentCollection: "paymentCollectionEnabled",
      payByBank: "payMethodPayByBank",
      payCard: "payMethodCard",
      payDirect: "payMethodDirect",
      badgeAnnouncements: "featureBadgeAnnouncements",
      gearReminder: "featureGearReminder",
      rollingSquad: "rollingSquadEnabled",
    };
    for (const [k, col] of Object.entries(columns)) {
      expect(d[col], col).toMatch(/^(true|false)$/);
      const on = d[col] === "true";
      expect(newClubs(k as SettingInfoKey), k).toMatch(on ? /^On\./ : /^Off\./);
      expect(newClubs(k as SettingInfoKey, "tr"), k).toMatch(on ? /^Açık\./ : /^Kapalı\./);
    }
  });

  it("each list's new-club default is the schema default", () => {
    const s = t("en");
    expect(d.benchPickMode).toBe("first-come");
    expect(newClubs("benchPickMode")).toMatch(new RegExp(`^${s.wr_pick_first_come}\\.`));
    expect(d.benchPickFallback).toBe("bench-offer");
    expect(newClubs("benchPickFallback")).toBe(`${s.wr_fallback_offer}.`);
    expect(d.listAnnouncer).toBe("matchtime");
    expect(newClubs("listAnnouncer")).toBe("MatchTime.");
    expect(d.momChosenBy).toBe("players");
    expect(newClubs("momChosenBy")).toBe(`${s.mom_chooser_players}.`);
    expect(d.adminChannelMode).toBe("one-person");
    expect(newClubs("adminChannel")).toMatch(/^One person: the club's owner\./);
    expect(d.squadMode).toBe("weekly");
    expect(newClubs("squadMode")).toBe("Weekly.");
    expect(d.monthCreditRule).toBe("any-miss");
    expect(newClubs("monthCreditRule")).toBe(`${s.msq_credit_any}.`);
    expect(d.monthListOpensDaysBefore).toBe("7");
    expect(newClubs("monthListOpens")).toBe("7 days.");
    expect(newClubs("monthListOpens", "tr")).toBe("7 gün.");
    expect(d.language).toBe("en");
  });

  it("partner clubs: asking is off, the cut-off is 4 hours (1 to 24), the automatic time 16:00", () => {
    expect(d.partnerAskWhen).toBe("off");
    expect(newClubs("partnerAskWhen")).toBe(`${t("en").pc_when_off}.`);
    expect(newClubs("partnerAskWhen", "tr")).toBe(`${t("tr").pc_when_off}.`);
    expect(d.partnerAskCutoffHours).toBe(String(PARTNER_ASK_CUTOFF_DEFAULT_HOURS));
    expect(newClubs("partnerAskCutoff")).toBe(`${t("en").pc_cutoff_hours({ hours: PARTNER_ASK_CUTOFF_DEFAULT_HOURS })}.`);
    expect(newClubs("partnerAskCutoff", "tr")).toBe(`${t("tr").pc_cutoff_hours({ hours: PARTNER_ASK_CUTOFF_DEFAULT_HOURS })}.`);
    expect(joined(settingInfo("en", "partnerAskCutoff"))).toContain(`from ${PARTNER_ASK_CUTOFF_MIN_HOURS} to ${PARTNER_ASK_CUTOFF_MAX_HOURS} hours`);
    expect(joined(settingInfo("tr", "partnerAskCutoff"))).toContain(`${PARTNER_ASK_CUTOFF_MIN_HOURS} ile ${PARTNER_ASK_CUTOFF_MAX_HOURS} saat`);
    expect(newClubs("partnerAskTime")).toBe(`${PARTNER_ASK_TIME_DEFAULT}.`);
    expect(newClubs("partnerAskTime", "tr")).toBe(`${PARTNER_ASK_TIME_DEFAULT}.`);
    // The partner's approval default is the table's column default.
    const schema = read("prisma/schema.prisma");
    const block = schema.slice(schema.indexOf("model ClubPartnership {"));
    expect(block.slice(0, block.indexOf("\n}"))).toMatch(/partnerApproval\s+String\s+@default\("each-ask"\)/);
    expect(newClubs("partnerApproval")).toBe(`${t("en").pc_approval_each}.`);
    expect(newClubs("partnerApproval", "tr")).toBe(`${t("tr").pc_approval_each}.`);
  });

  it("the pay-by-link prices are what a player is charged on a £10 fee", () => {
    expect(PLATFORM_FEE_RATE).toBe(0.01);
    const bank = totalForMethod(10, "pay_by_bank", 1).toFixed(2);
    const card = totalForMethod(10, "card", 1).toFixed(2);
    for (const lang of LANGS) {
      expect(joined(settingInfo(lang, "payByBank"))).toContain(`£${bank}`);
      expect(joined(settingInfo(lang, "payCard"))).toContain(`£${card}`);
      expect(joined(settingInfo(lang, "payByBank"))).toMatch(/1%|%1/);
    }
    expect(totalForMethod(10, "direct", 1)).toBe(10);
  });

  it("the admin group codes last 48 hours from the button and 7 days from the setup message", () => {
    expect(ADMIN_GROUP_CODE_TTL_MS).toBe(48 * 3600_000);
    expect(ADMIN_GROUP_DM_CODE_TTL_MS).toBe(7 * 24 * 3600_000);
    expect(joined(settingInfo("en", "adminGroupLink"))).toMatch(/48 hours[\s\S]*7 days/);
    expect(joined(settingInfo("tr", "adminGroupLink"))).toMatch(/48 saat[\s\S]*7 gün/);
  });

  it("the monthly limits are the ones the save enforces", () => {
    expect(joined(settingInfo("en", "monthListOpens"))).toContain(`from ${LIST_OPENS_DAYS_MIN} to ${LIST_OPENS_DAYS_MAX}`);
    expect(joined(settingInfo("tr", "monthListOpens"))).toContain(`${LIST_OPENS_DAYS_MIN} ile ${LIST_OPENS_DAYS_MAX}`);
    expect(joined(settingInfo("en", "paymentInstructions"))).toContain(`Up to ${PAYMENT_INSTRUCTIONS_MAX} characters`);
    expect(joined(settingInfo("tr", "paymentInstructions"))).toContain(`En fazla ${PAYMENT_INSTRUCTIONS_MAX} karakter`);
    for (const lang of LANGS) expect(joined(settingInfo(lang, "paygPrice"))).toContain(`£${MAX_PER_GAME_PENCE / 100}`);
  });

  it("Teams ready: the default follows who announces, and the reminder is 2 hours before kickoff", () => {
    expect(effectiveTeamsReadyTime(null, true)).toBe("10:00");
    expect(effectiveTeamsReadyTime(null, false)).toBe("off");
    expect(newClubs("teamsReady")).toMatch(/10:00 when the organisers announce[\s\S]*Off when MatchTime does/);
    expect(REMINDER_LEAD_MS).toBe(2 * 3600_000);
    expect(joined(settingInfo("en", "teamsReady"))).toContain("2 hours before kickoff");
  });

  it("the kit reminder: football only, 90 minutes to 2 hours before kickoff, a squad post, off sent nowhere", () => {
    const sched = read("src/lib/bot-scheduler.ts");
    const block = sched.slice(sched.indexOf("5a. Football gear reminder"), sched.indexOf("5b. Ask for the score"));
    expect(block).toMatch(/features\.gearReminder !== false/);
    expect(block).toMatch(/startsWith\("football"\)/);
    expect(block).toMatch(/hoursUntilMatch <= 2 &&\s*hoursUntilMatch >= 1\.5/);
    expect(block).toMatch(/kind: "group-message"/);
    expect(sched).toMatch(/seg\.startsWith\("football-gear-reminder"\)\s*\)\s*return "attendance"/);
    const en = joined(settingInfo("en", "gearReminder"));
    expect(en).toMatch(/90 minutes and 2 hours before each football kickoff/);
    expect(en).toContain("not sent anywhere");
    expect(en).toContain("Attendance tracking");
  });

  it("If nobody picks in time: a day, at the latest 4 hours before kickoff, never under an hour", () => {
    const H = 3600_000;
    const opened = new Date("2026-10-12T10:00:00Z");
    expect(pickFallbackAt(opened, new Date(opened.getTime() + 72 * H)).getTime() - opened.getTime()).toBe(24 * H);
    expect(pickFallbackAt(opened, new Date(opened.getTime() + 10 * H)).getTime() - opened.getTime()).toBe(6 * H);
    expect(pickFallbackAt(opened, new Date(opened.getTime() + 3 * H)).getTime() - opened.getTime()).toBe(1 * H);
    expect(joined(settingInfo("en", "benchPickFallback"))).toMatch(/within a day[\s\S]*4 hours before kickoff[\s\S]*at least an hour/);
  });
});
