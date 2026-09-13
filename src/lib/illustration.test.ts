import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDistillPrompt,
  buildPollinationsUrl,
  buildProxyPath,
  deriveSeed,
  parseDistillResponse,
  signIllustration,
  verifyIllustration,
} from "./illustration";

const SECRET = "test-secret";

test("buildDistillPrompt asks for a visual prompt grounded in the passages", () => {
  const prompt = buildDistillPrompt(
    "Who is more powerful, Karna or Arjuna?",
    "Passage 1 [mahabharata p.4205]\nKarna's chariot wheel sank into the earth.",
  );

  assert.match(prompt, /Karna or Arjuna/);
  assert.match(prompt, /chariot wheel sank/);
  assert.match(prompt, /PROMPT:/);
  assert.match(prompt, /CAPTION:/);
});

test("parseDistillResponse reads the prompt and caption lines", () => {
  const parsed = parseDistillResponse(
    "PROMPT: two chariot archers loose arrows across a dust-choked battlefield\nCAPTION: The wheel sinks at Kurukshetra",
  );

  assert.ok(parsed);
  assert.equal(parsed.prompt, "two chariot archers loose arrows across a dust-choked battlefield");
  assert.equal(parsed.caption, "The wheel sinks at Kurukshetra");
});

test("parseDistillResponse tolerates surrounding chatter and markdown", () => {
  const parsed = parseDistillResponse(
    "Sure! Here you go:\n\n**PROMPT:** a lone archer draws a great bow at dawn\n**CAPTION:** Rama at the bowstring\n\nHope that helps.",
  );

  assert.ok(parsed);
  assert.equal(parsed.prompt, "a lone archer draws a great bow at dawn");
  assert.equal(parsed.caption, "Rama at the bowstring");
});

test("parseDistillResponse returns null without a usable prompt", () => {
  assert.equal(parseDistillResponse("CAPTION: nothing to draw"), null);
  assert.equal(parseDistillResponse(""), null);
});

test("deriveSeed is deterministic for the same prompt", () => {
  assert.equal(deriveSeed("a chariot"), deriveSeed("a chariot"));
  assert.notEqual(deriveSeed("a chariot"), deriveSeed("a bow"));
  assert.ok(Number.isInteger(deriveSeed("a chariot")));
  assert.ok(deriveSeed("a chariot") >= 0);
});

test("buildPollinationsUrl encodes the prompt and pins the style parameters", () => {
  const url = new URL(buildPollinationsUrl("two archers & a chariot", 42));

  assert.equal(url.hostname, "image.pollinations.ai");
  assert.ok(decodeURIComponent(url.pathname).includes("two archers & a chariot"));
  assert.equal(url.searchParams.get("seed"), "42");
  assert.equal(url.searchParams.get("nologo"), "true");
  assert.equal(url.searchParams.get("private"), "true");
  assert.ok(Number(url.searchParams.get("width")) > 0);
  assert.ok(Number(url.searchParams.get("height")) > 0);
});

test("buildPollinationsUrl attaches the token only when one is configured", () => {
  const before = process.env.POLLINATIONS_TOKEN;

  delete process.env.POLLINATIONS_TOKEN;
  assert.equal(new URL(buildPollinationsUrl("x", 1)).searchParams.get("token"), null);

  process.env.POLLINATIONS_TOKEN = "secret-token";
  assert.equal(new URL(buildPollinationsUrl("x", 1)).searchParams.get("token"), "secret-token");

  if (before === undefined) {
    delete process.env.POLLINATIONS_TOKEN;
  } else {
    process.env.POLLINATIONS_TOKEN = before;
  }
});

test("signatures round-trip and reject tampering", () => {
  const signature = signIllustration("a chariot", 42, SECRET);

  assert.ok(verifyIllustration("a chariot", 42, signature, SECRET));
  assert.equal(verifyIllustration("a different prompt", 42, signature, SECRET), false);
  assert.equal(verifyIllustration("a chariot", 43, signature, SECRET), false);
  assert.equal(verifyIllustration("a chariot", 42, "deadbeef", SECRET), false);
  assert.equal(verifyIllustration("a chariot", 42, signature, "other-secret"), false);
  assert.equal(verifyIllustration("a chariot", 42, "", SECRET), false);
});

test("buildProxyPath points at our own route and never leaks the upstream token", () => {
  const before = process.env.POLLINATIONS_TOKEN;
  process.env.POLLINATIONS_TOKEN = "secret-token";

  const path = buildProxyPath("two archers & a chariot", 42, SECRET);

  assert.ok(path.startsWith("/api/illustration?"));
  assert.doesNotMatch(path, /secret-token/);
  assert.doesNotMatch(path, /pollinations/);

  const params = new URLSearchParams(path.slice(path.indexOf("?") + 1));
  assert.equal(params.get("prompt"), "two archers & a chariot");
  assert.equal(params.get("seed"), "42");
  assert.ok(verifyIllustration("two archers & a chariot", 42, params.get("sig") ?? "", SECRET));

  if (before === undefined) {
    delete process.env.POLLINATIONS_TOKEN;
  } else {
    process.env.POLLINATIONS_TOKEN = before;
  }
});
