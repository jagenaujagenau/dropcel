/**
 * Subsequence matching for the command palette.
 *
 * Deliberately not a general fuzzy-search library: the corpus here is a few
 * dozen short labels ("Redeploy · landing-page"), typed against by someone who
 * knows what they're looking for. That makes *ranking* the whole job — every
 * candidate a user types toward will match as a subsequence, so the score is
 * what decides whether "dep" surfaces "Deploy Preview" or "landing-page".
 *
 * The scoring rewards, in order of weight: the query appearing as a contiguous
 * substring, matches at a word boundary (start of string, or after a
 * space/-/_/.), and runs of adjacent characters. All three encode the same
 * intuition — that people type prefixes, initials and whole words ("dp" for
 * "Deploy Preview", "land" for "landing-page"), not letters plucked from the
 * middle of words.
 */

export interface FuzzyMatch {
  /** Higher is better. Only meaningful relative to other matches of the same query. */
  score: number;
  /** Indices into the *original* text that were matched, for highlighting. */
  indices: number[];
}

const BOUNDARY_BONUS = 12;
const ADJACENT_BONUS = 8;
/** A match at index 0 is the strongest positional signal — someone typing a
 * prefix means it. Stacks with BOUNDARY_BONUS, which index 0 also earns. */
const START_BONUS = 10;
/**
 * Awarded when the query (ignoring the spaces the user typed as separators)
 * appears verbatim in the text. This is what keeps a genuine substring hit
 * ahead of a scattered one that happens to land on many boundaries — without
 * it "l-a-n-d" outranks "landing-page" for the query "land", since every one
 * of its characters follows a hyphen.
 */
const SUBSTRING_BONUS = 30;
/** Charged per skipped character before the first match, capped, so a hit
 * buried deep in a long label ranks below a shallow one without letting a
 * long string be penalised into oblivion. */
const LEADING_PENALTY = 1;
const MAX_LEADING_PENALTY = 20;
/** Breaks otherwise-equal scores toward the shorter, more specific label. */
const LENGTH_PENALTY = 0.05;

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  return /[\s\-_./]/.test(text[i - 1]!);
}

/** Positional score for matching a query char at `i`, independent of what
 * came before it. */
function charScore(text: string, i: number): number {
  let s = 0;
  if (i === 0) s += START_BONUS;
  if (isBoundary(text, i)) s += BOUNDARY_BONUS;
  return s;
}

/**
 * Best-scoring subsequence alignment of `query` within `text`,
 * case-insensitive.
 *
 * This is a dynamic program over (query index × text index) rather than a
 * greedy left-to-right scan, because greedy gets the cases that matter here
 * wrong: for "dp" against "Deploy Preview" it takes the `p` inside "De**p**loy"
 * — the first one available — and never reaches the `P` of "Preview" that the
 * user actually meant. Choosing the alignment that maximises the score finds
 * the initials. The corpus is dozens of short labels, so the O(q·t²) cost is
 * irrelevant next to getting the ranking right.
 *
 * Returns null when `text` doesn't contain `query` as a subsequence. An empty
 * query matches everything with score 0, which leaves callers free to use it
 * as the "no filter" case and keep their own default ordering.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  // Spaces are separators the user typed for readability ("dep prev"); they
  // shouldn't have to appear in the text.
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (q.length === 0) return { score: 0, indices: [] };
  if (q.length > text.length) return null;

  const t = text.toLowerCase();

  const NEG = -Infinity;
  // best[ti] = score of the best alignment of q[0..qi] whose last character
  // matched at t[ti]. `from[qi][ti]` records the previous text index, for
  // backtracking the highlight positions.
  let prev: number[] = new Array(t.length).fill(NEG);
  const from: Int32Array[] = [];

  for (let qi = 0; qi < q.length; qi++) {
    const cur: number[] = new Array(t.length).fill(NEG);
    const back = new Int32Array(t.length).fill(-1);
    // Running best of prev[0..ti-2] — everything strictly before the
    // immediately-preceding cell, which is handled separately so it can take
    // the adjacency bonus. Keeps each row linear rather than quadratic.
    let bestBefore = NEG;
    let bestBeforeIdx = -1;

    for (let ti = 0; ti < t.length; ti++) {
      if (ti >= 2) {
        const cand = prev[ti - 2]!;
        if (cand > bestBefore) {
          bestBefore = cand;
          bestBeforeIdx = ti - 2;
        }
      }

      if (t[ti] !== q[qi]) continue;

      if (qi === 0) {
        cur[ti] = charScore(text, ti);
        back[ti] = -1;
        continue;
      }

      // Either continue a run (previous char matched at ti-1), or jump from
      // the best earlier position.
      const adjacent = ti >= 1 && prev[ti - 1]! > NEG ? prev[ti - 1]! + ADJACENT_BONUS : NEG;
      if (adjacent >= bestBefore && adjacent > NEG) {
        cur[ti] = adjacent + charScore(text, ti);
        back[ti] = ti - 1;
      } else if (bestBefore > NEG) {
        cur[ti] = bestBefore + charScore(text, ti);
        back[ti] = bestBeforeIdx;
      }
    }

    from.push(back);
    prev = cur;
  }

  // Best final cell = best complete alignment.
  let best = NEG;
  let bestIdx = -1;
  for (let ti = 0; ti < t.length; ti++) {
    if (prev[ti]! > best) {
      best = prev[ti]!;
      bestIdx = ti;
    }
  }
  if (bestIdx === -1) return null;

  const indices: number[] = new Array(q.length);
  let ti = bestIdx;
  for (let qi = q.length - 1; qi >= 0; qi--) {
    indices[qi] = ti;
    ti = from[qi]![ti]!;
  }

  let score = best;
  if (t.includes(q)) score += SUBSTRING_BONUS;
  score -= Math.min(indices[0]! * LEADING_PENALTY, MAX_LEADING_PENALTY);
  score -= text.length * LENGTH_PENALTY;

  return { score, indices };
}
