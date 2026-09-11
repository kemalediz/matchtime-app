/**
 * INTERACTION CONTRACT — the deterministic gate that decides whether
 * MatchTime is allowed to ACT on / ANSWER a group message.
 *
 * GUIDING PRINCIPLE: "LLM extracts, code decides." The LLM classifies
 * intent; THIS code decides whether MT may act, based on a simple,
 * predictable contract:
 *
 *   ACT WITHOUT A TAG only for a player's OWN clear self-attendance
 *   (intent in/out with registerAttendance for the SELF sender, no
 *   third-party registerFor). Plus the separate, tag-free admin
 *   squad-from-list pipeline (cron/archive driven — not handled here).
 *
 *   REQUIRE an @Match Time tag for everything else MT could DO or
 *   ANSWER: questions, team ops (generate/show), stats requests, moving/
 *   benching/replacing OTHER players, reminders, payment queries, etc.
 *   Untagged → noise: no action, no reply, no reaction, DB unchanged.
 *
 *   TWO NAMED EXCEPTIONS have been argued and added on top, each as one
 *   revertable constant: a third-party ADD is tag-free for anyone, and
 *   an OWNER/ADMIN reporting another player OUT is tag-free for them
 *   (`ADMIN_REPORTED_OUT_IS_TAG_FREE`, 2026-09-07). A BENCH still needs
 *   a tag from everyone, including the owner.
 *
 *   AND THE QUESTION IS ASKED PER ENTRY, NOT PER MESSAGE (2026-09-08).
 *   `registerForEntryRequiresTag` is the whole rule; `actionRequiresTag`
 *   is its OR over the message and stays the message-level answer for
 *   every caller that wants one. The split exists because one refused
 *   clause used to discard every other clause in the same message: see
 *   the essay on that function for the David incident.
 *
 * MT must be CONSERVATIVE and PREDICTABLE: act only when clearly
 * warranted, stay silent on banter.
 */

export interface TagInput {
  body: string;
  /** Structured signal forwarded by the Pi: did this message @-mention
   *  the bot's own JID? PRIMARY tag signal. `undefined` when an older Pi
   *  build didn't send it → fall back to text matching. */
  botMentioned?: boolean;
}

/**
 * Did this message tag @Match Time?
 *
 *  - PRIMARY:  msg.botMentioned === true — the Pi matched the bot inside
 *              the message's mention list. Authoritative when true.
 *  - FALLBACK: an explicit textual bot tag in the body. This runs whenever
 *              the structured signal is NOT a positive true — i.e. when
 *              botMentioned is `false` OR `undefined`.
 *
 * HARDENED (prod incident 2026-06-29): a `false` botMentioned NO LONGER
 * suppresses a clear text tag. Root cause was a Pi-side @lid-vs-@c.us
 * self-mention bug that reported botMentioned:false for a genuinely-tagged
 * admin command ("@Match Time Kieran and Rashad are IN"), so the gate
 * silently dropped a real action. Since the Pi rewrites a bot @-mention
 * into the literal "@Match Time" in the body, the text tag is a reliable
 * second signal that survives a structured-signal regression. The
 * false-positive risk (casual "match time" banter) is the same tradeoff
 * already accepted for the undefined-fallback path, and we lean toward the
 * hardened fallback because dropping a real admin action is the worse error.
 */
export function messageTagsBot(msg: TagInput): boolean {
  if (msg.botMentioned === true) return true;
  const body = msg.body ?? "";
  return (
    /@?\s*match\s*time\b/i.test(body) ||
    /\bmatchtime\b/i.test(body) ||
    /@mt\b/i.test(body)
  );
}

/**
 * Was MatchTime ADDRESSED — with an @ — rather than merely mentioned?
 *
 * ⚠️ THE STRICTER SIBLING OF `messageTagsBot`, AND IT EXISTS BECAUSE OF
 * ONE MESSAGE. Read them together. This one is for the BULK-DM commands
 * and nothing else; every other caller keeps `messageTagsBot`.
 *
 * ── THE 2026-09-10 NEAR-MISS ─────────────────────────────────────────
 *
 * At 18:38 Kemal posted an ordinary reminder to his players in the live
 * group:
 *
 *   "please do not forget to rate the players via the link from
 *    Matchtime DM'ed to you. the more accurate ratings, the more
 *    balanced teams next time"
 *
 * MatchTime queued 69 personal stats-link DMs. The classifier that fired
 * is deleted (see `lib/stats-blast.ts`), but the tag gate that was
 * supposed to be the backstop would NOT have stopped it either:
 * `messageTagsBot` counts the bare word "matchtime", anywhere in a body,
 * as a tag — and that sentence contains it. The sentence is ABOUT
 * MatchTime and addressed to the PLAYERS.
 *
 * ── WHY `messageTagsBot` IS STILL RIGHT WHERE IT IS ──────────────────
 *
 * Its looseness is deliberate and was hardened INTO it on 2026-06-29,
 * after the Pi's structured signal regressed and a genuine admin command
 * was dropped. For an ANSWER — a question, a team sheet, one DM to the
 * asker — a false negative (silence at a player who really did ask) is
 * the worse error, so leaning loose is correct.
 *
 * In front of a MASS DM the costs invert, and `RECRUIT_BLAST_REQUIRES_TAG`
 * already spells out why: "A blast that does not fire costs the owner
 * one re-typed message. A blast that fires when it should not costs the
 * WhatsApp account" — the bot runs on an unofficial client, and the ban
 * takes the whole product down. So the bulk-DM door asks the strictest
 * question the bytes can answer.
 *
 * ── WHAT COUNTS, AND WHAT THIS COSTS ─────────────────────────────────
 *
 *   • the Pi's structured mention list (`botMentioned === true`) — the
 *     authoritative signal, unchanged;
 *   • an explicit "@" in the body: "@Match Time", "@MatchTime", "@mt".
 *     The Pi rewrites a real bot @-mention into the literal "@Match
 *     Time", so this is the same fact seen from the text side, and the
 *     2026-06-29 hardening survives: a FALSE structured signal still
 *     cannot suppress a real @-tag.
 *
 * NOT the bare word. THE COST, stated rather than discovered later: an
 * admin who types "matchtime send everyone their stats", with no @, gets
 * silence and has to send it again with the tag on. That is the cheap
 * direction of the asymmetry above, and it is the whole point.
 */
export function messageMentionsBotExplicitly(msg: TagInput): boolean {
  if (msg.botMentioned === true) return true;
  const body = msg.body ?? "";
  return /@\s*match\s*time\b/i.test(body) || /@\s*matchtime\b/i.test(body) || /@mt\b/i.test(body);
}

export interface GateRegisterForEntry {
  name: string;
  action: "IN" | "OUT" | "BENCH";
}

export interface GateVerdict {
  intent: string;
  registerAttendance: "IN" | "OUT" | "BENCH" | null;
  registerFor: GateRegisterForEntry[] | null;
}

/**
 * Is this verdict PURELY the sender's own attendance (the only tag-free
 * action class)? True when:
 *   - the intent is a self-attendance intent (in / out / conditional_in /
 *     replacement_request — a player speaking about THEIR OWN slot), AND
 *   - there is NO third-party registerFor (moving/benching/replacing
 *     someone else is a directed op that REQUIRES a tag).
 *
 * We deliberately DON'T require registerAttendance to be populated: a bare
 * intent:"in" whose registerAttendance the server backfills later is still
 * self-attendance. A self-attendance intent that ALSO carries a
 * registerFor for another player is a directed op → not pure self.
 */
export function isSelfAttendanceVerdict(v: GateVerdict): boolean {
  const SELF_ATTENDANCE_INTENTS = new Set([
    "in",
    "out",
    "conditional_in",
    "replacement_request",
  ]);
  if (!SELF_ATTENDANCE_INTENTS.has(v.intent)) return false;
  const movesOthers = !!(v.registerFor && v.registerFor.length > 0);
  return !movesOthers;
}

/**
 * MAY AN ORG OWNER/ADMIN REPORT ANOTHER PLAYER **OUT** WITHOUT TAGGING
 * @Match Time?
 *
 * ⚠️ A DELIBERATE, ARGUED WIDENING OF THE CONTRACT, kept as one named
 * constant so it can be reverted on its own line. Set it to `false` and
 * the gate behaves exactly as it did before 2026-09-07. It is named for
 * exactly what it permits and it permits nothing else — see THE SCOPE.
 *
 * ── THE INCIDENT (2026-09-07 21:11, Sutton FC, the live group) ───────
 *
 * Kemal posted, the day before kickoff:
 *
 *   "@Shahrokh🐔 Sutton Football Club is out due to unforeseen issue at
 *    work"
 *
 * Shahrokh was CONFIRMED at position 10. MatchTime did nothing. The
 * verdict is a third-party OUT, `actionRequiresTag` said yes, and the
 * message tags no bot — so the whole message was treated as overheard
 * chat. The squad kept reading 13/14 with a player in it who was not
 * coming; the row was corrected by hand.
 *
 * ⚠️ THE TRAP IN THE WORDING, because it confused the owner and it
 * confused the first reader of the log: that message DOES contain an
 * "@" mention — of the PLAYER. "Tagged" in this codebase means the BOT
 * was mentioned (`messageTagsBot`). A player @-mention has never been a
 * tag and still is not one. Keep that distinction crisp in anything you
 * write here.
 *
 * ── THE ARGUMENT ────────────────────────────────────────────────────
 *
 * The old rule's stated reason was "removing or moving someone who never
 * consented stays an explicit, tagged op", and that reason is still
 * exactly right FOR AN ORDINARY MEMBER: without it anyone in the group
 * can remove a player by typing a sentence, and the cost of a wrong drop
 * is somebody losing their place.
 *
 * It is not right for the OWNER. Managing the squad is what the owner
 * DOES; "X is out" from him is not overheard chat about a third party,
 * it is the roster instruction the product exists to execute. He should
 * not have to address the bot to do the one job he bought it for, and
 * on 2026-09-07 the tag requirement cost him a squad list that was wrong
 * until he went and corrected the row himself.
 *
 * This mirrors `RECRUIT_COMMAND_IMPLIES_ADDRESSED` (PR #33) in shape:
 * the tag is a PROXY for "addressed to MatchTime", not the thing itself,
 * and the seat the sender holds is the other evidence for it. It also
 * heeds that constant's lesson — a waiver reused past its intended path
 * produced the 27-person untagged mass DM fixed in `9d73716` — so this
 * is a NEW constant, read in exactly one place.
 *
 * ── THE SCOPE, and it is narrow ─────────────────────────────────────
 *
 *   WHO   OWNER/ADMIN only, and the seat is read from the MEMBERSHIP
 *         TABLE (`engineAdminIds` in the analyze route → `Member.isAdmin`
 *         → `senderIsAdmin` in the engine). NO authorisation rests on
 *         model output, here or anywhere below it.
 *   WHAT  an OUT ENTRY. An OUT alone is the incident; an OUT beside an
 *         IN is the same message with the replacement named ("Shahrokh
 *         is out, Amir can take his spot"), and the IN half has been
 *         tag-free for EVERYONE since the third-party-add change, so the
 *         pair grants nothing neither half grants alone.
 *   NOT   BENCH. Kemal asked for removal, and a demote is a different
 *         act: it leaves the player in the squad in a worse position,
 *         it is roster surgery rather than recording a fact the player
 *         reported, and the engine's separate admin-only bench guard
 *         means the seat is ALREADY spent as its authorisation there.
 *         The tag is the second, independent signal and it stays.
 *         Owning less is the safer default; this is the line.
 *
 *         ⚠️ AND IT COST A SECOND INCIDENT THE NEXT DAY, not because the
 *         line is wrong but because of where it was drawn. This waiver
 *         shipped as `entries.every(IN | OUT)`, one answer for the whole
 *         message, so a bench clause anywhere in a message refused every
 *         other clause in it: on 2026-09-08 "David is OUT … the other
 *         can go to bench" recorded NOTHING and David played on in a
 *         squad he had left. The scope above is unchanged, and it is now
 *         read per entry (`registerForEntryRequiresTag`). A refused
 *         BENCH refuses the BENCH.
 *   NOT   anything outside `registerFor`: questions, team ops,
 *         reminders, payments, the recruit blast. Those read their own
 *         gates and none of them reads this constant.
 *
 * ── WHAT ELSE HAD TO MOVE WITH IT ───────────────────────────────────
 *
 * `banterRefusal` in `pipeline/engine.ts` exempted ADMINS from its
 * joke-marker refusal. That exemption was safe only because an admin's
 * third-party drop necessarily carried a tag, and a tag is a deliberate
 * act. This waiver removes that, so the exemption was re-hung on the
 * TAG rather than on the seat. Without that change "Shahrokh is out 😂
 * vote him out lads" from the owner would have dropped him.
 */
export const ADMIN_REPORTED_OUT_IS_TAG_FREE = true;

/** Everything the gate is allowed to know about WHO sent the message.
 *  One field, read from the membership table, never from a model. */
export interface GateSender {
  /** Is the sender an org OWNER or ADMIN? Absent means NO (fail closed). */
  senderIsAdmin?: boolean;
}

/**
 * DOES THIS ONE `registerFor` ENTRY REQUIRE AN @Match Time TAG?
 *
 * The whole third-party rule, stated once, for ONE named person and ONE
 * action. `actionRequiresTag` is the OR of this over a message.
 *
 *   IN     never. A third-party ADD has been tag-free for everyone since
 *          the third-party-add change: registering a friend somebody
 *          names in ordinary group chat is not a directed op.
 *   OUT    tag-free for an OWNER/ADMIN only
 *          (`ADMIN_REPORTED_OUT_IS_TAG_FREE`, and the seat comes from the
 *          membership table, never from a model). For anyone else it
 *          stays an explicit, tagged op, or the group can remove each
 *          other by typing a sentence.
 *   BENCH  always, from everybody, the owner included. See the NOT
 *          clause on `ADMIN_REPORTED_OUT_IS_TAG_FREE`: a demote leaves
 *          the player in the squad in a worse position, it is roster
 *          surgery rather than the recording of a fact the player
 *          reported, and the engine's admin-only bench guard has already
 *          spent the seat as ITS authorisation. The tag is the second,
 *          independent signal and it stays.
 *
 * ── WHY THIS FUNCTION EXISTS AT ALL (2026-09-08, the David incident) ─
 *
 * Kemal posted to the live group, untagged, on match day:
 *
 *   "David is OUT voluntarily to switch to 5aside.
 *
 *    Either @Mojib Jalali or @Najib can be in the main squad and the
 *    other can go to bench"
 *
 * MatchTime recorded NOTHING, reasoning "requires an @Match Time tag
 * (interaction contract)". David stayed in the squad and was corrected
 * by hand, twice, on the day.
 *
 * The BENCH exclusion was not the mistake and is not reversed here. The
 * mistake was that the rules were written as `entries.every(...)`, so
 * the answer was a property of the MESSAGE: one clause MatchTime may not
 * act on poisoned every clause it may. A clean, unambiguous "David is
 * OUT" from the one person entitled to say it was thrown away by a
 * sentence about somebody else.
 *
 * This is the fifth production incident in this repo where a compound
 * message lost half its meaning (see the terminal-short-circuit note),
 * and the shape is always the same: a decision taken for the whole
 * message when it belonged to each part. Asking the question per entry
 * is what makes that class unrepresentable here — there is no longer a
 * message-shaped answer for a caller to over-apply.
 *
 * IDENTITY IS NOT THIS FUNCTION'S BUSINESS. It reads `action` and the
 * seat, never `name`: whether a reference is a squad member, a guest or
 * nobody at all is the roster's answer and is resolved downstream.
 */
export function registerForEntryRequiresTag(
  entry: GateRegisterForEntry,
  sender?: GateSender,
): boolean {
  if (entry.action === "IN") return false;
  if (entry.action === "OUT") {
    return !(ADMIN_REPORTED_OUT_IS_TAG_FREE && sender?.senderIsAdmin === true);
  }
  return true;
}

/**
 * Does acting on this verdict REQUIRE an @Match Time tag?
 *
 * No when it's pure self-attendance (the one tag-free action class).
 * No when there's nothing to do (noise/unclear with no writes) — there's
 * no action to gate, so the tag is irrelevant; the existing noise path
 * already keeps MT silent.
 * For a third-party registerFor the answer is `registerForEntryRequiresTag`
 * OR-ed over the entries: an ADD is tag-free for anyone, an admin's OUT
 * is tag-free for them, a BENCH never is. `sender` is read for that and
 * for nothing else; it is optional and its absence means "not an admin",
 * so every existing single-argument caller keeps the old, stricter answer.
 * Yes for everything else action/answer-y: questions, team ops, reminders,
 * payment, score handling.
 *
 * ⚠️ THIS IS A MESSAGE-LEVEL ANSWER AND IT IS ONLY EVER A SUMMARY. "Does
 * anything in here need a tag?" is the right question for a caller
 * deciding whether an UNTAGGED message has anything at all it may act on.
 * It is the WRONG question for deciding what to do with each part, and
 * using it that way is the 2026-09-08 David incident: a `true` here does
 * NOT mean every entry was refused. A caller that acts per entry must ask
 * per entry.
 */
export function actionRequiresTag(v: GateVerdict, sender?: GateSender): boolean {
  if (isSelfAttendanceVerdict(v)) return false;

  const entries = v.registerFor ?? [];
  if (entries.length > 0) {
    // ONE ANSWER PER ENTRY, OR-ed. The message needs a tag when ANY
    // entry in it does — which is the same message-level answer this
    // returned when the rules were written as three `every` clauses, and
    // it is pinned as an exhaustive equivalence test. What the OR does
    // NOT do any more is decide what happens to the entries that did not
    // need one; that is the caller's, per entry.
    return entries.some((e) => registerForEntryRequiresTag(e, sender));
  }

  // Action/answer-y intents MT performs in the group, all of which
  // require an explicit @Match Time tag. NOTE: "score" is deliberately
  // EXCLUDED — a match-result report ("we won 5-2") is a genuine state
  // change MT records (feeds MoM/ratings), closer to self-attendance than
  // to an answer; it stays tag-free (and is separately permission-gated
  // to participants/admins by the score path).
  //
  // "bring_guests_vague" stays listed as a BACKSTOP only. The analyze
  // route peels every unnamed-guest offer off BEFORE this gate (see the
  // UNNAMED-GUEST NAME ASK block in api/whatsapp/analyze/route.ts) and
  // decides it with shouldAskForGuestName in lib/guest-name-ask.ts —
  // the one tag-free thing MT may SAY rather than DO.
  //
  // Why that is a narrow exception and not a hole in the contract
  // (Kemal, 2026-08-31): nobody has been named, so the branch is
  // structurally incapable of writing attendance — its blast radius is
  // one sentence. Against that, staying silent cost the owner a manual
  // "yes pls, can you share the name?" for a guest who was being
  // offered to him. The chattiness the contract exists to prevent is
  // held back by four separate gates in shouldAskForGuestName: the
  // message must READ as an offer (not banter that mentions a mate),
  // the squad must actually have room, the sender must be a resolved
  // member, and each player gets AT MOST ONE ask per match, forever.
  // Anything that fails those gets today's silence.
  const ACTIONY_INTENTS = new Set([
    "question",
    "generate_teams_request",
    "show_teams_request",
    "reminder_request",
    "bulk_payment_credit",
    "bring_guests_vague",
  ]);
  if (ACTIONY_INTENTS.has(v.intent)) return true;

  // Anything left (noise, unclear, conditional_in with no write) has no
  // action to gate.
  return false;
}

/**
 * Deterministic seatbelt: does this message look like a HYPOTHETICAL,
 * PAST-TENSE, or CONDITIONAL self-statement that must NEVER be turned
 * into an attendance write — even if the LLM slips and emits one?
 *
 *   "If I was in the team it won't be ruined"  → hypothetical
 *   "I would have been in" / "I would've been in" → hypothetical
 *   "I was in last week"                        → past tense
 *
 * Kept tight so a plain present-tense "I'm in" / "in" never trips it.
 */
export function looksLikeHypotheticalOrPast(body: string): boolean {
  const t = (body ?? "").toLowerCase();

  // Hypothetical: "if I was/were in", "if I'd be in", "if I was playing".
  if (/\bif\s+i\s+(was|were|wuz|am|'?d|would)\b/.test(t)) return true;

  // Counterfactual: "I would('ve)/I'd have been in", "would have played".
  if (/\bi\s*(would|'?d)\s*('?ve|\s+have|\s+of)?\s+(been|have|play|join)/.test(t)) return true;
  if (/\bwould\s*('?ve|\s+have|\s+of)\s+(been\s+in|played|joined)/.test(t)) return true;

  // Past tense self-attendance: "I was in", "I was playing" (but NOT
  // "I am in"). Guard against "I was in" being a present claim by
  // requiring the literal past-tense "was/were".
  if (/\bi\s+(was|were)\s+(in|playing|out|down|on)\b/.test(t)) return true;

  return false;
}

/** People a member can offer up who are NOT the member. Deliberately a
 *  closed list of PERSON nouns — "my back", "my car", "my shift" must
 *  never match. */
const THIRD_PARTY_NOUN =
  "brothers?|sisters?|bro|sis|mates?|friends?|cousins?|sons?|dad|father|uncle|nephew|" +
  "colleagues?|boys?|lads?|guys?|pals?|neighbou?rs?|flatmates?|housemates?|team-?mates?|kids?";

/** The message's SUBJECT is someone else: it opens with a possessive
 *  person ("my brother", "Dan's mate", "his cousin"). Leading @mentions
 *  and punctuation are stripped first — the production message was
 *  "@Kemal Ediz my brother can play if needed". */
const THIRD_PARTY_SUBJECT = new RegExp(
  `^(?:my|his|her|their|[a-z][a-z'’-]*'s)\\s+(?:${THIRD_PARTY_NOUN})\\b`,
  "i",
);

/** Any first-person pronoun anywhere — the sender putting THEMSELVES in
 *  the picture ("me and my brother", "my mate and I", "put us down"). */
const FIRST_PERSON = /\b(?:i|me|myself|we|us|our)\b/i;

/** Words that can legitimately OPEN the sentence we're testing, so they
 *  must never be swallowed as part of a leading @mention. */
const SUBJECT_STARTER = /^(?:my|his|her|their|our|i|im|me|we|us)\b/i;

/** Drop leading "@Handle Surname" mentions — the production message was
 *  "@Kemal Ediz my brother can play if needed", and the subject we care
 *  about only starts after them. One capitalised token is consumed per
 *  mention (the surname), never a word that could start the sentence. */
function stripLeadingMentions(raw: string): string {
  const tokens = raw.trim().split(/\s+/);
  let i = 0;
  let afterMention = false;
  while (i < tokens.length) {
    const tk = tokens[i];
    if (tk.startsWith("@")) {
      afterMention = true;
      i++;
      continue;
    }
    if (afterMention && /^\p{Lu}/u.test(tk) && !SUBJECT_STARTER.test(tk)) {
      afterMention = false;
      i++;
      continue;
    }
    break;
  }
  return tokens.slice(i).join(" ");
}

/**
 * Deterministic seatbelt: is this message an offer about a THIRD PARTY
 * playing, with the sender nowhere in it?
 *
 *   "my brother can play if needed"          → true  (the production bug)
 *   "my mate could fill in if you're short"  → true
 *   "me and my brother are both in"          → false (sender included)
 *   "in, my mate's coming too"               → false (sender is the subject)
 *   "I'll be the 14th if you're short"       → false (a real self offer)
 *
 * Callers use it ONLY to strip a self IN/BENCH write the LLM should never
 * have emitted (see the analyze route). It is deliberately narrow on both
 * axes — the third-party phrase must be the SUBJECT of the message, and
 * a single first-person pronoun anywhere disarms it — because wrongly
 * dropping a genuine self-registration is worse than the bug it guards.
 */
export function offerIsAboutSomeoneElse(body: string): boolean {
  const t = stripLeadingMentions(body ?? "")
    // Leading punctuation / emoji, so the real subject lands at index 0.
    .replace(/^[^\p{L}]+/u, "")
    .trim();
  if (!t) return false;
  if (FIRST_PERSON.test(t)) return false;
  return THIRD_PARTY_SUBJECT.test(t);
}
