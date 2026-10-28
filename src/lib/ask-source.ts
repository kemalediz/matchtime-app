/**
 * WHERE THE PLAYERS COME FROM: THE I/O (2026-10-28). The rules are
 * `ask-source-rules.ts`; this reads what the club has and logs MatchTime's
 * question where it was asked: in HQ the way every HQ question is logged
 * (`recordMatchTimeQuestion`), read back by `admin-group-understand.ts`; in
 * the players' group of a club with no HQ (`recordGroupQuestion`), read
 * back by `ask-source-group.ts`. Either way the answer is found by the
 * safe-YES rule's positional test and read by the model.
 *
 * It calls no model, so it may read the pool's switch (`pool/flags.ts`,
 * pure) without breaking `pool/__tests__/source-guard.test.ts`. Never
 * throws: a failed read is "nothing besides the players' group", which is
 * what an unnamed ask did before.
 */
import { db } from "./db";
import { recordGroupQuestion, recordMatchTimeQuestion } from "./admin-group-log";
import { loadPartnerAskSettings } from "./club-partnership";
import { activePartnerChoices } from "./partner-ask-words";
import { poolOffersOpenForClub } from "./pool/flags";
import { t } from "./i18n/t";
import { askSourceRef, offerAfterNobodyLeft, type RecruitSource, type SourcesAvailable } from "./ask-source-rules";

type Env = Record<string, string | undefined>;

/**
 * What this club may be asked to look in besides its own players' group:
 * an active partner club with asking switched on (`resolvePartnerRef`
 * refuses an ask with it off), and the pool open for the club (the
 * platform switch, as this request read it, and the club's own flag).
 */
export async function sourcesAvailable(orgId: string, env?: Env): Promise<SourcesAvailable> {
  const [partners, settings, org] = await Promise.all([
    activePartnerChoices(orgId).catch(() => []),
    loadPartnerAskSettings(orgId).catch(() => null),
    db.organisation.findUnique({ where: { id: orgId }, select: { featurePlayerPool: true } }).catch(() => null),
  ]);
  return {
    partners: partners.length > 0 && !!settings?.when && settings.when !== "off",
    pool: poolOffersOpenForClub(org, env),
  };
}

/** Where MatchTime asked: the admin group (HQ) or the players' group. */
export type AskedIn = "hq" | "group";

async function recordQuestion(where: AskedIn, args: { orgId: string; askRef: string; text: string; now: Date }): Promise<void> {
  if (where === "group") await recordGroupQuestion(args);
  else await recordMatchTimeQuestion(args);
}

/** Ask the organisers, once, which they mean; logged as MatchTime's question. */
export async function askWhichSource(args: {
  orgId: string;
  lang: string | null;
  options: RecruitSource[];
  now: Date;
  /** Default "hq". */
  where?: AskedIn;
}): Promise<string> {
  const where = args.where ?? "hq";
  const text = t(args.lang).hq_ask_source({ options: args.options, inGroup: where === "group" });
  await recordQuestion(where, { orgId: args.orgId, askRef: askSourceRef(args.options), text, now: args.now });
  return text;
}

/**
 * The recruit DM found nobody new among the club's recent players: the
 * line that says so, and, when the club has partner clubs or the pool, the
 * offer to ask them, logged as MatchTime's question so "the pool" or
 * "both" answers it (2026-10-28, after "No new players to ask for Football
 * 9-a-side right now."). Never throws: a failed read is the plain line.
 */
export async function nobodyLeftReply(args: {
  orgId: string;
  lang: string | null;
  matchName: string;
  now: Date;
  where: AskedIn;
  env?: Env;
}): Promise<{ text: string; offered: RecruitSource[] }> {
  const s = t(args.lang);
  const offered = offerAfterNobodyLeft(await sourcesAvailable(args.orgId, args.env).catch(() => ({ partners: false, pool: false })));
  if (offered.length === 0) return { text: s.recruit_nobody_new({ matchName: args.matchName }), offered };
  const text = s.recruit_nobody_left_ask({ matchName: args.matchName, options: offered as Array<"partners" | "pool"> });
  await recordQuestion(args.where, { orgId: args.orgId, askRef: askSourceRef(offered), text, now: args.now });
  return { text, offered };
}
