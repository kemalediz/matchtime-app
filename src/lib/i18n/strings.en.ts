/**
 * THE ENGLISH STRING TABLE, and the TYPE every other language must satisfy.
 *
 * `type Strings = typeof en` (in ./t.ts). `strings.tr.ts` is declared
 * `const tr: Strings`, so a key missing from Turkish is a `tsc` error and
 * the build fails. That is the "missing key fails the build" rule, with
 * no runtime machinery.
 *
 * Every entry with parameters is a FUNCTION `(p) => string`, never a
 * `"{name}"` interpolation string. Turkish attaches case suffixes to the
 * thing it names ("Salı'ya", "Sim Arena'da") and vowel harmony decides
 * the suffix, so a placeholder dropped into a fixed sentence is wrong for
 * half the venues and names. A function lets the native speaker write
 * the sentence so the interpolated value sits in a suffix-free position.
 *
 * ── PHASE 0: THE MECHANISM ONLY ─────────────────────────────────────
 *
 * This table holds ONE probe entry. No existing string has been moved
 * here yet: that is Phase 2's job, one composer at a time, with
 * `__tests__/copy-golden.test.ts` proving every English byte identical
 * before and after each move. Moving a string is a refactor of the
 * composer that owns it, reviewed as such, never a drive-by.
 *
 * ── WHEN YOU ADD AN ENTRY (Phase 2 onwards) ─────────────────────────
 *
 *   - WhatsApp formatting, not markdown: `*bold*`, no headings.
 *   - Keep the emoji the English copy uses, in the same positions.
 *   - No time-of-day greeting and no send-time stamp
 *     (`no-time-of-day-greeting.test.ts` scans this directory too).
 *   - The English wording is moved BYTE FOR BYTE. If the current English
 *     contains an em dash, it keeps it: the golden snapshot decides,
 *     not house style. Cleaning it up is a separate, visible change.
 *
 * See MDs/multi-language-design-2026-09-16.md section 4.2.
 */

export const en = {
  /**
   * The one entry that proves the mechanism is wired: `t(lang)` resolves
   * a table, the table's keys are typed, and a parameterised entry is a
   * function. Not used by any composer. Remove it once a real entry
   * exists, or keep it as the canary; either is fine.
   */
  probe: (p: { name: string }): string => `Hello ${p.name}, this is MatchTime.`,

  // ── onboarding (self-setup) ──────────────────────────────────────────
  // The group-add flow (bot added to a group → intro → consent → admins →
  // when and where → live), its completion post, its DMs and the
  // "@Match Time help" block. Composers in src/lib/onboarding-conversation.ts
  // and the details question in src/lib/onboarding-parse.ts read these.
  // The English here is byte for byte what those composers produced
  // before the move (copy-golden.test.ts), except `onbIntro`, which was
  // rewritten on purpose on 2026-09-17 (the 1,300-character pitch became
  // one line and one question).

  /** The first thing the bot says in a group it was just added to. One
   *  line on what it is, one question. The consent keyword is load
   *  bearing: parseBundleReply reads it. */
  onbIntro: (): string =>
    `👋 Hi, I'm *MatchTime*. I run the weekly admin for a football group: who's in, who's out, fair teams, reminders.\n\n` +
    `*Want me to run this group?* Whoever organises it, reply *YES* and I'll ask two quick questions. ` +
    `Not for you? Ignore me and I'll stay quiet. 🤐`,

  /** The admins question, asked right after consent. */
  onbAdminQuestion: (): string =>
    `Who else helps run this group? Reply with their name + number (or @mention) — ` +
    `you can list a few, separated by commas. Or say *just me* if it's only you.`,

  /** The reply to a consent answer: a short lead, then the admins question. */
  onbConsentAck: (p: { adminCaptured: boolean; adminQuestion: string }): string =>
    `${p.adminCaptured ? "Done — you're the admin 🎽" : "Done ✅"} ${p.adminQuestion}`,

  /** The reply to the admins answer: an optional lead, then the details question. */
  onbAdminsAck: (p: { added: number; detailsQuestion: string }): string =>
    (p.added > 0
      ? `Got it — I'll set up ${p.added === 1 ? "that admin" : `those ${p.added} admins`} once we're live. `
      : "") + p.detailsQuestion,

  /** The combined "when and where" question, or the follow-up for the gaps. */
  onbDetailsQuestion: (p: { missing: Array<"day" | "time" | "venue"> }): string => {
    if (p.missing.length === 3) {
      return (
        "One thing I need: *when and where do you play?* One message is fine, " +
        "like: _\"Thursdays 9pm at PowerLeague Shoreditch, 7-a-side\"_."
      );
    }
    const parts: string[] = [];
    if (p.missing.includes("day")) parts.push("which *day of the week* you play");
    if (p.missing.includes("time")) parts.push("the *kickoff time* (e.g. 9pm)");
    if (p.missing.includes("venue")) parts.push("the *venue* name");
    return `Almost there — I just need ${parts.join(" and ")}.`;
  },

  /** The "All set" post for the group-add flow. `dayName` and `onLabels`
   *  are already in this language; `howToUseMe` is the block below. */
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
    const adminLine = p.adminDmQueued
      ? `${adminName || "Admin"}, I've sent you a private link to your admin page — player names, ratings and payments live there. `
      : `Whoever runs this group can claim the admin page any time at matchtime.ai. `;
    return (
      `✅ *All set!* I'm live for *${p.groupName || "this group"}* with: *${p.onLabels.join(", ")}*.\n\n` +
      `📅 First match: *${p.dayName} ${p.kickoffTime}* at *${p.venue}*` +
      `${p.weekly ? ", every week" : ""}.\n` +
      (p.rosterCount > 0
        ? `👥 I've added the *${p.rosterCount} ${p.rosterCount === 1 ? "person" : "people"}* in this group to the squad — no need to type anyone in.\n`
        : ``) +
      (p.adminsAdded > 0
        ? `👮 Added *${p.adminsAdded} co-admin${p.adminsAdded === 1 ? "" : "s"}* — I've DM'd them their admin link.\n`
        : ``) +
      `\n` +
      `${adminLine}Everyone else: just chat normally, say *"in"* when you're playing, and I'll handle the rest. ⚽` +
      `\n\n*How to use me* 👇\n${p.howToUseMe}`
    );
  },

  /** The magic-link DM to the captured admin at completion. */
  onbAdminDm: (p: { groupName: string | null; url: string; payments: boolean }): string =>
    `👋 You're the admin of *${p.groupName || "your club"}* on MatchTime.\n\n` +
    `Here's your private link to the admin page — player names, ratings` +
    `${p.payments ? ", payments" : ""} and settings live there:\n${p.url}` +
    (p.payments
      ? `\n\nWant me to *collect* the money too? Connect a bank from your admin page — takes 2 minutes.`
      : ``),

  /** The magic-link DM to each additional admin named at the admins stage. */
  onbCoAdminDm: (p: { groupName: string | null; url: string }): string =>
    `👋 You've been made an admin of *${p.groupName || "the club"}* on MatchTime.\n\n` +
    `Here's your private link to the admin page:\n${p.url}`,

  /** The DM that points the admin at the enrichment review page. */
  onbEnrichmentDm: (p: { messagesAnalyzed: number; groupName: string | null; playerCount: number; url: string }): string =>
    `📋 I read ${p.messagesAnalyzed} past messages from *${p.groupName || "your group"}* ` +
    `and drafted positions + seed ratings for ${p.playerCount} players.\n\n` +
    `Nothing's applied yet — review & finish setup here:\n${p.url}`,

  /** The reply when someone tagged the bot and asked it to stop the setup. */
  onbCancelled: (): string =>
    `Okay, I've stopped the setup and I'll stay quiet. Add me to the group again, or tag *@Match Time setup*, to start over.`,

  /** The feature label in a completion post ("I'm live with: ..."). */
  onbFeatureLabel: (p: { key: string; englishLabel: string }): string => p.englishLabel,

  /** Day of week, 0 = Sunday. */
  onbDayName: (p: { dow: number }): string =>
    ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][p.dow] ?? "Tuesday",

  /** The feature-aware "how to use me" block (completion post and bare help). */
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
      lines.push(`✅ Say *"In"* or *"Out"* to mark your own availability — no need to tag me.`);
      lines.push(`🤔 Not sure? Just say *"maybe"* and I'll check with you ~24h before.`);
    } else {
      lines.push(`📋 Paste your squad list and I'll read who's playing — no need to tag me.`);
    }
    const caps: string[] = [];
    if (f.attendance) caps.push(`see who's in / how many we've got`);
    if (f.teamBalancing) caps.push(`make / show the teams`);
    if (f.statsQa) caps.push(`who won last week? / past stats`);
    lines.push(`💬 Tag *@Match Time* when you want me to do or tell you something:`);
    for (const c of caps) lines.push(`   • ${c}`);
    lines.push(`🤐 I stay quiet the rest of the time — banter and jokes are safe, I won't butt in.`);
    if (f.momVoting) lines.push(`🏆 After the game I'll run a quick *Man of the Match* vote.`);
    if (f.playerRating) lines.push(`⭐ I'll DM you a one-tap *rating* link after the match.`);
    if (f.reminders) lines.push(`⏰ Say *"@Match Time remind me Thursday"* and I'll nudge you.`);
    if (f.paymentTracking) lines.push(`💳 I keep track of who's *paid*.`);
    lines.push(`\nType *"@Match Time help"* any time to see this again.`);
    return lines.join("\n");
  },

  /** Bare "@Match Time help": the lead line above the topic list. */
  onbHelpHead: (): string => `ℹ️ *MatchTime help* — here's what I can explain. Tag me with one of these:`,

  /** One line of the bare-help topic list. `word` is what the player
   *  types after "help" in this language; `label` names the topic. */
  onbHelpTopicLine: (p: { word: string; label: string }): string =>
    `   • *@Match Time help ${p.word}* — ${p.label}`,

  /** The word a player types after "help" for each topic, in this language. */
  onbHelpTopicWord: (p: { topic: "availability" | "teams" | "mom" | "ratings" | "reminders" | "payments" }): string =>
    p.topic,

  /** Human label for each topic, used in the bare-help topic menu. */
  onbHelpTopicLabel: (p: { topic: "availability" | "teams" | "mom" | "ratings" | "reminders" | "payments" }): string =>
    ({
      availability: "squad & availability",
      teams: "fair teams",
      mom: "Man of the Match",
      ratings: "player ratings",
      reminders: "reminders",
      payments: "payment tracking",
    })[p.topic],

  /** "help <topic>" for a topic whose feature is off. */
  onbHelpNotOn: (): string =>
    `That one isn't switched on for this group. Type *@Match Time help* to see what is.`,

  /** The per-topic explainers. */
  onbHelpExplainer: (p: { topic: "availability" | "teams" | "mom" | "ratings" | "reminders" | "payments" }): string =>
    ({
      ratings:
        `⭐ *Player ratings — how it works*\n` +
        `After each match I DM every player who turned out a private link. You rate the other players out of 10 (you can't rate yourself, and your scores stay private).\n` +
        `I combine everyone's scores into a form rating for each player that updates after every game — and that's what I use to build *balanced teams*. So the more people rate, the fairer the teams.\n` +
        `You'll get the link the morning after the game. Type *@Match Time my stats* for yours anytime.`,
      teams:
        `🟥🟦 *Fair teams — how it works*\n` +
        `Once the squad's locked in, any admin can tag *@Match Time generate the teams* and I'll split everyone into two balanced sides using their form ratings, so games stay even.\n` +
        `I post the line-ups straight into the chat. Not happy with a pairing? Tag me to *swap two players* (e.g. _"@Match Time swap Sam and Alex"_), or ask me to *"@Match Time show the teams"* again any time.\n` +
        `Want a bit of fun? Ask me to give the teams names and I'll sort it. Tag *@Match Time generate the teams* when you're ready.`,
      mom:
        `🏆 *Man of the Match — how it works*\n` +
        `After the final whistle I post a quick *Man of the Match* vote in the group. Everyone just taps who they thought was the standout player.\n` +
        `I tally the votes, announce the winner, and it counts towards everyone's season stats — so the MoM race builds up over the year.\n` +
        `Nothing to set up — I'll start the vote myself once the game's done. Type *@Match Time my stats* to see your MoM tally.`,
      availability:
        `⚽ *Squad & availability — how it works*\n` +
        `Just say *In* or *Out* in the group to mark yourself for the next game — no need to tag me, I read it automatically.\n` +
        `I keep a live, numbered squad list. When it's full, extra players go on the *bench/reserve* list in order. Not sure yet? Say *"maybe"* and I'll DM you ~24h before kick-off for a final answer.\n` +
        `If you drop out, I can nudge the bench to step in so we're never short. Say *Out* any time and I'll sort the rest.`,
      reminders:
        `⏰ *Reminders — how it works*\n` +
        `I gently nudge anyone who hasn't said *In* or *Out* yet, then remind the whole squad before kick-off so nobody forgets.\n` +
        `Want a personal nudge? Say *"@Match Time remind me Thursday"* and I'll ping you then.\n` +
        `It all happens automatically — you don't need to chase anyone yourself.`,
      payments:
        `💳 *Payment tracking — how it works*\n` +
        `I keep track of who's paid the match fee. The organiser sets the fee, and I show who's paid and who still owes at a glance.\n` +
        `I send friendly reminders to anyone outstanding. Players can pay by card, or the organiser can mark cash and bank transfers as received.\n` +
        `This only runs when payment tracking is switched on. Tag *@Match Time who still owes?* to see the latest.`,
    })[p.topic],
};
