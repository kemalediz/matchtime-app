/**
 * THE TURKISH STRING TABLE. The owner (a native speaker) reviews THIS
 * file, and only this file, when Turkish copy changes. The rendered
 * Turkish, in context with real names and numbers, is
 * `__tests__/__snapshots__/copy.tr.snap`.
 *
 * ── STATUS ──────────────────────────────────────────────────────────
 *
 * Phase 2, slice 1 (2026-09-17): every key in this file is real Turkish.
 * There is no `untranslated()` wrapper any more and no entry delegates
 * to the English one; `__tests__/strings.test.ts` enforces both. A
 * composer that still speaks English to a Turkish group has simply not
 * been moved into the table yet (later slices), and `copy.tr.snap` shows
 * exactly which those are: its English cases are the remaining work.
 *
 * ── CONVENTIONS FOR THE TURKISH (from the design, section 4.4) ──────
 *
 *   - WhatsApp formatting, not markdown: bold is `*single asterisks*`,
 *     no headings, no backticks except for literal commands the user
 *     should type (`swap X Y` stays a backtick because it is typed).
 *   - Keep the emoji the English copy uses in the same positions
 *     (📋, 🙏, ✅, 🥁, ⚽, 🪑); the group learns them once and they are
 *     language-free.
 *   - Register: warm-informal. "sen" in DMs (one person to one person),
 *     plural imperatives in the group ("yazın", "haber verin"). No
 *     "abi", no "beyler": that is the players' register with each
 *     other, and it assumes a gender the roster may not have.
 *   - Interpolated values (names, venues, dates, counts) sit where
 *     Turkish needs no suffix on them: "Yer: Sim Arena", "Maç: Salı 15
 *     Eylül", not "Sim Arena'da". Where a suffix is unavoidable the
 *     function computes it from the last vowel (a small, tested helper),
 *     never a fixed guess. (No entry in this slice needed one: every
 *     name, venue and date sits before a postposition, "için", "yerine",
 *     or after a colon or comma.)
 *   - No time-of-day greeting and no send-time stamp: no "Günaydın",
 *     "İyi akşamlar", "17:00 güncellemesi".
 *   - No em dashes and no en dashes (house style; the hygiene test in
 *     `__tests__/strings.test.ts` enforces it for this file).
 *   - Dotted and dotless i: any lower-casing of Turkish text for
 *     matching must use `toLocaleLowerCase("tr")`.
 *   - The word the group is told to type is *VARIM* (the bench and slot
 *     lines) and it works typed in either case: the Phase 1 floor
 *     (`router.ts` `FLOOR_IN_TR`) matches `var[ıi]m` case-insensitively,
 *     so "VARIM", "varım" and "varim" all register.
 *   - Team names come from `team-labels.ts`: a Turkish org with no
 *     custom names gets "Kırmızı" / "Sarı".
 *
 * See MDs/multi-language-design-2026-09-16.md sections 4.2 and 4.4.
 */
import type { Strings } from "./t";
import { joinList } from "./text";

export const tr: Strings = {
  // ── shared fragments ─────────────────────────────────────────────

  unnamed: "(isimsiz)",
  no_match_label: "bir sonraki maç",

  // ── row 1: composeSquadStatusPost ────────────────────────────────

  squad_status_lead: (p) => {
    const count = `*${p.confirmed}/${p.maxPlayers}*`;
    return (
      `📋 Aldığım mesajlara göre son kadro${p.withBench ? " ve yedekler" : ""}: ` +
      (p.need > 0 ? `${count}, *${p.need} kişi daha* lazım 🙏` : `${count} ✅ kadro tamam.`)
    );
  },
  playing_header: "*Oynayanlar:*",
  bench_header: (p) => `*Yedekler (${p.count}):*`,

  // ── row 2: formatTeamsPost ───────────────────────────────────────

  teams_post_header: (p) => `⚽ *Bu akşamın takımları*, ${p.kickoff}, ${p.venue}`,
  teams_post_footer: "İtirazı olan? `swap X Y` yazın, admin onaylar.",

  // ── row 43: buildSquadCompletePost ───────────────────────────────

  squad_complete_header: (p) =>
    `✅ *Kadro tamam, ${p.maxPlayers}/${p.maxPlayers}*, *${p.activityName}*, ${p.kickoffLabel} 🙌`,
  squad_complete_signoff: "Maçta görüşürüz ⚽",

  // ── rows 52, 53, 54: the bench-promotion promise ─────────────────

  bench_promotion_how: (p) =>
    p.reactions ? "ilk 👍 veren ya da *VARIM* yazan yeri alır" : "ilk *VARIM* yazan yeri alır",
  squad_complete_bench_invite: (p) =>
    `🪑 *Yedek listesi açık.* *VARIM* yazın, sizi yedeğe ekleyeyim. ` +
    `Biri çıkarsa yedekleri burada etiketlerim ve ${p.how}.`,
  bench_offer_group_post: (p) => {
    const claim = p.reactions
      ? "Almak için buraya 👍 verin ya da *VARIM* yazın."
      : "Almak için buraya *VARIM* yazmanız yeterli.";
    return (
      `🎟 Bir yer açıldı: ${p.context}. *İlk sahiplenen oynar.*\n\n` +
      `${p.tagList}\n\n` +
      `${claim} Acele yok, süre sınırı yok; kim önce müsaitse yeri o alır, ` +
      `diğerleri yedekte kalır. 🙏`
    );
  },

  // ── row 81: the bench offer's context clause ─────────────────────

  bench_offer_context_team: (p) =>
    `bu akşamki *${p.activityName}* için, *${p.teamLabel}* takımında (${p.replacingName} yerine)`,
  bench_offer_context_team_plain: (p) =>
    `bu akşamki ${p.activityName} için, ${p.teamLabel} takımında (${p.replacingName} yerine)`,
  bench_offer_context_fixture: (p) => `bu akşamki *${p.activityName}* için`,
  bench_offer_context_fixture_plain: (p) => `bu akşamki ${p.activityName} için`,

  // ── row 3: buildRatePromoPost ────────────────────────────────────

  rate_promo: (p) =>
    `🎯 ${p.matchDateLabel} tarihindeki *${p.activityName}* için her oyuncuya kişisel ` +
    `puanlama linkini DM'den gönderdim. Ne kadar çok puan gelirse gelecek haftaki ` +
    `takımlar o kadar dengeli olur. DM'lerinize bakın 👇`,

  // ── row 4: buildMatchDayChaseFallback ────────────────────────────

  match_day_chase_fallback: (p) =>
    `☀️ Bu akşamki *${p.activityName}* için hâlâ *${p.need} kişi* eksiğiz. Gelebilecek var mı? 👀`,

  // ── row 38: bench_offer_open ─────────────────────────────────────

  bench_offer_open: (p) =>
    `Bir yer açıldı 🎟 ${joinList("tr", p.benchNames)}, ilk VARIM yazan alır. Kimse çıkarılmıyor.`,

  // ── row 39: slot_opened ──────────────────────────────────────────
  //   No "13/14" and no "yer" count in a shape the guards misread: the
  //   count is spelled out ("13 kişiyiz, kadro 14 kişilik") for the same
  //   reason the English spells out "13 of 14".

  slot_opened: (p) => {
    const names = p.outFirstNames;
    const lead = names.length === 0 ? "" : `${joinList("tr", names)} çıktı, `;
    const slots =
      p.open === 1
        ? "Bir yer açıldı, almak için *VARIM* yazın."
        : `${p.open} yer açıldı, almak için *VARIM* yazın.`;
    return `${lead}${p.kickoffLabel} için ${p.confirmed} kişiyiz, kadro ${p.maxPlayers} kişilik. ${slots}`;
  },

  // ── row 68: buildAnnounceMatchPost ───────────────────────────────

  announce_match: (p) =>
    `📅 *${p.activityName}*, *${p.dateLabel}*, ${p.venue}.\n\nKatılmak için *VARIM* yazın. İlk ${p.maxPlayers} kişi oynar.`,

  // ── row 71: buildSquadRosterBlock ────────────────────────────────

  roster_confirmed_header: (p) => `*Onaylananlar (${p.confirmed}/${p.maxPlayers}):*`,
  roster_nobody_yet: "_henüz kimse yok_",

  // ── rows 69, 70: the match-day 17:00 posts ───────────────────────

  match_day_header: (p) => `⚽ *Bu akşam ${p.timeLabel}*, *${p.activityName}*, ${p.venue}`,
  match_day_teams_signoff: "Akşam görüşürüz 🙌",
  match_day_locked_line:
    "Kadro kilitlendi. Bu akşamın takımlarını belirlemek için sohbete *@MatchTime takımları oluştur* yazın 👇",

  // ── row 72: buildDailyInListFallback ─────────────────────────────

  daily_in_list_fallback_lead: (p) => `🗓 *${p.activityName}*, *${p.need} kişi daha* lazım.`,

  // ── row 73: buildUnpaidTailText ──────────────────────────────────

  unpaid_tail: (p) =>
    p.unpaid === 1
      ? `💳 Geçen haftaki maç için 1 ödeme hâlâ bekliyor, ödediyseniz yukarıdaki ankette takımınızı işaretleyin 🙏`
      : `💳 Geçen haftaki maç için *${p.unpaid}* ödeme hâlâ bekliyor, ödediyseniz yukarıdaki ankette takımınızı işaretlemeniz yeterli 🙏`,

  // ── row 78: buildPaymentPollQuestion ─────────────────────────────

  payment_poll_question: (p) => `💳 *${p.activityName}* ödemeleri, ödeyince işaretleyin`,
};
