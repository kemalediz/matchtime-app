# Landing page — season-stats showcase (`35b4b5b`)

Kemal wanted to "showcase the seasonal stats for players as that looks
so cool, badges stats, etc..." on matchtime.ai. He sent three real
screenshots from his Sutton FC stats page.

## Data-sharing constraint

The screenshots had real Sutton players' names + ratings. Kemal said
"blur the names or make up names due to data sharing rules". Rather than
ship blurred raster screenshots (also: scales poorly), I recreated the
screens **pixel-faithfully in code** with **fictional data** ("Riverside
FC", invented players: Alex, Marcus Bell, Danny Cole, Ryan Park, Sam
Reid, etc.). Same UI, sharp on retina, fully responsive, zero real data
exposed.

## What landed in `#player-stats` section

### New: `src/components/landing/stats-showcase.tsx`
- `<StatsShowcase />` — a horizontally-scrollable 3-phone gallery
  (snap-x, centered on desktop) with phone bezels + clipped screens.
  Each phone shows:
  1. **The season dashboard** — 4 stat cards (Avg rating, MoM, Games,
     W-D-L), current-form pill, ratings-over-time line chart (SVG, "You"
     solid blue vs squad-avg dashed, MoM flame marker).
  2. **Leaderboard + Team of the Season** — full 11-row leaderboard with
     ↑↓/new movement, then the green Team of the Season XI card.
  3. **Badges grid + Rivalries** — 8 badges (Iron Man, MoM, etc. — 5
     earned, 3 greyed), nemesis (Ryan Park) and "you own" (Danny Cole).
- `<WrappedCard />` — the Spotify-Wrapped-style share card, faithful
  recreation. Replaces the old hand-coded mock in the same section.

### Wired into `landing-page.tsx`
- Swapped the old inline mock card → `<WrappedCard />`.
- Inserted `<StatsShowcase />` between the hero card and the existing
  8-tile stat-feature grid.

## Verified live

Curl scraped strings present on matchtime.ai:
`"Stats that make players"`, `"Above the Curve"`, `"Riverside FC"`,
`"Squad leaderboard"`, `"Team of the Season"`, `"The season dashboard"`.

Took a viewport screenshot in an isolated Chrome context (signed-out
landing) and sent it to Kemal — looked great.

## Decision worth remembering

For marketing visuals of real product UI, **recreate in code with
fictional data**, don't ship blurred screenshots. Wins on resolution,
responsiveness, and data-sharing compliance.
