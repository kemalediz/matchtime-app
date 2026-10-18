/**
 * For stubbed router models in tests: the model is shown, and answers with,
 * short ids (m1, m2, ...; `shortRouterIds`), never the real message ids. A
 * test that scripts the answer by real id has it rewritten here to the
 * short id each real id was sent as (`ModelRequest.shortIds`).
 */
import type { ModelRequest } from "../llm";

export function asShortIds(answer: string, req: ModelRequest): string {
  const shortOf = new Map(Object.entries(req.shortIds ?? {}).map(([s, real]) => [real, s]));
  const parsed = JSON.parse(answer) as { routes?: Array<{ id?: unknown; route?: unknown }> };
  if (!Array.isArray(parsed.routes)) return answer;
  return JSON.stringify({
    ...parsed,
    routes: parsed.routes.map((r) => (typeof r.id === "string" && shortOf.has(r.id) ? { ...r, id: shortOf.get(r.id) } : r)),
  });
}
