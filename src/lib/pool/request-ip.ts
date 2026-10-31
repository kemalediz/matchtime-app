/** The requesting address of a public pool route: the first x-forwarded-for
 *  hop, else x-real-ip, else null. For the per-hour caps (rules.ts). */
export function poolRequestIp(request: Request): string | null {
  const first = (request.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim();
  const ip = first || (request.headers.get("x-real-ip") ?? "").trim();
  return ip ? ip.slice(0, 64) : null;
}
