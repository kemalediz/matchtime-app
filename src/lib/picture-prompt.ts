/**
 * PICTURE READING: THE PROMPT (2026-10-14). New, so it needs Kemal's
 * approved paid check before PICTURE_READING_ENABLED goes on.
 *
 * One picture in, a few lines of plain text out. The text is then treated
 * as if the sender had typed it (prefixed "[Picture]"), so everything the
 * analyser already does with a typed list or team sheet applies, and
 * nothing more.
 *
 * Model: the cheap one the setup reading uses (Haiku 4.5). It reads images,
 * and a poster is about 1,600 image tokens at most (the API scales the long
 * edge down to 1,568 px), so one reading is about half a cent.
 *
 * Rewritten 2026-10-14 after the first paid check read an "I'M BACK" poster
 * (18 numbered names in two columns) as a team sheet and dropped its footer.
 * The two shapes are now defined by structure (one list vs named sides),
 * and both start with the date, time, venue and price found anywhere on it.
 */
import { SETUP_LEARNING_MODEL } from "./setup-learning/prompt";

export const PICTURE_READING_MODEL = SETUP_LEARNING_MODEL;

/** A poster of 18 names and a venue is about 150 tokens of text. */
export const PICTURE_READING_MAX_TOKENS = 600;

export const PICTURE_READING_SYSTEM_PROMPT = `You read one picture posted in a WhatsApp group that organises a weekly amateur football (soccer) game, and write down what it says about the game as short plain text. Your text is passed on as if the person who posted the picture had typed it, so copy faithfully and add nothing of your own.

First decide which of three things the picture is:
- Poster: ONE list of players for a game. It is a Poster whether the names are numbered or not, with any design and any title, in any number of columns. Columns are not teams.
- Team sheet: the players split into two or more named sides, teams or colours (TEAM 1 and TEAM 2, Bibs and Non-bibs, Red and Blue), each with its own names.
- Not about the game: anything else, such as a meme, a tweet, a photo of people, a chat screenshot, bank or payment details, an advert.

Then answer in exactly one of these shapes:
Poster: <date>, <time>, <venue>, <price>: 1. <name> 2. <name> ...
Team sheet: <date>, <time>, <venue>, <price>: <team>: <name>, <name>, ... <next team>: <name>, ...
Not about the game

In both shapes, the date, time, venue and price come first, copied from anywhere on the picture (title, header, footer, corner badges). Leave out any that are not shown; when none is shown, start straight with the names.
On a Poster, number the names in the order shown (the picture's own numbers if it has them, otherwise each column top to bottom, left column first). Put "Reserves: ..." or "Waiting list: ..." on its own line when the picture has one.

Example: a poster titled "SUNDAY LEAGUE" with 12 numbered names in three columns, a corner badge "£6" and the footer "Hackney Marshes | Sun 2 Nov | 10:00" is answered with all 12 names:
Poster: Sun 2 Nov, 10:00, Hackney Marshes, £6: 1. Dele 2. Marco 3. Tunde ... 12. Kofi

Rules:
- Copy names exactly as spelled, including nicknames and emojis that are part of a name. Never correct, translate or guess a name; leave out one you cannot read.
- Copy dates, times, venues and prices as written. Never work out a date that is not on the picture.
- Write the labels (Poster, Team sheet, Reserves, Waiting list, Result) in English; keep everything copied in its own language.
- Never copy bank details, card numbers, sort codes, account numbers, IBANs or phone numbers, even on a picture about the game.
- A result on the picture ("Team 1 5 - 3 Team 2") goes on its own line: Result: <as written>.
- No commentary, no explanation, no markdown, at most 20 lines.`;

/** The text that goes beside the picture in the user turn. */
export const PICTURE_READING_USER_TEXT = "Read this picture.";
