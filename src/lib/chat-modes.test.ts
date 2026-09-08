import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRetrievalQuery,
  detectAnswerMode,
  findAnchorQuestion,
  retrievalLimit,
} from "./chat-modes";

test("detectAnswerMode classifies follow-up intents", () => {
  assert.equal(detectAnswerMode("Who is more powerful, Karna or Arjuna?"), "default");
  assert.equal(
    detectAnswerMode(
      "Expand the previous answer with MORE CONTEXT only: background, lineage, vows, curses, weapons, and judgments about the same rivals.",
    ),
    "more-context",
  );
  assert.equal(
    detectAnswerMode(
      "Tell the FULL BATTLE STORY step by step of the main duel(s) for the previous question.",
    ),
    "battle-story",
  );
  assert.equal(
    detectAnswerMode(
      "List EVERY ENCOUNTER or clash in Context for the previous question and who had the advantage in each.",
    ),
    "encounters",
  );
});

test("findAnchorQuestion skips follow-up messages", () => {
  const anchor = findAnchorQuestion([
    { role: "user", content: "Who is more powerful, Karna or Arjuna?" },
    { role: "assistant", content: "Verdict..." },
    {
      role: "user",
      content: "Tell the full story of the main battle(s) relevant to the previous question, step by step.",
    },
  ]);

  assert.equal(anchor, "Who is more powerful, Karna or Arjuna?");
});

test("buildRetrievalQuery expands follow-up modes with the anchor topic", () => {
  const query = buildRetrievalQuery(
    "battle-story",
    "Tell the full battle story step by step",
    "Who is more powerful, Karna or Arjuna?",
  );

  assert.match(query, /Karna or Arjuna/);
  assert.match(query, /duel|battle/i);
});

test("retrievalLimit increases for story and encounter modes", () => {
  assert.equal(retrievalLimit("default", true), 12);
  assert.equal(retrievalLimit("battle-story", true), 16);
  assert.equal(retrievalLimit("encounters", false), 20);
});
