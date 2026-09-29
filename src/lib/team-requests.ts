/**
 * WHEN MATCHTIME MAY TOUCH THE TEAM SHEET, READ FROM THE TEXT IN CODE.
 *
 * Written 2026-09-29 after the Sutton FC incident of Thu 24 Sep 22:51
 * BST. Straight after a chemistry table, the admin joked "@Match Time put
 * me in the same team with these guys in the match 😀". The router sent
 * it to `balancer`, the teams extractor read it as `generate` with a
 * pairing, and `team-ops-engine-batch.ts` ran the balancer for Tue 29
 * Sep, five days early. A minute later "@Match Time delete these teams,
 * early to form them, there is still 5 days" went to `admin_ops`, came
 * back `other`, and nothing happened and nobody was told. The noon cron
 * then published the stale sheet.
 *
 * Kemal's rule, which this file makes checkable:
 *
 *   • Teams are built ONLY when somebody clearly asks for the teams to
 *     be built, made, generated or balanced (English or Turkish), and
 *     ONLY on match day (the London calendar date of the match).
 *   • A pairing preference ("put me with X") is not a build request.
 *   • An admin can clear the teams.
 *
 * WHY IN CODE AND NOT IN THE EXTRACTOR PROMPT. The extractor's job is to
 * say what a message contains, and "generate + a pairing" is a fair
 * reading of a joke about pairings. Whether that reading is allowed to
 * rewrite every `TeamAssignment` on a match is a policy, and policy
 * belongs where it can be unit tested without a model call. These
 * checks run AFTER the extractor, as a second, independent gate: the
 * model must say `generate` AND the words must contain an explicit ask.
 * Missing a real ask costs one polite reply; honouring a joke cost the
 * club its team sheet.
 *
 * Every function here is pure. Nothing imports the database.
 */

/** Europe/London calendar date, "YYYY-MM-DD". DST-safe via Intl. */
export function londonDateKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Is `now` on the London calendar date of the match's kickoff? */
export function isMatchDay(matchDate: Date, now: Date): boolean {
  return londonDateKey(matchDate) === londonDateKey(now);
}

// ── Normalisation ────────────────────────────────────────────────────

function normalise(body: string): string {
  return body
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/@\s*match\s*time\b/gi, " ")
    .toLocaleLowerCase("tr")
    .replace(/\s+/g, " ")
    .trim();
}

/** The English view: Turkish lower-casing turns "I" into a dotless "ı",
 *  so "GENERATE THE TEAMS I SAID" would lose its English spelling. The
 *  English patterns read this copy; the Turkish ones read the original. */
function englishView(n: string): string {
  return n.replace(/ı/g, "i");
}

// ── English ──────────────────────────────────────────────────────────

/** What a message calls the teams. Plural or a sheet: "put me in the
 *  same team" is about ONE team and is never a build or a clear. */
const EN_TEAMS = String.raw`(?:teams|sides|line-?ups|line ups|team ?sheet)`;

/** Words allowed between the verb and the noun. A CLOSED list, so
 *  "remove me from the teams" (a person, not the sheet) and "make sure I
 *  am in the same team" never match. */
const EN_GAP = String.raw`(?:(?:the|these|those|this|current|existing|today's|todays|tonight's|tonights|all|our|both|new|fresh|balanced|some|2|two|old|generated|early|premature|whole)\s+){0,3}`;

const EN_BUILD_VERBS = String.raw`(?:re-?generate|generate|re-?make|make|re-?build|build|re-?balance|balance|re-?create|create|pick|split|re-?shuffle|shuffle|re-?do|form|organi[sz]e|arrange|prepare|draw up|set ?up|sort out|sort|work out|put together)`;

const EN_CLEAR_VERBS = String.raw`(?:delete|clear|scrap|remove|cancel|reset|wipe|undo|bin|discard|erase|ditch|get rid of|throw away|throw out)`;

const EN_NEGATION = /\b(?:don't|dont|do not|never|no need to|not|stop|without)\s+(?:\S+\s+){0,2}$/;

/** "come (up) with an alternative" about the teams: a real production
 *  phrasing of "build them again". Only when the message is about the
 *  teams at all. */
const EN_ALTERNATIVE = /\b(?:an? )?(?:alternative|another set|different (?:teams|sides|line-?ups))\b/;

function englishVerbNounMatch(text: string, verbs: string): boolean {
  const re = new RegExp(String.raw`\b${verbs}\s+${EN_GAP}${EN_TEAMS}\b`, "g");
  for (const m of text.matchAll(re)) {
    const before = text.slice(0, m.index ?? 0);
    if (EN_NEGATION.test(before)) continue;
    return true;
  }
  return false;
}

// ── Turkish ──────────────────────────────────────────────────────────

/** "takım", "takımlar", "takımları", "takımı". */
const TR_TEAMS = String.raw`takım\p{L}*`;
const TR_GAP = String.raw`(?:(?:yeniden|tekrar|bir|daha|şimdi|henüz|artık|hemen|lütfen|bugünkü|bu|yine)\s+){0,2}`;

const TR_BUILD_STEMS = ["kur", "oluştur", "yap", "ayarla", "belirle", "dengele", "karıştır", "hazırla", "çıkar", "ayır", "böl"];
const TR_CLEAR_STEMS = ["sil", "iptal", "temizle", "kaldır", "boz", "sıfırla"];

/** The negative imperative: "kurma", "kurmayın", "kurmasın",
 *  "kurmayalım". What follows the stem, never a whole word. */
const TR_NEGATIVE_SUFFIX = /^m[ae](?:y[ıi]n(?:[ıi]z)?|s[ıi]n|yal[ıi]m|yel[ıi]m)?$/;

function turkishVerbAfterTeams(text: string, stems: string[]): boolean {
  const re = new RegExp(String.raw`${TR_TEAMS}\s+${TR_GAP}(\p{L}+)(?:\s+(\p{L}+))?`, "gu");
  for (const m of text.matchAll(re)) {
    const word = m[1];
    const next = m[2] ?? "";
    for (const stem of stems) {
      if (!word.startsWith(stem)) continue;
      const rest = word.slice(stem.length);
      if (TR_NEGATIVE_SUFFIX.test(rest)) continue;
      // "iptal etme" is the negative of "iptal et".
      if (stem === "iptal" && /^etme(?:y[ıi]n|s[ıi]n)?$/.test(next)) continue;
      return true;
    }
  }
  return false;
}

// ── The two readings ─────────────────────────────────────────────────

/**
 * Does the message CLEARLY ask for the teams to be built (or rebuilt)?
 *
 * True for "generate the teams", "make teams", "set up the teams again",
 * "some are not happy with the teams, could you please come with an
 * alternative?", "takımları kur", "takımları yeniden oluştur".
 *
 * False for a pairing ("put me in the same team with these guys"), a
 * negated ask ("do not regenerate the teams"), a read ("show the
 * teams"), a rename or a swap.
 */
/** "teams please" as the WHOLE message: nothing else in it, so it can
 *  only be the ask. (A bare "teams?" is left out: it reads as "what are
 *  the teams?" as easily as "build them".) */
const EN_TEAMS_PLEASE = /^(?:the\s+)?(?:new\s+)?teams(?:\s+(?:please|pls|plz|now|asap|mate|guys))+\s*[.!]*$/;

/** "do the teams": "do" is too common a verb for the general list ("do
 *  these teams look fair?" must never rebuild), so it counts only as
 *  "do (the) teams" ending the clause or followed by a polite word. */
const EN_DO_THE_TEAMS = /\bdo\s+(?:the\s+)?(?:teams|line-?ups)\s*(?:$|[.,!?]|please\b|pls\b|now\b|again\b|for\b|tonight\b|today\b)/;

export function isExplicitTeamBuildRequest(body: string): boolean {
  const n = normalise(body);
  const en = englishView(n);
  if (englishVerbNounMatch(en, EN_BUILD_VERBS)) return true;
  if (EN_TEAMS_PLEASE.test(en)) return true;
  const doMatch = EN_DO_THE_TEAMS.exec(en);
  if (doMatch && !EN_NEGATION.test(en.slice(0, doMatch.index))) return true;
  if (new RegExp(String.raw`\b${EN_TEAMS}\b`).test(en) && EN_ALTERNATIVE.test(en)) {
    // Not negated: "we don't need an alternative" is not an ask.
    const m = EN_ALTERNATIVE.exec(en);
    if (m && !EN_NEGATION.test(en.slice(0, m.index)) && !/\bneed\s+$/.test(en.slice(0, m.index))) {
      return true;
    }
  }
  return turkishVerbAfterTeams(n, TR_BUILD_STEMS);
}

/**
 * Does the message ask for the existing teams to be deleted / cleared /
 * scrapped (English or Turkish)?
 *
 * A message that ALSO clearly asks to build new teams is not a clear:
 * "scrap the teams and generate new teams" is a regenerate, which the
 * build path handles and which replaces the sheet on match day.
 */
export function isClearTeamsRequest(body: string): boolean {
  const n = normalise(body);
  const en = englishView(n);
  const clears = englishVerbNounMatch(en, EN_CLEAR_VERBS) || turkishVerbAfterTeams(n, TR_CLEAR_STEMS);
  if (!clears) return false;
  return !isExplicitTeamBuildRequest(body);
}
