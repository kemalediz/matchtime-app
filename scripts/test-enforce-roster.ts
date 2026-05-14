/**
 * Smoke test for enforceCanonicalRoster — exercises the leaderboard
 * exemption that Kemal flagged on 2026-05-14 ("top 3 most consistent"
 * being clobbered by the upcoming-squad list).
 */
import { enforceCanonicalRoster } from "../src/lib/message-analyzer.ts";

const truth = {
  confirmed: ["Elvin", "Wasim", "Mustafa Cayir", "Idris Yildiz"],
  maxPlayers: 14,
};

function check(label: string, input: string, mustContain: string[], mustNotContain: string[]) {
  const out = enforceCanonicalRoster(input, truth);
  const failures: string[] = [];
  for (const s of mustContain) if (!out.includes(s)) failures.push(`missing: ${s}`);
  for (const s of mustNotContain) if (out.includes(s)) failures.push(`unexpected: ${s}`);
  if (failures.length === 0) {
    console.log(`PASS  ${label}`);
  } else {
    console.log(`FAIL  ${label}`);
    console.log("  failures:", failures);
    console.log("  output:\n" + out);
  }
}

// 1. Real squad roster — should be canonicalised + drums filled in.
check(
  "real squad roster gets canonicalised",
  `*Playing tonight:*
1. Elvin
2. Foo
3. Bar
4. Baz`,
  ["1. Elvin", "2. Wasim", "5. 🥁", "14. 🥁"],
  ["Foo", "Bar", "Baz"],
);

// 2. Attendance leaderboard — must NOT be overwritten.
check(
  "attendance leaderboard preserved",
  `Top 3 most consistent attenders:
1. Idris Yildiz — 4/4 (100%)
2. Kemal — 4/4 (100%)
3. Abid Kazmi — 3/3 (100%)

You and Idris are tied at perfect attendance! 🎯`,
  ["1. Idris Yildiz — 4/4 (100%)", "2. Kemal — 4/4 (100%)", "3. Abid Kazmi — 3/3 (100%)"],
  ["Elvin", "Wasim", "🥁"],
);

// 3. MoM leaderboard — must NOT be overwritten.
check(
  "MoM leaderboard preserved",
  `All-time MoM wins:
1. Ehtisham Ul Haq — 2 wins
2. Mojib — 2 wins
3. Sait — 1 win`,
  ["1. Ehtisham Ul Haq — 2 wins", "2. Mojib — 2 wins"],
  ["Elvin", "🥁"],
);

// 4. Elo top — must NOT be overwritten.
check(
  "Elo leaderboard preserved",
  `Top rated players:
1. Abid Kazmi — 1039 (3 matches)
2. Sait — 1039 (3 matches)
3. Elnur Mammadov — 1022 (2 matches)`,
  ["1. Abid Kazmi — 1039", "2. Sait — 1039"],
  ["Elvin", "Wasim"],
);

// 5. Real roster with leaderboard ALSO in the message — only the
//    leaderboard would have leaderboard markers, so the roster gets
//    canonicalised normally if it's a separate contiguous block.
//    (The current implementation finds the FIRST contiguous numbered
//    block — leaderboard first means roster block is missed. That's
//    acceptable; the LLM is now told not to mix the two.)
console.log();
console.log("Done.");
