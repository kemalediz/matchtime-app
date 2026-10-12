import { z } from "zod";

/**
 * Onboarding no longer collects positions (positions are now per-activity,
 * set when the user first attends a match for that activity).
 */
export const onboardingSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  phoneNumber: z.string().optional(),
});

export const activitySchema = z.object({
  name: z.string().min(2),
  sportId: z.string().min(1, "Pick a sport"),
  dayOfWeek: z.number().min(0).max(6),
  time: z.string().regex(/^\d{2}:\d{2}$/, "Time must be HH:mm format"),
  venue: z.string().min(2),
  deadlineHours: z.number().min(1).max(48).default(5),
  matchDurationMins: z.number().min(20).max(180).default(60),
  ratingWindowHours: z.number().min(1).max(168).default(48),
});

export const sportSchema = z.object({
  name: z.string().min(2),
  playersPerTeam: z.number().min(1).max(20),
  positions: z.array(z.string().min(1)).min(1, "At least one position"),
  teamLabels: z.tuple([z.string().min(1), z.string().min(1)]),
  mvpLabel: z.string().min(1),
  balancingStrategy: z.enum(["position-aware", "rating-only", "role-quota"]).default("position-aware"),
  positionComposition: z.record(z.string(), z.number().min(0)).optional(),
  preset: z.string().optional(),
});

export const playerPositionsSchema = z.object({
  activityId: z.string(),
  positions: z.array(z.string().min(1)).min(1, "Select at least one position"),
});

export const ratingSchema = z.object({
  ratings: z.array(
    z.object({
      playerId: z.string(),
      score: z.number().min(1).max(10),
    })
  ),
});

export const momVoteSchema = z.object({
  playerId: z.string(),
});

export const matchScoreSchema = z.object({
  redScore: z.number().min(0),
  yellowScore: z.number().min(0),
});

export const signUpSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * A club's name as the club setup form takes it: trimmed, 2 to 60
 * characters. One rule for creating a draft club (`createSelfJoinClub`)
 * and for renaming one (`renameDraftClub`).
 */
export const CLUB_NAME_MIN = 2;
export const CLUB_NAME_MAX = 60;
export const clubNameSchema = z.string().trim().min(CLUB_NAME_MIN).max(CLUB_NAME_MAX);

export const createOrgSchema = z.object({
  name: z.string().min(2, "Organisation name must be at least 2 characters"),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/, "URL slug must be lowercase letters, numbers and hyphens only"),
});

export const seedRatingSchema = z.object({
  players: z.array(
    z.object({
      userId: z.string(),
      rating: z.number().min(1).max(10),
    })
  ),
});
