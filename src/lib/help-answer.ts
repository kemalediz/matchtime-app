/**
 * ONE HELP ANSWER FOR A CLUB (2026-10-28), whichever place asked: the
 * players' group (pipeline/answer-batch.ts), the admin group
 * (admin-group-question.ts) or a DM (dm-help.ts). The topic is what the
 * question extractor named (`HelpRequest`); this reads the club's pool and
 * partner clubs (`help-club-facts.ts`) and writes `buildHelpReply`'s words
 * for the audience. Lazy imports: `onboarding-conversation.ts` pulls in the
 * database and the onboarding flow, and the pipeline only needs its copy.
 */
import type { OrgFeatures } from "./org-features";
import type { HelpRequest } from "./pipeline/types";
import type { HelpAdminPage, HelpAudience } from "./onboarding-conversation";

export async function clubHelpReply(args: {
  orgId: string;
  req: HelpRequest;
  features: OrgFeatures;
  audience: HelpAudience;
  /** Resolves the pool switch as the request does (`pool/switch-env.ts`). */
  poolEnv: () => Promise<Record<string, string | undefined>>;
  /** Signed-in links, an organiser's own DM only. */
  links?: Partial<Record<HelpAdminPage, string>>;
  adminGroupLinked?: boolean;
}): Promise<string> {
  const [m, facts, badges] = await Promise.all([
    import("./onboarding-conversation"),
    import("./help-club-facts"),
    import("./badge-rules"),
  ]);
  const club = await facts.loadHelpClubFacts(args.orgId, await args.poolEnv());
  const badge = args.req.badge ? badges.BADGES.find((b) => b.key === args.req.badge)?.label : undefined;
  return m.buildHelpReply(args.req.topic, m.helpFeaturesFrom(args.features, club), args.features.language, {
    audience: args.audience,
    ...(args.links ? { links: args.links } : {}),
    ...(badge ? { badgeQuery: badge } : {}),
    ...(args.adminGroupLinked ? { adminGroupLinked: true } : {}),
  });
}
