import assert from "node:assert/strict";
import test from "node:test";

import { buildScenePrompt, parseSceneResponse, sanitizeSvg } from "./scene";

const MINIMAL = '<svg viewBox="0 0 640 360"><circle cx="10" cy="10" r="5" /></svg>';

test("sanitizeSvg extracts the svg from fenced, chatty model output", () => {
  const raw = [
    "Here is the scene you asked for:",
    "```svg",
    MINIMAL,
    "```",
    "Let me know if you want changes.",
  ].join("\n");

  const svg = sanitizeSvg(raw);

  assert.ok(svg);
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.endsWith("</svg>"));
  assert.doesNotMatch(svg, /Here is the scene/);
  assert.doesNotMatch(svg, /```/);
});

test("sanitizeSvg removes script elements and their contents", () => {
  const svg = sanitizeSvg(
    '<svg viewBox="0 0 640 360"><SCRIPT>fetch("https://evil.test")</SCRIPT><rect /></svg>',
  );

  assert.ok(svg);
  assert.doesNotMatch(svg, /script/i);
  assert.doesNotMatch(svg, /evil\.test/);
  assert.match(svg, /<rect/);
});

test("sanitizeSvg removes inline event handlers", () => {
  const svg = sanitizeSvg(
    `<svg viewBox="0 0 640 360"><rect onclick="alert(1)" ONLOAD='alert(2)' fill="#333" /></svg>`,
  );

  assert.ok(svg);
  assert.doesNotMatch(svg, /onclick/i);
  assert.doesNotMatch(svg, /onload/i);
  assert.doesNotMatch(svg, /alert/);
  assert.match(svg, /fill="#333"/);
});

test("sanitizeSvg drops external references but keeps local fragment links", () => {
  const svg = sanitizeSvg(
    '<svg viewBox="0 0 640 360">' +
      '<use href="#chariot" />' +
      '<a xlink:href="javascript:alert(1)"><rect /></a>' +
      '<use href="https://evil.test/x.svg#a" />' +
      "</svg>",
  );

  assert.ok(svg);
  assert.match(svg, /href="#chariot"/);
  assert.doesNotMatch(svg, /javascript:/i);
  assert.doesNotMatch(svg, /evil\.test/);
});

test("sanitizeSvg removes foreignObject and raster image elements", () => {
  const svg = sanitizeSvg(
    '<svg viewBox="0 0 640 360">' +
      "<foreignObject><body>hi</body></foreignObject>" +
      '<image href="data:image/png;base64,AAAA" />' +
      "<path />" +
      "</svg>",
  );

  assert.ok(svg);
  assert.doesNotMatch(svg, /foreignObject/i);
  assert.doesNotMatch(svg, /<image/i);
  assert.match(svg, /<path/);
});

test("sanitizeSvg strips @import from style blocks", () => {
  const svg = sanitizeSvg(
    '<svg viewBox="0 0 640 360"><style>@import url("https://evil.test/x.css"); .a { fill: #222 }</style><rect class="a" /></svg>',
  );

  assert.ok(svg);
  assert.doesNotMatch(svg, /@import/i);
  assert.doesNotMatch(svg, /evil\.test/);
  assert.match(svg, /fill: #222/);
});

test("sanitizeSvg preserves SMIL animation elements", () => {
  const svg = sanitizeSvg(
    '<svg viewBox="0 0 640 360"><rect>' +
      '<animate attributeName="x" from="0" to="100" dur="3s" repeatCount="indefinite" />' +
      '<animateTransform attributeName="transform" type="rotate" dur="4s" repeatCount="indefinite" />' +
      "</rect></svg>",
  );

  assert.ok(svg);
  assert.match(svg, /<animate /);
  assert.match(svg, /<animateTransform /);
  assert.match(svg, /repeatCount="indefinite"/);
});

test("sanitizeSvg removes fixed root dimensions so the scene scales", () => {
  const svg = sanitizeSvg('<svg width="640" height="360" viewBox="0 0 640 360"><rect /></svg>');

  assert.ok(svg);
  assert.doesNotMatch(svg, /width="640"/);
  assert.doesNotMatch(svg, /height="360"/);
  assert.match(svg, /viewBox="0 0 640 360"/);
});

test("sanitizeSvg supplies a viewBox when the model omits one", () => {
  const svg = sanitizeSvg("<svg><rect /></svg>");

  assert.ok(svg);
  assert.match(svg, /viewBox="0 0 640 360"/);
});

test("sanitizeSvg rejects input that is not an svg", () => {
  assert.equal(sanitizeSvg("I cannot draw that."), null);
  assert.equal(sanitizeSvg(""), null);
  assert.equal(sanitizeSvg("<div>nope</div>"), null);
});

test("sanitizeSvg rejects oversized payloads", () => {
  const huge = `<svg viewBox="0 0 640 360">${"<rect />".repeat(20000)}</svg>`;

  assert.equal(sanitizeSvg(huge), null);
});

test("parseSceneResponse reads the caption line and the svg", () => {
  const scene = parseSceneResponse(`CAPTION: Karna's chariot wheel sinks\n${MINIMAL}`);

  assert.ok(scene);
  assert.equal(scene.caption, "Karna's chariot wheel sinks");
  assert.ok(scene.svg.startsWith("<svg"));
});

test("parseSceneResponse falls back to a default caption", () => {
  const scene = parseSceneResponse(MINIMAL);

  assert.ok(scene);
  assert.equal(scene.caption, "Scene from the retrieved passages");
});

test("parseSceneResponse returns null when no usable svg is present", () => {
  assert.equal(parseSceneResponse("CAPTION: nothing to draw"), null);
});

test("buildScenePrompt includes the question and the passages", () => {
  const prompt = buildScenePrompt("Who is more powerful, Karna or Arjuna?", "Passage 1 [mahabharata p.4205]\nThe wheel sank.");

  assert.match(prompt, /Karna or Arjuna/);
  assert.match(prompt, /The wheel sank/);
  assert.match(prompt, /CAPTION:/);
  assert.match(prompt, /colourful|indigo|ochre|crimson/i);
});
