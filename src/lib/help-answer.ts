/**
 * ONE HELP ANSWER FOR A CLUB (2026-10-28), whichever place asked: the
 * players' group (pipeline/answer-batch.ts), the admin group
 * (admin-group-question.ts) or a DM (dm-help.ts). The topic is what the
 * question extractor named (`HelpRequest`); this reads the club's pool and
 * partner clubs (`help-club-facts.ts`) and writes `buildHelpReply`'s words
 * for the audience. Lazy imports: `onboarding-conversation.ts` pulls in the
 * database and the onboarding flow, and the pipeline only needs its copy.
 *
 * A topic's answer ends with the way back to the menu (2026-11-10, Kemal);
 * the menu itself does not. The admin group's own two topics (finding
 * players, graphics) read here as the nearest players' topic
 * (`playersHelpTopic`); the admin group answers them with its own lines.
 */
import type { OrgFeatures } from "./org-features";
import { playersHelpTopic, type HelpRequest } from "./pipeline/types";
import type { HelpAdminPage, HelpAudience } from "./onboarding-conversation";
import type { HelpClubFacts } from "./help-club-facts";

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
  /** Answered by DM: "help teams" without the tag. */
  dm?: boolean;
  /** Answered in the admin group (admin-group-help.ts). */
  adminGroup?: boolean;
  /** Leave off the way back to the menu: the caller adds its own. */
  noBackLine?: boolean;
  /** The club's pool and partner clubs, already read (tests, or a caller
   *  that has them); otherwise read here. */
  club?: HelpClubFacts;
}): Promise<string> {
  const [m, facts, badges, { t }] = await Promise.all([
    import("./onboarding-conversation"),
    import("./help-club-facts"),
    import("./badge-rules"),
    import("./i18n/t"),
  ]);
  const club = args.club ?? (await facts.loadHelpClubFacts(args.orgId, await args.poolEnv()));
  const topic = args.req.topic === null ? null : playersHelpTopic(args.req.topic);
  const badge = args.req.badge ? badges.BADGES.find((b) => b.key === args.req.badge)?.label : undefined;
  const lang = args.features.language;
  const body = m.buildHelpReply(topic, m.helpFeaturesFrom(args.features, club), lang, {
    audience: args.audience,
    ...(args.links ? { links: args.links } : {}),
    ...(badge ? { badgeQuery: badge } : {}),
    ...(args.adminGroupLinked ? { adminGroupLinked: true } : {}),
    ...(args.dm ? { dm: true } : {}),
    ...(args.adminGroup ? { adminGroup: true } : {}),
  });
  if (topic === null || args.noBackLine) return body;
  return `${body}\n\n${t(lang).help_back({ dm: args.dm === true })}`;
}
