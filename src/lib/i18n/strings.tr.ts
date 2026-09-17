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
 * Three Turkish sentences quote a command the group would TYPE:
 * "takımları oluştur" (match_day_locked_line, teams_not_generated,
 * swap_deferred, intro_teams) and "takımları yeniden oluştur"
 * (bench_claim_team). The teams extractor's prompt is English and
 * Turkish command words are Phase 3 work, so whether those phrases
 * trigger team generation is untested; `swap X Y` is kept as the
 * literal typed command for the same reason.
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

  teams_not_generated: "Takımlar henüz oluşturulmadı, 'takımları oluştur' yazın, hallederim.",
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
    `_Yeni kadroyla takımları yeniden dengelemek isterseniz "takımları yeniden oluştur" yazın._`,
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
    `Takımlar henüz oluşturulmadı; *takımları oluştur* yazın, kurayım (sonra ikisini farklı takımlara koyabilirim).`,
  team_swap_done: (p) => `🔁 *${p.a}* ve *${p.b}* yer değiştirdi, kimse çıkarılmadı. Güncel takımlar:`,
  slot_transfer_done: (p) =>
    `🔁 *${p.to}*, *${p.teamLabel}* takımında *${p.from}* yerine oynuyor; ` +
    `takımlar aynı, yeniden oluşturulmadı, kimsenin katılımı değişmedi. Güncel takımlar:`,
  colour_swap_done: "🎨 Renkler değişti, takımlar aynı, taraflar ters döndü:",

  // ── row 67: the bot intro ──────────────────────────────────────────
  //   The attendance line says what the bot really does (✅ on the
  //   sender's own row); the English still says 👍 and is corrected in
  //   Phase 3c, the design's call (section 1.4).

  intro_opener: "👋 Herkese merhaba, MatchTime botu bu grupta aktif.",
  intro_what_i_do: "Yaptıklarım:",
  intro_attendance: `🗓  *Katılım*, buraya "VARIM" / "YOKUM" yazın (ya da uygulamadan işaretleyin), sizi kadroya ekler ya da çıkarırım. Onay için mesajınıza ✅ koyarım, ayrıca mesaj atmam.`,
  intro_daily: `🗒  *Günlük hatırlatma*, kadro dolana kadar her gün 17:00'de kadro listesini yeniden paylaşırım, kaç kişi eksik hep birlikte görürüz.`,
  intro_teams: `⚽  *Takımlar*, "takımları oluştur" deyin, dengeli takımları paylaşırım. İtirazı olan \`swap X Y\` yazsın, admin onaylar.`,
  intro_rating_bit: "her maçtan sonra herkese puanlama linkini DM'den gönderirim (kayıt yok, tıklamanız yeterli)",
  intro_mom_bit: "maçın adamını uygulamadan ya da paylaştığım anketten seçin, herkes oy verince (en geç maçtan 5 gün sonra) kazananı açıklarım",
  intro_ratings_line: (p) => `🏆  *Puanlama ve maçın adamı*, ${p.bits.join("; ")}.`,
  intro_reminders: `⏰  *Hatırlatmalar*, "@MatchTime pazartesi hatırlat" deyin, o gün size DM atarım.`,
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
};
