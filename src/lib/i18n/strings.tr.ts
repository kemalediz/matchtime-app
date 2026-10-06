/**
 * THE TURKISH STRING TABLE. The owner (a native speaker) reviews THIS
 * file, and only this file, when Turkish copy changes. The rendered
 * Turkish, in context with real names and numbers, is
 * `__tests__/__snapshots__/copy.tr.snap`.
 *
 * ── STATUS ──────────────────────────────────────────────────────────
 *
 * Phase 2, slices 1 and 2 (2026-09-17): every key in this file is real
 * Turkish and every GROUP-facing deterministic composer in the design's
 * inventory reads it. There is no `untranslated()` wrapper and no entry
 * delegates to the English one; `__tests__/strings.test.ts` enforces
 * both. Slice 3 gave the model-composed chases their language line and
 * the server-computed headers below (`roster_header_*`), and taught the
 * composition guards this file's vocabulary (`guard-vocab.ts`). What a
 * Turkish group still hears in English: the DMs (Phase 3), onboarding
 * and help (Phase 3c) and the reminder-time labels the reminder ack
 * quotes (Phase 3). `copy.tr.snap` shows exactly which: its English
 * cases are the remaining work.
 *
 * ── THE TEAM COMMANDS A TURKISH GROUP IS TOLD TO TYPE (2026-09-17) ──
 *
 * One form per action, always with the tag (a team command without
 * "@Match Time" is refused by the interaction contract), held in
 * `TR_TEAM_COMMANDS` at the bottom of this file:
 *
 *   generate        @Match Time takımları kur
 *   regenerate      @Match Time takımları yeniden kur
 *   show            @Match Time takımları göster
 *   swap players    @Match Time X ile Y'yi değiştir
 *   swap colours    @Match Time renkleri değiştir
 *
 * "kur" over "oluştur": the live teams extractor read both 10 of 10, so
 * the choice is on wording. "kur" is the shorter, the one football chat
 * uses ("takım kurmak"), and the verb this file already uses in the
 * bot's own voice ("kurayım", "kuramıyorum"). Every string that quotes a
 * command quotes exactly one of these; `__tests__/tr-team-commands.test.ts`
 * enforces it and checks the bot reads each one.
 *
 * ── CONVENTIONS FOR THE TURKISH (from the design, section 4.4) ──────
 *
 *   - WhatsApp formatting, not markdown: bold is `*single asterisks*`,
 *     no headings, no backticks except for literal commands the user
 *     should type (the player swap command is in backticks because it
 *     is typed).
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
import type { StatsPeriod } from "../pipeline/types";
import type { BadgeKey } from "../badge-rules";

const UNIT_TR = { day: "gün", week: "hafta", month: "ay", year: "yıl" } as const;

/** "son 1 yıl" / "son 3 ay" / "bu ay": the period as a noun phrase, in
 *  the nominative, so it sits in brackets or before "için" with no
 *  suffix to compute. Digits always, as the group writes it ("son 1
 *  yılda"). */
function spanTr(p: StatsPeriod): string {
  switch (p.kind) {
    case "last":
      return `son ${p.count} ${UNIT_TR[p.unit]}`;
    case "this":
      return `bu ${UNIT_TR[p.unit]}`;
    case "season":
      return "bu sezon";
    case "all_time":
      return "tüm zamanlar";
  }
}

/** The locative of each unit: "son 3 ayda", "son 2 haftada". */
const UNIT_TR_LOC = { day: "günde", week: "haftada", month: "ayda", year: "yılda" } as const;

/** The period of a results answer: "son 3 ayda", "bu ay", "bu sezon",
 *  "kayıtlarda". */
function resultsWhenTr(p: StatsPeriod): string {
  switch (p.kind) {
    case "last":
      return `son ${p.count} ${UNIT_TR_LOC[p.unit]}`;
    case "this":
      return `bu ${UNIT_TR[p.unit]}`;
    case "season":
      return "bu sezon";
    case "all_time":
      return "kayıtlarda";
  }
}

/** Upper-case the first letter, the Turkish way. */
function capTr(s: string): string {
  return s ? s.charAt(0).toLocaleUpperCase("tr") + s.slice(1) : s;
}

/** "*A*", "*A* ve *B*", "*A*, *B* ve *C*": kalın isimler, grup mesajı için. */
/** Tek sonuç, kazanan önce: "*Sarı* 9 - 6 kazandı, rakip Kırmızı" ya da
 *  "berabere, Kırmızı 7 - 7 Sarı". Üç skor yanıtı da bunu kullanır.
 *  Takım adına ek getirilmez (ünlü uyumu her ada uymaz). */
function resultTr(p: { redLabel: string; red: number; yellow: number; yellowLabel: string }): string {
  if (p.red === p.yellow) return `berabere, ${p.redLabel} ${p.red} - ${p.yellow} ${p.yellowLabel}`;
  return p.red > p.yellow
    ? `*${p.redLabel}* ${p.red} - ${p.yellow} kazandı, rakip ${p.yellowLabel}`
    : `*${p.yellowLabel}* ${p.yellow} - ${p.red} kazandı, rakip ${p.redLabel}`;
}

function boldNamesTr(names: string[]): string {
  const b = names.map((n) => `*${n}*`);
  return b.length <= 1 ? (b[0] ?? "") : `${b.slice(0, -1).join(", ")} ve ${b[b.length - 1]}`;
}

export const tr: Strings = {
  // ── shared fragments ─────────────────────────────────────────────

  unnamed: "(isimsiz)",
  team_sheet_open_slot: "(boş yer)",
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
  teams_post_footer: "İtirazınız mı var? `@Match Time X ile Y'yi değiştir` yazın, admin onaylar.",

  // ── row 2b: replacement_teams_post ───────────────────────────────
  //   "yerine" is the word the Turkish attendance examples are written
  //   around, so the group reads back the phrasing it types. No dash
  //   punctuation here (house style for the Turkish table); the clause
  //   break is a comma or a colon.

  replacement_note: (p) => `${p.from} yerine`,
  replacement_lead: (p) => {
    if (p.swaps.length === 1 && p.outNames.length === 1) {
      return (
        `🔁 *${p.outNames[0]} yok*, yerine *${p.swaps[0].inName}* geliyor ` +
        `ve *${p.swaps[0].teamLabel}* takımındaki yerini alıyor.`
      );
    }
    const head = p.outNames.length > 0 ? `🔁 *${joinList("tr", p.outNames)}* yok: ` : "🔁 ";
    return (
      head +
      p.swaps
        .map((x) => `*${x.inName}*, *${x.teamLabel}* takımında ${x.outName} yerine geçiyor`)
        .join(", ") +
      "."
    );
  },
  teams_post_footer_after_replacement:
    "İtirazınız mı var? Admin benden takımları yeniden kurmamı isteyebilir.",

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
  bench_offer_group_post_many: (p) => {
    const claim = p.reactions
      ? "Birini almak için buraya 👍 verin ya da *VARIM* yazın."
      : "Birini almak için buraya *VARIM* yazmanız yeterli.";
    return (
      `🎟 ${p.count} yer açıldı: ${p.context}. *İlk sahiplenenler oynar.*\n` +
      p.details.map((d) => `${d}\n`).join("") +
      `\n` +
      `${p.tagList}\n\n` +
      `${claim} Acele yok, süre sınırı yok; yerler önce yazanların olur, ` +
      `yer kalmazsa diğerleri yedekte kalır. 🙏`
    );
  },

  bench_offer_slot_detail: (p) => `• *${p.teamLabel}* takımında, ${p.replacingName} yerine`,
  bench_offer_slot_detail_plain: (p) => `• ${p.teamLabel} takımında, ${p.replacingName} yerine`,

  // ── row 81: the bench offer's context clause ─────────────────────

  //   `day` null on match day ("bu akşamki"), else "6 Ekim Salı günkü".

  bench_offer_context_team: (p) =>
    `${p.day ? `${p.day} günkü` : "bu akşamki"} *${p.activityName}* için, *${p.teamLabel}* takımında (${p.replacingName} yerine)`,
  bench_offer_context_team_plain: (p) =>
    `${p.day ? `${p.day} günkü` : "bu akşamki"} ${p.activityName} için, ${p.teamLabel} takımında (${p.replacingName} yerine)`,
  bench_offer_context_fixture: (p) => `${p.day ? `${p.day} günkü` : "bu akşamki"} *${p.activityName}* için`,
  bench_offer_context_fixture_plain: (p) => `${p.day ? `${p.day} günkü` : "bu akşamki"} ${p.activityName} için`,

  // ── row 3: buildRatePromoPost ────────────────────────────────────

  rate_promo: (p) =>
    `🎯 ${p.matchDateLabel} tarihindeki *${p.activityName}* için her oyuncuya kişisel ` +
    `puanlama linkini DM'den gönderdim. Ne kadar çok puan gelirse gelecek haftaki ` +
    `takımlar o kadar dengeli olur. DM'lerinize bakın 👇`,

  // ── row 4: buildMatchDayChaseFallback ────────────────────────────

  match_day_chase_fallback: (p) =>
    `☀️ Bu akşamki *${p.activityName}* için hâlâ *${p.need} kişi* eksiğiz. Gelebilecek var mı? 👀`,

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

  // ── row 71b: buildSquadFullEveningPost ───────────────────────────
  //   "kadro tamam" is `squad_complete_header`'s wording: the group has
  //   read it before, on the post that fired the moment the squad
  //   filled, and this is the same fact repeated daily. The activity
  //   name sits before a colon, so it takes no suffix.

  squad_full_evening_lead: (p) =>
    `🗓 *${p.activityName}*: kadro tamam, *${p.confirmed}/${p.maxPlayers}* ✅`,

  // ── rows 69, 70: the match-day 17:00 posts ───────────────────────

  match_day_header: (p) => `⚽ *Bu akşam ${p.timeLabel}*, *${p.activityName}*, ${p.venue}`,
  match_day_teams_signoff: "Akşam görüşürüz 🙌",
  match_day_locked_line:
    "Kadro kilitlendi. Bu akşamın takımlarını belirlemek için sohbete *@Match Time takımları kur* yazın 👇",

  // ── row 72: buildDailyInListFallback ─────────────────────────────

  daily_in_list_fallback_lead: (p) => `🗓 *${p.activityName}*, *${p.need} kişi daha* lazım.`,

  // ── row 73: buildUnpaidTailText ──────────────────────────────────

  unpaid_tail: (p) =>
    p.unpaid === 1
      ? `💳 Geçen haftaki maç için 1 ödeme hâlâ bekliyor, ödediyseniz yukarıdaki ankette takımınızı işaretleyin 🙏`
      : `💳 Geçen haftaki maç için *${p.unpaid}* ödeme hâlâ bekliyor, ödediyseniz yukarıdaki ankette takımınızı işaretlemeniz yeterli 🙏`,

  // ── row 78: buildPaymentPollQuestion ─────────────────────────────

  payment_poll_question: (p) => `💳 *${p.activityName}* ödemeleri, ödeyince işaretleyin`,

  // ═══════════════════════════════════════════════════════════════════
  // Phase 2, slice 2: the rest of the group-facing deterministic copy.
  // ═══════════════════════════════════════════════════════════════════

  fallback_player: "bir oyuncu",

  // ── rows 6 to 30: the batch answers ────────────────────────────────

  answer_count: (p) => {
    const head = p.stated
      ? `Tam değil, ${p.kickoffLabel} için ${p.confirmed}/${p.maxPlayers} kişiyiz`
      : `${p.kickoffLabel} için ${p.confirmed}/${p.maxPlayers} kişiyiz`;
    const tail = p.need > 0 ? `, ${p.need} kişi daha lazım 🙏` : " ✅ kadro tamam.";
    return `${head}${tail}`;
  },
  answer_fixture: (p) => (p.venue ? `⚽ ${p.kickoffLabel}, ${p.venue}.` : `⚽ ${p.kickoffLabel}.`),
  answer_score_no_match: "Bu grup için kayıtlı oynanmış bir maç bulamadım.",
  answer_score_no_score: (p) => `${p.kickoffLabel} için henüz skor bildirilmedi, sonucu yazın, kaydedeyim.`,
  answer_score_result: (p) =>
    `⚽ ${p.kickoffLabel}: ${p.redLabel} ${p.red} - ${p.yellow} ${p.yellowLabel}. ${p.winnerLabel === null ? "Berabere." : `${p.winnerLabel} kazandı.`}`,
  results_head: (p) => {
    const when = p.period ? resultsWhenTr(p.period) : "";
    if (!p.byCount) return `⚽ ${capTr(when)} oynanan maçların sonuçları:`;
    const what = p.n === 1 ? "son sonuç" : `son ${p.n} sonuç`;
    return `⚽ ${capTr(when ? `${when} ${what}` : what)}:`;
  },
  results_row: (p) =>
    `• ${p.dayLabel}: ${p.redLabel} ${p.red} - ${p.yellow} ${p.yellowLabel}. ${p.winnerLabel === null ? "Berabere." : `${p.winnerLabel} kazandı.`}`,
  results_all_i_have: "Skoru kayıtlı maçların hepsi bu.",
  results_capped: (p) => `Grupta en fazla ${p.max} sonuç paylaşıyorum.`,
  results_latest: (p) => `Bunlar en son ${p.n} tanesi.`,
  results_none: "Bu grup için skoru kayıtlı bir maç henüz yok.",
  results_none_when: (p) => `${capTr(resultsWhenTr(p.period))} skoru kayıtlı maç yok.`,
  answer_payments_not_tracked: "Bu grup için ödemeleri takip etmiyorum, o yüzden kimin ödediğini söyleyemem.",
  answer_payments_no_settled: "Ödemeleri kontrol edebileceğim tamamlanmış bir maç henüz yok.",
  answer_payments_no_signal: (p) =>
    `${p.kickoffLabel} için bana ulaşan ödeme yok; kimse ödememiş de olabilir, ben görmüyor da olabilirim, o yüzden bir sayı vermek istemiyorum.`,
  answer_payments_all_settled: (p) => `💳 ${p.kickoffLabel} için herkes ödedi 🙌`,
  answer_payments_unpaid: (p) =>
    `💳 ${p.kickoffLabel} için ${p.chargeable} kişiden ${p.unpaid} kişinin ödemesi bekleniyor. Grupta isim vermiyorum.`,
  answer_bench_empty: "Şu an yedekte kimse yok.",
  answer_bench_list: (p) => `Yedekler: ${joinList("tr", p.names)}.`,
  answer_person_not_down: (p) => `${p.who} ${p.kickoffLabel} için henüz kadroda değil.`,
  answer_person_bench: (p) => `${p.who} ${p.kickoffLabel} için yedekte.`,
  answer_person_confirmed: (p) => `Evet, ${p.who} ${p.kickoffLabel} için kadroda.`,
  answer_phones_none: "Kadrodaki herkesin kayıtlı numarası var.",
  answer_phones_missing: (p) => `Kayıtlı numarası olmayanlar: ${joinList("tr", p.names)}.`,
  answer_options_lead: (p) =>
    p.need > 0
      ? `${p.maxPlayers} kişilik kadroda ${p.confirmed} kişiyiz, ${p.need} kişi daha lazım 🙏`
      : `${p.maxPlayers} kişilik kadroda ${p.confirmed} kişiyiz ✅ kadro tamam.`,
  answer_options_no_formats: "Bu grup için daha küçük bir format tanımlı değil, o yüzden ya oyuncu bulacağız ya da hiç.",
  answer_options_none_viable: "Elimizdeki kadroyla daha küçük bir format da dolmuyor, o yüzden oyuncu bulmamız lazım.",

  // ── istatistik tabloları (2026-09-23), `pipeline/stats-answer.ts` ──
  // Her satırda `isLeaderboardLine` işaretlerinden biri var ("maç", "kez",
  // "%"), bu yüzden hiçbiri kadro listesi sanılmaz.
  // ── dönem (2026-09-23) ──
  // Dönem ve kayıtların başladığı ay hep parantez içinde ya da "için"
  // önünde, yalın halde: hiçbir ada ya da sayıya ek gelmiyor. "Nisan
  // 2026 itibarıyla" ekten kaçınmanın yolu ("2026'dan" yazmak yerine).
  stats_when: (p) => {
    const q = p.period;
    if (q === null) return p.since ? `${p.since} itibarıyla` : "";
    if (q.kind === "last" || q.kind === "this") return spanTr(q);
    if (q.kind === "season") return p.since ? `bu sezon, ${p.since} itibarıyla` : "bu sezon";
    return p.since ? `tüm zamanlar, kayıtlarım ${p.since} itibarıyla` : "tüm zamanlar";
  },
  stats_span: (p) => spanTr(p.period),
  stats_period_unreached: (p) =>
    `Bu kulüp için kayıtlarım ${p.since} itibarıyla başlıyor, yani ${p.span} için elimdeki her şey bu.`,
  stats_period_not_cut: (p) => {
    const every = p.since ? `${p.since} itibarıyla oynanan tüm maçlar` : "tüm maçlar";
    switch (p.table) {
      case "elo":
        return `Elo sürekli güncellenen bir puan, o yüzden bu tablo ${p.span} için değil, şu anki durum.`;
      case "team_of_season":
        return `Sezonun takımı ${every} üzerinden seçiliyor, o yüzden ${p.span} için ayrıca çıkaramıyorum.`;
      case "mr_reliable":
        return `Mr Reliable istatistik sayfasındaki rozet ve ${every} üzerinden veriliyor, o yüzden ${p.span} için ayrıca çıkaramıyorum.`;
      case "chemistry":
        return `Uyum ${every} üzerinden hesaplanıyor, o yüzden ${p.span} için ayrıca çıkaramıyorum.`;
      case "generic":
        return `Bu rakamlar ${p.since ? `${p.since} itibarıyla oynanan tüm maçları` : "tüm maçları"} kapsıyor, sadece ${p.span} değil.`;
    }
  },
  // "maç" is one of `isLeaderboardLine`'s markers (group-copy.ts), so
  // this row is never mistaken for a squad roster.
  stats_apps_head: (p) => (p.when ? `En çok maça çıkanlar (${p.when}):` : "En çok maça çıkanlar:"),
  stats_apps_row: (p) => `${p.rank}. ${p.name}: ${p.matches} maç`,
  stats_apps_empty: (p) =>
    p.when ? `Bu dönemde (${p.when}) sayılacak tamamlanmış maç yok.` : "Henüz sayılacak tamamlanmış maç yok.",
  stats_ratings_head: (p) =>
    p.when
      ? `Kulüp puanında ilk ${p.n} (${p.when}; en az ${p.minGames} puanlı maçı olanlar):`
      : `Kulüp puanında ilk ${p.n} (en az ${p.minGames} puanlı maçı olanlar):`,
  stats_ratings_row: (p) => `${p.rank}. ${p.name}: ${p.avg} (${p.games} maç)`,
  stats_ratings_empty: (p) =>
    p.when
      ? `Bu dönemde (${p.when}) en az ${p.minGames} puanlı maçı olan kimse yok, o yüzden paylaşacak bir puan tablosu yok. Tüm istatistikler sitede: ${p.url}`
      : `Henüz ${p.minGames} puanlı maçı olan kimse yok, o yüzden paylaşacak bir puan tablosu yok. Tüm istatistikler sitede: ${p.url}`,
  stats_capped: (p) => `Grupta en fazla ${p.cap} kişiyi listeliyorum. Tablonun tamamı sitede: ${p.url}`,
  stats_bottom: (p) =>
    `Grupta tabloların sadece üst kısmını paylaşıyorum, alt sıraları değil. Tabloların tamamı sitede: ${p.url}`,
  stats_mom_head: "En çok maçın adamı seçilenler:",
  stats_mom_row: (p) => `${p.rank}. ${p.name}: ${p.wins} kez`,
  stats_mom_empty: "Henüz kimse maçın adamı seçilmedi.",
  stats_mom_head_when: (p) => `En çok maçın adamı seçilenler (${p.when}):`,
  stats_mom_empty_when: (p) => `Bu dönemde (${p.when}) kimse maçın adamı seçilmedi.`,
  stats_elo_head: (p) => `Elo puanında ilk ${p.n} (en az ${p.minMatches} maç oynayanlar):`,
  stats_elo_row: (p) => `${p.rank}. ${p.name}: ${p.rating} (${p.matches} maç)`,
  stats_elo_empty: (p) => `Henüz ${p.minMatches} maç oynayan kimse yok, o yüzden paylaşacak bir Elo tablosu yok.`,
  stats_tots_head: (p) =>
    `Sezonun takımı (${p.sportName}), her mevkide en yüksek ortalama puan (en az ${p.minGames} puanlı maç):`,
  stats_tots_row: (p) => `${p.n}. ${p.name}${p.position ? ` (${p.position})` : ""}: ${p.avg} (${p.games} maç)`,
  stats_tots_empty: (p) => `Henüz sezonun takımı yok: ${p.minGames} puanlı maçı olan kimse yok.`,
  stats_movers_head:
    "Puan hareketini maç maç takip ediyorum, son maçtan beri kulüp puan tablosunda en çok yükselenler:",
  stats_movers_row: (p) =>
    `${p.n}. ${p.name}: ${p.delta} sıra yükseldi${p.rank !== null ? `, şu an ${p.rank}. sırada` : ""} (${p.games} maç)`,
  stats_movers_empty: "Son maçtan sonra kulüp puan tablosunda yükselen olmadı.",
  stats_reliable_head: (p) =>
    `Mr Reliable rozeti olanlar, istatistik sayfasındaki rozet (ortalama ${p.minAvg} ve üzeri, az dalgalanma, en az ${p.minGames} puanlı maç), en istikrarlıdan başlayarak:`,
  stats_reliable_row: (p) => `${p.n}. ${p.name}: ortalama ${p.avg} (${p.games} maç)`,
  stats_reliable_empty: (p) =>
    `Henüz Mr Reliable rozeti olan kimse yok (ortalama ${p.minAvg} ve üzeri, az dalgalanma, en az ${p.minGames} puanlı maç).`,
  stats_chem_head: (p) => `${p.name} için en iyi takım arkadaşları:`,
  stats_chem_winrate: (p) => `• Galibiyet oranına göre: ${p.partner}, birlikte ${p.games} maçta ${p.wins} galibiyet (%${p.pct})`,
  stats_chem_rating: (p) => `• Puana göre: ${p.partner}, ${p.player} onunla aynı takımdayken ortalama ${p.avg} alıyor`,
  stats_chem_nemesis: (p) =>
    `• ${p.player} için en zorlu rakip: ${p.name} (karşı karşıya ${p.games} maç, ${p.wins} galibiyet)`,
  stats_chem_empty: (p) =>
    `${p.name} henüz aynı takım arkadaşıyla 2 maç oynamadı, o yüzden gösterilecek bir uyum yok.`,
  stats_generic_safe: (p) => `Bunu buradan tam olarak cevaplayamıyorum. Tüm istatistikler sitede: ${p.url}`,
  stats_ask_unknown: (p) => `${p.asker ? `${p.asker}, k` : "K"}adroda ${p.ref} diye biri yok. Kimi kastettiniz?`,
  stats_ask_ambiguous: (p) => `${p.asker ? `${p.asker}, h` : "H"}angisini kastettiniz: ${p.choices}?`,

  // ── rows 32 to 42: the acks ────────────────────────────────────────

  teams_not_generated: "Takımlar henüz kurulmadı, *@Match Time takımları kur* yazın, hallederim.",
  score_ack: (p) => `Tamam 👍 ${resultTr(p)}. Kaydettim.`,
  score_corrected: (p) =>
    `Düzelttim 👍 Önceki kayıt ${p.redLabel} ${p.oldRed} - ${p.oldYellow} ${p.yellowLabel} idi. Şimdi ${resultTr(p)}.`,
  score_ask_team: (p) =>
    `${p.first} - ${p.second}: hangi takım kazandı? Kazanan takımı yazın: ${p.redLabel} mı, ${p.yellowLabel} mı?`,
  score_already_recorded: (p) =>
    `Bu maçın sonucu zaten kayıtlı: ${resultTr(p)}. Bir yönetici maç sayfasından değiştirebilir.`,
  score_recorded_hint: (p) =>
    `Bu maçın sonucu zaten kayıtlı: ${resultTr(p)}. ` +
    `Yanlışsa "hayır" diye başlayıp doğru skoru ve kazanan takımı yazın.`,
  score_which_match: (p) =>
    `Bunun hangi maçı düzelttiğini anlayamadım. ${p.kickoffLabel} için skoru ve kazanan takımı yazmanız yeterli. ` +
    `Daha önceki bir sonucu bir yönetici o maçın sayfasından değiştirebilir.`,
  score_elo_left_note:
    "Skor kaydedildi. Bu maç için Elo puanları yeniden hesaplanmadı, çünkü önceki sonuç için eklenen puanların kaydı yok. Elo hâlâ önceki sonucu yansıtıyor.",
  payments_live_announcement: (p) => {
    const who = p.collector ?? "organizatör";
    const lines = [
      "💳 *Maç ücretleri artık MatchTime üzerinden toplanıyor*",
      "",
      "Nasıl işliyor:",
      "• Her maçtan sonra oynayan herkese, payını ödemesi için özelden bir link gönderiyorum.",
    ];
    if (p.card || p.bank) {
      lines.push(
        p.card && p.bank
          ? "• Kartla, Apple Pay, Google Pay ile ya da doğrudan bankanızdan ödeyebilirsiniz."
          : p.card
            ? "• Kartla, Apple Pay ya da Google Pay ile ödeyebilirsiniz."
            : "• Doğrudan bankanızdan ödeyebilirsiniz.",
      );
      const fee = p.card && p.bank ? "kart ya da banka ücreti" : p.card ? "kart ücreti" : "banka ücreti";
      lines.push(`• Tutar, maç ücretinin oyuncular arasında bölünmüş payı, üstüne de ${fee}.`);
    }
    lines.push("• Ödemeyenlere hatırlatma gönderiyorum.");
    if (p.direct) lines.push(`• Ödemeyi doğrudan ${who} ile halletmek de olur. Bana özelden *Ödedim* yazın, ${who} onaylasın.`);
    return lines.join("\n");
  },
  payment_ack: (p) => `Not aldım 🙌 ${p.firstName} ${p.count} kişinin ödemesini yaptı.`,
  reminder_ack_resolved: (p) => `👍 Tamam, ${p.whenLabel} sana DM atarım.`,
  reminder_ack_unresolved: (p) => `Tamam 👍 ${p.phrase} sana hatırlatırım.`,
  needs_tag_for_rest: (p) => {
    const parts: string[] = [];
    if (p.dropped.length > 0) parts.push(`çıkış: ${joinList("tr", p.dropped)}`);
    if (p.benched.length > 0) parts.push(`yedek: ${joinList("tr", p.benched)}`);
    return (
      `Şunlara dokunmadım, ${parts.join("; ")}. ` +
      `Bunlar için @Match Time etiketi gerekiyor, beni etiketleyin, hallederim 👍`
    );
  },
  bench_claim_too_late: (p) =>
    `Sağ ol ${p.firstName} 🙏 biri senden önce davrandı, kadro yine ` +
    `${p.confirmed}/${p.maxPlayers}. Yedekte kalmaya devam ediyorsun, ` +
    `başka bir yer açılırsa sıra sende.`,
  pending_confirmed_ack: (p) => `Tamam 🙌 ${joinList("tr", p.names)}, ${p.kickoffLabel} için kadroda.`,

  // ── row 44: renderGuestNameAsk ─────────────────────────────────────

  guest_name_ask: (p) => {
    const opener = p.firstName ? `Süper ${p.firstName} 🙌` : "Süper 🙌";
    return p.plural
      ? `${opener} Adları ne? Yaz, kadroya ekleyeyim.`
      : `${opener} Adı ne? Yaz, kadroya ekleyeyim.`;
  },

  ask_who_mentioned: "Bunun kim olduğunu anlayamadım, adını yazar mısın?",

  // ── row 45: buildMomAnnouncement ───────────────────────────────────

  mom_header: (p) => `🏆 *${p.mvpLabel}, ${p.activityName}*`,
  mom_winner: (p) => `Tebrikler *${p.name}* (${p.top}/${p.total} oy) 🎉`,
  mom_shared: (p) => `*${p.names}* paylaştı (her biri ${p.top} oy, toplam ${p.total}) 🎉`,
  mom_votes_header: "Oylar:",
  mom_vote_row: (p) => `• ${p.name}: ${p.votes}`,
  mom_trophy_line: "Kupa gelecek maçta sahibini bekliyor.",

  // ── row 46: the format-switch proposal ─────────────────────────────

  format_switch_proposal: (p) => {
    const lead =
      `${p.shortBy} kişi daha bulamazsak ${p.formatName} formatına ` +
      `(${p.total} kişi) geçebiliriz, `;
    const tail = " Adminler portaldan sahayı yeniden ayırtıp formatı değiştirebilir.";
    return p.benched.length === 0
      ? `${lead}${p.confirmed} kişi hep birlikte oynar, kimse yedeğe geçmez.${tail}`
      : `${lead}${p.benched.join(" + ")} yedeğe geçer.${tail}`;
  },

  // ── row 47: renderKickoffMoveLine ──────────────────────────────────

  kickoff_move_line: (p) => `⏰ *Başlangıç saati ${p.newTime} oldu* (önceden ${p.oldTime}).`,

  // ── row 48: buildOutOfBandAttendanceLine ───────────────────────────

  oob_player_fallback: "Bir oyuncu",
  oob_in: (p) => {
    const how = p.source === "reaction" ? "davetine 👍 verdi" : p.source === "dm" ? "DM'den yazdı" : "uygulamadan";
    return `✅ *${p.name}* geliyor (${how}). Kadro *${p.confirmed}/${p.maxPlayers}*.`;
  },
  oob_bench: (p) => {
    const how =
      p.source === "reaction"
        ? "davetine 👍 verdi"
        : p.source === "dm"
          ? "DM'den varım dedi"
          : "uygulamadan varım dedi";
    return `📋 *${p.name}* ${how}, yedeğe geçti. Kadro *${p.confirmed}/${p.maxPlayers}*.`;
  },
  oob_out: (p) => {
    const how = p.source === "reaction" ? "davetine 👎 verdi" : p.source === "dm" ? "DM'den yazdı" : "uygulamadan";
    return `❌ *${p.name}* gelmiyor (${how}). Kadro *${p.confirmed}/${p.maxPlayers}*.`;
  },

  // ── row 49: buildBenchClaimAnnouncement ────────────────────────────

  bench_claim_team: (p) =>
    `🎟 *${p.claimer}* yeri aldı, *${p.teamLabel}* takımında *${p.dropped}* yerine oynuyor 🙌\n\n` +
    `_Yeni kadroyla takımları yeniden dengelemek isterseniz "@Match Time takımları yeniden kur" yazın._`,
  bench_claim_replacing: (p) =>
    `✅ *${p.claimer}* kadroda, *${p.dropped}* yerine geliyor, kadro *${p.confirmed}/${p.maxPlayers}* 🙌`,
  bench_claim_open: (p) => `✅ *${p.claimer}* açık yeri aldı, kadro *${p.confirmed}/${p.maxPlayers}* 🙌`,

  // ── rows 53, 54, 55: the rest of bench-offer-copy.ts ───────────────

  bench_intro_line: (p) =>
    `🔁  *Yedekten kadroya*, biri çıkarsa yedekleri burada etiketlerim ve ` +
    `${p.how}. Süre sınırı yok, geç görene de bir şey olmaz, yedekteki yeri kalır.`,
  full_squad_bench_invite: (p) =>
    `*${p.matchName}* kadrosu dolu, ${p.maxPlayers} kişilik kadroda ${p.confirmed} kişiyiz, ama yedek listesi açık. ` +
    `*VARIM* yazın, sizi yedeğe ekleyeyim. Biri çıkarsa yedekleri grupta etiketlerim ` +
    `ve ${p.how}. 🙏`,
  bench_asked_line: (p) => {
    const how = p.reactions
      ? "burada 👍 istemiyle etiketlendi"
      : "burada etiketlendi, *VARIM* yazması yeterli";
    return (
      `*${p.benchName}* kadroya çağrılıyor, ${how}. ` +
      `Onaylayana kadar kadro *${p.confirmed}/${p.maxPlayers}*.`
    );
  },

  // ── row 50: planUnresolvedNudge ────────────────────────────────────

  unresolved_nudge_named: (p) => {
    const verb = p.verb === "join" ? "katılma" : "çıkma";
    return (
      `Dikkat: *${p.pushname}* adından bir *${verb}* mesajı aldım ama bu isim ` +
      `kadro listesindeki kimseyle eşleşmiyor, o yüzden henüz bir şey değiştirmedim. ` +
      `*${p.pushname}* kayıtlı olduğu ismi yazabilir mi, ya da bir admin panelden eşleştirebilir? 🙏`
    );
  },
  unresolved_nudge_anonymous: (p) => {
    const verb = p.verb === "join" ? "katılma" : "çıkma";
    return (
      `Dikkat: tanımadığım birinden bir *${verb}* mesajı aldım, ` +
      `o yüzden henüz bir şey değiştirmedim. Kayıtlı olduğu ismi yazabilir mi, ` +
      `ya da bir admin panelden eşleştirebilir? 🙏`
    );
  },

  // ── row 51: composeStatsBlastReply ─────────────────────────────────

  stats_blast_reply: (p) =>
    `📊 Tamam, ${p.queued} oyuncuya kişisel istatistik linkini DM'den gönderdim. ` +
    `Birkaç dakika içinde ulaşır.`,

  // ── row 164: buildStatsLinkSentLine ────────────────────────────────
  //   "gönderiyorum" (I'm sending), not "gönderdim" (I sent): the DM is
  //   queued and goes out a moment later. "özel mesajla" says private in
  //   plain words. Addressed to the one asker, so "sen" and no plural.

  stats_link_sent: (p) =>
    p.firstName
      ? `📊 ${p.firstName}, istatistiklerini sana özel mesajla gönderiyorum.`
      : `📊 İstatistiklerini sana özel mesajla gönderiyorum.`,

  // ── row 58: buildAttendanceFailureReply ────────────────────────────

  attendance_failure: (p) => {
    const greeting = p.firstName ? `Kusura bakma ${p.firstName}, ` : "Kusura bakma, ";
    let clause: string;
    if (p.self === "OUT") {
      clause = "az önce kaydedemedim, hâlâ oynuyor görünüyorsun";
    } else if (p.self === "IN") {
      clause = "az önce kaydedemedim, henüz listede değilsin";
    } else {
      clause = `${joinList("tr", p.others)} için değişikliği az önce kaydedemedim, kadro değişmedi`;
    }
    const extra = p.self && p.others.length > 0 ? ` ${joinList("tr", p.others)} için de güncelleyemedim.` : "";
    return `${greeting}${clause}.${extra} Bir dakika sonra tekrar yazarsan hallederim 🙏`;
  },

  // ── rows 59, 60: rating progress ───────────────────────────────────

  rating_progress_failed: "Şu an kontrol edemedim.",
  rating_progress_no_match: "Kontrol edilecek yakın tarihli tamamlanmış bir maç yok.",
  rating_progress_header: (p) => `📋 *${p.matchName}* (${p.matchWhen}), puanlama durumu:`,
  rating_progress_rated: (p) => `• Puan veren: ${p.rated}/${p.confirmed}`,
  rating_progress_mom: (p) => `• Maçın adamını seçen: ${p.mom}/${p.confirmed}`,
  rating_progress_still_to_rate: (p) => `• Henüz puan vermeyenler (${p.names.length}): ${p.names.join(", ")}`,
  rating_progress_everyone_rated: "• Herkes puan verdi ✅",
  rating_progress_no_mom_pick: (p) =>
    `• Puan verdi ama maçın adamını seçmedi (${p.names.length}): ${p.names.join(", ")}`,

  // ── rows 61, 62: the recruit refusals ──────────────────────────────

  recruit_no_match: "Oyuncu davet edilecek yaklaşan bir maç yok.",
  recruit_full_squad: (p) => `*${p.matchName}* kadrosu zaten dolu, davet edecek açık yer yok.`,

  // ── row 63: buildBulkCancelAnnouncement ────────────────────────────

  bulk_cancel: (p) => {
    const list = p.dateLabels.map((d) => `• ${d}`).join("\n");
    const noun = p.dateLabels.length === 1 ? "maçı iptal" : "maçları iptal";
    return (
      `❌ *Program güncellemesi*, aşağıdaki *${p.activityName}* ${noun}:\n\n` +
      `${list}\n\n` +
      `Bir sonrakinde görüşürüz! 👋`
    );
  },

  // ── rows 64, 65: the admin actions ─────────────────────────────────

  format_switch_header: (p) => `🔁 *Format değişti*, artık *${p.sportName}* (${p.maxPlayers} kişi).`,
  format_switch_playing_header: (p) => `*Oynayanlar (${p.confirmed}/${p.maxPlayers}):*`,
  format_switch_bench_header: "*Yedekler:*",
  match_cancelled: (p) =>
    `❌ *Maç iptal*, ${p.activityName}, ${p.whenLabel}.\n\n` +
    `Bu hafta yeterli oyuncu yok. Haftaya görüşürüz!`,

  // ── rows 66, 134: team-ops-engine.ts and the balancer's reasons ────

  team_ops_no_match: "Takım kurulacak bir maç yok.",
  balancer_refusal: (p) => `Şu an takımları kuramıyorum, ${p.reason}.`,
  team_gen_reason_not_found: "maç bulunamadı",
  team_gen_reason_status: (p) =>
    p.status === "COMPLETED" ? "maç tamamlanmış" : p.status === "CANCELLED" ? "maç iptal edilmiş" : `maç durumu ${p.status.toLowerCase()}`,
  team_gen_reason_not_enough: (p) => `yeterli onaylı oyuncu yok, ${p.confirmed}/${p.needed}`,
  team_gen_note_including: (p) => `_İstek üzerine ${p.names.join(", ")} kadroya ONAYLI olarak eklendi._`,
  team_gen_note_pinned: (p) => `_İstek üzerine sabitlendi: ${p.pinned.join(", ")}._`,
  team_gen_note_unmatched_includes: (p) => `_(${p.names.join(", ")} listede bulunamadı, atlandı)_`,
  team_gen_note_unmatched_pins: (p) => `_(${p.names.join(", ")} takım sabitleme için bulunamadı, atlandı)_`,

  // ── row R170 (2026-09-29): teams only on request, on match day ─────

  team_ops_not_match_day: "Takımları maç günü kuracağım, o gün benden isteyin yeter.",
  team_ops_not_a_build_request: "Takımları sadece maç günü, biri benden istediğinde kuruyorum.",
  team_ops_say_generate: `"@Match Time takımları kur" yazın, takımları kurayım.`,
  teams_cleared: "Takımlar silindi. Maç günü istenince yenilerini kurarım.",
  teams_clear_nothing: "Silinecek takım yok.",
  teams_clear_admin_only: "Takımları sadece bir admin silebilir.",
  request_not_handled: "Kusura bakmayın, bunu henüz yapamıyorum.",
  request_not_handled_admin: (p: { url: string }): string =>
    `Bunu mesajla değiştiremiyorum, ama yönetici sayfasından birkaç dokunuşla yapabilirsiniz: ${p.url}\n` +
    `Ya da bana sorun: *@Match Time yardım program*`,

  // ── row 133: composePaymentAck ─────────────────────────────────────

  payment_credit_ack: (p) => {
    const credited = p.credited.length > 0 ? p.credited.join(", ") : `${p.count} ödeme`;
    const tail =
      p.unmatched > 0
        ? `\n\n_(o isimlerden ${p.unmatched} tanesi kadroda bulunamadı, atlandı)_`
        : "";
    return (
      `💳 Tamam, *${p.payerName}* adına ${credited} için ödeme kaydettim, maç: *${p.matchName}*. ` +
      `Ödemeyen: ${p.unpaid}/${p.confirmed}.${tail}`
    );
  },

  // ── rows 123 to 131: the analyze route's group literals ────────────

  recruit_failed: "Şu an yapamadım.",
  recruit_invited: (p) =>
    `📣 Hallediyorum, cevap vermemiş ${p.invited} oyuncuya *${p.matchName}* için DM attım${p.need ? ` (${p.need} yer boş)` : ""}. Varım diyeni ekleyeceğim. 🙏`,
  recruit_already_pinged: (p) => `*${p.matchName}* için oyunculara zaten yazdım, cevaplarını bekliyorum. 🙏`,
  recruit_nobody_new: (p) => `*${p.matchName}* için şu an sorulacak yeni oyuncu yok. 👍`,
  swap_deferred: (p) =>
    `*${p.a}* ve *${p.b}* zaten kadroda, kimse çıkarılmadı. ` +
    `Takımlar henüz kurulmadı; *@Match Time takımları kur* yazın, kurayım (sonra ikisini farklı takımlara koyabilirim).`,
  team_swap_done: (p) => `🔁 *${p.a}* ve *${p.b}* yer değiştirdi, kimse çıkarılmadı. Güncel takımlar:`,
  slot_transfer_done: (p) =>
    `🔁 *${p.to}*, *${p.teamLabel}* takımında *${p.from}* yerine oynuyor; ` +
    `takımlar aynı, yeniden kurulmadı, kimsenin katılımı değişmedi. Güncel takımlar:`,
  colour_swap_done: "🎨 Renkler değişti, takımlar aynı, taraflar ters döndü:",
  swap_refused: (p) =>
    `*${p.a}* ve *${p.b}* için değişiklik yapmadım. ${p.why} Hiçbir şey değişmedi, kimse çıkarılmadı.`,
  swap_refused_unknown: (p) =>
    `Bu maç için *${p.name}* adında bir oyuncu bulamadım. Kayıtlı olduğu ismi yazın.`,
  swap_refused_ambiguous: (p) =>
    `*${p.name}* birden fazla oyuncu olabilir (${p.candidates.join(", ")}). Tam ismini yazın.`,
  swap_refused_teams_not_generated: "Takımlar henüz kurulmadı. Önce *@Match Time takımları kur* yazın.",
  swap_refused_same_player: "İki isim de aynı oyuncuyu gösteriyor.",
  swap_refused_nobody_playing: "İkisi de kadroda değil.",
  swap_refused_not_in_squad: (p) => `*${p.name}* kadroda değil, o yüzden takımda yer veremem.`,
  swap_refused_both_hold_slots: (p) =>
    `*${p.name}* kadroda değil ama takımda hâlâ yeri var, diğer oyuncunun da yeri var. Hangi değişikliği istediğinizi anlayamadım.`,
  swap_refused_no_slot: (p) => `*${p.name}* kadroda değil ve devredilecek bir takım yeri yok.`,

  // ── row 67: the bot intro ──────────────────────────────────────────
  //   The attendance line says what the bot really does (✅ on the
  //   sender's own row); the English still says 👍 and is corrected in
  //   Phase 3c, the design's call (section 1.4).

  intro_opener: "👋 Herkese merhaba, MatchTime botu bu grupta aktif.",
  intro_what_i_do: "Yaptıklarım:",
  intro_attendance: `🗓  *Katılım*, buraya "VARIM" / "YOKUM" yazın (ya da uygulamadan işaretleyin), sizi kadroya ekler ya da çıkarırım. Onay için mesajınıza ✅ koyarım, ayrıca mesaj atmam.`,
  intro_daily: `🗒  *Günlük hatırlatma*, kadro dolana kadar her gün 17:00'de kadro listesini yeniden paylaşırım, kaç kişi eksik hep birlikte görürüz.`,
  intro_teams: `⚽  *Takımlar*, "@Match Time takımları kur" deyin, dengeli takımları paylaşırım. İtirazı olan \`@Match Time X ile Y'yi değiştir\` yazsın, admin onaylar.`,
  intro_rating_bit: "her maçtan sonra herkese puanlama linkini DM'den gönderirim (kayıt yok, tıklamanız yeterli)",
  intro_mom_bit: "maçın adamını uygulamadan ya da paylaştığım anketten seçin, herkes oy verince (en geç maçtan 5 gün sonra) kazananı açıklarım",
  intro_ratings_line: (p) => `🏆  *Puanlama ve maçın adamı*, ${p.bits.join("; ")}.`,
  intro_reminders: `⏰  *Hatırlatmalar*, "@Match Time pazartesi hatırlat" deyin, o gün size DM atarım.`,
  intro_stats: `📊  *İstatistikler*, "geçen hafta maçın adamı kimdi?" ya da "en istikrarlı oyuncumuz kim?" gibi sorular sorabilirsiniz.`,
  intro_payments: `💳  *Ödemeler*, her maçtan hemen sonra "ödedin mi?" anketi paylaşırım.`,
  intro_closer: "Sorunuz varsa buradan sorun. Hadi başlayalım.",

  // ── rows 74 to 77: the remaining scheduler posts ───────────────────

  chase_pre_kickoff_fallback: (p) =>
    `⏳ *${p.activityName}* (${p.timeLabel}) için hâlâ *${p.need} kişi* eksiğiz. Bu akşam müsait olan var mı?`,
  pre_kickoff_short_fallback: (p) =>
    `⏰ Bu akşam *${p.timeLabel}*, *${p.venue}* · ${p.confirmed}/${p.maxPlayers}, *hâlâ ${p.need} kişi lazım*, katılmak için son şans. 🙏`,
  gear_reminder: (p) =>
    `⚽ *${p.timeLabel}, ${p.venue}*, orada görüşürüz!\n\n` +
    `Küçük bir hatırlatma: varsa *kaleci eldiveni*, *top* ve *yedek yelek* getirin.`,
  ask_score: (p) =>
    `🏁 *${p.activityName}*, umarım iyi geçmiştir. Skor ne oldu? ` +
    `Gelecek haftaki takımları dengeli kurmak için kullanacağım.`,

  // ═══════════════════════════════════════════════════════════════════
  // Phase 2, slice 3: the chase model's server-computed headers.
  // ═══════════════════════════════════════════════════════════════════

  roster_header_past: "*Kadro:*",
  roster_header_tonight: "*Bu akşam oynayanlar:*",
  roster_header_tomorrow: "*Yarın oynayanlar:*",
  roster_header_day: (p) => `*${p.dayLabel} oynayanlar:*`,
  chase_tentative_line: (p) => `Belki: ${p.name} (kimse çıkmazsa oynar)`,
  chase_opener_example: "🗓 Kadro durumu",

  // ── onboarding (self-setup) ──────────────────────────────────────────
  // Written 2026-09-17 for the first Turkish group. Register: the intro
  // and the how-to block speak to the whole group (plural imperatives);
  // the consent ack, the admins question and the DMs speak to the one
  // person who answered ("sen"). Interpolated names sit where no suffix
  // is needed. No dashes, no time-of-day greetings. The owner reviews
  // this block; nothing here has been reviewed yet.

  onbIntro: (): string =>
    `👋 Merhaba, ben *MatchTime*. Futbol gruplarının haftalık işlerini burada, WhatsApp'ta üstlenirim:\n\n` +
    `✅ *Kim var:* *VARIM* ya da *YOKUM* yazmanız yeter. Listeyi tutar, mesajınıza tik koyarım.\n` +
    `🪑 *Yedekler:* kadro dolunca geç gelenler yedeğe yazılır, biri çıkarsa ilk şans yedeklerindir.\n` +
    `📣 *Hatırlatma:* oyuncu mu eksik? Gruba hatırlatırım, kadro dolunca dururum.\n` +
    `⚖️ *Dengeli takımlar:* beni etiketleyin, oyuncu puanlarına göre dengeli takımlar kurarım.\n` +
    `⭐ *Puanlar ve maçın oyuncusu* her maçtan sonra.\n` +
    `📊 *İstatistikler:* bana istediğinizi sorun, herkesin kendi istatistik sayfası olur.\n` +
    `💷 *Maç ücretleri:* isterseniz kart ya da banka ile ödeme bağlantıları.\n\n` +
    `Sohbet sırasında sessiz kalırım, sadece VARIM, YOKUM ya da etiketlenince yanıt veririm.\n\n` +
    `*Bu grubu ben yöneteyim mi?* Organizatör kimse *EVET* yazsın, iki kısa soru soracağım. ` +
    `İstemiyorsanız beni görmezden gelin, sessiz kalırım. 🤐`,

  onbAdminQuestion: (): string =>
    `Bu grubu başka kim yönetiyor? İsim ve numara yaz (veya @etiketle), ` +
    `birkaç kişiyi virgülle ayırabilirsin. Tek sen isen *sadece ben* yaz.`,

  onbConsentAck: (p: { adminCaptured: boolean; adminQuestion: string }): string =>
    `${p.adminCaptured ? "Tamam, yönetici sensin 🎽" : "Tamam ✅"} ${p.adminQuestion}`,

  onbAdminsAck: (p: { added: number; detailsQuestion: string }): string =>
    (p.added > 0
      ? `Tamam, yayına geçince ${p.added === 1 ? "o yöneticiyi" : `o ${p.added} yöneticiyi`} ekleyeceğim. `
      : "") + p.detailsQuestion,

  onbDetailsQuestion: (p: { missing: Array<"day" | "time" | "venue"> }): string => {
    if (p.missing.length === 3) {
      return (
        "Bir şey daha lazım: *ne zaman ve nerede oynuyorsunuz?* Tek mesaj yeter, " +
        "örneğin: _\"Cuma 21:30, Sim Arena, 7'ye 7\"_."
      );
    }
    const parts: string[] = [];
    if (p.missing.includes("day")) parts.push("hangi *gün* oynadığınız");
    if (p.missing.includes("time")) parts.push("*başlangıç saati* (örn. 21:30)");
    if (p.missing.includes("venue")) parts.push("*saha* adı");
    return `Az kaldı, bir de ${parts.join(" ve ")} lazım.`;
  },

  onbCompletionPost: (p: {
    groupName: string | null;
    onLabels: string[];
    dayName: string;
    kickoffTime: string | null;
    venue: string | null;
    weekly: boolean;
    rosterCount: number;
    adminsAdded: number;
    adminDmQueued: boolean;
    adminName: string | null;
    howToUseMe: string;
  }): string => {
    const adminName = p.adminName?.trim();
    const forGroup = p.groupName ? `*${p.groupName}* için` : "bu grup için";
    const adminLine = p.adminDmQueued
      ? `${adminName || "Yönetici"}, yönetici sayfanın özel bağlantısını sana gönderdim: oyuncu adları, puanlar ve ödemeler orada. `
      : `Bu grubu kim yönetiyorsa yönetici sayfasını istediği zaman matchtime.ai üzerinden alabilir. `;
    return (
      `✅ *Hazırız!* ${forGroup} yayındayım: *${p.onLabels.join(", ")}*.\n\n` +
      `📅 İlk maç: *${p.dayName} ${p.kickoffTime}*, yer: *${p.venue}*` +
      `${p.weekly ? ", her hafta" : ""}.\n` +
      (p.rosterCount > 0
        ? `👥 Bu gruptaki *${p.rosterCount} kişiyi* kadroya ekledim, kimseyi elle yazmanıza gerek yok.\n`
        : ``) +
      (p.adminsAdded > 0
        ? `👮 *${p.adminsAdded} yardımcı yönetici* ekledim, yönetici bağlantılarını özelden gönderdim.\n`
        : ``) +
      `\n` +
      `${adminLine}Diğer herkes: normal sohbete devam edin, oynayacağınız zaman *"varım"* yazın, gerisini ben hallederim. ⚽` +
      `\n\n*Beni nasıl kullanırsınız* 👇\n${p.howToUseMe}`
    );
  },

  onbAdminDm: (p: {
    groupName: string | null;
    url: string;
    payments: boolean;
    seedUrl?: string | null;
    blockBookingsUrl?: string | null;
    matchesUrl?: string | null;
  }): string =>
    `👋 MatchTime'da ${p.groupName ? `*${p.groupName}* grubunun` : "grubunun"} yöneticisi sensin.\n\n` +
    `Yönetici sayfanın özel bağlantısı burada, oyuncu adları, puanlar` +
    `${p.payments ? ", ödemeler" : ""} ve ayarlar orada:\n${p.url}` +
    (p.seedUrl
      ? `\n\n⭐ *Başlangıç puanları:* ilk takımlarım dengeli olsun diye her oyuncuya 10 üzerinden kabaca bir puan ver. ` +
        `Oyuncular bunları hiç görmez, maçlardan sonra oyuncular birbirine puan verince gerçek puanlar bunların yerini alır:\n${p.seedUrl}`
      : ``) +
    (p.blockBookingsUrl ? `\n\n📅 Sezonluk blok rezervasyonun mu var? Tarihleri buradan ekle:\n${p.blockBookingsUrl}` : ``) +
    (p.matchesUrl
      ? `\n\n🗓️ Bir haftayı iptal etmen ya da formatını değiştirmen mi gerekiyor? O maçı maç listenden aç:\n${p.matchesUrl}`
      : ``) +
    (p.payments
      ? `\n\nParayı da ben *toplayayım* mı? Yönetici sayfandan bir banka hesabı bağla, 2 dakika sürer.`
      : ``),

  onbCoAdminDm: (p: { groupName: string | null; url: string }): string =>
    `👋 MatchTime'da ${p.groupName ? `*${p.groupName}* grubuna` : "gruba"} yönetici olarak eklendin.\n\n` +
    `Yönetici sayfanın özel bağlantısı:\n${p.url}`,

  onbEnrichmentDm: (p: { messagesAnalyzed: number; groupName: string | null; playerCount: number; url: string }): string =>
    `📋 ${p.groupName ? `*${p.groupName}* grubunun` : "Grubun"} ${p.messagesAnalyzed} eski mesajını okudum ve ` +
    `${p.playerCount} oyuncu için mevki ve başlangıç puanı taslağı hazırladım.\n\n` +
    `Henüz hiçbir şey uygulanmadı, buradan inceleyip kurulumu bitir:\n${p.url}`,

  onbCancelled: (): string =>
    `Tamam, kurulumu durdurdum, sessiz kalacağım. Baştan başlamak için beni gruba yeniden ekleyin veya *@Match Time kurulum* yazın.`,

  onbFeatureLabel: (p: { key: string; englishLabel: string }): string =>
    ({
      attendance: "Yoklama",
      bench: "Yedek listesi",
      teamBalancing: "Takım kurma",
      momVoting: "Maçın adamı",
      playerRating: "Oyuncu puanları",
      reminders: "Hatırlatmalar",
      statsQa: "İstatistik cevapları",
      paymentTracking: "Ödeme takibi",
      paymentCollection: "Maç ücreti toplama",
      payByBank: "Banka ile ödeme",
      payCard: "Kart ile ödeme",
      payDirect: "Organizatöre ödeme",
    })[p.key] ?? p.englishLabel,

  onbDayName: (p: { dow: number }): string =>
    ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"][p.dow] ?? "Salı",

  onbHowToUseMe: (f: {
    attendance: boolean;
    teamBalancing: boolean;
    momVoting: boolean;
    playerRating: boolean;
    statsQa: boolean;
    reminders: boolean;
    bench: boolean;
    paymentTracking: boolean;
    paymentCollection?: boolean;
  }): string => {
    const lines: string[] = [];
    if (f.attendance) {
      lines.push(`✅ Kendi durumunuz için *"varım"* veya *"yokum"* yazın, beni etiketlemenize gerek yok.`);
      lines.push(`🤔 Emin değil misiniz? *"belki"* yazın, maçtan yaklaşık 24 saat önce size özelden sorarım.`);
    } else {
      lines.push(`📋 Kadro listesini yapıştırın, kimin oynadığını okurum, beni etiketlemenize gerek yok.`);
    }
    const caps: string[] = [];
    if (f.attendance) caps.push(`kim var / kaç kişiyiz`);
    if (f.teamBalancing) caps.push(`takımları kur / takımları göster`);
    if (f.statsQa) caps.push(`geçen hafta kim kazandı? / eski istatistikler`);
    lines.push(`💬 Bir şey yapmamı veya söylememi istediğinizde *@Match Time* etiketleyin:`);
    for (const c of caps) lines.push(`   • ${c}`);
    lines.push(`🤐 Diğer zamanlarda sessizim, sohbet ve şaka serbest, araya girmem.`);
    if (f.momVoting) lines.push(`🏆 Maçtan sonra kısa bir *maçın adamı* oylaması yaparım.`);
    if (f.playerRating) lines.push(`⭐ Maçtan sonra tek dokunuşla *puanlama* bağlantısını özelden gönderirim.`);
    if (f.reminders) lines.push(`⏰ Hatırlatma mı lazım? *"@Match Time perşembe hatırlat"* yazın, o zaman size özelden yazarım.`);
    if (f.paymentCollection) lines.push(`💷 Her maçtan sonra size özelden bir ödeme bağlantısı gönderirim: kart, Apple veya Google Pay ya da banka.`);
    if (f.paymentTracking) lines.push(`💳 Kimin *ödediğini* takip ederim.`);
    if (!f.paymentTracking && !f.paymentCollection) lines.push(`💷 Maç ücretlerini toplamak mı istiyorsunuz? Bana sorun: *@Match Time yardım ödeme*`);
    lines.push(`\nBunu tekrar görmek için istediğiniz zaman *"@Match Time yardım"* yazın.`);
    return lines.join("\n");
  },

  onbHelpHead: (): string => `ℹ️ *MatchTime yardım*, açıklayabileceklerim şunlar. Beni şunlardan biriyle etiketleyin:`,

  onbHelpTopicLine: (p: { word: string; label: string }): string =>
    `   • *@Match Time yardım ${p.word}*, ${p.label}`,

  onbHelpTopicWord: (p: { topic: "availability" | "teams" | "mom" | "ratings" | "reminders" | "payments" | "schedule" | "badges" }): string =>
    ({
      availability: "kadro",
      teams: "takımlar",
      mom: "maçın adamı",
      ratings: "puanlama",
      reminders: "hatırlatma",
      payments: "ödeme",
      schedule: "program",
      badges: "rozetler",
    })[p.topic],

  onbHelpTopicLabel: (p: { topic: "availability" | "teams" | "mom" | "ratings" | "reminders" | "payments" | "schedule" | "badges" }): string =>
    ({
      availability: "kadro ve katılım",
      teams: "dengeli takımlar",
      mom: "maçın adamı",
      ratings: "oyuncu puanları",
      reminders: "hatırlatmalar",
      payments: "ödeme takibi",
      schedule: "program ve rezervasyonlar",
      badges: "rozetler ve nasıl kazanılır",
    })[p.topic],

  onbHelpNotOn: (): string =>
    `Bu özellik bu grupta açık değil. Açık olanları görmek için *@Match Time yardım* yazın.`,

  // The admin pages are English only, so their button names are quoted
  // as they appear there; the steps read as a short path, which suits
  // both the group ("siz") and a DM ("sen").
  onbHelpSchedule: (p: {
    audience: "group" | "admin" | "player";
    activities: string;
    blockBookings: string;
    bulk: string;
    matches: string;
  }): string => {
    if (p.audience === "player") {
      return `🗓️ Maç günlerini, saatleri, iptalleri ve blok rezervasyonları organizatör yönetici sayfasından ayarlar. Bir şeyin değişmesi gerekiyorsa ona söyle.`;
    }
    return (
      `🗓️ *Programı değiştirmek*\n` +
      `Program değişiklikleri mesajla değil, yönetici sayfasından yapılır, her biri birkaç dokunuş sürer. Sayfa İngilizce, düğme adları aşağıdaki gibi.\n\n` +
      `1️⃣ *Haftalık maç (gün, başlama saati, saha):* *Activities* › maçta *Edit* › *Save changes*. Yalnızca ileriki maçlar değişir, gruba bir şey yazılmaz.\n${p.activities}\n\n` +
      `2️⃣ *Sezonluk blok rezervasyon:* *Block bookings* › *New block booking* › başlangıç tarihi ile bitiş tarihi ya da maç sayısı › *Preview dates* › *Create block*. Gruba bir şey yazılmaz.\n${p.blockBookings}\n\n` +
      `3️⃣ *Bir haftayı (ya da birkaç tarihi) iptal etmek:* *Block bookings* › *Bulk cancel / restore* › *From* ve *To* alanlarına o tarih › *Find matches* › gruba duyurmamı istiyorsanız *Announce to the group* › onay. Geri almak da aynı şekilde.\n${p.bulk}\n\n` +
      `4️⃣ *Bir maçı başka bir formata çevirmek:* maç listesinden maçı aç › *Switch format* › formatı seç › *Confirm switch*. Yeni kadroyu gruba ben yazarım.\n${p.matches}\n\n` +
      `Tek bir haftanın başlama saati henüz ayrıca değiştirilemiyor: ileriki haftalar için haftalık maçı değiştirmek gerekiyor.` +
      (p.audience === "group"
        ? `\nYöneticiler: bana özelden *yardım program* yazın, bunları sizi doğrudan giriş yapmış olarak açan bağlantılar olarak göndereyim.`
        : ``)
    );
  },

  onbHelpOffLead: (): string => `ℹ️ Bu özellik bu grupta henüz açık değil, ama nasıl çalıştığı şöyle.`,

  // The Settings page is English only, so the setting is named as it
  // appears there, with the Turkish in brackets.
  onbHelpSettingLabel: (p: { topic: "availability" | "teams" | "mom" | "ratings" | "reminders" | "payments" }): string =>
    ({
      availability: "Attendance tracking (yoklama)",
      teams: "Team generation (takım kurma)",
      mom: "Man of the Match (maçın adamı)",
      ratings: "Player ratings (oyuncu puanları)",
      reminders: "Personal reminders (kişisel hatırlatmalar)",
      payments: "Payment tracking (ödeme takibi)",
    })[p.topic],

  onbHelpPaymentsOff: (): string =>
    `💷 *Maç ücretleri nasıl çalışır*\n` +
    `Her maçtan sonra parayı toplayan kişiye kişi başı ücreti sorarım, sonra oynayan herkese payını kartla veya bankadan ödemesi için özelden bir bağlantı gönderirim. Para doğrudan parayı toplayan kişinin banka hesabına gider.\n` +
    `Ödemeyenlere her gün bir hatırlatma gönderirim, kimse arkadaşının peşinden para için koşmak zorunda kalmaz.\n` +
    `Nakit ya da havaleyle mi ödendi? Oyuncu bana *"ödedim"* yazar, ben de parayı toplayan kişiden paranın geldiğini onaylamasını isterim.`,

  onbHelpSwitchOn: (p: {
    topic: "availability" | "teams" | "mom" | "ratings" | "reminders" | "payments";
    audience: "group" | "admin" | "player";
    url: string;
    word: string;
    label: string;
  }): string => {
    if (p.audience === "player") {
      return p.topic === "payments"
        ? `🔧 Bunu organizatör yönetici sayfasından açar. Bu şekilde ödemek istersen ona söyle.`
        : `🔧 Bunu organizatör yönetici sayfasından açabilir. İstersen ona söyle.`;
    }
    if (p.audience === "admin") {
      const what =
        p.topic === "payments"
          ? `*Bot features* altında *Payment tracking* ve *Collect match fees* ayarlarını aç, parayı kimin toplayacağını seç, sonra o kişinin banka hesabını Stripe ile bir kez bağla (yaklaşık 2 dakika)`
          : `*Bot features* altında *${p.label}* ayarını aç`;
      return `🔧 Açmak için yönetici sayfanda *Settings* bölümüne gir, ${what}:\n${p.url}`;
    }
    const what =
      p.topic === "payments"
        ? `*Bot features* altında *Payment tracking* ve *Collect match fees* ayarlarını açar, parayı kimin toplayacağını seçer, sonra o kişinin banka hesabını Stripe ile bir kez bağlar (yaklaşık 2 dakika)`
        : `*Bot features* altında *${p.label}* ayarını açar`;
    return (
      `🔧 Açmak için bir yönetici, yönetici sayfasında (${p.url}) *Settings* bölümüne girer, ${what}.\n` +
      `Yöneticiler: bana özelden *yardım ${p.word}* yazın, sizi doğrudan giriş yapmış olarak açan bir bağlantı göndereyim.`
    );
  },

  onbHelpAdminSettings: (p: { url: string }): string => `⚙️ Ayarları yönetici sayfanda:\n${p.url}`,

  onbHelpAdminPage: (p: { url: string }): string => `⚙️ Kulübünün ayarları, giriş yapmış olarak:\n${p.url}`,

  onbHelpForClub: (p: { club: string }): string => `🏟️ *${p.club}* için:`,

  onbHelpExplainer: (p: { topic: "availability" | "teams" | "mom" | "ratings" | "reminders" | "payments" }): string =>
    ({
      ratings:
        `⭐ *Oyuncu puanları nasıl çalışır*\n` +
        `Her maçtan sonra oynayan herkese özelden bir bağlantı gönderirim. Diğer oyunculara 10 üzerinden puan verirsiniz (kendinize veremezsiniz, puanlarınız gizli kalır).\n` +
        `Herkesin puanlarını birleştirip bu kulüpteki her oyuncu için maçtan maça güncellenen bir form puanı çıkarırım, *dengeli takımları* bununla kurarım. Puanlar kulübün içinde kalır: başka bir grupta da oynuyorsanız oradaki puanlarınız buraya karışmaz. Ne kadar çok kişi puan verirse takımlar o kadar adil olur.\n` +
        `Bağlantı maçın ertesi günü gelir. Kendi puanlarınız için istediğiniz zaman *@Match Time istatistiklerim* yazın.`,
      teams:
        `🟥🟦 *Dengeli takımlar nasıl çalışır*\n` +
        `Kadro netleşince herhangi bir yönetici *@Match Time takımları kur* yazar, ben de form puanlarına göre herkesi iki dengeli takıma bölerim.\n` +
        `Kadroları doğrudan gruba yazarım. Bir eşleşmeyi beğenmediniz mi? İki oyuncuyu *değiştirmemi* isteyin (örn. _"@Match Time Ali ile Can'ı değiştir"_) veya istediğiniz zaman *"@Match Time takımları göster"* yazın. Renkleri değiştirmek için *@Match Time renkleri değiştir* yazın, takımlar aynı kalır.\n` +
        `Hazır olunca *@Match Time takımları kur* yazmanız yeter.`,
      mom:
        `🏆 *Maçın adamı nasıl çalışır*\n` +
        `Maç bitince gruba kısa bir *maçın adamı* oylaması açarım. Herkes öne çıkan oyuncuya dokunur.\n` +
        `Oyları sayar, kazananı duyururum, sonuç herkesin sezon istatistiklerine işlenir.\n` +
        `Ayarlamanız gereken bir şey yok, oylamayı maç bitince kendim başlatırım. Kendi sayınız için *@Match Time istatistiklerim* yazın.`,
      availability:
        `⚽ *Kadro ve katılım nasıl çalışır*\n` +
        `Bir sonraki maç için grupta *varım* veya *yokum* yazmanız yeter, beni etiketlemenize gerek yok, otomatik okurum.\n` +
        `Numaralı ve güncel bir kadro listesi tutarım. Kadro dolunca sonra yazanlar sırayla *yedek* listesine girer. Emin değil misiniz? *"belki"* yazın, maçtan yaklaşık 24 saat önce özelden kesin cevabınızı sorarım.\n` +
        `Biri çıkarsa yedekleri dürterim, böylece hiç eksik kalmayız. İstediğiniz zaman *yokum* yazın, gerisini ben hallederim.`,
      reminders:
        `⏰ *Hatırlatmalar nasıl çalışır*\n` +
        `Henüz *varım* veya *yokum* demeyenleri nazikçe dürterim, sonra maçtan önce bütün kadroya hatırlatırım ki kimse unutmasın.\n` +
        `Hepsi otomatik olur, kimseyi tek tek aramanıza gerek kalmaz.`,
      payments:
        `💳 *Ödeme takibi nasıl çalışır*\n` +
        `Maç ücretini kimin ödediğini takip ederim. Organizatör ücreti belirler, ben kimin ödediğini ve kimin borcu kaldığını tek bakışta gösteririm.\n` +
        `Ödemeyenlere nazik hatırlatmalar gönderirim. Oyuncular kartla ödeyebilir, organizatör nakit ve havaleleri alındı olarak işaretleyebilir.\n` +
        `Bu yalnızca ödeme takibi açıkken çalışır. Son durum için *@Match Time kim ödemedi?* yazın.`,
    })[p.topic],

  // ── "help badges" (2026-10-01) ──────────────────────────────────────
  // Rozet adları istatistik sayfasındaki gibi (İngilizce) kalır. Ondalık
  // ayırıcı virgül; örnek puan listeleri noktalı virgülle ayrılır, yoksa
  // "7,5" ile karışır.

  onbHelpBadgesHead: () => `🏅 *Rozetler: nasıl kazanılır*`,

  onbHelpBadgeLine: (p) => {
    const n = p.n;
    const d = (x: number) => String(x).replace(".", ",");
    const rule = ({
      "first-game": `bu kulüpteki ilk maçını oyna.`,
      "ten-games": `${n.regularMinGames} veya daha fazla maç oyna.`,
      ironman: `katıldığından beri her maçı oyna, en az ${n.ironManMinMatches} maç oynanmış olsun.`,
      "first-mom": `maçın adamı oylamasını bir kez kazan.`,
      "mom-machine": `maçın adamı oylamasını ${n.momMachineMinWins} veya daha fazla kez kazan.`,
      masterclass: `tek bir maçta ortalama ${d(n.masterclassMinGameAvg)} veya üzeri puan al.`,
      reliable: `en az ${n.mrReliableMinGames} maçta puan al, ortalaman ${d(n.mrReliableMinAvg)} veya üzeri olsun ve maçtan maça istikrarlı ol.`,
      "above-field": `en az ${n.aboveCurveMinRatedGames} maçta puan al ve ortalaman kulüp ortalamasının üstünde olsun.`,
    } as Record<BadgeKey, string>)[p.key];
    return `${p.emoji} *${p.label}*: ${rule}`;
  },

  onbHelpBadgesFoot: (p) =>
    `Rozetler bu kulüpteki tüm biten maçlardan hesaplanır. Çoğu bir kez kazanılınca kalır. ` +
    `Iron Man, Mr Reliable ve Above the Curve kaybedilebilir: Mr Reliable ve Above the Curve puanlar toparlanınca geri gelir, Iron Man ise kaçırılan ilk maçta biter.\n` +
    `Tek bir rozetin tüm kuralları için: *${p.dm ? "" : "@Match Time "}yardım rozetler ${p.example}*`,

  onbHelpBadgesUnknown: (p) => `🤔 "${p.query}" adında bir rozet bilmiyorum. Hepsi burada:`,

  onbHelpBadgesClubNote: () => `Rozetler bu kulüpteki tüm biten maçlardan hesaplanır.`,

  onbHelpBadgeDetail: (p) => {
    const n = p.n;
    const d = (x: number) => String(x).replace(".", ",");
    const list = (xs: readonly number[]) => `${xs.slice(0, -1).map(d).join("; ")} ve ${d(xs[xs.length - 1])}`;
    const kept = `Bir kez kazanılınca kalır.`;
    const body = ({
      "first-game":
        `Bu kulüpte ilk maçını oynayan kazanır. Bir maç, bittiğinde oyuncu kesin kadrodaysa ya da takım listesindeyse sayılır.\n${kept}`,
      "ten-games":
        `Bu kulüpte ${n.regularMinGames} veya daha fazla maç oynayan kazanır. Oyuncunun kesin kadroda ya da takım listesinde olduğu her biten maç sayılır.\n${kept}`,
      ironman:
        `İkisi birden doğruysa kazanılır:\n` +
        `1. Kulübe katıldığından beri bu kulüpteki her maçı oynamış olmak. Katılmadan önceki maçlar aleyhine sayılmaz.\n` +
        `2. Bu sürede en az ${n.ironManMinMatches} maç oynanmış olması.\n` +
        `Kaçırılan ilk maçta biter ve o maç hep sayıldığı için geri gelmez.`,
      "first-mom":
        `Maçın adamı oylamasını bir kez kazanan alır. En çok oyda iki ya da daha fazla oyuncu berabere kalırsa hepsi kazanmış sayılır.\n${kept}`,
      "mom-machine":
        `Maçın adamı oylamasını ${n.momMachineMinWins} veya daha fazla kez kazanan alır. En çok oyda beraberlik, berabere kalan herkes için bir galibiyet sayılır.\n${kept}`,
      masterclass:
        `Diğer oyuncuların verdiği puanların ortalaması tek bir maçta ${d(n.masterclassMinGameAvg)} veya üzeri olursa kazanılır. Bir maç yeter.\n${kept}`,
      reliable:
        `Üçü birden doğruysa kazanılır:\n` +
        `1. En az ${n.mrReliableMinGames} maçta puan almış olmak.\n` +
        `2. Aldığı tüm puanların ortalaması ${d(n.mrReliableMinAvg)} veya üzeri.\n` +
        `3. Maçtan maça istikrarlı olmak: maç maç ortalamaları çok dalgalanmıyor. Sayıyla, yayılım (standart sapma) ${d(n.mrReliableMaxSpread)} puanın altında. ` +
        `${list(n.mrReliableSteady)} alan bir oyuncu hak kazanır. ${list(n.mrReliableSwinging)} alan bir oyuncu, ortalaması benzer olsa bile kazanamaz.\n` +
        `Puanlar düşer ya da dalgalanmaya başlarsa kaybedilebilir, yeniden oturunca geri gelir.`,
      "above-field":
        `İkisi birden doğruysa kazanılır:\n` +
        `1. En az ${n.aboveCurveMinRatedGames} maçta puan almış olmak.\n` +
        `2. Aldığı tüm puanların ortalaması kulüp ortalamasından (kulübün maçlarında her oyuncuya verilen tüm puanlar) yüksek.\n` +
        `Ortalaması kulüp ortalamasına ya da altına düşerse kaybedilebilir, yeniden üstüne çıkınca geri gelir.`,
    } as Record<BadgeKey, string>)[p.key];
    return `${p.emoji} *${p.label}*\n${body}`;
  },

  // ── private messages (Phase 3) ──────────────────────────────────────
  // Register: "sen" in every DM (the owner's decision). Names, dates and
  // match names sit where Turkish needs no suffix on them: before
  // "için", in brackets, or after a colon. A missing first name is left
  // out rather than replaced with a stand-in word. The words a player is
  // told to type are *VARIM* / *YOKUM* (attendance) and *EVET* (the
  // bench slot); the readers in `dm-reply/route.ts`,
  // `dm-self-attendance.ts` and `fee-confirm.ts` accept them.

  dm_rating: (p) =>
    `🏆 *${p.activityName}*, ${p.dateLabel}\n\n` +
    `Takım arkadaşlarına puan ver, ${p.mvpLabel} için de oyunu kullan. Yaklaşık 1 dakika sürer.\n\n` +
    `Kişisel linkin:\n${p.rateUrl}\n\n` +
    `Link 5 gün geçerli.\n\n` +
    `📊 Sezon istatistiklerin (puanlar, maçın adamı, rozetler, paylaşım kartı), istediğin zaman:\n${p.statsUrl}`,

  dm_rating_reminder: (p) => {
    const n = p.firstName;
    const sig = `\n${p.url}`;
    switch (p.dayNum) {
      case 1:
        return (
          `${n ? `${n} 👋 ` : "👋 "}Umarım dünkü *${p.activityName}* maçı iyi geçmiştir.\n\n` +
          `Bir dakikan olunca buradan takım arkadaşlarına puan ver, ${p.mvpLabel} için de oyunu kullan. ` +
          `Ne kadar çok kişi oy verirse gelecek haftaki takımlar o kadar dengeli olur 🙌${sig}`
        );
      case 2:
        return (
          `${n ? `${n}, küçük` : "Küçük"} bir hatırlatma 🙂 *${p.activityName}* için puanlarını hâlâ bekliyorum.\n\n` +
          `Söz, 30 saniye sürer. Gelecek hafta herkes için daha adil takımlar demek ⚽${sig}`
        );
      case 3:
        return (
          `Puanlama süresinin yarısı geçti${n ? `, ${n}` : ""} ⏳\n\n` +
          `Kadronun yarısı oy verdi, senin oyun da *${p.activityName}* puanlarını epey değiştirir. Hızlıca dokun:${sig}`
        );
      case 4:
        return (
          `${n ? `${n}, ` : ""}*${p.activityName}* için puan vermeye ve ${p.mvpLabel} oylamasına son iki gün 🏆\n\n` +
          `30 saniye, sonra işin biter:${sig}`
        );
      default:
        return (
          `Son çağrı${n ? ` ${n}` : ""} 🔔 *${p.activityName}* için puanlama yarın kapanıyor.\n\n` +
          `Kapanmadan puanını ver, ${p.mvpLabel} için de oyunu kullan. Senin oyun da önemli:${sig}`
        );
    }
  },

  dm_tentative_followup: (p) =>
    `${p.firstName ? `${p.firstName} 👋 ` : "👋 "}*${p.activityName}* (${p.whenLabel}) için *belki* demiştin.\n\n` +
    `Var mısın, yok musun? *VARIM* ya da *YOKUM* yazman yeterli, kadroyu ben ayarlarım 🙏`,

  dm_tentative_reask: "Sorun değil, oynayabiliyorsan *VARIM*, oynayamıyorsan *YOKUM* yaz, kadroyu güncellerim 🙏",

  dm_tentative_ack: (p) => {
    if (p.failed) {
      return "Kusura bakma, kadroyu şu an güncelleyemedim. Bir yönetici halleder, istersen biraz sonra tekrar dene 🙏";
    }
    return p.decision === "in"
      ? "✅ Süper, kadrodasın! Maçta görüşürüz ⚽"
      : "👋 Sorun değil, haber verdiğin için sağ ol. Belki bir dahaki sefere!";
  },

  dm_bench_offer: (p) => {
    const claim = p.reactions
      ? "Almak için buraya *EVET* yaz, gruptaki etiketlediğim mesaja 👍 ver ya da orada *VARIM* yaz."
      : "Almak için buraya *EVET* yaz ya da gruptaki etiketlediğim mesaja *VARIM* diye cevap ver.";
    return (
      `👋 ${p.firstName ? `${p.firstName}, bir` : "Bir"} yer açıldı: ${p.context}. Yedekte olduğun için sana da yazıyorum.\n\n` +
      `İster misin? ${claim} İlk sahiplenen oynar. Süre sınırı yok, müsait değilsen de sorun değil, yedekte kalırsın. 🙏`
    );
  },

  dm_bench_offer_many: (p) => {
    const claim = p.reactions
      ? "Almak için buraya *EVET* yaz, gruptaki etiketlediğim mesaja 👍 ver ya da orada *VARIM* yaz."
      : "Almak için buraya *EVET* yaz ya da gruptaki etiketlediğim mesaja *VARIM* diye cevap ver.";
    return (
      `👋 ${p.firstName ? `${p.firstName}, ${p.count}` : `${p.count}`} yer açıldı: ${p.context}. Yedekte olduğun için sana da yazıyorum.\n` +
      p.details.map((d) => `${d}\n`).join("") +
      `\n` +
      `Birini ister misin? ${claim} İlk sahiplenen oynar. Süre sınırı yok, müsait değilsen de sorun değil, yedekte kalırsın. 🙏`
    );
  },

  dm_bench_unclear: (p) =>
    `${p.day ? `${p.day} günkü` : "Bu akşamki"} boş yeri ister misin? Almak için *EVET* yaz. İstemiyorsan sorun değil, her durumda yedekte kalırsın 🙏`,

  dm_bench_ack: (p) =>
    ({
      declined: "👍 Sorun değil, yedekte kalmaya devam ediyorsun, bir şey değişmedi.",
      confirmed: `✅ Yer senin, ${p.day ? `${p.day} günü` : "bu akşam"} oynuyorsun! ⚽`,
      taken: "Maalesef biri senden önce davrandı. Yedekte kalmaya devam ediyorsun, başka bir yer açılırsa sıra sende 🙏",
      other: "👍 Tamam.",
    })[p.kind],

  dm_recruit_invite: (p) => {
    const spots = p.spotsLeft > 0 ? ` ${p.spotsLeft} yer kaldı.` : "";
    const lines = [
      `👋 ${p.firstName ? `${p.firstName}, ` : ""}*${p.matchName}* (${p.matchWhen}) için kadroyu kuruyoruz.${spots}`,
      "",
      p.reactions ? "Oynuyor musun? *VARIM* yaz ya da bu mesaja 👍 ver." : "Oynuyor musun? *VARIM* yazman yeterli.",
      p.reactions
        ? "Gelemiyor musun? *YOKUM* yaz ya da 👎 ver, bir daha sormam 🙌"
        : "Gelemiyor musun? *YOKUM* yaz, bir daha sormam 🙌",
    ];
    if (p.link) lines.push("", `Uygulamadan yapmak istersen: ${p.link}`);
    return lines.join("\n");
  },
  dm_recruit_group_invite: (p) =>
    `👋 ${p.firstName ? `${p.firstName}, ` : ""}*${p.matchName}* (${p.matchWhen}) için kadroyu kuruyoruz. ` +
    `Var mısın? Grupta *VARIM* yazman yeterli 🙌`,

  dm_recruit_chase: (p) =>
    `👋 ${p.firstName ? `${p.firstName}, ` : ""}*${p.activityName}* (${p.matchWhen}) için hâlâ ${p.count} oyuncu arıyoruz. ` +
    `Varsan *VARIM*, yoksan *YOKUM* yaz, bir daha sormam 🙏`,

  dm_self_ack: (p) => {
    const m = `*${p.matchName}* (${p.matchWhen})`;
    if (p.failed) {
      return "Kusura bakma, kadroyu şu an güncelleyemedim. Bir yönetici halleder, istersen biraz sonra tekrar dene 🙏";
    }
    if (p.status === "CONFIRMED") return `✅ ${m} için kadrodasın. Maçta görüşürüz ⚽`;
    if (p.status === "BENCH") {
      return `📋 ${m} için kadro dolu, o yüzden seni yedeğe yazdım. Bir yer açılınca sana haber veririm 🙏`;
    }
    if (p.status === "DROPPED") return `👋 Sorun değil, ${m} için seni çıkardım. Haber verdiğin için sağ ol.`;
    return `👍 Not aldım. ${m} için zaten kadroda değildin, bir şey değişmedi.`;
  },

  dm_sub_ack: (p) =>
    ({
      "opt-out-all":
        'Tamam, bundan sonra sana yalnızca ödemelerle ilgili yazacağım. ' +
        'Diğer mesajları yeniden açmak için istediğin zaman "mesajları aç" yaz.',
      "opt-out-ratings":
        'Tamam, artık puanlama ve maçın adamı mesajı göndermeyeceğim 👍 ' +
        'Yeniden açmak için istediğin zaman "puanlamayı aç" yaz.',
      "opt-in-all": "Süper, bütün mesajlarım yeniden açık 👍",
      "opt-in-ratings": "Süper, puanlama ve maçın adamı linklerini yeniden göndereceğim 👍",
    })[p.kind],

  dm_reminder: (p) =>
    `⏰ Hatırlatma${p.firstName ? `, ${p.firstName}` : ""}: seni dürtmemi istemiştin.\n\n` +
    `_${p.note}_\n\n` +
    `(hazır olunca grupta yazarsın 👍)`,

  dm_stats_blast: (p) =>
    `📊 ${p.firstName ? `${p.firstName}, ` : ""}MatchTime istatistiklerin burada: zaman içindeki puanların, ` +
    `maçın adamı seçildiğin maçlar, kadroyla karşılaştırman, rozetlerin ve paylaşılabilir sezon kartın.\n\n` +
    `${p.url}\n\nBu linki sakla, süresi dolmaz.`,

  dm_stats_link: (p) =>
    `📊 ${p.firstName ? `${p.firstName}, ` : ""}MatchTime istatistiklerin burada: zaman içindeki puanların, ` +
    `maçın adamı seçildiğin maçlar, kadroyla karşılaştırman, rozetlerin ve paylaşılabilir sezon kartın.\n\n` +
    `${p.url}\n\nLink 48 saat geçerli.`,

  dm_qa_apology: "Kusura bakma, bunu çıkaramadım, bir daha sorar mısın? 🙂",

  dm_fee_ask: (p) =>
    `💷 ${p.firstName ? `${p.firstName}, ` : ""}*${p.activityName}* için oyuncu başı ne kadar alalım` +
    (p.headcount > 0 ? ` (${p.headcount} kişi oynadı)` : "") +
    `?\n\n` +
    `Tutarı yazman yeterli, örneğin "kişi başı £8" ya da "toplam £80, bölüşülsün". ` +
    `Önce sana teyit ederim, sonra herkese ödeme linkini gönderirim.`,

  dm_fee_confirm_prompt: (p) => {
    const split = p.wasTotal ? ` (${p.headcount} kişiye bölündü)` : "";
    const charge = p.headcount === "N" || p.headcount > 0;
    return (
      `Tamam, *${p.matchName}* için kişi başı *${p.fee}*${split}` +
      (charge ? `, ${p.headcount} kişiden alınacak` : "") +
      `.\n\nHerkese ödeme linkini göndermek için *✅* (ya da "evet") yaz, değiştirmek için başka bir tutar gönder.`
    );
  },

  dm_fee_released: (p) =>
    `✅ Tamam, *${p.matchName}* için kişi başı *${p.fee}* üzerinden ${p.released} ödeme linki gönderdim. ` +
    `Oyuncular bankayla, kartla, Apple ya da Google Pay ile veya doğrudan sana ödeyebilir. Ödemeyenlere ben hatırlatırım.`,

  dm_fee_cancelled: "Sorun değil, iptal ettim. Hazır olunca kişi başı tutarı yazman yeterli.",

  dm_pay_link: (p) =>
    `💷 ${p.firstName ? `${p.firstName}, ` : ""}*${p.activityName}* için maç ücreti *${p.fee}*.\n\n` +
    `Ödemek için dokun (banka, kart, Apple ya da Google Pay, ya da doğrudan organizatöre):\n${p.url}\n\n` +
    `Getirdiğin misafirlerin ücretini de buradan ödeyebilirsin.`,

  dm_pay_chase: (p) => {
    const phrase = p.dayNum <= 1 ? "kısa bir not" : p.dayNum === 2 ? "nazik bir hatırlatma" : "tekrar hatırlatıyorum";
    const opener = p.firstName
      ? `${p.firstName}, ${phrase}`
      : phrase.charAt(0).toLocaleUpperCase("tr") + phrase.slice(1);
    return (
      `💷 ${opener}: *${p.activityName}* için *${p.fee}* ödemen hâlâ açık.\n\n` +
      `Bankayla, kartla, Apple ya da Google Pay ile veya doğrudan organizatöre ödeyebilirsin:\n${p.url}`
    );
  },

  dm_direct_pay_nudge: (p) =>
    `🤝 ${p.count} oyuncu *${p.activityName}* için sana doğrudan ödeyeceğini söyledi. ` +
    `Ödeyenleri buradan işaretle:\n${p.url}`,

  dm_direct_pay_notice: (p) =>
    `💸 *${p.playerName ?? "Bir oyuncu"}*, *${p.activityName}* için ` +
    `${p.claimedPaid ? "sana doğrudan ödeme yaptığını yazdı" : "sana doğrudan ödeyeceğini söyledi"}: ` +
    `*${p.amount}*${p.quantity > 1 ? ` (${p.quantity} kişi)` : ""}.\n\n` +
    `Para eline geçince ödendi olarak işaretle:\n${p.url}`,

  dm_paid_claim_ack: (p) =>
    `Teşekkürler${p.firstName ? ` ${p.firstName}` : ""}! *${p.activityName}* için *${p.amount}* ödediğini ilettim. ` +
    `${p.collectorName ?? "Organizatör"} para eline geçince onaylayacak 👍`,

  dm_paid_claim_already: (p) =>
    `Tamamdır${p.firstName ? ` ${p.firstName}` : ""}, *${p.activityName}* için *${p.amount}* ödemeni zaten ilettim. ` +
    `${p.collectorName ?? "Organizatör"} para eline geçince onaylayacak 👍`,

  dm_paid_for_others: (p) =>
    `Teşekkürler${p.firstName ? ` ${p.firstName}` : ""}! ${p.collectorName ?? "Organizatör"} doğru tutarı görüp onaylayabilsin diye ` +
    `ödeme linkini aç, kaç kişi için ödediğini seç ve *Pay the collector directly* seçeneğine dokun:\n${p.url}`,

  dm_admin_recruit_done: (p) =>
    `📣 Tamam, cevap vermemiş ${p.invited} oyuncuya *${p.matchName}* (${p.matchWhen}) için DM attım${p.need ? ` (${p.need} yer boş)` : ""}. Varım diyeni ekleyeceğim. 🙏`,
  dm_admin_recruit_nobody_new: (p) =>
    `Son maçlarda oynayan herkes *${p.matchName}* için zaten cevap vermiş, davet edilecek yeni kimse yok. 👍`,

  dm_survey_clarify_probe: (p) => `Kusura bakma${p.firstName ? ` ${p.firstName}` : ""}, emin olamadım:`,
  dm_survey_clarify: (p) =>
    [
      `Kusura bakma${p.firstName ? ` ${p.firstName}` : ""}, emin olamadım: bu mesaj *${p.orgName}* kadro yoklamasına cevap mıydı?`,
      ``,
      `Cevabın hangisiydi:`,
      `• evet / varım`,
      `• belki / ara sıra`,
      `• şimdilik yok / bırakıyorum`,
      ``,
      `Kısa bir cevap yeter, yazmazsan da sorun değil, bir yönetici halleder 🙏`,
    ].join("\n"),

  dm_survey_confirm: (p) => {
    const n = p.firstName ? ` ${p.firstName}` : "";
    if (p.category === "in") return `Tamam${n}, seni varım olarak işaretledim 👍 Sağ ol!`;
    if (p.category === "maybe") {
      return `Tamam${n}, seni belki olarak işaretledim 👍 Oynamak istediğin hafta grupta *VARIM* yazman yeterli, önceden haber vermene gerek yok.`;
    }
    return `Sorun değil${n}, bir süre ara verdiğini not ettim. Yöneticiler haftanın sonunda kadroyu düzenleyecek. O zamana kadar fikrin değişirse buraya yazman yeterli 🙏`;
  },

  dm_survey_invite: (p) =>
    [
      p.firstName ? `${p.firstName} 👋` : "👋",
      ``,
      `Ben *Match Time*, *${p.orgName}* WhatsApp grubunu düzenleyen bot.`,
      ``,
      `Kısa bir yoklama: son zamanlarda katılım az, o yüzden herkese önümüzdeki haftalarda da oynamak isteyip istemediğini soruyoruz.`,
      ``,
      `Buraya bir iki kelimeyle cevap vermen yeterli:`,
      `• "evet" / "varım", kadroda kalayım`,
      `• "belki" / "duruma göre", sadece ben onaylarsam`,
      `• "şimdilik yok" / "bırakıyorum", beni kadrodan çıkarın`,
      ``,
      `Seçimin sadece seninle grup yöneticisi arasında kalır 🙏`,
    ].join("\n"),
  // ── the legacy "@Match Time setup" flow (Phase 3c) ──
  // Group-facing: plural register ("yazın"), as the group-add flow.

  onb_legacy_intro:
    `👋 Merhaba, ben *MatchTime*, futbol grubunuzun otomatik organizatörü. ` +
    `Haftalık işleri ben üstlenirim, siz sadece gelip oynarsınız.\n\n` +
    `Neler yaparım:\n` +
    `⚽ *Katılım*, oyuncular buraya "varım" ya da "yokum" yazar; kadro listesini güncel tutarım, eksik kalınca hatırlatırım\n` +
    `⚖️ *Dengeli takımlar*, gerçek oyuncu puanlarına göre her hafta dengeli iki takım\n` +
    `🪑 *Akıllı yedek listesi*, kadro dolu mu? Açılan yeri bütün yedeklere sorarım, ilk sahiplenen oynar. Geç gördü diye kimse yerini kaybetmez\n` +
    `🏆 *Maçın adamı ve puanlar*, maçtan sonra kısa bir oylama ve tek dokunuşla puanlama linki, uygulama indirmeye gerek yok\n` +
    `⏰ *Hatırlatmalar ve istatistikler*, maçtan önce herkese hatırlatırım, "geçen hafta maçın adamı kim oldu?" gibi sorulara cevap veririm\n\n` +
    `Tablo yok, kovalamaca yok, organizasyon derdi yok. ⚡\n\n` +
    `Hadi kuralım, yaklaşık bir dakika sürer:`,

  onb_legacy_question: (p) =>
    ({
      name: "👋 MatchTime'ı bu grup için kuralım! Önce şu: kulübünüzün ya da grubunuzun adı ne olsun? (örn. *Cuma Futbolu*)",
      side: `Tamam, adımız *${p.groupName}*. Takım başına kaç oyuncu oynuyor? (örn. 7'ye 7 için *7*, 5'e 5 için *5*)`,
      day: "Genelde haftanın hangi *günü* oynuyorsunuz? (örn. Cuma)",
      time: "Maç *saat kaçta* başlıyor? (örn. 21:30)",
      venue: "Nerede oynuyorsunuz? *Saha* adını yazın.",
      recurrence: "Bu *her hafta* oynanan bir maç mı, yoksa *tek seferlik* mi?",
      date: "Tek seferlik maç *hangi tarihte*? (örn. 2026-05-28)",
    })[p.field],

  onb_legacy_menu: (p) => {
    const lines = p.items.map((f, i) => `${i + 1}. *${f.label}*: ${f.blurb}`);
    return (
      `${p.lead}:\n\n${lines.join("\n")}\n\n` +
      `İstediklerinizi yazın, örneğin "maçın adamı ve oyuncu puanları", "hepsi" ya da "ödeme hariç hepsi". ` +
      `Numaralarını da yazabilirsiniz: "1, 3 ve 4".`
    );
  },

  onb_legacy_feature_blurb: (p) =>
    ({
      attendance: "VARIM ve YOKUM mesajlarını okur, kadro listesini tutar, eksik kalınca hatırlatır.",
      bench: "Kadro dolunca gelenleri sıraya alır; biri çıkınca açılan yeri yedeklere sorar.",
      teamBalancing: "İstenince dengeli iki takım kurar.",
      momVoting: "Maçtan sonra maçın adamı oylamasını açar, kazananı duyurur.",
      playerRating: "Her oyuncuya maçtan sonra kısa bir puanlama linki gönderir.",
      reminders: "İstenen gün oyuncuya özelden hatırlatma yazar.",
      statsQa: "Geçmişle ilgili soruları cevaplar (en çok gelenler, eski maçın adamları, skorlar).",
      paymentTracking: "Kimin ödediğini takip eder, ödemeyenlere hatırlatır (isteğe bağlı).",
      paymentCollection: "Her maçtan sonra oyunculara ödeme linki gönderir. Bağlı bir banka hesabı gerekir.",
      payByBank: "En ucuz yöntem (yaklaşık 10p). Önerilen varsayılan.",
      payCard: "Kartla ödeme (£10 için yaklaşık 35p).",
      payDirect: "Nakit ya da havale; parayı toplayan kişi alındığını onaylar. Ücret yok.",
    })[p.key] ?? p.englishBlurb,

  onb_legacy_menu_retry_lead: "Hangilerini seçtiğinizi anlayamadım, istediğiniz özellikleri yazın",

  onb_legacy_provisioned_lead: (p) =>
    `Süper, *${p.groupName}* hazır: takım başına *${p.playersPerTeam}* oyuncu, *her ${p.dayName} ${p.kickoffTime}*, yer: *${p.venue}*.\n\n` +
    `Son adım: hangi özellikleri istiyorsunuz? Yapabildiklerimin hepsi burada`,

  onb_legacy_completion: (p) =>
    `✅ *Hazırız!* Bu grup için şu özelliklerle çalışıyorum: *${p.onLabels.join(", ")}*.\n\n` +
    `İlk maç: *${p.dayName} ${p.kickoffTime}*, yer: *${p.venue}*` +
    `${p.weekly ? " (her hafta)" : ""}.\n\n` +
    `*Beni nasıl kullanırsınız* 👇\n${p.howToUseMe}`,

  // ── iki puan, web arayüzünde (slice 6, 2026-09-19) ──────────────────
  //
  // Bu tablodaki ilk web metinleri. WhatsApp değil tarayıcı okuyor, o
  // yüzden `*kalın*` yok, emoji yok. Oyuncunun kendi sayfasında iki ayrı
  // puan var ve hangisine baktığını ancak bu satırlar söylüyor:
  // KULÜP PUANI sadece o kulüpte alınan puanlardan çıkar ve takımları o
  // kurar; GENEL PUAN oyuncunun bugüne kadar her kulüpte aldığı bütün
  // puanların ortalamasıdır ve onu sadece oyuncunun kendisi görür.
  //
  // Kayıt: DM metinlerinde olduğu gibi burada da "sen" kullanılıyor,
  // çünkü bunlar oyuncunun kendi sayfasında ona söylenen şeyler.

  rating_club_tile: "Kulüp puanı",

  rating_club_label: (p) => `Kulüp puanın: ${p.orgName}`,

  rating_club_note: "Sadece bu kulüpte aldığın puanlardan. Başka kulüpler buraya karışmaz.",

  rating_overall_label: "Genel puanın",

  rating_overall_note:
    "Bugüne kadar aldığın bütün puanlar, hangi kulüpten olursa olsun, hepsi bir kez sayılır. Bunu sadece sen görüyorsun.",

  rating_club_empty: "Bu kulüpte henüz puanın yok. İlk maçından sonra takım arkadaşların puan verecek.",

  rating_seed_club_hint:
    "Başlangıç puanları sadece bu kulüp için geçerli. Başka bir yerde de oynayan bir oyuncunun orada ayrı bir puanı olur, buraya yazdığınız hiçbir şey onu değiştirmez.",

  // 2026-09-19: eski satır "kulüp ortalamasına yakın durur" diyordu.
  // Artık oyuncu kendi ham ortalamasını görüyor, yani o cümle yanlıştı.
  // Yeni cümle sayının oynatılmasından değil, elde az veri olmasından
  // bahsediyor.
  rating_club_provisional: (p) =>
    `Geçici: şimdilik ${p.count} puan var, yenileri geldikçe bu sayı çok oynayacak.`,

  rating_club_balance_note:
    "Sadece bir iki puanın varken MatchTime takımları kurarken bu sayıya temkinli yaklaşır, böylece tek bir erken puan takımı belirlemez.",

  rating_club_peers: (p) => `takım arkadaşlarından ${p.count} puan`,

  ai_daily_cap_reached: () => "Bugün çok soru yanıtladım, yarın tekrar sor.",

  // ── /profile/stats: kadro sıralaması ve sezonun takımı panelleri
  // (2026-09-30). İki panel aynı kuralı kullanıyor, kural tek bir
  // metinden (`stats_table_rule`) okunuyor.
  stats_leaderboard_title: "Kadro sıralaması",
  stats_leaderboard_info_lead: "Tablodaki herkes bu sezonki ortalama puanına göre sıralanır.",
  stats_leaderboard_info_arrows_lead: "Ok, her oyuncunun geçen haftaki maçtan beri nasıl hareket ettiğini gösterir:",
  stats_leaderboard_arrow_up: "yükseldi",
  stats_leaderboard_arrow_down: "düştü",
  stats_leaderboard_arrow_same: "değişmedi",
  stats_leaderboard_new: "yeni",
  stats_leaderboard_you: " (sen)",
  stats_leaderboard_not_ranked: "sıralamada değil",
  stats_table_rule: (p) =>
    `Kadro sıralaması ve sezonun takımı aynı kuralı kullanır: bir oyuncunun en az ${p.minGames} puanlı maçı ve son üç ayda oynadığı bir maç olmalı. Daha uzun süre oynamayan biri tekrar oynayana kadar listeden çıkar, oynadığı an aynı puanla geri döner, çünkü uzaktayken puanı hiç düşürülmez.`,
  stats_leaderboard_join: (p) =>
    `Tabloya girmek için ${p.minGames} puanlı maç oynaman gerekiyor. Şimdiye kadar ${p.games} maçın var, ${p.minGames - p.games} maç daha kaldı.`,
  stats_leaderboard_away: (p) =>
    `Şu an sıralamada değilsin${p.lastPlayed ? `, son maçın ${p.lastPlayed} tarihindeydi` : ""}. ${p.avg} puanın olduğu gibi duruyor, bir maç daha oynarsan aynı puanla hemen tabloya dönersin.`,
  stats_tots_title: "Sezonun takımı",
  stats_tots_info_lead: (p) =>
    `Sezonun şimdiye kadarki en iyi kadrosu: her mevkide sezon ortalama puanı en yüksek oyuncu (${p.sportName}).`,

  // ── /profile/stats: kartları görsel olarak paylaşma (2026-10-01).
  // Rozet adları iki dilde de İngilizce kalıyor (player-stats.ts). Kulüp
  // adı parantez içinde, ek almadan duruyor. ──
  stats_share_card: "Kartı paylaş",
  stats_share_badge_label: (p) => `Paylaş: ${p.label}`,
  stats_share_saved: "Görsel kaydedildi. WhatsApp'tan gönder.",
  stats_share_failed: "Görsel hazırlanamadı. Tekrar dene.",
  stats_share_badge_text: (p) => `MatchTime'da yeni rozetim: ${p.emoji} ${p.label} (${p.orgName})`,
  stats_share_season_text: (p) => `MatchTime'da sezonum (${p.orgName})`,

  // ── Rozet duyuruları (2026-10-01): maçtan iki gün sonra gruba giden
  // mesaj (badge-announcements.ts) ve /admin/settings anahtarı. Her rozet
  // tek satır; aynı rozeti kazananlar aynı satırı paylaşır. Rozet adları
  // istatistik sayfasındaki gibi İngilizce kalıyor. ──
  badges_post_header: "🏅 *Bu haftanın yeni rozetleri*",
  badges_post_footer:
    "Hepinizin eline sağlık! 👏\n📊 Kendi istatistiklerini ve rozetlerini istediğin zaman görebilirsin: her maçtan sonra gönderdiğim puanlama mesajındaki istatistik linkine dokun.",
  badges_line_first_game: (p) =>
    p.names.length === 1
      ? `${p.emoji} *${p.label}*: aramıza hoş geldin ${boldNamesTr(p.names)}, kulüpteki ilk maçın! 🎉`
      : `${p.emoji} *${p.label}*: aramıza hoş geldiniz ${boldNamesTr(p.names)}, kulüpteki ilk maçınız! 🎉`,
  badges_line_first_mom: (p) => {
    const clauses = p.shared.map(
      (g) => `${boldNamesTr(g)} ödülü paylaştı, ${g.length === 2 ? "ikisi için de" : "hepsi için"} bir ilk`,
    );
    if (p.solo.length > 0) clauses.push(`${boldNamesTr(p.solo)} ilk kez maçın adamı seçildi`);
    return `${p.emoji} *${p.label}*: ${clauses.join("; ")} ⭐`;
  },
  badges_line_mom_machine: (p) =>
    `${p.emoji} *${p.label}*: ${boldNamesTr(p.names)} artık 3 kez maçın adamı seçildi 🔥`,
  badges_line_masterclass: (p) =>
    `${p.emoji} *${p.label}*: ${boldNamesTr(p.names)} bir maçta 9+ ortalama yakaladı, birinci sınıf 🎯`,
  badges_line_ten_games: (p) =>
    `${p.emoji} *${p.label}*: ${boldNamesTr(p.names)} artık 10 maç oynadı 💪`,
  badges_line_reliable: (p) =>
    p.names.length === 1
      ? `${p.emoji} *${p.label}*: ${boldNamesTr(p.names)}, her hafta yüksek puan, ona güvenebilirsiniz 🔒`
      : `${p.emoji} *${p.label}*: ${boldNamesTr(p.names)}, her hafta yüksek puan, onlara güvenebilirsiniz 🔒`,
  badges_feature_label: "Rozet duyuruları",
  badges_feature_blurb:
    "Her maçtan iki gün sonra yeni rozetleri grupta paylaşır: ilk maç, Regular, Man of the Match, MoM Machine, Masterclass, Mr Reliable.",

  // ── Self-join, 4. dilim: organizatörün web sayfaları (2026-09-29) ──
  // Sayılara gelen ek (7'ye, 5'e, 6'ya...) sayının okunuşuna göre
  // seçilir: yedi, beş, altı. Kulüp adı hep eksiz bir yerde durur
  // ("Riverside FC kulübünü bağla"), grup adı da tırnak içinde
  // "grubuna/grubunda" ile.
  sj_activity_name: (p) => `${perSideTr(p.perSide)} futbol`,
  sj_per_side_option: (p) => perSideTr(p.perSide),

  sj_form_title: "Kulübünüzü kurun",
  sj_form_lead: "Bize kulübünüzü ve haftalık maçınızı anlatın. Ardından MatchTime'ı WhatsApp grubunuza bağlayacaksınız.",
  sj_form_club_name: "Kulüp adı",
  sj_form_club_name_placeholder: "örn. Riverside FC",
  sj_form_language: "MatchTime'ın grubunuzda konuşacağı dil",
  sj_form_game_heading: "Haftalık maçınız",
  sj_form_day: "Gün",
  sj_form_time: "Başlama saati",
  sj_form_venue: "Saha",
  sj_form_venue_placeholder: "örn. Goals Wembley",
  sj_form_per_side: "Takım başına oyuncu",
  sj_form_submit: "Kulübü kur",
  sj_form_submitting: "Kuruluyor...",

  sj_err_invalid: "Lütfen tüm alanları doldurun.",
  sj_err_verify_phone: "Lütfen önce WhatsApp numaranızı doğrulayın, böylece MatchTime sizi tanır.",
  sj_verify_phone_link: "Numaramı doğrula",
  sj_err_one_club: "MatchTime'da zaten bir kulübünüz var. Profilinizden açabilirsiniz.",
  sj_open_my_club: "Kulübümü aç",
  sj_err_site_cap: "Her gün birkaç yeni kulüp alıyoruz. Lütfen yarın tekrar deneyin.",
  sj_err_generic: "Bir şeyler ters gitti. Lütfen tekrar deneyin.",

  sj_connect_prefill: (p) => `${p.club} kulübünü bağla, kod ${p.code}`,

  sj_card_title: "MatchTime'ı WhatsApp'a bağlayın",
  sj_button: "MatchTime'ı WhatsApp'a ekle",
  sj_button_again: "WhatsApp'ı tekrar aç",
  sj_card_draft: "Aşağıdaki düğmeye dokunun. WhatsApp, MatchTime'a gönderilmeye hazır kısa bir mesajla açılır.",
  sj_card_issued: "1. adım: WhatsApp'ta açılan mesajı gönderin. Bu kod 60 dakika geçerli.",
  sj_card_code: (p) => `Kodunuz: ${p.code}`,
  sj_card_wrong_number: (p) =>
    `Kodunuz ${p.seen} numarasından geldi. Lütfen kayıt olduğunuz numaradan, yani ${p.expected} numarasından gönderin.`,
  sj_card_dm_verified:
    "2. adım: MatchTime'ı futbol grubunuza ekleyin. Aşağıdaki numarayı MatchTime adıyla rehberinize kaydedin, sonra grubu açıp Katılımcı ekle'ye dokunun ve MatchTime'ı seçin.",
  sj_card_number_label: "MatchTime'ın WhatsApp numarası",
  sj_card_pending:
    "3. adım: kulübünüzü kontrol ediyoruz, genellikle bir gün içinde. Kulübünüz onaylanana kadar MatchTime grupta sessiz kalır, yayına geçince size WhatsApp'tan yazar.",
  sj_card_pending_other: (p) =>
    `MatchTime "${p.group}" grubuna başka biri tarafından eklendi. Açmadan önce kontrol edeceğiz.`,
  sj_card_approved: (p) => `Aktifsiniz. MatchTime "${p.group}" grubunda herkese merhaba dedi.`,
  sj_card_rejected: "Bu grubu şu an alamıyoruz.",
  sj_card_expired: "Bu kodun süresi doldu. Yeni bir kod için düğmeye tekrar dokunun.",
  sj_card_code_cap: "Bugünkü kodlarınızı kullandınız. Lütfen yarın tekrar deneyin.",
  sj_card_unavailable: "MatchTime şu an yeni grup alamıyor. Lütfen kısa süre sonra tekrar bakın.",
  sj_card_already_connected: "Zaten bağlısınız. Şimdi MatchTime'ı grubunuza eklemeniz yeterli.",

  // ── /admin/players (2026-09-29) ─────────────────────────────────────
  admin_players_new_heading: (p: { count: number }): string =>
    `${p.count} yeni oyuncu WhatsApp üzerinden katıldı`,
  admin_players_new_body: (p: { names: string[] }): string =>
    `${p.names.length > 0 ? p.names.join(", ") : "Bu oyuncular"} grupta mesaj yazdı ve otomatik eklendi. ` +
    `Aşağıdan telefon, pozisyon ve başlangıç puanını kontrol edin. Onaylamak için ✓, oyuncu değilse kaldırmak için ✕ tuşuna basın.`,
  admin_players_club_rating_header: "Kulüp puanı",
  admin_players_club_rating_hint:
    "Bu kulübün oyuncularının verdiği puanların ortalaması, oyuncunun kendi sayfasında gördüğü sayının aynısı. Takım dengeleyici, daha fazla puan gelene kadar başlangıç puanını da hesaba katar.",
  admin_players_not_rated_yet: "Henüz puan yok",
  admin_players_rated_games: (p: { count: number }): string => `${p.count} puanlanmış maç`,

  // ── Self-join slice 5: the connect DM replies ──
  sj_site_cap_groups: "Her gün birkaç yeni grup alıyoruz. Lütfen yarın tekrar deneyin.",

  sj_dm_connected: (p) =>
    `Merhaba${p.name ? ` ${p.name}` : ""}, tamamdır: ${p.club} bu sohbete bağlandı.\n` +
    "Sıradaki adım: beni futbol grubunuza ekleyin. Önce bu numarayı MatchTime adıyla rehberinize kaydedin, sonra grubu açıp Katılımcı ekle'ye dokunun ve MatchTime'ı seçin.\n" +
    "Kulübünüz onaylanana kadar grupta sessiz kalacağım, genellikle bir gün içinde. Yayına geçince size buradan yazacağım.",
  sj_dm_already_connected: "Zaten bağlısınız. Şimdi beni grubunuza eklemeniz yeterli.",
  sj_dm_code_expired:
    "Bu kodun süresi doldu. matchtime.ai'de kulübünüzü açın ve MatchTime'ı WhatsApp'a ekle düğmesine tekrar dokunun.",

  sj_dm_in_group: (p) =>
    `Teşekkürler, ${p.group ? `"${p.group}" grubuna` : "grubunuza"} katıldım. Kulübünüz onaylanana kadar orada sessiz kalacağım, genellikle bir gün içinde. Yayına geçince size buradan yazacağım.`,

  // ── Self-join slice 7: the decision ──
  sj_group_hello: (p) =>
    `👋 Herkese merhaba, ben *MatchTime*. ${p.organiser ? `${p.organiser} beni bu grubun maçlarını düzenlemem için kurdu.` : "Bu grubun maçlarını düzenlemek için buradayım."} ` +
    `Burada, WhatsApp'ta şunları yaparım:\n\n` +
    `✅ *Kim var:* *VARIM* ya da *YOKUM* yazmanız yeter. Listeyi tutar, mesajınıza tik koyarım.\n` +
    `🪑 *Yedekler:* kadro dolunca geç gelenler yedeğe yazılır, biri çıkarsa ilk şans yedeklerindir.\n` +
    `⏰ *Hatırlatma:* *"@Match Time perşembe hatırlat"* yazın, o zaman size özelden yazarım.\n` +
    `⚖️ *Dengeli takımlar:* beni etiketleyin, oyuncu puanlarına göre dengeli takımlar kurarım.\n` +
    `⭐ *Maçın oyuncusu ve puanlar* her maçtan sonra.\n` +
    `📊 *İstatistikler:* bana istediğinizi sorun, herkesin kendi istatistik sayfası olur.\n` +
    `💷 *Maç ücretleri:* organizatörünüz isterse kart ya da banka ile ödeme bağlantılarını açabilir.\n\n` +
    `Sohbet sırasında sessiz kalırım, sadece VARIM, YOKUM ya da etiketlenince yanıt veririm. Başka bir şey için beni etiketleyin: *@Match Time yardım*`,
  sj_dm_approved: (p) =>
    `Güzel haber: ${p.club} artık aktif. ${p.group ? `"${p.group}" grubunda` : "Grubunuzda"} herkese merhaba dedim.\n\n` +
    `Vaktiniz olunca ayarlamanız gereken birkaç şey:\n\n` +
    `📅 *Haftalık maçınız:* günü, saati ve sahayı kontrol edin ya da değiştirin:\n${p.scheduleUrl}\n\n` +
    `⭐ *Başlangıç puanları:* ilk takımlar dengeli olsun diye her oyuncuya 10 üzerinden kabaca bir puan verin:\n${p.ratingsUrl}\n\n` +
    `⚙️ *Ayarlar:* ödemeleri, devam eden kadroyu, haftalık son saatleri, yönetici mesajlarını, organizatör seçimini ve rozet duyurularını buradan açın:\n${p.settingsUrl}\n\n` +
    `❓ *Yardım:* istediğiniz zaman bana buradan yazın, örneğin *yardım ödeme* ya da *yardım rozetler*.\n\n` +
    `İlk ayınız ücretsiz.` +
    (p.tip ? `\n\n${p.tip}` : ""),
  sj_dm_rejected: (p) =>
    `MatchTime'ı denediğiniz için teşekkürler. ${p.group ? `"${p.group}" grubunu` : "Grubunuzu"} şu an alamıyoruz, bu yüzden gruptan ayrıldım. Bu değişirse size haber vereceğiz.`,

  dm_admin_join_new: (p) =>
    `🆕 *${p.club}* WhatsApp grubuna yeni bir oyuncu katıldı.\n\nTelefon: ${p.phone}\n` +
    `Onu oyuncu listene ekledim. Grupta ilk yazdığında WhatsApp adını kendim eklerim, istersen şimdi de girebilirsin:\n${p.url}`,
  dm_admin_join_new_named: (p) =>
    `🆕 *${p.name}*, *${p.club}* WhatsApp grubuna katıldı ve oyuncu listende.\n\nTelefon: ${p.phone}\nBilgilerine bakmak için dokun:\n${p.url}`,
  dm_admin_join_first: (p) =>
    `🆕 *${p.name}*, *${p.club}* WhatsApp grubuna katıldı ve artık oyuncu listende.`,
  dm_admin_join_rejoined: (p) =>
    `🔁 *${p.name}*, *${p.club}* WhatsApp grubuna geri döndü.\n\nÜyeliği yeniden etkinleştirildi. Başka bir şey yapmana gerek yok.`,
  dm_admin_join_linked: (p) =>
    `🔗 Onu ${p.addedOn} tarihinde eklenen *${p.placeholder}* kaydıyla birleştirdim, maçları ve takımdaki yeri korunuyor.`,
  dm_admin_join_possible_duplicate: (p) =>
    `❓ Bu kişi daha önce adıyla eklenen ${joinList("tr", p.names.map((n) => `*${n}*`))} olabilir. Öyleyse buradan birleştir:\n${p.url}`,

  admin_players_duplicates_heading: "Olası çift kayıtlar",
  admin_players_duplicate_row: (p) => `Adıyla eklenen ${p.placeholder}, ${p.keeper} ile aynı kişi olabilir.`,
  admin_players_duplicate_merge: (p) => `Birleştir: ${p.keeper}`,

  // ── Kadro devam eder (2026-09-30) ──
  rolling_announce_lead: (p) =>
    `📅 *${p.activityName}*, *${p.dateLabel}*, ${p.venue}.\n\n` +
    `Geçen maçta oynayan herkes yine kadroda. Son çıkış: *${p.deadline}*. O saate kadar *YOKUM* yazmazsanız kadrodasınız.`,
  rolling_in_header: (p) => `*Kadroda (${p.confirmed}/${p.maxPlayers}):*`,
  rolling_waiting_header: (p) => `*Yedek listesi (${p.count}):*`,
  rolling_tail_open: (p) => `${p.open} yer boş: almak için *VARIM* yazın.`,
  rolling_tail_open_organiser: (p) =>
    `${p.open} yer boş: *VARIM* yazın, yedek listesine ekleyeyim; kimin oynayacağını organizatörler seçer.`,
  rolling_tail_full: "Kadro dolu. Yedek listesine girmek için *VARIM* yazın.",
  rolling_deadline_line: (p) => `Son çıkış: *${p.deadline}*. O saate kadar *YOKUM* yazmazsanız kadrodasınız.`,
  intro_rolling_squad:
    "🔁 *Kadro devam eder*: geçen maçta oynadıysanız bir sonrakinde de kadrodasınız. Gelemeyecekseniz son çıkış saatinden önce *YOKUM* yazın.",
  late_drop_admin_notice: (p) =>
    `Geç çıkış: *${p.name}*, *${p.activityName}* (${p.whenLabel}) için ${p.time} saatinde YOKUM dedi, son çıkış ${p.deadline} idi. Kadro şimdi ${p.confirmed}/${p.maxPlayers}.`,
  wr_section_title: "Haftalık düzen",
  wr_section_lead: "Kadronun her hafta nasıl oluştuğu. Her ayar siz açana kadar kapalı kalır.",
  wr_rolling_label: "Kadro devam eder",
  wr_rolling_blurb: "Geçen maçta oynayan herkes, YOKUM demedikçe yine kadroda.",
  wr_rolling_info:
    "Bu açıkken, son maçta oynayan herkes bir sonraki maçta otomatik olarak kadroda olur; gelemeyecekse sadece YOKUM yazması yeterli. " +
    "Yedek listesindekiler, telefon numarası olmayan misafirler ve gruptan ayrılanlar aktarılmaz. " +
    "Kadro her maçtan sonraki sabah 08:00'de aktarılır, böylece gelmeyenleri o gece listeden çıkarabilirsiniz. " +
    "Maç bittiğinde listede olan herkes ödeme ve puanlama için oynamış sayılır.",
  wr_rolling_on: "Kadro devam eder: açık",
  wr_rolling_off: "Kadro devam eder: kapalı",
  wr_save_failed: "Ayar kaydedilemedi",
  carry_over_button: "Geçen kadroyu aktar",
  carry_over_hint: (p) => `${p.dateLabel} maçında oynayan herkesi bu maça ekler. Yine de YOKUM diyebilirler.`,
  carry_over_done: (p) => `${p.count} oyuncu aktarıldı`,
  carry_over_nothing: "Aktarılacak kimse yok",

  // ── Haftalık saatler (2026-09-30) ──
  dropout_reminder_post: (p) =>
    `⏰ *${p.activityName}*, ${p.whenLabel}: son çıkış saati *bugün ${p.time}*. Oynayamayacaksanız o saatten önce *YOKUM* yazın.\n\n${p.rosterBlock}`,
  deadline_summary_admin: (p) =>
    [
      `*${p.activityName}* (${p.whenLabel}) için son çıkış saati geçti. Kadro ${p.confirmed}/${p.maxPlayers}.`,
      `Bu hafta çıkanlar: ${p.out.length > 0 ? p.out.join(", ") : "kimse"}.`,
      ...(p.maybe.length > 0 ? [`Belki diyenler: ${p.maybe.join(", ")}.`] : []),
      `Yedek listesi: ${p.waiting.length > 0 ? p.waiting.join(", ") : "boş"}.`,
      ...(p.open > 0 ? [`${p.open} yer boş.`] : []),
    ].join("\n"),
  list_published_head: (p) => `📋 *${p.activityName}* listesi, *${p.dateLabel}*, ${p.venue}`,
  list_published_playing_header: (p) => `*Oynayanlar (${p.confirmed}/${p.maxPlayers}):*`,
  list_published_open: (p) => `${p.open} yer hâlâ boş.`,
  list_published_footer: "Artık gelemiyorsanız yerinize birinin alınabilmesi için hemen *YOKUM* yazın.",
  wd_dropout_label: "Son çıkış saati",
  wd_dropout_blurb: "Oyuncuların geç sayılmadan çıkabileceği son gün ve saat.",
  wd_dropout_info:
    "Oyuncuların geç sayılmadan çıkabileceği son saat. MatchTime 3 saat önce gruba hatırlatır, sonra yöneticilere kimin çıktığını ve kimin beklediğini yazar. " +
    "Son çıkış saatinden sonra YOKUM yine geçerlidir, yöneticilere geç olduğu bildirilir.",
  wd_publish_label: "Liste yayını",
  wd_publish_blurb: "MatchTime'ın son listeyi gruba gönderdiği zaman.",
  wd_publish_info:
    "MatchTime'ın son listeyi gruba gönderdiği zaman: kim oynuyor, kim yedekte. " +
    "Bu ve son çıkış saati ayarlıysa MatchTime, maç günü dışında her gün 17:00'de gönderdiği mesajı durdurur.",
  wd_day_label: "Gün",
  wd_time_label: "Saat",
  wd_not_set: "Ayarlanmadı",
  wd_weekday: (p) => ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"][p.dow] ?? "",
  wd_save: "Kaydet",
  wd_clear: "Temizle",
  wd_saved: "Haftalık saatler kaydedildi",
  wd_err_incomplete: "Hem gün hem saat seçin ya da ikisini de boş bırakın.",
  wd_err_bad_value: "Bu gün ya da saat geçerli değil.",
  wd_err_outside_hours: "08:00 ile 21:30 arasında bir saat seçin.",
  wd_err_order: "Son çıkış saati, listenin yayınlanmasından önce olmalı.",
  wd_err_after_kickoff: "Maç günü için maç saatinden önce bir saat seçin.",
  // ── Slice 2a: yönetici kanalı (2026-09-30) ──
  admin_group_linked: (p: { club: string }): string => `✅ *${p.club}* için yönetici grubu olarak bağlandı.`,
  admin_group_bad_code:
    "Bu kod artık geçerli değil. Sitede Ayarlar sayfasını açıp yeni kod için *Yönetici grubunu bağla* düğmesine basın.",
  admin_group_main_group: (p: { club: string }): string =>
    `Bu, *${p.club}* kulübünün ana grubu; yönetici grubu olamaz. Beni yöneticiler için ayrı bir gruba ekleyin.`,
  admin_group_removed_dm: (p: { club: string }): string =>
    `*${p.club}* yönetici grubundan çıkarıldım, bu yüzden yönetici mesajları artık size DM olarak gelecek. Ayarlar'dan yeniden bir grup bağlayabilirsiniz.`,
  settings_admin_channel_heading: "Yönetici mesajları",
  settings_admin_channel_info:
    "MatchTime'ın yalnızca yöneticilerin görmesi gereken mesajları nereye gönderdiği: seçim için yedek listesi, son çıkış özeti, geç çıkanlar, ödemeyenler ve kontrol edilecek yeni oyuncular. Tek kişi: seçtiğiniz kişiye DM. Yönetici WhatsApp grubu: yöneticilerin grubuna tek mesaj; yöneticiler orada numara, isim ya da etiketle oyuncu seçebilir. MatchTime o grupta başka hiçbir şeyi okumaz. Her yöneticiye DM: her yönetici kendi kopyasını alır.",
  settings_admin_channel_mode_one_person: "Tek kişi",
  settings_admin_channel_mode_admin_group: "Yönetici WhatsApp grubu",
  settings_admin_channel_mode_each_admin: "Her yöneticiye DM",
  settings_admin_channel_person_label: "Kim",
  settings_admin_channel_person_owner: (p: { name: string }): string => `${p.name} (kulüp sahibi)`,
  settings_admin_channel_link_button: "Yönetici grubunu bağla",
  settings_admin_channel_link_again: "Yeni kod",
  settings_admin_channel_link_info_title: "Yönetici grubunu bağla",
  settings_admin_channel_link_info:
    "Düğmeye basın, sonra MatchTime'ı yöneticilerin WhatsApp grubuna ekleyip burada görünen kodu o gruba gönderin. Kod bir kez çalışır ve 48 saat geçerlidir. MatchTime o grupta kulüp kurulumu başlatmaz.",
  settings_admin_channel_step_code: (p: { code: string }): string => `Bu sayfayı açık tutun. Kodunuz: ${p.code}`,
  settings_admin_channel_step_add: "MatchTime'ı yöneticilerin WhatsApp grubuna ekleyin.",
  settings_admin_channel_step_send: "O grupta şunu gönderin:",
  settings_admin_channel_command: (p: { code: string }): string => `@Match Time yönetici grubu ${p.code}`,
  settings_admin_channel_validity: "Kod bir kez çalışır ve 48 saat geçerlidir.",
  settings_admin_channel_linked: (p: { group: string }): string => `Bağlı: ${p.group}`,
  settings_admin_channel_unlink: "Bağlantıyı kaldır",
  settings_admin_channel_pending_note:
    "Bir grup bağlanana kadar yönetici mesajları şu an gittiği yere gitmeye devam eder.",
  settings_admin_channel_saved: "Kaydedildi",
  settings_admin_channel_unlinked: "Bağlantı kaldırıldı. Yönetici mesajları artık kulüp sahibine DM olarak gidiyor.",


  // ── Organizatör seçimi (2026-10-01) ──
  slot_opened_organiser: (p) =>
    `${p.kickoffLabel} maçında bir yer açıldı. *VARIM* yazın, yedek listesine ekleyeyim; kimin oynayacağını organizatörler seçer.`,
  pick_lead_drop: (p) =>
    `${joinList("tr", p.names.map((n) => `*${n}*`))}, *${p.activityName}* (${p.whenLabel}) maçından ${p.late ? "son çıkış saatinden sonra " : ""}çıktı.`,
  pick_lead_deadline: (p) => `*${p.activityName}* (${p.whenLabel}) için son çıkış saati geçti.`,
  pick_lead_open_place: (p) =>
    `*${p.activityName}* (${p.whenLabel}) için ${p.open} yer boş, kadro ${p.confirmed}/${p.maxPlayers}.`,
  pick_places_line: (p) => `${p.open} yer boş, kadro ${p.confirmed}/${p.maxPlayers}.`,
  pick_waiting_header: "Yedek listesi:",
  pick_list_row: (p) => `${p.n}. ${p.name} (${p.position ?? "mevki yok"}, ${p.rating ?? "yeni"})`,
  pick_instructions_dm:
    "Birini almak için numara ya da isim yazın, örneğin *2*, iki kişi için *2 3*. Boş bırakmak için *HİÇBİRİ* yazın.",
  pick_instructions_group:
    "Buraya numara, isim ya da @etiket yazın, örneğin *2*, iki kişi için *2 3*. *HİÇBİRİ* yazarsanız yer boş kalır.",
  pick_fallback_offer: (p) => `${p.when} saatine kadar kimse seçmezse yeri tüm yedek listesine açarım.`,
  pick_fallback_leave: (p) => `${p.when} saatine kadar kimse seçmezse yer boş kalır.`,
  pick_done_admin: (p) =>
    `✅ Tamam: *${p.name}*${p.replacedName ? `, *${p.replacedName}* yerine` : ""} kadroda${p.pickerName ? ` (${p.pickerName} seçti)` : ""}.`,
  pick_group_post: (p) =>
    p.replacedName
      ? `✅ *${p.name}*, ${p.team ? `*${p.team}* takımında ` : ""}*${p.replacedName}* yerine kadroda. Kadro *${p.confirmed}/${p.maxPlayers}*.`
      : `✅ *${p.name}* kadroda. Kadro *${p.confirmed}/${p.maxPlayers}*.`,
  pick_player_dm: (p) => `${p.dayTime}, ${p.venue}: kadrodasın ⚽ Gelemeyecek olursan *YOKUM* yazman yeterli.`,
  pick_not_on_list: (p) => `*${p.name}* yedek listesinde değil. Yine de kadroya alayım mı? *EVET* yazın.`,
  pick_already_in: (p) => `*${p.name}* zaten kadroda. Başka birini seçer misiniz?`,
  pick_already_filled: (p) => `Bu yer doldu: *${p.name}* kadroda (${p.pickerName} seçti).`,
  pick_already_filled_full: (p) => `Bu yer doldu: kadro dolu (${p.confirmed}/${p.maxPlayers}).`,
  pick_unresolved_tag: "Bunun kim olduğunu anlayamadım, adını yazar mısınız?",
  pick_ambiguous: (p) =>
    `${p.names.length === 2 ? "İki" : p.names.length === 3 ? "Üç" : String(p.names.length)} oyuncunun adı *${p.first}*: ${joinList("tr", p.names.map((n) => `*${n}*`))}. Hangisi? Tam adını yazın.`,
  pick_list_changed: "Son mesajımdan beri yedek listesi değişti. Güncel hali:",
  pick_not_understood:
    "Bunu yedek listesiyle eşleştiremedim. Listeden bir numara (örneğin *2*) ya da tam isim yazın. *HİÇBİRİ* yazarsanız yer boş kalır.",
  pick_only_k: (p) =>
    `Sadece ${p.k} yer boştu, bu yüzden ilk ${p.names.length === 1 ? "seçiminizi" : "seçimlerinizi"} aldım: ${joinList("tr", p.names.map((n) => `*${n}*`))}.`,
  pick_none_ack: "Tamam, yeri boş bırakıyorum. Maç sayfasından yine yedek listesinden seçebilirsiniz.",
  pick_fallback_offered: (p) =>
    `*${p.activityName}* için kimse seçim yapmadı, bu yüzden yeri yedek listesine açtım: ilk VARIM diyen alır.`,
  pick_fallback_offered_many: (p) =>
    p.stillOpen === 0
      ? `*${p.activityName}* için kimse seçim yapmadı, bu yüzden ${p.offered} boş yeri yedek listesine açtım: VARIM diyen bir yer alır.`
      : `*${p.activityName}* için kimse seçim yapmadı, bu yüzden yedek listesine ${p.offered} yer açtım (bekleyen her kişiye bir yer): ` +
        `VARIM diyen bir yer alır. ${p.stillOpen} yer daha boş.`,
  pick_fallback_left: (p) =>
    `*${p.activityName}* için kimse seçim yapmadı, yer boş kalıyor. Kadro ${p.confirmed}/${p.maxPlayers}.`,
  onb_weekly_routine_tip:
    "İpucu: kadroyu her hafta devam ettirmek, yerine geçecekleri yedek listesinden kendiniz seçmek ya da yönetici mesajlarını yöneticilerin grubunda almak için sitedeki Ayarlar sayfasını açın.",
  wr_pick_label: "Boşalan yeri kim doldurur",
  wr_pick_blurb: "İlk VARIM diyen, ya da organizatörler yedek listesinden seçer.",
  wr_pick_info:
    "İlk VARIM diyen: bir yer açılınca MatchTime yeri yedek listesine sunar, ilk VARIM diyen alır. " +
    "Organizatörler seçer: MatchTime hiçbir yeri kendisi doldurmaz. VARIM diyen herkes yedek listesine girer; yönetici mesajlarınız " +
    "(bkz. Yönetici mesajları) yedek listesini, mevkileri ve kulüp puanlarını içerir. Numara, isim ya da etiketle ilk yanıt veren yöneticinin seçtiği oyuncu kadroya girer.",
  wr_pick_first_come: "İlk VARIM diyen",
  wr_pick_organiser: "Organizatörler seçer",
  wr_fallback_label: "Zamanında kimse seçmezse",
  wr_fallback_info:
    "Hiçbir yönetici bir gün içinde, en geç maçtan 4 saat önce yanıt vermezse, MatchTime yeri ya tüm yedek listesine sunar " +
    "(ilk VARIM diyen alır) ya da boş bırakır.",
  wr_fallback_offer: "Yedek listesine sun",
  wr_fallback_leave: "Boş bırak",
  wr_pick_saved: "Kaydedildi",
  wl_title: (p) => `Yedek listesi (${p.count})`,
  wl_hint: "Kimin oynayacağını organizatörler seçer. Listeyi sıralayın ya da birini kadroya alın.",
  wl_bring_in: "Kadroya al",
  wl_move_up: "Yukarı taşı",
  wl_move_down: "Aşağı taşı",
  wl_no_position: "mevki yok",
  wl_new: "yeni",
  wl_brought_in: (p) => `${p.name} kadroda`,
  wl_full: "Kadro dolu",
  wl_failed: "Kaydedilemedi. Tekrar deneyin.",
  squad_complete_bench_invite_organiser:
    "🪑 *Yedek listesi açık.* *VARIM* yazın, yedek listesine ekleyeyim; kimin oynayacağını organizatörler seçer.",
  bench_intro_line_organiser:
    "🔁  *Yedek listesi:* *VARIM* yazın, yedek listesine ekleyeyim. Bir yer açılınca kimin oynayacağını organizatörler seçer.",
  full_squad_bench_invite_organiser: (p) =>
    `*${p.matchName}* kadrosu dolu, ${p.maxPlayers} kişilik kadroda ${p.confirmed} kişiyiz, ama yedek listesi açık. ` +
    `*VARIM* yazın, yedek listesine ekleyeyim; kimin oynayacağını organizatörler seçer. 🙏`,
  dm_recruit_invite_play_organiser: "Oynamak ister misin? *VARIM* yaz, yedek listesine ekleyeyim; kimin oynayacağını organizatörler seçer.",
  dm_recruit_chase_organiser: (p) =>
    `👋 ${p.firstName ? `${p.firstName}, ` : ""}*${p.activityName}* (${p.matchWhen}) için hâlâ ${p.count} oyuncu arıyoruz. ` +
    `Varsan *VARIM* yaz, yedek listesine ekleyeyim (kimin oynayacağını organizatörler seçer); yoksan *YOKUM* yaz, bir daha sormam 🙏`,
  dm_self_ack_waiting_organiser: (p) =>
    `📋 *${p.matchName}* (${p.matchWhen}) için seni yedek listesine yazdım. Kimin oynayacağını organizatörler seçer; seçilirsen sana haber veririm 🙏`,

  // ── UNP1 (2026-10-01): yöneticilere ödemeyenler listesi ──
  unpaid_list_admin: (p) =>
    `💷 *${p.activityName}* (${p.whenLabel}) için ödemeyenler: ${p.names.join(", ")}. ${p.n} kişiden ${p.paid} kişi ödedi.`,
  // ── UNP2 (2026-10-01): haftalık düzenli kulüplerde gruba tek başına ödeme hatırlatması ──
  unpaid_group_reminder: (p) =>
    p.unpaid === 1
      ? `💳 ${p.dayName} günkü maç için 1 ödeme hâlâ bekliyor. Ödediyseniz ödeme anketinde takımınızı işaretleyin 🙏`
      : `💳 ${p.dayName} günkü maç için *${p.unpaid}* ödeme hâlâ bekliyor. Ödediyseniz ödeme anketinde takımınızı işaretlemeniz yeterli 🙏`,
  // ── Günlük yapay zekâ sınırı, kulüp yöneticilerine günde bir kez (2026-10-01) ──
  ai_cap_admin_notice: (p) =>
    `⚠️ MatchTime, *${p.club}* için bugünkü yapay zekâ kullanım hakkını doldurdu. ` +
    `Gece yarısına kadar (İngiltere saati) grupta düz bir "varım" ya da "yokum" mesajını yine kaydederim, ` +
    `ama soruları ve yapay zekâ gerektiren diğer istekleri yanıtlamam. Planlı paylaşımlar her zamanki gibi devam eder. ` +
    `Kullanım hakkı gece yarısı sıfırlanır. ${p.more}`,
  ai_cap_more_contact: "Daha fazlası mı gerekiyor? hello@matchtime.ai adresine yazın, kulübünüzün günlük hakkını artıralım.",
  ai_cap_more_buy: (p) => `Daha fazlası mı gerekiyor? Ek yapay zekâ hakkını buradan satın alabilirsiniz: ${p.url}`,
  club_fee_tip: (p) =>
    `💷 *Kulüp ücreti ipucu:* MatchTime yalnızca oynadığınız maçlar için ücret alır, ayda en fazla ${p.price}. ` +
    `Oynanan her maç kulübe en fazla ${p.perGame} tutar; bu da ${p.players} oyuncunuz için *oyuncu başına maç başına yaklaşık ${p.share}* eder. ` +
    (p.mode === "split"
      ? `Saha ücretini bölüştürürken her oyuncunun payına yaklaşık ${p.share} ekleyin.`
      : p.mode === "known"
        ? `Maç ücretiniz kişi başı ${p.fee}, *${p.feePlus}* alırsanız karşılanır.`
        : `Maç ücreti kişi başı ${p.fee} ise *${p.feePlus}* alın, kulüp ücreti karşılanmış olur.`) +
    ` Oynamadığınız haftalar için hiçbir şey ödemezsiniz.`,
  sj_dm_approved_tip: (p) =>
    `💷 *Kulüp ücreti ipucu:* sonrasında MatchTime yalnızca oynadığınız maçlar için ücret alır, grup için ayda en fazla ${p.price}; ücreti maç ücretlerini toplayan kişi kartla öder. ` +
    `Oynanan her maç en fazla ${p.perGame} tutar, ${p.players} oyuncuyla *oyuncu başına maç başına yaklaşık ${p.share}* eder` +
    (p.split
      ? `; saha ücretini bölüştürürken her oyuncunun payına ekleyebilirsiniz.`
      : `; ${p.fee} olan bir maç için *${p.feePlus}* alabilirsiniz.`),
  billing_page_title: "Kulüp ücreti",
  billing_state_trial: (p) =>
    `Ücretsiz ay ${p.date} tarihine kadar. Sonrasında yalnızca oynadığınız maçlar için ödersiniz, tüm grup için ayda en fazla ${p.price}.`,
  billing_state_grace: (p) => `Ücretsiz ay sona erdi. Kart eklenmezse MatchTime ${p.date} tarihinde durur.`,
  billing_state_subscribed: (p) => `Yalnızca oynanan maçlar için ücret alınır, ayda en fazla ${p.price}. Sonraki ödeme ${p.date}.`,
  billing_state_card_saved: (p) => `Kart kaydedildi. ${p.date} tarihine kadar hiçbir ücret alınmaz.`,
  billing_state_nothing_until: (p) => `${p.date} tarihine kadar hiçbir ücret alınmaz.`,
  billing_state_subscribed_ending: (p) => `Ödeme ${p.date} tarihinde, bu ay oynanan maçlar için ücret alındıktan sonra sona eriyor.`,
  billing_state_card: (p) => `${p.brand} kart, son dört hanesi ${p.last4}.`,
  billing_state_paid_with_other: (p) => `Siz kendi kartınızı ekleyene kadar ${p.holder} kişisinin kartıyla ödeniyor. ${p.rest}`,
  billing_state_past_due: (p) =>
    (p.amount
      ? p.months > 1
        ? `${p.months} ayın maçlarına ait ${p.amount} ödemesi alınamadı. `
        : `${p.from} ile ${p.to} arası için ${p.amount} ödemesi alınamadı. `
      : `Son ödeme alınamadı. `) +
    (p.retrying ? `Önümüzdeki birkaç gün içinde tekrar denenecek. ` : `MatchTime'ın çalışmaya devam etmesi için kartı güncelleyip ödeyin. `) +
    `Ödeme alınamazsa MatchTime ${p.date} tarihinde durur.`,
  billing_state_paused: "MatchTime duraklatıldı. Tüm veriler saklanıyor. Yeniden açmak için kart ekleyin.",
  billing_state_paused_unpaid: (p) =>
    `MatchTime duraklatıldı çünkü ` +
    (p.amount ? (p.months > 1 ? `${p.months} ayın maçlarına ait ${p.amount} ödenmedi. ` : `${p.amount} ödenmedi. `) : `bir ödeme yapılmadı. `) +
    `Tüm veriler saklanıyor. Yeniden açmak için kartı güncelleyip ödeyin.`,
  billing_state_paused_stopped:
    "Ödeme durdurulduğu için MatchTime duraklatıldı. Tüm veriler saklanıyor. Yeniden açmak için Ödemeye devam et düğmesine basın.",
  billing_month_box: (p) =>
    p.scheduled === 0
      ? `Bu ay (${p.from} ile ${p.to} arası): şu ana kadar maç yok, bu yüzden ödenecek bir şey yok.`
      : p.upcoming > 0
        ? `Bu ay (${p.from} ile ${p.to} arası): şu ana kadar ${p.scheduled} maçın ${p.played} tanesi oynandı, ${p.upcoming} maç daha var. ` +
          `Şu ana kadar ${p.amount}; kalan tüm maçlar oynanırsa ${p.max}. Ödeme ${p.date} tarihinde alınır.`
        : `Bu ay (${p.from} ile ${p.to} arası): ${p.scheduled} maçın ${p.played} tanesi oynandı. Bu ${p.amount} eder, ödeme ${p.date} tarihinde alınır.`,
  billing_nothing: "ücret yok",
  billing_past_months: "Geçmiş aylar",
  billing_see_games: "Maçları gör",
  billing_receipt: "Makbuz",
  billing_month_line: (p) => {
    const head = `${p.from} ile ${p.to} arası: `;
    const g = p.games ? `${p.games}, ` : "";
    switch (p.status) {
      case "paid":
        return `${head}${g}${p.amount} ödendi`;
      case "invoiced":
        return `${head}${g}${p.amount} alınıyor`;
      case "failed":
        return `${head}${g}${p.amount} henüz ödenmedi`;
      case "void":
        return `${head}${g}${p.amount} iptal edildi, ödenecek bir şey yok`;
      case "no-games":
        return `${head}maç yok, ödenecek bir şey yok`;
      case "below-minimum":
        return `${head}${g}30p altında, bu yüzden ödenecek bir şey yok`;
      case "no-card":
        return `${head}${g}ücret alınmadı (kayıtlı kart yok)`;
      case "waived":
        return `${head}ödenecek bir şey yok`;
      default:
        return `${head}hesaplanıyor`;
    }
  },
  billing_month_games: (p) => `${p.scheduled} maçın ${p.played} tanesi`,
  billing_game_outcome: (p) =>
    ({
      played: "oynandı",
      cancelled: "iptal edildi",
      "nobody-in": "kimse VARIM demedi",
      paused: "MatchTime duraklatılmıştı",
      "no-match": "maç yok",
      "not-completed": "oynanmadı",
      upcoming: "henüz oynanmadı",
    })[p.outcome] ?? "oynanmadı",
  billing_state_paused_removed:
    "MatchTime kulübün WhatsApp grubundan çıkarıldığı için duraklatıldı. Tüm veriler saklanıyor. Devam etmek için MatchTime'ı gruba geri ekleyin.",
  billing_card_holder_note: (p) =>
    `${p.contact} kendi kartını ekleyene kadar ${p.club} için MatchTime ücreti sizin kartınızdan ödenmeye devam ediyor.`,
  billing_who_collector: (p) => `Kartla ${p.name} ilgileniyor.`,
  billing_who_owner: "Para toplayan kişi seçilmedi: kart kulüp sahibinden istenir.",
  billing_who_none: "Telefon numarası kayıtlı bir para toplayan kişi ya da kulüp sahibi yok, bu yüzden henüz kimseden kart istenemiyor.",
  billing_card_on_file: (p) => (p.yes ? "Kayıtlı kart: var." : "Kayıtlı kart: yok."),
  billing_btn_add_card: "Kart ekle",
  billing_btn_change_card: "Kartı değiştir",
  billing_btn_use_mine: "Bunun yerine kendi kartımı kullan",
  billing_btn_update_card: "Kartı güncelle ve öde",
  billing_btn_remove_mine: "Kartımı kaldır",
  billing_btn_stop_paying: "Ödemeyi durdur",
  billing_btn_keep_paying: "Ödemeye devam et",
  billing_stop_confirm_title: "MatchTime için ödemeyi durdurmak istiyor musunuz?",
  billing_stop_confirm_month: (p) =>
    `Ödeme ${p.date} tarihinde, bu ay oynanan maçlar için ücret alındıktan sonra sona erer. Sonra MatchTime, biri yeniden ödemeye başlayana kadar grupta durur.`,
  billing_stop_confirm_free: (p) =>
    `Kartınız şimdi kaldırılır ve hiçbir ücret alınmaz. Ücretsiz ay ${p.date} tarihine kadar devam eder; sonrasında MatchTime'ın çalışmaya devam etmesi için kart gerekir.`,
  billing_btn_stop_confirm_yes: "Evet, ödemeyi durdur",
  billing_btn_stop_confirm_no: "Geri dön",
  billing_exempt: (p) => `${p.club} için kulüp ücreti yok. MatchTime bu kulüp için ücretsiz.`,
  billing_open: "Ödeme sayfasını aç",
  billing_choose_collector: "Para toplayan kişiyi seçin",
  billing_banner_grace: (p) =>
    `Ücretsiz ay sona erdi. MatchTime'ın çalışmaya devam etmesi için ${p.date} tarihinden önce kart ekleyin.`,
  billing_banner_past_due: (p) =>
    (p.amount
      ? p.months > 1
        ? `${p.months} ayın kulüp ücreti olan ${p.amount} alınamadı. `
        : `${p.from} ile ${p.to} arası kulüp ücreti (${p.amount}) alınamadı. `
      : `Son kulüp ücreti ödemesi alınamadı. `) + `Ödeme alınamazsa MatchTime ${p.date} tarihinde durur.`,
  billing_banner_paused: "MatchTime bu kulüp için duraklatıldı. Yeniden açmak için kart ekleyin.",
  billing_banner_paused_unpaid: "Bir kulüp ücreti ödemesi yapılmadığı için MatchTime bu kulüp için duraklatıldı. Ödeme sayfasından ödenebilir.",
  billing_banner_paused_stopped:
    "Ödeme durdurulduğu için MatchTime bu kulüp için duraklatıldı. Ödeme sayfasındaki Ödemeye devam et düğmesi yeniden açar.",
  billing_banner_paused_removed: "MatchTime bu kulübün WhatsApp grubundan çıkarıldığı için duraklatıldı. Devam etmek için gruba geri ekleyin.",
  billing_banner_link: "Ödeme sayfası",
  billing_notice_done: "Teşekkürler, kartınız kaydediliyor. Bir dakika içinde bu sayfada görünür.",
  billing_notice_replaced: "Teşekkürler, kartınız ekleniyor. Bir dakika içinde bu sayfada görünür.",
  billing_notice_removed: "Kartınız kaldırıldı ve bu kulüp için bir daha ücret alınmayacak.",
  billing_notice_not_set_up: "Kartla ödeme henüz açık değil. Lütfen daha sonra tekrar deneyin.",
  billing_notice_already: "Bu kulüp için zaten bir kart ödeme yapıyor.",
  billing_notice_re_add: "MatchTime kulübün WhatsApp grubunda değil. Önce gruba geri ekleyin.",
  billing_notice_failed: "Bir sorun oluştu. Lütfen tekrar deneyin.",
  billing_notice_stopped:
    "Tamam. Ödeme bu ay bitince sona eriyor: bu ay oynanan maçlar için her zamanki gibi ücretlendirilir, sonra başka bir şey alınmaz. MatchTime o zamana kadar çalışmaya devam ediyor.",
  billing_notice_stopped_free: "Tamam. Kartınız kaldırıldı ve hiçbir ücret alınmadı. Ücretsiz ay bitene kadar devam ediyor.",
  billing_notice_kept: "Tamam. MatchTime çalışmaya devam ediyor ve her ay yalnızca oynanan maçlar için ücret alınır.",
  billing_notice_past_due: "Gecikmiş bir ödeme var. Önce kartı güncelleyip ödeyin.",
  billing_dm_card_added: (p) =>
    `Teşekkürler${p.name ? ` ${p.name}` : ""}, kartınız kaydedildi. ` +
    (p.resumed
      ? `MatchTime ${p.club} için yeniden açıldı ve birkaç dakika içinde grupta kaldığı yerden devam ediyor. Duraklatılmışken VARIM yazanlar lütfen tekrar yazsın. `
      : `MatchTime ${p.club} WhatsApp grubunda çalışmaya devam ediyor. `) +
    `Şu an hiçbir ücret alınmadı: her ayın sonunda oynanan maçları sayıyorum ve yalnızca onlar için, en fazla ${p.price} alıyorum. ` +
    `${p.first ? "İlk" : "Sonraki"} ödeme ${p.date} tarihinde. Her ödemeyi ve makbuzunu ödeme sayfanızda görebilir, kartınızı orada değiştirebilir ya da durdurabilirsiniz: ${p.link}`,
  billing_dm_card_replaced: (p) =>
    `Merhaba${p.name ? ` ${p.name}` : ""}, ${p.club} için MatchTime ücretini artık ${p.newName} ödüyor. Kartınız kaldırıldı ve bunun için bir daha ücret alınmayacak.`,
  billing_dm_billed_again_card: (p) =>
    `Merhaba${p.name ? ` ${p.name}` : ""}, ${p.club} yeniden MatchTime planında ve son dört hanesi ${p.last4} olan kartınızla ödeniyor: yalnızca oynanan maçlar, ayda en fazla ${p.price}. ` +
    `İlk ödeme ${p.date} tarihinde alınır. Ödemeyi durdurmak ya da kartı değiştirmek için: ${p.link}`,
  billing_dm_card_dropped: (p) =>
    `Merhaba${p.name ? ` ${p.name}` : ""}, kartınız artık ${p.club} için MatchTime ücretinde kullanılmıyor ve kaldırıldı. Bunun için bir daha ücret alınmayacak.`,
  billing_dm_resumed: (p) =>
    `MatchTime ${p.club} için yeniden açıldı. Birkaç dakika içinde grupta kaldığım yerden devam ediyorum. Ben duraklatılmışken VARIM yazanlar lütfen tekrar yazsın.`,
  billing_dm_plan_billed: (p) =>
    `Merhaba${p.name ? ` ${p.name}` : ""}, ${p.club} yeniden MatchTime planında: yalnızca oynanan maçlar, ayda en fazla ${p.price}. ` +
    `Ücretsiz ay daha önce kullanıldı, bu yüzden MatchTime grupta ${p.date} tarihine kadar çalışmaya devam edecek. ` +
    `Çalışmaya devam etmesi için o tarihe kadar kart ekleyin: ${p.link}`,
  billing_dm_trial_21: (p) =>
    `Merhaba${p.name ? ` ${p.name}` : ""}, ${p.club} için MatchTime'daki ücretsiz ay ${p.date} tarihinde bitiyor. ` +
    (p.collector ? `Maç ücretlerini siz topladığınız için kartı sizden istiyorum. ` : "") +
    `MatchTime'ın ${p.club} WhatsApp grubunda çalışmaya devam etmesi için buradan kart ekleyin: ${p.link}\n` +
    `Sonrasında yalnızca oynadığınız maçlar için ödersiniz, tüm grup için ayda en fazla ${p.price}, her ay bittikten sonra alınır. ` +
    `Kartı eklediğinizde hiçbir ücret alınmaz; ilk ödeme ${p.firstCharge} tarihinde.`,
  billing_dm_trial_28: (p) =>
    `Merhaba${p.name ? ` ${p.name}` : ""}, kısa bir hatırlatma: ${p.club} için ücretsiz ay ${p.date} tarihinde bitiyor. ` +
    `MatchTime'ın ${p.club} WhatsApp grubunda çalışmaya devam etmesi için kart ekleyin: ${p.link}\n` +
    `Yalnızca oynadığınız maçlar için ödersiniz, ayda en fazla ${p.price}; kartı eklediğinizde hiçbir ücret alınmaz.`,
  billing_dm_trial_ended: (p) =>
    `Merhaba${p.name ? ` ${p.name}` : ""}, ${p.club} için ücretsiz ay sona erdi. ` +
    `MatchTime ${p.club} WhatsApp grubunda bir hafta daha, ${p.date} tarihine kadar çalışmaya devam edecek. ` +
    `O tarihe kadar istediğiniz zaman kart ekleyebilirsiniz: ${p.link}\n` +
    `Yalnızca oynadığınız maçlar için ödersiniz, ayda en fazla ${p.price}, her ay bittikten sonra alınır.`,
  billing_dm_set_collector:
    "İpucu: maç ücretlerini başka biri topluyorsa, Ayarlar'dan onu para toplayan kişi yapın, kartla o ilgilensin.",
  billing_dm_paused: (p) =>
    (p.kind === "payment-failed"
      ? p.months > 1
        ? `Merhaba${p.name ? ` ${p.name}` : ""}, ${p.club} için ${p.months} ayın maçlarına ait toplam ${p.amount} ödemesini alamadık, bu yüzden MatchTime şu an duraklatıldı. `
        : `Merhaba${p.name ? ` ${p.name}` : ""}, ${p.club} için ${p.amount} ödemesini alamadık, bu yüzden MatchTime şu an duraklatıldı. `
      : p.kind === "cancelled"
        ? `Merhaba${p.name ? ` ${p.name}` : ""}, ${p.club} için MatchTime ödemesini durdurdunuz, bu yüzden şu an duraklatıldı. Son ay, her zamanki gibi yalnızca oynanan maçlar için ücretlendirildi. `
        : `Merhaba${p.name ? ` ${p.name}` : ""}, MatchTime ${p.club} için şu an duraklatıldı. `) +
    `Hâlâ ${p.club} WhatsApp grubundayım ama orada mesaj atmayacağım ya da yanıt vermeyeceğim, gruba da hiçbir şey söylenmedi. ` +
    `Oyuncular, maçlar ve istatistikler saklanıyor. ` +
    (p.kind === "payment-failed"
      ? `MatchTime'ı yeniden açmak için buradan kartı güncelleyip ödeyin, birkaç dakika içinde tekrar başlar: ${p.link}`
      : p.kind === "cancelled"
        ? `MatchTime'ı yeniden açmak için buradan Ödemeye devam et düğmesine basın, birkaç dakika içinde tekrar başlar: ${p.link}`
        : `MatchTime'ı yeniden açmak için buradan kart ekleyin, birkaç dakika içinde tekrar başlar: ${p.link}`),
  billing_dm_payment_failed: (p) =>
    `Merhaba${p.name ? ` ${p.name}` : ""}, ${p.club} için ${p.from} ile ${p.to} arasındaki maçların ${p.amount} ödemesi alınamadı. ` +
    (p.retrying
      ? `Önümüzdeki birkaç gün içinde tekrar denenecek, bu sürede MatchTime çalışmaya devam ediyor. ` +
        (p.ownCard ? `Kartı güncellemek için: ${p.link}` : `Bunun yerine kendi kartınızı eklemek için: ${p.link}`)
      : `MatchTime şimdilik çalışmaya devam ediyor. ` +
        (p.ownCard ? `Şimdi ödemek için buradan kartı güncelleyip ödeyin: ${p.link}` : `Şimdi kendi kartınızla ödemek için: ${p.link}`)),
  billing_dm_payment_action: (p) =>
    `Merhaba${p.name ? ` ${p.name}` : ""}, ${p.club} için ${p.from} ile ${p.to} arasındaki maçların ${p.amount} ödemesinin geçebilmesi için bankanız onayınızı istiyor. ` +
    `Lütfen buradan onaylayın: ${p.link}\nBu sürede MatchTime çalışmaya devam ediyor.`,
  billing_dm_payment_action_other: (p) =>
    `Merhaba${p.name ? ` ${p.name}` : ""}, ${p.club} için kayıtlı kartla ${p.from} ile ${p.to} arasındaki maçların ${p.amount} ödemesinin geçebilmesi için banka onayı gerekiyor. ` +
    `Buradan onaylayıp ödeyebilirsiniz: ${p.link}\nBunun yerine kendi kartınızı ekleyin: ${p.billingLink}\nBu sürede MatchTime çalışmaya devam ediyor.`,
  billing_dm_payer_changed_card: (p) =>
    `Merhaba${p.name ? ` ${p.name}` : ""}, artık ${p.club} için para toplayan kişi sizsiniz, bu yüzden ${p.club} WhatsApp grubu için MatchTime kulüp ücretiyle siz ilgileniyorsunuz: yalnızca oynanan maçlar, ayda en fazla ${p.price}. ` +
    `Siz kendi kartınızı ekleyene kadar ${p.oldName} kişisinin kartından ödenmeye devam ediyor, size uygun bir zamanda ekleyebilirsiniz: ${p.link}`,
  billing_dm_payer_changed_no_card: (p) =>
    `Merhaba${p.name ? ` ${p.name}` : ""}, artık ${p.club} için para toplayan kişi sizsiniz, bu yüzden ${p.club} WhatsApp grubu için MatchTime kulüp ücretiyle siz ilgileniyorsunuz: yalnızca oynanan maçlar, ayda en fazla ${p.price}. ` +
    `Çalışmaya devam etmesi için ${p.date} tarihinden önce kart ekleyin: ${p.link}`,
  billing_dm_payer_changed_paused: (p) =>
    `Merhaba${p.name ? ` ${p.name}` : ""}, artık ${p.club} için para toplayan kişi sizsiniz, bu yüzden ${p.club} WhatsApp grubu için MatchTime kulüp ücretiyle siz ilgileniyorsunuz: yalnızca oynanan maçlar, ayda en fazla ${p.price}. ` +
    `Yeniden açmak için kart ekleyin: ${p.link}`,
  billing_dm_payer_changed_removed: (p) =>
    `Merhaba${p.name ? ` ${p.name}` : ""}, artık ${p.club} için para toplayan kişi sizsiniz, bu yüzden ${p.club} WhatsApp grubu için MatchTime kulüp ücretiyle siz ilgileniyorsunuz: yalnızca oynanan maçlar, ayda en fazla ${p.price}. ` +
    `MatchTime ${p.club} WhatsApp grubundan çıkarıldığı için duraklatıldı. Yeniden açmak için MatchTime'ı gruba geri ekleyin. Kulüp ücreti sayfası: ${p.link}`,
  billing_admin_no_collector: (p) =>
    `Henüz para toplayan kişi seçilmedi. Ayarlar'dan birini seçin: kulüp ücreti için kartla o ilgilenecek ve bu ipucunu o da alacak.${p.link ? ` ${p.link}` : ""}`,
  billing_dm_month_charged: (p) =>
    `Merhaba${p.name ? ` ${p.name}` : ""}, ${p.club} ${p.from} ile ${p.to} arasında` +
    (p.played === p.scheduled && p.scheduled > 1 ? `ki ${p.scheduled} maçın hepsini oynadı` : ` ${p.scheduled} maçın ${p.played} tanesini oynadı`) +
    `, bu yüzden ` +
    (p.last4 ? `${p.last4} ile biten ` : "") +
    (p.ownCard ? "kartınızdan" : "kayıtlı karttan") +
    ` ${p.amount} çekildi (KDV dahil; tam ay ${p.price}). ` +
    (p.ownCard
      ? `Makbuzu Stripe size e-postayla gönderdi. Ayrıntılar: ${p.link}`
      : `Ayın maçlarını ve ücretini ödeme sayfanızda görebilirsiniz: ${p.link}`),
  billing_dm_month_free: (p) =>
    `Merhaba${p.name ? ` ${p.name}` : ""}, ${p.club} ${p.from} ile ${p.to} arasında hiç maç oynamadı, bu yüzden o ay için ödenecek bir şey yok. ` +
    `MatchTime yalnızca oynadığınız maçlar için ücret alır.`,
  billing_dm_keep_paying: (p) =>
    `Merhaba${p.name ? ` ${p.name}` : ""}, ` +
    (p.restarted
      ? `MatchTime ${p.club} için yeniden açıldı ve birkaç dakika içinde grupta kaldığı yerden devam ediyor. Duraklatılmışken VARIM yazanlar lütfen tekrar yazsın. Her ay`
      : `tamam: MatchTime ${p.club} WhatsApp grubunda çalışmaya devam ediyor ve ödeme sürüyor. Önceden olduğu gibi her ay`) +
    ` yalnızca oynanan maçlar için, en fazla ${p.price}, ay bittikten sonraki sabah ücret alınır; sonraki ödeme ${p.date} tarihinde. ` +
    `Kartınızı değiştirmek ya da durdurmak için: ${p.link}`,

  // ── Organizatör bilgi düğmeleri (F1, 2026-10-05) ─────────────────────
  // Organizatör sayfalarındaki ⓘ açılır pencereleri. Her biri bir çift:
  // `info_<anahtar>_title` ve `info_<anahtar>_body`. Tire yok, sade dil,
  // yalnızca kodun gerçekten yaptığı şeyler.

  info_open: (p) => `${p.title} nedir?`,
  info_close: "Kapat",

  fs_conf_high: "Emin",
  fs_conf_med: "Büyük ihtimalle",
  fs_conf_low: "Tahmin: lütfen kontrol edin",
  fs_evidence_none: "Sohbette bu oyuncuyla ilgili bir şey yok, bu yüzden nötr bir başlangıç noktası belirledim.",

  info_fs_players_title: "Önerilen oyuncular",
  info_fs_players_body:
    "MatchTime'ın grubunuzun sohbet geçmişinde oynadığını gördüğü herkes, tahmini bir mevki ve başlangıç puanıyla. Kontrol edin, yanlış olanı değiştirin, sonra \"Apply & finish setup\" düğmesine basın. Uygulayana kadar hiçbir şey kaydedilmez.",
  info_fs_confidence_title: "MatchTime ne kadar emin",
  info_fs_confidence_body:
    "Sohbetin MatchTime'a bu oyuncunun mevkii ve başlangıç puanı hakkında ne kadar bilgi verdiği. Emin: sohbette çok ipucu var. Büyük ihtimalle: biraz ipucu var. Tahmin: lütfen kontrol edin: sohbette çok az şey var ya da hiç yok, bu bir başlangıç tahmini.\n\n" +
    "Bu, oyuncu hakkında bir yargı değildir. Tahmin, mevkii ve puanı sizin kontrol etmeniz gerektiği anlamına gelir.",
  info_fs_position_title: "Mevki",
  info_fs_position_body:
    "Bu oyuncunun genelde oynadığı yer. MatchTime takımları kurarken her iki takıma dengeli bir karışım vermek için mevkileri kullanır. Emin değilseniz \"None\" seçin; sonra Oyuncular sayfasından ayarlayabilirsiniz.",
  info_fs_seed_title: "Başlangıç puanı",
  info_fs_seed_body:
    "Bu oyuncu için bu kulüpteki başlangıç puanınız, 1 ile 10 arası. Oyuncular maçlardan sonra birbirine puan vermeye başlayana kadar takımlar buna göre dengelenir; sonra gerçek puanlar yavaş yavaş yerini alır. Oyuncular bunu hiç görmez.",
  info_fs_evidence_title: "MatchTime bunu neden tahmin etti",
  info_fs_evidence_body:
    "Tahminin dayandığı sohbet mesajı ya da özeti, böylece siz de değerlendirebilirsiniz. Bunu yalnızca yöneticiler görür.",
  info_fs_phones_title: "Eksik telefon numaraları",
  info_fs_phones_body:
    "MatchTime'ın telefon numarasını bilmediği grup üyeleri. Puanlama bağlantısı ve hatırlatma gibi özel mesajları alabilmeleri için ülke koduyla başlayan bir numara ekleyin (örneğin +90). İstediğinizi boş bırakabilirsiniz.",
  info_fs_schedule_title: "Program ve format",
  info_fs_schedule_body:
    "MatchTime'ın sohbetten okuduğu haftalık maçınız. Uyguladığınızda haftalık maçınızın günü, başlama saati ve sahası ayarlanır. Takım başına oyuncu sayısı bir sonraki maçınızın büyüklüğünü belirler.",

  info_dash_players_title: "Oyuncular",
  info_dash_players_body: "MatchTime'da kulübünüzdeki herkes. Ayrılan oyuncular sayılmaz. Görmek ve düzenlemek için dokunun.",
  info_dash_activities_title: "Etkinlikler",
  info_dash_activities_body:
    "Düzenli haftalık maçlarınız, örneğin Salı 7'ye 7. MatchTime her aktif etkinliğin bir sonraki maçını kendisi ekler. Yönetmek için dokunun.",
  info_dash_upcoming_title: "Yaklaşan",
  info_dash_upcoming_body: "Henüz oynanmamış maçlar, takımları kurulmuş olanlar da dahil.",
  info_dash_completed_title: "Tamamlanan",
  info_dash_completed_body:
    "MatchTime kulübünüzü yönetmeye başladığından beri oynanan maçlar. Önceden içe aktarılan eski maçlar sayılmaz.",
  info_dash_ratings_title: "Puanlama durumu",
  info_dash_ratings_body:
    "Son maçınızdan sonra kimlerin takım arkadaşlarına puan verdiği. MatchTime oynayan her oyuncuya özel bir puanlama bağlantısı gönderir; yedek listesindekiler sayılmaz. Bekleyenler henüz puan vermedi.",
  info_dash_connect_title: "MatchTime'ı bağlamak",
  info_dash_connect_body:
    "MatchTime'ı WhatsApp grubunuza eklemenin adımları: kodu telefonunuzdan gönderin, MatchTime'ı gruba ekleyin, sonra kulübünüzü kontrol ederiz, genelde bir gün içinde. Kulübünüz onaylanana kadar MatchTime grupta sessiz kalır.",

  info_pl_list_title: "Oyuncular",
  info_pl_list_body:
    "Kulübünüzdeki herkes. Değiştirmek için bir isme ya da telefon numarasına dokunun. Ayrılan oyuncuları görmek için \"Include former members\" kutusunu işaretleyin; geçmişleri saklanır.",
  info_pl_add_title: "Oyuncu ekle",
  info_pl_add_body:
    "Grupta henüz yazmamış birini ekleyin. Telefon numarasıyla MatchTime ona özel mesaj atabilir ve onu grupta tanıyabilir. Numara MatchTime'da zaten varsa, iki kez eklenmez, o oyuncu kullanılır.",
  info_pl_seed_title: "Başlangıç puanı",
  info_pl_seed_body:
    "Bir oyuncu için bu kulüpteki başlangıç puanınız, 1 ile 10 arası. Oyuncular maçlardan sonra birbirine puan verene kadar takımlar buna göre dengelenir; sonra gerçek puanlar yavaş yavaş yerini alır. Oyuncular bunu hiç görmez ve aynı kişinin başka bir kulüpteki başlangıç puanı ayrıdır.",
  info_pl_club_rating_title: "Kulüp puanı",
  info_pl_club_rating_body:
    "Bu kulübün oyuncularının maçlardan sonra verdiği puanların ortalaması, oyuncunun kendi sayfasında gördüğü sayının aynısı. Biri puan verene kadar Henüz puan yok yazar.",
  info_pl_aliases_title: "Takma adlar",
  info_pl_aliases_body:
    "MatchTime'ın grupta bu oyuncu olarak tanıması gereken diğer adlar, örneğin bir lakap ya da WhatsApp adı. Biri \"Mo varım\" yazdığında işe yarar. Kaldırmak için takma ada dokunun.",
  info_pl_merge_title: "Birleştir",
  info_pl_merge_body:
    "Bir kişinin iki satırı olduğunda \"Merge\" düğmesini kullanın, örneğin biri adıyla, biri telefonla eklenmişse. Kalacak satırı seçin: katılımları, puanları ve mesajları ona taşınır, diğer satır silinir. Bu geri alınamaz.",
  info_pl_duplicates_title: "Olası çift kayıtlar",
  info_pl_duplicates_body:
    "Biri adıyla eklendi, örneğin başka bir oyuncu onun geleceğini yazdığında, ve telefon numarası olan bir üyenin adı da ona benziyor. Aynı kişiyse, yalnızca adı olan satırı telefonlu üyeye katmak için Birleştir'e dokunun.",
  info_pl_new_title: "Yeni oyuncular",
  info_pl_new_body:
    "MatchTime, grupta yazan kişileri kendisi ekler. Telefonlarını, mevkilerini ve başlangıç puanlarını kontrol edin, sonra \"Confirm\" düğmesine dokunun. Oyuncu değilse \"Remove\" düğmesine dokunun; geçmişleri saklanır.",
  info_pl_role_title: "Rol",
  info_pl_role_body: "Yöneticiler bu yönetim sayfalarını açabilir ve kulübü yönetebilir. Oyuncular yalnızca kendi sayfalarını görür.",

  info_st_general_title: "Genel",
  info_st_general_body: "Kulübünüzün MatchTime'daki adı ve web adresi. Buradan değiştirilemez.",
  info_st_team_names_title: "Takım adları",
  info_st_team_names_body:
    "Takım listelerinde, skor mesajlarında ve maç sayfalarında iki tarafın adı. Varsayılan adı kullanmak için kutuyu boş bırakın.",
  info_st_language_title: "Bot dili",
  info_st_language_body:
    "MatchTime'ın grubunuzda ve oyuncularınıza özel mesajlarda yazdığı dil. Henüz çevrilmemiş mesajlar İngilizce gönderilir.",
  info_st_invite_title: "Davet bağlantısı",
  info_st_invite_body:
    "Birinin MatchTime web sitesinde kulübünüze katılabilmesi için bu bağlantıyı gönderin. WhatsApp grubunuzda yazanlar kendiliğinden eklenir, bu yüzden çoğu oyuncunun buna ihtiyacı yoktur.",
  info_st_features_title: "Bot özellikleri",
  info_st_features_body:
    "Her düğme MatchTime'ın bir bölümünü kulübünüz için açar ya da kapatır, böylece yalnızca istediğinizi kullanırsınız. Değişikliklerin gruba ulaşması birkaç dakika sürebilir.",
  info_st_weekly_title: "Haftalık düzen",
  info_st_weekly_body:
    "Grubunuzun haftasının nasıl işlediği: kadronun devam edip etmediği, açılan yeri kimin doldurduğu, haftalık son saatler ve MatchTime'ın yöneticilere yönelik mesajları nereye gönderdiği.",
  info_st_billing_title: "Kulüp ücreti",
  info_st_billing_body:
    "MatchTime'ın kulübünüze maliyeti. Her ay yalnızca oynanan maçlar için ücret alınır, aylık üst sınırı asla geçmez, ödeme ay bittikten sonraki sabah alınır.\n\n" +
    "Kartla fatura sayfasında para toplayan kişi ilgilenir; para toplayan kişi yoksa kart kulüp sahibinden istenir. Diğer yöneticiler görebilir ama kartı değiştiremez.",
  info_st_collector_title: "Para toplayan kişi",
  info_st_collector_body:
    "Maç ücretlerini toplayan üye. Her maçtan sonra MatchTime ona her oyuncunun ne kadar ödeyeceğini sorar, kendisine doğrudan yapılan ödemeleri o onaylar ve kartla yapılan ödemeler onun banka hesabına gider. MatchTime'ın kulüp ücreti için kartla da o ilgilenir. Yalnızca telefon numarası olan üyeler listelenir.",
  info_st_bank_title: "Para toplayan kişinin bankası",
  info_st_bank_body:
    "Kartla ve Pay by Bank ile yapılan ödemeler Stripe üzerinden para toplayan kişinin kendi banka hesabına gider. Bir kez bağlayın: Stripe birkaç kimlik bilgisi ve banka hesabını ister.\n\n" +
    "\"Manage bank / payouts\" ödemeleri görmek için Stripe'ı açar. \"Start over\" bu Stripe hesabının MatchTime'daki bağlantısını kaldırır, böylece başka bir hesap bağlayabilirsiniz; daha önce alınmış ödemeler etkilenmez.",
  info_st_whatsapp_title: "WhatsApp botu",
  info_st_whatsapp_body:
    "MatchTime'ın WhatsApp grubunuz için açık olup olmadığı ve hangi gruba bağlı olduğu. Bunu MatchTime yönetir, buradan değiştirilemez.",

  info_feat_attendance_title: "Katılım takibi",
  info_feat_attendance_body:
    "MatchTime grupta VARIM ve YOKUM mesajlarını okur, bir sonraki maçın kadro listesini tutar, güncellemeler paylaşır ve kadro eksikse oyuncu arar. Grubunuz yalnızca puanlama ya da Man of the Match istiyorsa kapatın.",
  info_feat_bench_title: "Yedek listesi",
  info_feat_bench_body:
    "Kadro dolunca fazladan VARIM diyenler yedek listesine girer. Biri çıkarsa yer yedek listesine geçer: onlara sunulur ya da Haftalık düzen altında bunu seçtiyseniz bir organizatör seçer.",
  info_feat_teams_title: "Takım kurma",
  info_feat_teams_body:
    "MatchTime'dan grupta takımları kurmasını isteyin ya da bir maçın takım sayfasında \"Generate teams\" düğmesine basın. Kadroyu kulüp puanlarına ve mevkilere göre iki dengeli takıma böler ve maçtan sonra skoru sorar.",
  info_feat_mom_title: "Man of the Match (maçın adamı)",
  info_feat_mom_body: "Her maçtan sonra MatchTime grupta Man of the Match oylaması başlatır ve kazananı duyurur.",
  info_feat_rating_title: "Oyuncu puanları",
  info_feat_rating_body:
    "Her maçtan sonra MatchTime, oynayan ve telefon numarası olan her oyuncuya diğerlerine puan vermesi için özel bir bağlantı gönderir. Bu puanlar her oyuncunun kulüp puanını ekler ve takımları dengelemeye yardım eder.",
  info_feat_reminders_title: "Kişisel hatırlatmalar",
  info_feat_reminders_body:
    "Oyuncular MatchTime'ı etiketleyip hatırlatma isteyebilir, örneğin \"pazartesi bana hatırlat\", ve MatchTime o zaman onlara özel mesaj gönderir.",
  info_feat_stats_title: "İstatistik cevapları",
  info_feat_stats_body:
    "Oyuncular MatchTime'ı etiketleyip grubun geçmişi hakkında soru sorabilir, örneğin en çok kim oynadı ya da geçmiş Man of the Match kazananları, ve MatchTime grupta cevaplar.",
  info_feat_pay_tracking_title: "Ödeme takibi",
  info_feat_pay_tracking_body: "MatchTime her maç için kimin ödediğini takip eder ve ödemeyenlere hatırlatır.",
  info_feat_pay_collect_title: "Maç ücretlerini topla",
  info_feat_pay_collect_body:
    "Her maçtan sonra MatchTime para toplayan kişiye her oyuncunun ne kadar ödeyeceğini sorar, sonra her oyuncuya ödeme için özel bir bağlantı gönderir. Kartla yapılan ödemeler para toplayan kişinin bankasına gider; banka aşağıdan bağlanmalıdır.",
  info_feat_pay_bank_title: "Pay by Bank (bankadan ödeme)",
  info_feat_pay_bank_body: "Oyuncular doğrudan banka uygulamalarından öder. En ucuz ödeme yoludur.",
  info_feat_pay_card_title: "Kart ve Apple Pay",
  info_feat_pay_card_body: "Oyuncular kart, Apple Pay ya da Google Pay ile öder. Stripe her ödemeden küçük bir ücret alır.",
  info_feat_pay_direct_title: "Organizatöre doğrudan ödeme",
  info_feat_pay_direct_body:
    "Oyuncular para toplayan kişiye nakit ya da havaleyle ödediklerini söyleyebilir. Para toplayan kişi bunu onaylar. Ücret alınmaz.",
  info_feat_badges_title: "Rozet duyuruları",
  info_feat_badges_body:
    "Her maçtan iki gün sonra MatchTime oyuncuların kazandığı yeni rozetleri grupta paylaşır. Kapatırsanız grupta rozetlerle ilgili hiçbir şey paylaşılmaz.",

  info_act_page_title: "Etkinlikler",
  info_act_page_body:
    "Etkinlik, düzenli haftalık maçlarınızdan biridir: günü, başlama saati, sahası ve formatı. MatchTime her gece her aktif etkinliğin bir sonraki maçını kendisi ekler.",
  info_act_generate_title: "Maç ekle",
  info_act_generate_body:
    "Gece çalışmasını beklemeden bu etkinliğin bir sonraki maçını hemen ekler. Aynı güne ikinci bir maç eklemez.",
  info_act_active_title: "Aktif ya da pasif",
  info_act_active_body:
    "Aktif etkinliklerin maçları kendiliğinden eklenir. Yeni maçları durdurmak için \"Deactivate\" düğmesine basın; önceden eklenmiş maçlar ve geçmişleri kalır.",
  info_act_deadline_title: "Kayıtların kapanması",
  info_act_deadline_body:
    "MatchTime'ın maçtan kaç saat önce oyuncu aramayı bıraktığı. Oyuncular maç başlayana kadar VARIM ya da YOKUM diyebilir.",

  info_bb_page_title: "Toplu rezervasyonlar",
  info_bb_page_body:
    "Toplu rezervasyon sahayı kiralama şeklinize uyar: peşin ödenmiş bir dizi haftalık maç, örneğin 10 salı. Bu maçların hepsini tek seferde ekler. MatchTime yine yalnızca bir sonraki maç hakkında paylaşım yapar.\n\n" +
    "\"Cancel remaining\" bu rezervasyonun gelecekteki maçlarını grupta paylaşım yapmadan iptal eder. \"Restore cancelled\" onları yine sessizce geri getirir. \"Delete block\" boş gelecek maçları kaldırır; oynanmış maçlar ve verisi olan her şey saklanır.",
  info_bulk_page_title: "Toplu iptal ya da geri alma",
  info_bulk_page_body:
    "Tatiller ve hatalar için. Tarihleri seçin, listeyi kontrol edin, sonra onaylayın. Duyuru kutusunu işaretlemezseniz iptal grupta hiçbir şey paylaşmaz. Geri alma her zaman sessizdir.",

  info_cancel_title: "Maçı iptal et",
  info_cancel_body:
    "Bir maç oynanmayacaksa bunu kullanın. MatchTime grupta tek bir iptal mesajı paylaşır ve bu maç için başka hiçbir şey göndermez: hatırlatma, puanlama ya da Man of the Match olmaz. İptal edilen bir maç \"Bulk cancel / restore\" sayfasından geri getirilebilir.",
  info_switch_title: "Formatı değiştir",
  info_switch_body:
    "Format bir haftalığına değiştiğinde bunu kullanın, örneğin 7'ye 7'den 5'e 5'e. Maç diğer etkinliğe geçer, yeni sayının üstündekiler yedek listesine girer ve MatchTime yeni kadroyu grupta paylaşır. Yalnızca aynı spordan, farklı büyüklükteki etkinlikler sunulur.",
  info_teams_page_title: "Takım yönetimi",
  info_teams_page_body:
    "\"Generate teams\" onaylı oyuncuları kulüp puanlarına ve mevkilere göre iki dengeli takıma böler. \"Regenerate\" yeni takımlar yapar. Yer değiştirmek için iki oyuncuya dokunun ya da düğmelerle bir oyuncuyu diğer takıma geçirin veya takımdan çıkarın. \"Swap colours\" takımları korur, adlarını değiştirir.",
  info_teams_unassigned_title: "Takımı olmayanlar",
  info_teams_unassigned_body: "Henüz bir takımda olmayan onaylı oyuncular, örneğin son anda gelen bir yedek. Her birini bir takıma koyun.",
  info_teams_bench_title: "Yedek listesi",
  info_teams_bench_body: "Yer bekleyen oyuncular. Birini yukarı almak onu bu maç için onaylar ve seçtiğiniz takıma koyar.",
  info_teams_publish_title: "Takımları yayınla",
  info_teams_publish_body: "Bu takımları maç için kesinleşmiş olarak işaretler. Sonrasında da oyuncuların yerini değiştirebilirsiniz.",
  info_teams_score_title: "Maç skoru",
  info_teams_score_body:
    "Maç bitince son skoru girin. Kaydetmek maçı oynanmış olarak işaretler ve takımlardaki her oyuncunun Elo'sunu günceller; Elo, bu kulüpte sonuçlara dayalı bir güç puanıdır.",

  info_clubs_waiting_title: "Sizi bekleyenler",
  info_clubs_waiting_body:
    "MatchTime'ı gruplarına ekleyip kararınızı bekleyen kulüpler. Siz karar verene kadar MatchTime orada sessiz kalır. \"Approve\" onu açar, grupta merhaba der ve organizatöre mesaj atar. \"Reject\" gruptan çıkar ve organizatöre tek bir nazik mesaj gönderir.",
  info_clubs_live_title: "Aktif kulüpler",
  info_clubs_live_body:
    "Kendileri katılan ve sizin onayladığınız kulüpler. Yeni kulüplerin ilk günlerinde günlük sınırları daha sıkıdır. \"Turn off\" MatchTime'ın gruptan çıkıp sessiz kalmasını sağlar; kimseye mesaj gönderilmez.",
  info_clubs_fee_title: "Kulüp ücreti",
  info_clubs_fee_body:
    "Kulübün planı ve fatura durumu, bu ay ve geçen ay, kimin ödediği ve son 30 gündeki yapay zeka maliyeti. \"Plan\" aylık üst sınırı belirler. \"Start free month\" bir kulübün alabileceği tek ücretsiz ayı başlatır.",
  info_clubs_unsolicited_title: "MatchTime'ı kimsenin istemediği gruplar",
  info_clubs_unsolicited_body:
    "Birinin MatchTime'ı kodsuz eklediği gruplar. MatchTime orada sessiz kalır ve 48 saat sonra kendisi çıkar; hemen çıkmak için \"Leave\" düğmesine basın. Gruptaki kimseye mesaj gönderilmez.",
  info_clubs_rejected_title: "Reddedilenler",
  info_clubs_rejected_body: "Reddettiğiniz kulüpler, en yenisi önce. MatchTime gruplarından çıktı.",
  info_clubs_suspended_title: "Kapatılanlar",
  info_clubs_suspended_body: "Kapattığınız aktif kulüpler, en yenisi önce. MatchTime gruplarından çıktı ve orada sessiz.",
  info_clubs_limits_title: "Bugünkü site sınırları",
  info_clubs_limits_body:
    "Tüm sitenin bugün kullandığı kayıt kodu, yeni kulüp ve grup bağlantısı sayısı, günlük sınırlarla birlikte. Londra saatiyle gece yarısı sıfırlanır.",

  info_health_status_title: "Şu anki durum",
  info_health_status_body:
    "MatchTime'ın açık olduğu her kulüp için bir kart. \"All good\": açık bir sorun yok. \"Worth a look\": açık bir uyarı var. \"Needs attention\": ciddi bir sorun açık. Son satır, o kulübün botunun en son ne zaman haber verdiğini gösterir.",
  info_health_alerts_title: "Son uyarılar",
  info_health_alerts_body:
    "Son 30 günde işaretlenen her şey. \"Still happening\": son kontrolde yine görüldü. \"Cleared\": durdu. \"One-off\": süren bir kontrol değil, tek bir olay. Buradaki hiçbir şey telefonunuza ya da e-postanıza gönderilmez.",

  info_bill_page_title: "Kulüp ücreti nasıl işler",
  info_bill_page_body:
    "MatchTime kulübünüzden ayda bir kez, yönettiği maçlar için ücret alır, aylık üst sınırı asla geçmez. İptal edilen maçlar ve kimsenin oynamadığı haftalar ücretsizdir. Ödeme ay bittikten sonraki sabah alınır, KDV dahildir.",
  info_bill_card_title: "Kartla kim ilgilenir",
  info_bill_card_body:
    "Kartla para toplayan kişi ilgilenir, para toplayan kişi yoksa kulüp sahibi. Kart kaydetmek para almaz. Yöneticiler bu sayfayı görebilir ama kartı değiştiremez.",
  info_bill_past_title: "Geçmiş aylar",
  info_bill_past_body: "Biten her ay ve alınan ücret. \"Maçları gör\" ayın maçlarını ve her birinin sayılıp sayılmadığını listeler.",
  sj_dm_setup_intro: (p) =>
    `${p.group ? `"${p.group}" grubundaki` : "Grubunuzdaki"} son mesajları okuyup grubun nasıl işlediğine baktım ve MatchTime'ı aynı şekilde kurdum.`,
  sj_dm_setup_intro_nothing: (p) =>
    `${p.group ? `"${p.group}" grubundaki` : "Grubunuzdaki"} son mesajları okuyup grubun nasıl işlediğine baktım. Hiçbir ayarı değiştirmedim, ama göz atmaya değer birkaç şey var.`,
  setup_applied_line: (p) =>
    p.key === "rollingSquad"
      ? `*Kadro devam ediyor:* geçen maçta oynayan herkes, YOKUM demedikçe bir sonrakinde de oynar.`
      : p.key === "organiserPicks"
        ? `*Boşalan yeri organizatörler seçiyor:* MatchTime önce size sorar; zamanında kimse seçmezse yeri yedek listesine sunar.`
        : p.key === "dropOutDeadline"
          ? `*Son çıkış saati:* ${p.day} ${p.time}. MatchTime bundan önce gruba hatırlatır.`
          : p.key === "listPublish"
            ? `*Son liste:* ${p.day} ${p.time} saatinde gruba gönderilir.`
            : `*Ödeme takibi açık:* MatchTime kimin ödediğini takip eder ve ödemeyenlere nazikçe hatırlatır.`,
  sj_dm_setup_from: (p) => `Şu tür mesajlardan: "${p.quote}"`,
  sj_dm_setup_undo: (p) => `Geri almak ya da değiştirmek için: ${p.url}`,
  sj_dm_setup_check_head: "Kontrol etmeye değer (burada hiçbir şeyi değiştirmedim):",
  setup_suggestion_line: (p) =>
    p.key === "organiserPicks"
      ? `Görünüşe göre boşalan yeri kimin dolduracağını organizatörler seçiyor. Öyleyse "Organizatörler seçer" ayarını açın.`
      : p.key === "weeklyGameDay"
      ? `Sohbette maçlar ${p.detected} günü geçiyor; haftalık maçınız ise ${p.current} günü.`
      : p.key === "weeklyGameTime"
        ? `Sohbete göre maç saati ${p.detected}; haftalık maçınız ise ${p.current} olarak ayarlı.`
        : p.key === "venue"
          ? `Sohbette saha olarak ${p.detected} geçiyor; haftalık maçınızda ise ${p.current} yazıyor.`
          : p.key === "format"
            ? `Sohbette takım başına ${p.detected} kişiden söz ediliyor; haftalık maçınız ise takım başına ${p.current} kişi.`
            : `Sohbet çoğunlukla ${p.detected}; MatchTime bu grupta ${p.current} konuşuyor.`,
  sj_dm_setup_check_link: (p) => `Buradan değiştirebilirsiniz: ${p.url}`,
  sj_dm_setup_pick_link: (p) => `Buradan açabilirsiniz: ${p.url}`,
  setup_monthly_pattern: (p) => {
    const parts = [
      p.prepay ? "düzenli oyuncular aya yazılıp ayın ücretini peşin ödüyor" : "düzenli oyuncular aya yazılıyor",
      ...(p.payg ? ["diğerleri boşlukları maç başı ödeyerek dolduruyor"] : []),
      ...(p.credits ? ["düzenli bir oyuncunun kaçırdığı maç alacak olarak kalıyor"] : []),
    ];
    return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} ve ${parts[parts.length - 1]}` : parts[0];
  },
  sj_dm_setup_monthly: (p) =>
    `📋 Ayrıca aylık bir liste olduğunu fark ettim: ${p.pattern}. MatchTime'ın böyle gruplar için aylık kadro modu var. Ben açmadım: isterseniz Ayarlar'da, Aylık kadro bölümünden açabilirsiniz. Siz açana kadar bunun için hiçbir şey değişmedi` +
    (p.heldPaymentTracking ? ` ve ödeme takibini kapalı bıraktım, çünkü maç maç çalışıyor` : ``) +
    `.`,
  sj_dm_setup_outro: (p) => `Hepsi, her birinin dayandığı sohbet mesajlarıyla birlikte ayarlar sayfanızda: ${p.url}`,
  setup_monthly_label: "Aylık liste",
  setup_lang_name: (p) => (p.key === "tr" ? "Türkçe" : "İngilizce"),
  settings_learned_title: "Grup sohbetinizden kurulanlar",
  settings_learned_lead:
    "MatchTime, gruba katıldığında WhatsApp'ın paylaştığı mesajları okudu ve bunları grubunuza uygun şekilde kurdu. Her birini tek dokunuşla geri alabilirsiniz.",
  settings_learned_undo: "Geri al",
  settings_learned_undone: "Geri alındı",
  settings_learned_changed_since: "Sonradan değiştirildi",
  settings_learned_undo_failed: "Geri alınamadı",
  settings_learned_from: "Şu tür mesajlardan",
  settings_learned_check_head: "Kontrol etmeye değer (hiçbir şey değişmedi)",
  settings_learned_open_setting: "Ayara git",
  settings_learned_noted_head: "Fark edildi, karar sizde",
  // ── Aylık kadro (2026-10-05, dilim 2) ────────────────────────────
  // /admin/settings "Aylık kadro" bölümü (msq_) ve /admin/months (mth_).
  msq_section_title: "Aylık kadro",
  msq_section_lead:
    "Daimi oyuncuların aya yazılıp tüm ay için ödediği, boş yerleri maç başı ödeyen (PAYG) oyuncuların doldurduğu gruplar için. Siz açana kadar kapalı kalır.",
  msq_mode_label: "Kadronuz nasıl oluşuyor",
  msq_mode_blurb: "Haftalık, MatchTime'ın bugünkü çalışma şeklidir. Aylık, tüm ay süren bir liste içindir.",
  msq_mode_weekly: "Haftalık (VARIM diyenler)",
  msq_mode_monthly: "Aylık (daimi oyuncular ay için öder)",
  msq_rolling_note: "Kadronuz aylıkken \"Kadro devam eder\" kapalıdır: onun yerini ayın daimi oyuncuları alır.",
  msq_months_link: "Aylar sayfasını aç",
  msq_payg_label: "Maç başı ücret, PAYG (£)",
  msq_payg_blurb: "Maç başı ödeyen bir oyuncunun tek maç için ödediği tutar. Sabit bir ücretiniz yoksa boş bırakın.",
  msq_list_note:
    "MatchTime her ayın listesini ilk maçtan birkaç gün önce grubunuza gönderir (aşağıdaki \"Liste açılışı\" ayarı); bu ayın daimi oyuncuları listede hazır gelir.",
  msq_opens_label: "Liste açılışı",
  msq_opens_blurb: "Gelecek ayın listesi, ayın ilk maçından kaç gün önce açılsın.",
  msq_opens_unit: "gün, ilk maçtan önce",
  msq_credit_label: "Krediler",
  msq_credit_blurb: "Ödemesini yapmış bir daimi oyuncu bir maçı kaçırırsa gelecek ay bir maç düşülsün mü?",
  msq_credit_any: "Ödemiş daimi oyuncunun kaçırdığı her maç",
  msq_credit_filled: "Yalnızca yeri doldurulduğunda",
  msq_credit_none: "Kredi yok",
  msq_instructions_label: "Ödeme talimatı",
  msq_instructions_blurb: "Nasıl ödeneceğini anlatan kendi cümleleriniz. Oyunculara borçlarıyla birlikte gösterilir. İsteğe bağlı.",
  msq_instructions_placeholder: "Banka bilgileri grup açıklamasında.",
  msq_save: "Kaydet",
  msq_saved: "Kaydedildi",
  msq_switched_monthly: "Aylık kadro açık. \"Kadro devam eder\" kapalı.",
  msq_switched_weekly: "Haftalık kadroya dönüldü",
  msq_err_price: "8 veya 7.50 gibi bir ücret girin, en fazla £100.",
  msq_err_days: "1 ile 28 arasında tam bir gün sayısı girin.",
  msq_err_long: "Ödeme talimatı 500 karakteri geçmesin.",

  mth_nav: "Aylar",
  mth_page_title: "Aylar",
  mth_page_lead: "Aylık kadronuzun listesi: daimi oyuncular, maç başı ödeyenler, kimin ödediği ve krediler.",
  mth_no_fixture: "Kulübünüzün henüz etkin bir maçı yok. Önce Activities sayfasından bir tane ekleyin.",
  mth_no_players: "Kulübünüzde henüz oyuncu yok. Players sayfanıza eklendiklerinde burada görünürler.",
  mth_fixture_games: (p: { games: number; played: number }): string =>
    `Bu ayki maç sayısı: ${p.games}. Oynanan: ${p.played}.`,
  mth_empty_title: (p: { month: string }): string => `${p.month} henüz başlatılmadı`,
  mth_empty_body:
    "Ayın ortasında bile şimdi başlatabilirsiniz. Güncel listenizi yapıştırın ya da oyuncuları işaretleyin, kimin ödediğini belirtin ve aya getirdikleri kredileri ekleyin. Oynanmış maçlar, listedeki daimi oyuncular için oynanmış sayılır.",
  mth_paste_label: "Güncel listenizi yapıştırın",
  mth_paste_hint:
    "Bu ayın listesini grubunuzdan kopyalayıp buraya yapıştırın. MatchTime oyuncuları, ödeme işaretleri ve PAYG ile birlikte sizin için işaretler. Ayı başlatana kadar hiçbir şey kaydedilmez.",
  mth_paste_button: "Listeyi oku",
  mth_paste_read: (p: { count: number }): string =>
    `Listenizden okunan oyuncu sayısı: ${p.count}. Ayı başlatmadan önce aşağıda kontrol edin.`,
  mth_paste_unmatched: (p: { names: string }): string =>
    `Bir oyuncuyla eşleşmeyenler: ${p.names}. Onları aşağıda kendiniz işaretleyin ya da önce Players sayfanıza ekleyin.`,
  mth_paste_month: "Bu listenin başlığında başka bir ay yazıyor. Bu ayın listesi olduğunu kontrol edin.",
  mth_paste_not_list: "Bu bir listeye benzemiyor. Grubunuzdaki numaralı listenin tamamını yapıştırın.",
  mth_games_label: "Bu ayki maç sayısı",
  mth_played_label: "Oynanan maç",
  mth_share_label: "Daimi oyuncunun maç başı payı (£)",
  mth_share_hint: "İsteğe bağlı. Girerseniz MatchTime her daimi oyuncunun ay için borcunu hesaplar.",
  mth_col_in: "Listede",
  mth_col_slot: "Sıra",
  mth_col_player: "Oyuncu",
  mth_col_type: "Tür",
  mth_col_paid: "Ödedi mi?",
  mth_col_amount: "Ödenen tutar (£)",
  mth_col_credits: "Aya getirilen kredi",
  mth_col_games: "Maç",
  mth_col_credits_used: "Kullanılan kredi",
  mth_col_due: "Borç",
  mth_kind_regular: "Daimi",
  mth_kind_payg: "Maç başı (PAYG)",
  mth_paid_none: "Ödemedi",
  mth_paid_claimed: "Ödedim diyor",
  mth_paid_confirmed: "Ödedi, onaylandı",
  mth_due_unknown: "Belirlenmedi",
  mth_selected_count: (p: { regulars: number; payg: number }): string => `Listede: ${p.regulars} daimi, ${p.payg} maç başı`,
  mth_nothing_posts: "Ayı başlatmak grubunuza hiçbir mesaj göndermez.",
  mth_start_button: (p: { month: string }): string => `${p.month} ayını başlat`,
  mth_started: (p: { month: string }): string => `${p.month} başlatıldı`,
  mth_status: (p: { status: string }): string =>
    p.status === "open" ? "Kayıt açık" : p.status === "priced" ? "Ücret belirlendi" : p.status === "closed" ? "Kapandı" : "Sürüyor",
  mth_started_mid: (p: { played: number }): string =>
    `Ay ortasında başlatıldı. O sırada oynanmış maç sayısı: ${p.played}.`,
  mth_share_line: (p: { amount: string }): string => `Maç başı pay: ${p.amount}`,
  mth_no_share: "Maç başı pay henüz girilmedi, bu yüzden borçlar hesaplanmadı.",
  mth_paid_amount: (p: { state: string; amount: string }): string => `${p.state}: ${p.amount}`,
  mth_start_error: (p: { key: string }): string =>
    p.key === "no-players"
      ? "En az bir oyuncu işaretleyin."
      : p.key === "bad-games"
        ? "Maç sayılarını kontrol edin. Oynanan maç, bu ayki maç sayısından fazla olamaz."
        : p.key === "bad-share"
          ? "Payı 7.50 gibi bir tutar olarak girin."
          : p.key === "bad-amount"
            ? "Ödenen tutarları kontrol edin. 30 veya 22.50 gibi tutarlar girin."
            : p.key === "bad-credits"
              ? "Aya getirilen kredi, bu ayki maç sayısından fazla olamaz."
              : p.key === "already-started"
                ? "Bu ay zaten başlatılmış. Görmek için sayfayı yenileyin."
                : p.key === "not-monthly"
                  ? "Kulübünüz için aylık kadro kapalı."
                  : "Ay başlatılamadı. Lütfen tekrar deneyin.",

  info_st_monthly_title: "Aylık kadro",
  info_st_monthly_body:
    "Daimi oyuncuların aya yazılıp tüm ay için ödediği, diğer oyuncuların boş yerleri maç başı ödeyerek doldurduğu gruplar için. Siz açana kadar kapalıdır ve o zamana kadar grubunuz için hiçbir şey değişmez.\n\n" +
    "Açıkken yönetici sayfalarınızda Aylar sayfası görünür. Ayın listesini orada tutarsınız: kim daimi, kim ödedi ve krediler.",
  info_msq_mode_title: "Kadronuz nasıl oluşuyor",
  info_msq_mode_body:
    "Haftalık: her maçın kadrosu o hafta VARIM diyenlerden oluşur. Siz değiştirmedikçe MatchTime böyle çalışır.\n\n" +
    "Aylık: daimi oyuncular ayın her maçında kadrodadır ve ay için bir kez öder. Maç başı ödeyenler boş yerleri alır ve maç başına öder. Bu açıkken \"Kadro devam eder\" kapalıdır, çünkü onun yerini ayın daimi oyuncuları alır.",
  info_msq_payg_title: "Maç başı ücret (PAYG)",
  info_msq_payg_body:
    "Maç başı ödeyen bir oyuncunun tek maç için ödediği tutar, örneğin £8. Daimi oyuncular bunu ödemez. Onlar ay için kendi paylarını öder.",
  info_msq_opens_title: "Liste açılışı",
  info_msq_opens_body:
    "Gelecek ayın listesinin, ayın ilk maçından kaç gün önce açılacağı. Bu ayın daimi oyuncuları listede hazır gelir. Çoğu grup için 7 gün uygundur.",
  info_msq_credit_title: "Krediler",
  info_msq_credit_body:
    "Bir kredi, gelecek ayın ödemesinden bir maç düşülmesi demektir. Ödemesini yapmış bir daimi oyuncunun ne zaman kredi kazanacağını seçin: kaçırdığı her maçta, yalnızca yerini başkası aldığında ya da hiç. Krediler pound ile değil, maç sayısıyla tutulur.",
  info_msq_instructions_title: "Ödeme talimatı",
  info_msq_instructions_body:
    "Nasıl ödeneceğini anlatan kendi cümleleriniz. Oyunculara borçlarının yanında gösterilir. Örneğin: banka bilgileri grup açıklamasında.\n\n" +
    "MatchTime asla banka hesap numarası istemez. Bu yalnızca sizin buraya yazdığınız metindir.",
  info_mth_page_title: "Aylar",
  info_mth_page_body:
    "Her haftalık maç için ayda bir liste. Daimi oyuncular ayın her maçında kadrodadır ve bir kez öder. Maç başı ödeyenler boş yerleri alır ve maç başına öder.\n\n" +
    "Bu sayfayı yalnızca Ayarlar'da Aylık kadro açıkken görürsünüz.",
  info_mth_start_title: "Ayı ortasından başlatmak",
  info_mth_start_body:
    "Ayın 1'ini beklemeniz gerekmez. Bu ayın listesinde kim varsa işaretleyin, kimin ne kadar ödediğini belirtin ve aya getirdikleri kredileri ekleyin.\n\n" +
    "Bu ay oynanmış maçlar, işaretlediğiniz daimi oyuncular için oynanmış sayılır, yani o maçlar için kimse kredi almaz. Ayı başlatmak grubunuza hiçbir mesaj göndermez.",
  info_mth_paste_title: "Listenizi yapıştırmak",
  info_mth_paste_body:
    "Listeyi grubunuzun yazdığı gibi yapıştırın: numaralı isimler, (ödedi) ya da (Paid £22.50), (PAYG) ve \"ödedi gelemiyor\" bölümü. Ödeme işareti \"Ödedim diyor\" olarak okunur, asla onaylanmış sayılmaz.\n\n" +
    "İsimler oyuncularınızla eşleştirilir. Kimseye uymayan ya da birden fazla oyuncuya uyan bir isim, sizin işaretlemeniz için bırakılır.",
  info_mth_paid_title: "Ödedi mi?",
  info_mth_paid_body:
    "Ödemedi: hiçbir şey kaydedilmez. Ödedim diyor: oyuncu ödediğini söylüyor ama kimse kontrol etmedi. Ödedi, onaylandı: paranın geldiğini biliyorsunuz.\n\n" +
    "Onaylandı seçeneğini yalnızca gördüğünüz ödemeler için kullanın.",
  info_mth_credits_title: "Aya getirilen kredi",
  info_mth_credits_body:
    "Bir daimi oyuncunun bu aya getirdiği kredi, maç sayısı olarak. Örneğin geçen ay parasını ödeyip kaçırdığı bir maç için. Bir kredi bir maç düşer. Maç başı £7.50 ise bir kredi, 4 maçlık ayı £30 yerine £22.50 yapar.",

  // ── Aylık kadro, 5. dilim (2026-10-06): haftalık akış ────────────
  // Başlık ve üç bölüm adı `monthly-list.ts` okuyucusunun tanıdığı
  // sözcüklerle yazılır: üye listeyi kopyalayıp geri yapıştırabilsin.
  mwk_list_header: (p) => `📋 ${p.month} listesi: ${p.when}`,
  mwk_list_paid: "(ödedi)",
  mwk_list_cant_play_paid: "Ödedi gelemiyor",
  mwk_list_cant_play: "Gelemeyenler",
  mwk_list_reserves: "Yedekler",
  mwk_list_open: (p) => `${p.open} yer boş${p.price ? `, maç başı ${p.price} (PAYG)` : ""}: almak için *VARIM* yazın.`,
  mwk_list_open_organiser: (p) => `${p.open} yer boş. Yedek listesine girmek için *VARIM* yazın, kimin oynayacağını organizatörler seçer.`,
  mwk_pool_group: (p) => `🎟 *${p.when}* maçında ${p.open} yer açık${p.price ? `, maç başı ${p.price} (PAYG)` : ""}. İlk *VARIM* yazan alır.`,
  mwk_dm_sender_not_matched: (p) =>
    `📋 Yapıştırdığın listedeki ${p.names.join(", ")} adını bir oyuncuyla eşleştiremedim, bu yüzden kimseyi eklemedim. ` +
    `Oynamak için grupta kendin *VARIM* yaz ya da bir organizatörden eklemesini iste.`,
  mwk_dm_sender_not_list: (p) =>
    `📋 Gönderdiğin listeyi ${p.month} kadro listesi olarak okuyamadım, bu yüzden bir şey değiştirmedim. ` +
    `Kadro listesiyse başlık satırıyla yapıştır ("${p.month} listesi").`,
  mwk_pool_dm: (p) =>
    `👋 ${p.firstName ? `${p.firstName}, ` : ""}*${p.activityName}* için bir yer açıldı: ${p.when}${p.price ? `, maç başı ${p.price}` : ""}.\n\n` +
    `İster misin? *VARIM* yaz. İlk yazan oynar. Bu sefer olmuyorsa cevap yazmana gerek yok.`,
  mwk_dm_moved_out_paid: (p) =>
    `📋 ${p.actor} seni *${p.activityName}* (${p.when}) için "Ödedi gelemiyor" bölümüne aldı.\n\nYanlış mı? *VARIM* yaz, seni geri alayım.`,
  mwk_dm_moved_out: (p) =>
    `📋 ${p.actor} seni *${p.activityName}* (${p.when}) listesinden çıkardı.\n\nYanlış mı? *VARIM* yaz, seni geri alayım.`,
  mwk_dm_added: (p) =>
    `📋 ${p.actor} seni *${p.activityName}* (${p.when}) listesine ekledi.\n\nYanlış mı? *YOKUM* yaz, seni çıkarayım.`,
  mwk_admin_paste_ignored: (p) =>
    `📋 ${p.actor}, ${p.when} maçı için listenin eski bir kopyasını yapıştırdı. ${p.names.join(", ")} için bir şey değiştirmedim: ` +
    `yapıştırılan liste, çıkan bir oyuncuyu geri getiremez ya da satırını boşaltarak başkasını çıkaramaz. ` +
    `Değişiklik doğruysa oyuncu kendisi yazabilir ya da siz maç sayfasından yapabilirsiniz.`,
  mwk_admin_paste_not_added: (p) =>
    `📋 ${p.actor}, ${p.when} maçı için içinde ${p.names.join(", ")} olan bir liste yapıştırdı. Bunu bu ayın listesindeki bir oyuncuyla eşleştiremedim, ` +
    `bu yüzden kimseyi eklemedim. Oyuncu grupta kendisi *VARIM* yazabilir ya da siz maç sayfasından ekleyebilirsiniz.`,
  mwk_dm_bumped: (p) =>
    `👋 ${p.firstName ? `${p.firstName}, ` : ""}*${p.activityName}* (${p.when}) maçında yerler önce ayı ödeyen daimi oyuncuların, ` +
    `bu yüzden şimdilik yedek listesindesin. Yer açılırsa sana yazarım.`,

  // ── Aylık kadro, 3. dilim (2026-10-06): ay açılır, kayıt ─────────
  // Başlık `monthly-list.ts` okuyucusunun tanıdığı sözcüklerle yazılır.
  // Üyeye yazması söylenen sözler ("KASIM VARIM") `readSignupMessage`
  // tarafından okunur.
  msu_list_header: (p) => `📋 ${p.month} listesi (${p.games} ${p.weekday}: ${p.days})`,
  msu_list_carried: (p) => `${p.prev} ayının daimi oyuncuları listede.`,
  msu_list_out: (p) => `${p.month} ayında yok musun? *${p.month.toLocaleUpperCase("tr")} YOKUM* yaz.`,
  msu_list_join: (p) =>
    `${p.month} için yer mi istiyorsun? Listeyi kopyalayıp adını ekle ya da *${p.month.toLocaleUpperCase("tr")} VARIM* yaz.`,
  msu_list_payg: (p) => `Sadece bazı haftalar mı oynayacaksın? Adını (PAYG) ya da (PAYG ${p.day}) ile ekle.`,
  msu_list_link: (p) => `Ya da buradan kaydol: ${p.url}`,
  msu_list_deadline: (p) => `İsimler için son an: ${p.when}. Fiyat ve ödeme bilgisi sayılar netleşince gelir.`,
  msu_dm_waiting: (p) =>
    `👋 ${p.firstName ? `${p.firstName}, ` : ""}${p.month} için ${p.max} daimi yerin hepsi dolu, bu yüzden bir yer bekliyorsun. ` +
    `Organizatörlere haber verildi. Yer açıldığında maç başı ödeyerek yine oynayabilirsin.`,
  msu_dm_payg: (p) =>
    `👋 ${p.firstName ? `${p.firstName}, ` : ""}${p.month} için maç başı ödeyen (PAYG) olarak yazıldın${p.days ? `: ${p.days} tarihli maçlar` : ""}. ` +
    `Sadece oynadığın maçlar için ödersin. ` +
    (p.days ? `O tarihlerde listedesin. ` : "") +
    `Başka bir hafta yer açılırsa sana yazarım; ilk *VARIM* yazan alır.`,
  msu_admin_waiting: (p) =>
    `📋 ${p.month} listesi: ${p.max} daimi yerin hepsi dolu ve ${p.name} bir yer istedi, şimdi bekliyor. ` +
    `Yine de daimi yapmak için Aylar sayfasını açın: ${p.link}`,
  msu_dm_paste_others: (p) =>
    `📋 ${p.month} için yapıştırdığın listeyi okudum. Yapıştırılan liste sadece yapıştıran kişiyi kaydeder, bu yüzden ${p.names.join(", ")} için bir şey değiştirmedim. ` +
    `Kendileri *${p.month.toLocaleUpperCase("tr")} VARIM* yazabilir ya da bir organizatör Aylar sayfasından ekleyebilir.`,
  msu_dm_locked: (p) =>
    `📋 ${p.month} için ödediğini söylemiştin, bu yüzden yerini değiştirmedim. Değişmesi gerekiyorsa bir organizatöre yaz.`,
  msu_dm_unknown_days: (p) =>
    `📋 ${p.days} ${p.month} tarihinde maç yok. Maç günleri: ${p.games}. Tarihleri yeniden yaz, düzelteyim.`,

  mth_signup_open: (p) =>
    `Kayıt ${p.when} tarihine kadar açık. Liste grubunuza gönderildi; isimler yapıştırılan listeyle, mesajla ya da kayıt sayfasından gelir.`,
  mth_signup_ended: "Kayıt bitti. Bu ay artık haftalık liste yürüyor. Listede kimin olduğunu buradan yine değiştirebilirsiniz.",
  mth_signup_counts: (p) => `Daimi: ${p.regulars} / ${p.max}. PAYG: ${p.payg}. Daimi yer bekleyen: ${p.waiting}.`,
  mth_kind_waiting: "Daimi yer bekliyor",
  mth_payg_days: (p) => `PAYG günleri: ${p.days}`,
  mth_act_regular: "Daimi yap",
  mth_act_payg: "PAYG'ye al",
  mth_act_remove: "Bu ay için çıkar",
  mth_act_error: "Kaydedilemedi. Sayfayı yenileyip yeniden deneyin.",
  mth_add_label: "Oyuncu ekle",
  mth_add_regular: "Daimi olarak ekle",
  mth_add_payg: "PAYG olarak ekle",
  mth_next_month: (p) => `Gelecek ay: ${p.month}`,
  info_mth_signup_title: "Ay için kayıt",
  info_mth_signup_body:
    "MatchTime ayın listesini ilk maçtan birkaç gün önce grubunuza gönderir; bu ayın daimi oyuncuları listede hazır gelir. Oyuncular listeyi adlarını ekleyip yapıştırarak, ayın adıyla VARIM yazarak ya da kayıt sayfasından katılır. Yapıştırılan liste sadece yapıştıran kişiyi kaydeder.\n\nDaimi yerlerin hepsi dolunca sıradaki kişi bekler ve size bir kez haber verilir. Onu buradan daimi yapabilirsiniz.\n\nListe gönderildikten bir gün sonra kayıt biter ve haftalık liste devreye girer.",

  mmp_title: (p) => `${p.month} listesi`,
  mmp_games: (p) => `${p.games} maç: ${p.days}`,
  mmp_none: "Kulübünüzde şu an açık bir aylık liste yok.",
  mmp_state: (p) =>
    p.outcome === "regular"
      ? `Bu ay varsın${p.slot != null ? `, listede ${p.slot} numarasın` : ""}.`
      : p.outcome === "waiting"
        ? "Daimi yerlerin hepsi dolu, bir yer bekliyorsun."
        : p.outcome === "payg"
          ? p.days
            ? `Şu günler için maç başı ödüyorsun: ${p.days}.`
            : "Maç başı ödüyorsun: yer açıldığında oynarsın."
          : p.outcome === "out"
            ? "Bu ayın listesinde değilsin."
            : "Henüz bu ayın listesinde değilsin.",
  mmp_btn_in: "Bu ay varım",
  mmp_btn_payg: "Maç başı öde",
  mmp_btn_out: "Bu ay yokum",
  mmp_payg_pick: "Sadece bazı haftalar mı? İstediğin maçları işaretle; hiçbirini işaretlemezsen yer açıldığında sana sorulur.",
  mmp_closed: "Bu ayın kaydı bitti. Yerini değiştirmek için bir organizatöre yaz.",
  mmp_locked: "Bu ay için ödediğini söyledin, bu yüzden yerin buradan değişmez. Bir organizatöre yaz.",
  mmp_error: "Kaydedilemedi. Yeniden dene.",

  // ── Aylık kadro, 4. dilim (2026-10-06): fiyat, ödemeler, hatırlatmalar ─
  // Sadece havale (D5). "Ödedi" bir beyandır; ödemeyi yalnızca parayı
  // toplayan kişi onaylar (D3).
  mpy_priced_header: (p) => `📋 ${p.month} listesi: maç başı ${p.share}, son ödeme ${p.when}${p.collector ? ` (${p.collector})` : ""}`,
  mpy_priced_sub: (p) => `(${p.games} maç = ${p.full}. Krediler düşüldü.)`,
  mpy_list_paid_amount: (p) => `(ödedi ${p.amount})`,
  mpy_priced_instructions: (p) => `Ödeme: ${p.text}`,
  mpy_priced_how: 'Ödedin mi? Adının yanına (ödedi) yazıp listeyi yapıştır ya da bana özelden "ödedim" yaz.',
  mpy_group_reminder: (p) => `💷 ${p.month} için ${p.count} kişi henüz ödemedi. Son ödeme: ${p.when}.`,
  mpy_dm_reminder: (p) =>
    `👋 ${p.firstName ? `${p.firstName}, ` : ""}` +
    (p.kind === "late"
      ? `${p.month} için ${p.amount} ödemenin son zamanı ${p.when} idi ve senden bir ödeme görünmüyor.`
      : p.kind === "r2"
        ? `hatırlatma: ${p.month} için ${p.amount} bugün ödenmeli, son an ${p.when}.`
        : `${p.month} için yerin ${p.amount}. Son ödeme: ${p.when}.`) +
    ` Bu ${p.games} maç eder${p.credits > 0 ? `, ${p.credits} kredi düşüldü` : ""}.` +
    ` Lütfen ${p.collector ?? "parayı toplayan kişiye"} havale ile öde.` +
    (p.instructions ? `\n\n${p.instructions}` : "") +
    `\n\nÖdeyince *ödedim* yaz.`,
  mpy_dm_claim_ack: (p) =>
    `✅ ${p.firstName ? `${p.firstName}, ` : ""}not aldım: ${p.month} için${p.amount ? ` ${p.amount}` : ""} ödediğini söylüyorsun. ` +
    `${p.collector ?? "Parayı toplayan kişi"} para gelince onaylayacak.`,
  mpy_admin_price_ask: (p) =>
    `📋 ${p.month} listesi: şimdilik ${p.regulars} daimi, ${p.payg} PAYG. Fiyatı belirleyin: ${p.link}` + (p.tip ? `\n\n${p.tip}` : ""),
  mpy_fee_tip: (p) =>
    `MatchTime kulüpten ayda en fazla ${p.price} alır, yalnızca oynanan maçlar için. ${p.regulars} daimi oyuncu ve ${p.games} maç için ` +
    `her daiminin payına maç başı ${p.perGame} (ay için ${p.perMonth}) eklemek bunu karşılar.`,
  mpy_digest: (p) =>
    `💷 ${p.month} için ${p.count} kişi ödediğini söylüyor:\n${p.lines.join("\n")}\n\n` +
    `*ÖDENDİ HEPSİ* yazın, ya da *ÖDENDİ* ve gelenlerin numaralarını (ÖDENDİ 1 3), ya da *ÖDENDİ HİÇBİRİ*.`,
  mpy_reply_confirmed: (p) => `✅ ${p.month} için ödendi olarak işaretlendi: ${p.names.join(", ")}.`,
  mpy_reply_declined: (p) =>
    `Not aldım: ${p.month} için ${p.names.join(", ")} tarafından henüz bir şey gelmedi. Bunları bir daha sormayacağım. Para gelince Aylar sayfasından onaylayın.`,
  mpy_reply_unknown: (p) =>
    `${p.month} listesinde ${p.numbers} numarada "ödedi" diyen yok, bu yüzden kimseyi işaretlemedim. *ÖDENDİ* ve son mesajımdaki numaraları yazın.`,
  mpy_reply_stale: "O liste artık güncel değil, bu yüzden kimseyi işaretlemedim.",
  mpy_reply_other_month: (p) =>
    `Bu ${p.month} içindi. ${p.other} için ayı da yazın: *ÖDENDİ ${p.other.toLocaleUpperCase("tr")} HEPSİ* ya da *ÖDENDİ ${p.other.toLocaleUpperCase("tr")}* ve numaralar.`,
  mpy_reply_no_digest: "Şu an sizden onay bekleyen bir ödeme yok. Ödemeleri Aylar sayfasından onaylayabilirsiniz.",
  mpy_summary_head: (p) => `📒 ${p.month}: son ödeme zamanı geçti.`,
  mpy_summary_confirmed: (p) => `Ödedi ve onaylandı: ${p.count} (${p.total}).`,
  mpy_summary_claimed: (p) => `Ödediğini söylüyor, onaylanmadı: ${p.count} (${p.names}).`,
  mpy_summary_unpaid: (p) => `Ödemedi: ${p.count} (${p.names}).`,
  mpy_summary_venue: (p) => `Ayın payları toplam ${p.due}, saha ücreti ${p.venue}.`,
  mpy_none: "kimse yok",

  mth_price_title: "Ayın fiyatı",
  mth_price_share: "Maç başı pay (£)",
  mth_price_concession: "İndirimli maç başı pay (£), isteğe bağlı",
  mth_price_venue: "Maç başı saha ücreti (£), isteğe bağlı",
  mth_price_payby: "Son ödeme (Londra saati)",
  mth_price_suggest: (p) => `Öneri: maç başı ${p.amount} (saha ücreti bölü daimi oyuncu sayısı, 50p'ye yuvarlanmış).`,
  mth_price_save: "Fiyatı belirle",
  mth_price_update: "Fiyatı güncelle",
  mth_price_posts: "MatchTime fiyatlı listeyi grubunuza gönderir ve son ödeme zamanından önce ödemeyen daimi oyunculara hatırlatır.",
  mth_price_locked: "Biri ödedi ya da ödediğini söylüyor; pay kilitlendi. Son ödeme zamanını yine değiştirebilirsiniz.",
  mth_price_error: (p) =>
    p.key === "bad-share"
      ? "Maç başı payı 7.50 gibi bir fiyat olarak girin, en fazla £100."
      : p.key === "bad-concession"
        ? "İndirimli payı, paydan yüksek olmayan bir fiyat olarak girin."
        : p.key === "bad-venue"
          ? "Maç başı saha ücretini 90 gibi bir fiyat olarak girin."
          : p.key === "bad-pay-by"
            ? "Henüz geçmemiş bir son ödeme tarihi ve saati seçin."
            : p.key === "locked"
              ? "Biri ödedi, bu yüzden pay değiştirilemez."
              : "Fiyat kaydedilemedi. Sayfayı yenileyip yeniden deneyin.",
  mth_payby_line: (p) => `Son ödeme: ${p.when}.`,
  mth_confirm: "Ödemeyi onayla",
  mth_unconfirm: "Geri al",
  mth_confirm_error: (p) =>
    p.key === "not-collector" ? "Ödemeleri yalnızca kulübün parayı toplayan kişisi onaylar." : "Kaydedilemedi. Sayfayı yenileyip yeniden deneyin.",
  info_mth_price_title: "Ayın fiyatı",
  info_mth_price_body:
    "Maç başı payı siz belirlersiniz. Her daimi oyuncu, pay çarpı aydaki maç sayısı kadar borçludur; parasını ödeyip kaçırdığı maçların kredileri düşülür. İndirimli pay isteğe bağlıdır.\n\nMatchTime fiyatlı listeyi gönderir, oyuncuların \"ödedim\" demesini beyan olarak alır ve son ödeme zamanından önce ödemeyenlere hatırlatır. Ödemeyi yalnızca parayı toplayan kişi onaylar. Ödeme havaleyledir: MatchTime parayı hiç görmez.",

  mmp_due: (p) => `${p.games} maç için ${p.amount}${p.credits > 0 ? `, ${p.credits} kredi düşüldü` : ""}.`,
  mmp_payby: (p) => `${p.collector ?? "Parayı toplayan kişiye"} havale ile öde. Son ödeme: ${p.when}.`,
  mmp_not_priced: "Fiyat henüz belirlenmedi.",
  mmp_btn_paid: "Ödedim",
  mmp_paid_state: (p) => (p.kind === "confirmed" ? "Ödendi, onaylandı." : "Ödediğini söyledin. Para gelince onaylanır."),

  // ── Aylık kadro, 6. dilim (2026-10-06): krediler, iptal edilen haftalar,
  // ay ortasında katılma ve ayrılma, ödemelerden sonra değişen pay, iadeler,
  // ayın kapanışı ──────────────────────────────────────────────────────
  mcl_cancel_credit: (p) =>
    p.count === 1 ? "Daimi oyunculara 1 maç kredisi yazıldı." : `Daimi oyunculara iptal edilen ${p.count} maçın her biri için bir maç kredisi yazıldı.`,
  mcl_sum_head: (p) => `📒 ${p.month} özeti (${p.games} maç oynandı)`,
  mcl_sum_regulars: (p) => `Daimi oyuncu: ${p.count}. Ödedi ve onaylandı: ${p.confirmed} (${p.total}).`,
  mcl_sum_claimed: (p) => `Ödediğini söylüyor, onaylanmadı: ${p.count} (${p.names}).`,
  mcl_sum_unpaid: (p) => `Ödemedi: ${p.count} (${p.names}).`,
  mcl_sum_owes_more: (p) => `Ödemiş olup şimdi eksiği olanlar: ${p.names}.`,
  mcl_sum_owed_back: (p) => `Ödemiş olup geri alacağı olanlar: ${p.names}.`,
  mcl_sum_payg: (p) => `Maç başı (PAYG): ${p.games} maç oynandı, ${p.total} (${p.paid} ödendi).`,
  mcl_sum_payg_chase: (p) => `Maç başı ödemesi beklenenler: ${p.count} (${p.names}).`,
  mcl_sum_payg_none: "Maç başı (PAYG): oynanan maç yok.",
  mcl_sum_leavers: (p) => `Ay ortasında ayrılan ve alacaklı olanlar: ${p.names}.`,
  mcl_sum_owed_games: (p) => `${p.name} ${p.games} maç`,
  mcl_sum_carried: (p) => `Sonraki bir aya devreden krediler: ${p.games} maç (${p.names}).`,
  mcl_sum_carried_none: "Sonraki bir aya devreden kredi yok.",
  mcl_sum_used: (p) => `Bu ay kullanılan krediler: ${p.games} maç.`,
  mcl_sum_page: (p) => `Ayın tamamı: ${p.link}`,
  mcl_leaver_notice: (p) =>
    `📒 ${p.name} ödeme yaptıktan sonra ${p.month} listesinden ayrıldı. Alacağı: ${p.games} maç${p.amount ? ` (${p.amount})` : ""}.\n` +
    `MatchTime kimseye iade yapmaz. Parayı kendi yönteminizle geri verin, sonra buradan kaydedin: ${p.link}`,
  mcl_share_head: (p) => `📋 ${p.month}: maç başı pay artık ${p.share}.`,
  mcl_share_owes: (p) => `Ödemiş olup şimdi eksiği olanlar: ${p.names}.`,
  mcl_share_back: (p) => `Ödemiş olup şimdi geri alacağı olanlar: ${p.names}.`,
  mcl_share_none: "Ödeme yapmış kimse etkilenmedi.",
  mcl_share_foot: (p) => `Kimsenin ödemesi değiştirilmedi. Farkı kendi yönteminizle kapatın: ${p.link}`,
  mcl_midjoin_dm: (p) =>
    `👋 ${p.firstName ? `${p.firstName}, ` : ""}${p.month} ayının kalanı için listedesin: ${p.games} maç` +
    (p.amount
      ? `, ${p.amount}. Ödemeyi havale ile yap${p.collector ? ` (parayı toplayan: ${p.collector})` : ""}, sonra bana "ödedim" yaz.`
      : ". Fiyat ayrıca bildirilecek."),
  mcl_midjoin_admin: (p) => `📋 ${p.name}, ${p.month} ayına ortasında katıldı: ${p.games} maç${p.amount ? `, ödeyeceği ${p.amount}` : ""}. ${p.link}`,

  mpy_reply_closed: (p) => `${p.month} ayı kapandı, bu yüzden kimseyi işaretlemedim. Geç gelen ödemeyi buradan onaylayın: ${p.link}`,
  mth_refund_too_much: "İade, oyuncunun o ay için ödediğinden fazla olamaz.",
  mcp_title: "Onaylanacak ödemeler",
  mcp_lead: "Bu kulübün parasını siz topluyorsunuz. Ödeme gelince onaylayın, para geri verdiğinizde iadeyi kaydedin. MatchTime hiçbir parayı aktarmaz.",
  mcp_link: "Ödemeleri onayla, iadeleri kaydet",
  mcp_none: "Burada gösterilecek bir ay yok.",
  mmp_club_pick: "Kulüplerin:",
  mth_bal_owes: (p) => `${p.amount} eksik`,
  mth_bal_back: (p) => `${p.amount} geri verilecek`,
  mth_refunded: (p) => `${p.amount} iade edildi`,
  mth_leavers_title: "Ay ortasında ayrılanlar",
  mth_leavers_lead: "Ödeme yapmış ama artık ayın listesinde olmayan daimi oyuncular. MatchTime kimseye iade yapmaz: parayı kendi yönteminizle geri verin, sonra kaydedin.",
  mth_leaver_owed: (p) => `Alacağı: ${p.games} maç${p.amount ? ` (${p.amount})` : ""}`,
  mth_leaver_settled: "Alacağı yok",
  mth_refund_label: "İade edilen (£)",
  mth_refund_btn: "İadeyi kaydet",
  mth_refund_error: "İade kaydedilemedi. Tutarı kontrol edip yeniden deneyin.",
  mth_refund_collector_only: "İadeyi yalnızca parayı toplayan kişi kaydeder.",
  mth_share_change_title: "Ödemelerden sonra payı değiştir",
  mth_share_change_lead:
    "Ödeme yapanlar var. Payı şimdi değiştirirseniz kimsenin ödemesine dokunulmaz: ödeme yapmış her daimi oyuncunun eksiği ya da geri alacağı gösterilir, farkı siz kapatırsınız.",
  mth_share_change_ack: "Yapılmış ödemelerin olduğu gibi kalacağını anlıyorum.",
  mth_share_change_btn: "Payı değiştir",
  mth_summary_title: "Ay özeti",
  mth_credits_link: "Kredi defteri",
  mth_earlier: (p) => `Önceki ay: ${p.month}`,
  mth_back_current: "Bu aya dön",
  mth_viewing_past: (p) => `Şu an ${p.month} ayına bakıyorsunuz.`,

  mcr_title: "Krediler",
  mcr_lead: "Daimi oyuncularınızın elindeki ve kullandığı her maç kredisi. Bir kredi, sonraki bir ayın tutarından düşülen bir maçtır.",
  mcr_back: "Aylara dön",
  mcr_add_title: "Kredi ekle",
  mcr_add_player: "Oyuncu",
  mcr_add_games: "Maç sayısı",
  mcr_add_reason: "Neden",
  mcr_add_reason_hint: "Örneğin: 5 Ekim maçını kaçırdı, burada başlamadan önce",
  mcr_add_btn: "Krediyi ekle",
  mcr_error: (p) =>
    p.key === "bad-reason"
      ? "3 ile 200 karakter arasında bir neden yazın."
      : p.key === "bad-games"
        ? "Maç sayısı 1 ile 10 arasında bir tam sayı olmalı."
        : p.key === "not-a-member"
          ? "Kulübünüzden bir oyuncu seçin."
          : p.key === "used"
            ? "Bu kredi bir ayın tutarından düşülmüş, bu yüzden kaldırılamaz."
            : "Kaydedilemedi. Sayfayı yenileyip yeniden deneyin.",
  mcr_empty: "Henüz kredi yok.",
  mcr_available: (p) => `Kullanılabilir: ${p.games} maç`,
  mcr_col_date: "Tarih",
  mcr_col_reason: "Neden",
  mcr_col_state: "Durumu",
  mcr_reason: (p) => {
    const on = p.day ? ` (${p.day})` : "";
    return p.kind === "missed"
      ? `Ödedi, oynayamadı${on}`
      : p.kind === "cancelled-week"
        ? `Maç iptal edildi${on}`
        : p.kind === "left-mid-month"
          ? `Ay ortasında ayrıldı${on}`
          : p.kind === "carried-in"
            ? `Aya başlarken devredildi${on}`
            : `Organizatör ekledi${on}`;
  },
  mcr_state: (p) =>
    p.status === "used"
      ? `Kullanıldı${p.detail ? `: ${p.detail}` : ""}`
      : p.status === "removed"
        ? `Organizatör kaldırdı${p.detail ? ` (${p.detail})` : ""}`
        : p.status === "refunded"
          ? `İade edildi${p.detail ? ` (${p.detail})` : ""}`
          : p.status === "taken-back"
            ? `Geri alındı${p.detail ? ` (${p.detail})` : ""}: oyuncu yine de oynadı ya da maç yeniden yapıldı`
            : `Kullanılabilir${p.detail ? ` (${p.detail})` : ""}`,
  mcr_remove_btn: "Krediyi kaldır",
  mcr_remove_reason: "Neden kaldırıyorsunuz?",
  mcr_remove_confirm: "Kaldır",
  mcr_cancel: "Vazgeç",
  info_mcr_title: "Krediler",
  info_mcr_body:
    "Bir kredi bir maçtır. Daimi oyuncu, parasını ödeyip oynayamadığında ya da bir maç iptal edildiğinde bir kredi kazanır. Kredi, sonraki bir ayın tutarından en eskisi önce olacak şekilde düşülür.\n\n" +
    "Kredi ekle, MatchTime'ın görmediği durumlar içindir; örneğin burada başlamadan önce kaçırılan bir maç. Krediyi kaldır, yanlış bir krediyi geri alır. İkisi de bir neden ister. Hiçbir şey silinmez: kaldırılan kredi listede durur, kullanılmış bir kredi ise kaldırılamaz.",

  mmp_away_title: "Gelemeyeceğim maçlar",
  mmp_away_lead: (p) =>
    p.kind === "none"
      ? "Kaçıracağın maçları işaretle. O maçlarda yerin başkasına önerilir."
      : "Kaçıracağın maçları işaretle. O maçlarda yerin başkasına önerilir; parasını ödeyip kaçırdığın maç, sonraki bir ayın tutarından düşülen bir kredi olur.",
  mmp_away_save: "Kaydet",
  mmp_away_saved: "Kaydedildi.",
  mmp_away_seeded: (p) => `${p.day}: kadro açıklandı. Grupta ya da maç sayfasında YOKUM de.`,
  mmp_away_none: "Bu ay işaretlenecek maç kalmadı.",
  mmp_join_rest: (p) => `Ay başladı. Kalanı için yine de katılabilirsin: ${p.games} maç${p.amount ? `, ${p.amount}` : ""}.`,
  mmp_btn_join_rest: "Ayın kalanına katıl",
  mmp_bal_owes: (p) => `Sen ödedikten sonra senden istenen tutar arttı: ${p.amount} daha ödemen gerekiyor.`,
  mmp_bal_back: (p) => `Sen ödedikten sonra senden istenen tutar azaldı: ${p.amount} geri alacağın var. Parayı toplayan kişi halleder.`,

  mwp_title: "Bu ayın listesi",
  mwp_tag_paid: "Aylık, ödedi",
  mwp_tag_monthly: "Aylık",
  mwp_tag_payg: "Maç başı",
  mwp_cant_paid: "Ödedi ama gelemiyor",
  mwp_cant: "Gelemiyor",
  mwp_open: (p) => `${p.open} boş yer`,
};

/**
 * "7'ye 7", "5'e 5", "6'ya 6": the dative suffix a number takes depends
 * on how the number is READ (yedi, beş, altı), so it is tabulated for
 * the sizes the setup form offers (4 to 11) rather than computed.
 */
const PER_SIDE_SUFFIX_TR: Record<number, string> = {
  4: "'e", // dört
  5: "'e", // beş
  6: "'ya", // altı
  7: "'ye", // yedi
  8: "'e", // sekiz
  9: "'a", // dokuz
  10: "'a", // on
  11: "'e", // on bir
};

function perSideTr(n: number): string {
  return `${n}${PER_SIDE_SUFFIX_TR[n] ?? "'e"} ${n}`;
}

/**
 * The team commands the Turkish copy quotes, one form per action (see
 * the header). The strings above spell them out literally so this file
 * reads as Turkish; `__tests__/tr-team-commands.test.ts` checks every
 * one of them against this list and against what the bot understands.
 */
export const TR_TEAM_COMMANDS = {
  generate: "takımları kur",
  regenerate: "takımları yeniden kur",
  show: "takımları göster",
  swapPlayers: "X ile Y'yi değiştir",
  swapPlayersExample: "Ali ile Can'ı değiştir",
  swapColours: "renkleri değiştir",
} as const;
