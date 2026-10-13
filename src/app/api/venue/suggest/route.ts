/**
 * GET /api/venue/suggest?q=<typed text>&session=<token>&lang=<en|tr>
 *
 * The venue box's suggestions (2026-10-13). The browser never talks to
 * Google and never holds a key: it asks here, and this asks Google's
 * Places API (New) Autocomplete on the server (src/lib/places.ts).
 *
 * Signed-in only (any signed-in person: on /create-org there is no club
 * yet). The middleware already sends a caller with no session cookie to
 * /login; the 401 below is for a cookie that is not a session. It answers
 *
 *     { "suggestions": [ { "placeId", "primary", "secondary" }, ... ] }
 *
 * with at most five suggestions.
 *
 * IT ANSWERS AN EMPTY LIST, WITH A 200, FOR EVERYTHING THAT GOES WRONG:
 * fewer than three characters, a pasted link, no session token, the
 * person's hourly cap used up, no key, Google slow (2.5 seconds), down,
 * refusing or answering nonsense. The box then behaves as a plain text
 * box. Creating a club or saving a venue never waits for, or depends on,
 * this route.
 *
 * A suggestion carries no position. When one is picked, the form submits
 * its place id and the SERVER asks Google where that place is
 * (src/lib/venue-location.ts): nothing here is ever trusted back.
 *
 * LOGS: the user's id, a count and a reason code. Never the typed text,
 * a place name, an address, a URL, a session token or the key.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { placesAutocomplete, placesConfigured } from "@/lib/places";
import { claimSuggestCall } from "@/lib/venue-suggest-cap";
import { suggestLanguage, suggestQuery, validSessionToken, type VenueSuggestion } from "@/lib/venue-suggest-rules";

export const dynamic = "force-dynamic";

function answer(suggestions: VenueSuggestion[], status = 200): NextResponse {
  return NextResponse.json({ suggestions }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return answer([], 401);

  try {
    const params = new URL(request.url).searchParams;
    const input = suggestQuery(params.get("q"));
    const sessionToken = params.get("session");
    // Nothing to ask: not counted against the cap, nothing sent.
    if (!input || !validSessionToken(sessionToken)) return answer([]);
    if (!placesConfigured()) return answer([]);

    if (!(await claimSuggestCall(userId))) {
      console.debug(`[venue-suggest] user=${userId} outcome=capped`);
      return answer([]);
    }

    const got = await placesAutocomplete({ input, sessionToken, languageCode: suggestLanguage(params.get("lang")) });
    if (got.status !== "ok") {
      console.warn(`[venue-suggest] user=${userId} outcome=error reason=${got.status === "error" ? got.code : got.status}`);
      return answer([]);
    }
    console.debug(`[venue-suggest] user=${userId} outcome=ok count=${got.suggestions.length}`);
    return answer(got.suggestions);
  } catch (err) {
    // The name only: an error's message can carry what was typed.
    console.error(`[venue-suggest] user=${userId} outcome=error reason=exception (${(err as Error)?.name ?? "error"})`);
    return answer([]);
  }
}
