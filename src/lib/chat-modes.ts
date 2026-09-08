export type AnswerMode = "default" | "more-context" | "battle-story" | "encounters";

type ChatRole = "user" | "assistant";

export type ChatTurn = {
  role: ChatRole;
  content: string;
};

const MORE_CONTEXT_MARKERS = [
  "more context",
  "deeper background",
  "related background",
  "surrounding events",
];

const BATTLE_STORY_MARKERS = [
  "full battle story",
  "full story of the main battle",
  "step by step",
  "step-by-step",
  "who had the upper hand at each stage",
];

const ENCOUNTERS_MARKERS = [
  "more encounters",
  "every encounter",
  "every clash",
  "list every encounter",
  "who had the advantage in each",
];

function includesAny(haystack: string, markers: string[]): boolean {
  return markers.some((marker) => haystack.includes(marker));
}

export function detectAnswerMode(message: string): AnswerMode {
  const normalized = message.trim().toLowerCase();

  if (includesAny(normalized, BATTLE_STORY_MARKERS)) {
    return "battle-story";
  }

  if (includesAny(normalized, ENCOUNTERS_MARKERS)) {
    return "encounters";
  }

  if (includesAny(normalized, MORE_CONTEXT_MARKERS)) {
    return "more-context";
  }

  return "default";
}

/** Prefer the latest non-follow-up user question as the topic anchor. */
export function findAnchorQuestion(messages: ChatTurn[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message.role !== "user") {
      continue;
    }

    if (detectAnswerMode(message.content) === "default") {
      return message.content.trim();
    }
  }

  const firstUser = messages.find((message) => message.role === "user");
  return firstUser?.content.trim() ?? "";
}

export function buildRetrievalQuery(mode: AnswerMode, lastUserMessage: string, anchorQuestion: string): string {
  const topic = anchorQuestion || lastUserMessage;

  switch (mode) {
    case "more-context":
      return [
        topic,
        "background context lineage vows judgments surrounding events related episodes",
        "Krishna counsel boons curses charioteer weapons reputation",
      ].join("\n");
    case "battle-story":
      return [
        topic,
        "full duel battle sequence arrows divine weapons chariot stages upper hand defeat death",
        "Karna Arjuna fight day of battle step by step encounter",
      ].join("\n");
    case "encounters":
      return [
        topic,
        "every encounter duel clash comparison who had the upper hand advantage victory",
        "list of battles confrontations between the rivals",
      ].join("\n");
    default:
      return topic;
  }
}

export function retrievalLimit(mode: AnswerMode, hasSourceFilter: boolean): number {
  if (mode === "battle-story" || mode === "encounters") {
    return hasSourceFilter ? 16 : 20;
  }

  if (mode === "more-context") {
    return hasSourceFilter ? 14 : 18;
  }

  return hasSourceFilter ? 12 : 18;
}
