import assert from "node:assert/strict";
import test from "node:test";

import { enrichVisualQuery, matchEpicTopic, scoreChapter } from "./epic-topics";

test("matchEpicTopic finds Karna/Arjuna battle chapters", () => {
  const match = matchEpicTopic("Who is more powerful, Karna or Arjuna?");

  assert.ok(match);
  assert.match(match.chapter.title, /Karna|Arjuna|Ultimate Battle|Battle/i);
  assert.ok(match.score >= 2);
  assert.match(match.visualFocus, /Karna|Arjuna/i);
});

test("matchEpicTopic skips non-mahabharata source filters", () => {
  assert.equal(matchEpicTopic("Karna and Arjuna", "ramayana"), null);
  assert.equal(matchEpicTopic("Karna and Arjuna", "gita"), null);
});

test("scoreChapter weighs title hits higher than description hits", () => {
  const chapter = {
    id: 102,
    title: "Karna and Arjuna",
    description: "A peaceful forest scene with birds",
    source: "mahabharata" as const,
  };

  assert.ok(scoreChapter("Karna and Arjuna duel", chapter) > scoreChapter("birds in forest", chapter));
});

test("enrichVisualQuery appends scene focus when a topic matched", () => {
  const topic = matchEpicTopic("Draupadi swayamvara Arjuna");
  const enriched = enrichVisualQuery("What happened at Draupadi's swayamvara?", topic);

  assert.match(enriched, /swayamvara/i);
  if (topic) {
    assert.match(enriched, /Scene focus:/);
  }
});
