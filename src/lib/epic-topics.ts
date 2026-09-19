import chapters from "../../data/mahabharata-chapters.json";

export type EpicChapter = {
  id: number;
  title: string;
  description: string;
  source: "mahabharata" | "ramayana" | "gita";
};

export type MatchedTopic = {
  chapter: EpicChapter;
  score: number;
  /** Short phrase to steer artwork search and image generation. */
  visualFocus: string;
};

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "his",
  "her",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "our",
  "the",
  "their",
  "to",
  "who",
  "what",
  "when",
  "where",
  "with",
  "more",
  "than",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

/**
 * Score a chapter against the question by overlapping content words.
 * Title hits weigh more than description hits so "Karna" beats a vague chapter blurb.
 */
export function scoreChapter(question: string, chapter: EpicChapter): number {
  const queryTokens = new Set(tokenize(question));

  if (queryTokens.size === 0) {
    return 0;
  }

  const titleTokens = tokenize(chapter.title);
  const descriptionTokens = tokenize(chapter.description);

  let score = 0;

  for (const token of titleTokens) {
    if (queryTokens.has(token)) {
      score += 3;
    }
  }

  for (const token of descriptionTokens) {
    if (queryTokens.has(token)) {
      score += 1;
    }
  }

  return score;
}

/** Pick the best Mahabharata chapter topic for a question, or null when nothing overlaps. */
export function matchEpicTopic(
  question: string,
  source?: "mahabharata" | "ramayana" | "gita" | "",
): MatchedTopic | null {
  if (source && source !== "mahabharata") {
    return null;
  }

  let best: MatchedTopic | null = null;

  for (const chapter of chapters as EpicChapter[]) {
    const score = scoreChapter(question, chapter);

    if (score < 2) {
      continue;
    }

    if (!best || score > best.score) {
      best = {
        chapter,
        score,
        visualFocus: `${chapter.title}: ${chapter.description}`,
      };
    }
  }

  return best;
}

/** Append topic focus to a retrieval/generation query without drowning the original question. */
export function enrichVisualQuery(question: string, topic: MatchedTopic | null): string {
  if (!topic) {
    return question;
  }

  return `${question}\nScene focus: ${topic.visualFocus}`;
}
