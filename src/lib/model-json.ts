/**
 * Reading a MODEL'S answer, never a person's words (2026-10-30). A short
 * classifier answers with one JSON object, but now and then it writes one,
 * says "Wait, that output included an extra field. Correcting...", and
 * writes another (seen live on the DM reader). One greedy `{...}` across
 * both parses as nothing; the first complete object is the answer.
 */
/** The first balanced `{...}` in a model answer that parses, or null. */
export function firstJsonObject(raw: string): unknown {
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

