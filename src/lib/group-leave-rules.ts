/**
 * WAS THIS WHATSAPP LEAVE AN ORGANISER'S REMOVAL? (Kemal, 2026-10-31.)
 *
 * The Pi reports who removed whom on a group-leave (`whatsapp-bot/src/
 * group-leave.ts`: the remover's phone and LID, resolved like a bot-added
 * adder). The route resolves those to MatchTime accounts
 * (`resolveSenderUserIds`) and asks this. Yes only when:
 *   - the remover is known (an old Pi payload, or a number MatchTime does
 *     not know, is never an organiser's removal: today's behaviour);
 *   - he is NOT the person who left (a person leaving himself, organisers
 *     included, is not a removal; nor is a remover whose number and LID
 *     resolve to two accounts, one of them the leaver's);
 *   - he is an OWNER or ADMIN of THIS club. A WhatsApp group admin who is
 *     not one of the club's organisers does not count.
 *
 * Then the route stamps `Membership.removedByOrganiserAt`
 * (`guest-door-rules.ts`). Pure.
 */
export function leaveIsOrganiserRemoval(a: {
  removerUserIds: readonly string[];
  leaverUserId: string;
  organiserUserIds: ReadonlySet<string>;
}): boolean {
  if (a.removerUserIds.length === 0) return false;
  if (a.removerUserIds.includes(a.leaverUserId)) return false;
  return a.removerUserIds.some((id) => a.organiserUserIds.has(id));
}
