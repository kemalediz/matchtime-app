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
  answer_stats_empty: (p) =>
    `Son ${p.windowDays} günde tamamlanmış maç yok, o yüzden en istikrarlı oyuncuyu söyleyemem.`,
  answer_stats_head: (p) => `Son ${p.windowDays} günde en çok oynayanlar:`,
  // "maç" is one of `isLeaderboardLine`'s markers (group-copy.ts), so
  // this row is never mistaken for a squad roster. See the English note.
  answer_stats_row: (p) => `${p.rank}. ${p.name}: ${p.matches} maç`,
  answer_options_lead: (p) =>
    p.need > 0
      ? `${p.maxPlayers} kişilik kadroda ${p.confirmed} kişiyiz, ${p.need} kişi daha lazım 🙏`
      : `${p.maxPlayers} kişilik kadroda ${p.confirmed} kişiyiz ✅ kadro tamam.`,
  answer_options_no_formats: "Bu grup için daha küçük bir format tanımlı değil, o yüzden ya oyuncu bulacağız ya da hiç.",
  answer_options_none_viable: "Elimizdeki kadroyla daha küçük bir format da dolmuyor, o yüzden oyuncu bulmamız lazım.",

  // ── rows 32 to 42: the acks ────────────────────────────────────────

  teams_not_generated: "Takımlar henüz kurulmadı, *@Match Time takımları kur* yazın, hallederim.",
  score_ack: (p) => `Tamam 👍 ${p.redLabel} ${p.red} - ${p.yellow} ${p.yellowLabel}, kaydettim.`,
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
    `👋 Merhaba, ben *MatchTime*. Futbol grubunun haftalık işlerini üstlenirim: kim var kim yok, dengeli takımlar, hatırlatmalar.\n\n` +
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

  onbAdminDm: (p: { groupName: string | null; url: string; payments: boolean }): string =>
    `👋 MatchTime'da ${p.groupName ? `*${p.groupName}* grubunun` : "grubunun"} yöneticisi sensin.\n\n` +
    `Yönetici sayfanın özel bağlantısı burada, oyuncu adları, puanlar` +
    `${p.payments ? ", ödemeler" : ""} ve ayarlar orada:\n${p.url}` +
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
    if (f.reminders) lines.push(`⏰ Maçtan önce kadroya hatırlatma gönderirim.`);
    if (f.paymentTracking) lines.push(`💳 Kimin *ödediğini* takip ederim.`);
    lines.push(`\nBunu tekrar görmek için istediğiniz zaman *"@Match Time yardım"* yazın.`);
    return lines.join("\n");
  },

  onbHelpHead: (): string => `ℹ️ *MatchTime yardım*, açıklayabileceklerim şunlar. Beni şunlardan biriyle etiketleyin:`,

  onbHelpTopicLine: (p: { word: string; label: string }): string =>
    `   • *@Match Time yardım ${p.word}*, ${p.label}`,

  onbHelpTopicWord: (p: { topic: "availability" | "teams" | "mom" | "ratings" | "reminders" | "payments" }): string =>
    ({
      availability: "kadro",
      teams: "takımlar",
      mom: "maçın adamı",
      ratings: "puanlama",
      reminders: "hatırlatma",
      payments: "ödeme",
    })[p.topic],

  onbHelpTopicLabel: (p: { topic: "availability" | "teams" | "mom" | "ratings" | "reminders" | "payments" }): string =>
    ({
      availability: "kadro ve katılım",
      teams: "dengeli takımlar",
      mom: "maçın adamı",
      ratings: "oyuncu puanları",
      reminders: "hatırlatmalar",
      payments: "ödeme takibi",
    })[p.topic],

  onbHelpNotOn: (): string =>
    `Bu özellik bu grupta açık değil. Açık olanları görmek için *@Match Time yardım* yazın.`,

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

  dm_bench_unclear:
    "Bu akşamki boş yeri ister misin? Almak için *EVET* yaz. İstemiyorsan sorun değil, her durumda yedekte kalırsın 🙏",

  dm_bench_ack: (p) =>
    ({
      declined: "👍 Sorun değil, yedekte kalmaya devam ediyorsun, bir şey değişmedi.",
      confirmed: "✅ Yer senin, bu akşam oynuyorsun! ⚽",
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
};

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
