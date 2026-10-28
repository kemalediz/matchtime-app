/**
 * WHERE THE PLAYERS COME FROM, IN HQ: THE I/O (2026-10-28). The rules are
 * `ask-source-rules.ts`; this reads what the club has and logs MatchTime's
 * question in HQ, the way every HQ question is logged
 * (`recordMatchTimeQuestion`), so the answer is found by the safe-YES
 * rule's positional test and read by the model in `admin-group-understand.ts`.
 *
 * It calls no model, so it may read the pool's switch (`pool/flags.ts`,
 * pure) without breaking `pool/__tests__/source-guard.test.ts`. Never
 * throws: a failed read is "nothing besides the players' group", which is
 * what an unnamed ask did before.
 */
import { db } from "./db";
import { recordMatchTimeQuestion } from "./admin-group-log";
import { loadPartnerAskSettings } from "./club-partnership";
import { activePartnerChoices } from "./partner-ask-words";
import { poolOffersOpenForClub } from "./pool/flags";
import { t } from "./i18n/t";
import { askSourceRef, type RecruitSource, type SourcesAvailable } from "./ask-source-rules";

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

/** Ask the organisers, once, which they mean; logged as MatchTime's question. */
export async function askWhichSource(args: {
  orgId: string;
  lang: string | null;
  options: RecruitSource[];
  now: Date;
}): Promise<string> {
  const text = t(args.lang).hq_ask_source({ options: args.options });
  await recordMatchTimeQuestion({ orgId: args.orgId, askRef: askSourceRef(args.options), text, now: args.now });
  return text;
}
