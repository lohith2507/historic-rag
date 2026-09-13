import assert from "node:assert/strict";
import test from "node:test";

import { ARTWORK_MIN_SIMILARITY, buildAttribution, toArtworkScene } from "./artwork";

const ROW = {
  id: "1",
  source: "mahabharata" as const,
  title: "Arjuna and His Charioteer Krishna Confront Karna.jpg",
  image_url: "https://upload.wikimedia.org/x/arjuna.jpg",
  page_url: "https://commons.wikimedia.org/wiki/File:Arjuna.jpg",
  artist: "Unknown, Mewar school",
  license: "Public domain",
  date_text: "circa 1820",
  similarity: 0.64,
};

test("buildAttribution joins the parts that are present", () => {
  assert.equal(
    buildAttribution(ROW),
    "Unknown, Mewar school, circa 1820 · Public domain",
  );
});

test("buildAttribution copes with missing artist and date", () => {
  assert.equal(
    buildAttribution({ ...ROW, artist: null, date_text: null }),
    "Unknown artist · Public domain",
  );
});

test("toArtworkScene strips the file extension from the caption", () => {
  const scene = toArtworkScene(ROW);

  assert.ok(scene);
  assert.equal(scene.caption, "Arjuna and His Charioteer Krishna Confront Karna");
  assert.doesNotMatch(scene.caption, /\.jpg/i);
});

test("toArtworkScene carries the image, link, and attribution through", () => {
  const scene = toArtworkScene(ROW);

  assert.ok(scene);
  assert.equal(scene.imageUrl, ROW.image_url);
  assert.equal(scene.sourceUrl, ROW.page_url);
  assert.match(scene.attribution ?? "", /Public domain/);
  assert.equal(scene.kind, "artwork");
});

test("toArtworkScene rejects matches below the similarity floor", () => {
  assert.equal(toArtworkScene({ ...ROW, similarity: ARTWORK_MIN_SIMILARITY - 0.01 }), null);
  assert.ok(toArtworkScene({ ...ROW, similarity: ARTWORK_MIN_SIMILARITY }));
});

test("toArtworkScene rejects rows without a usable image", () => {
  assert.equal(toArtworkScene({ ...ROW, image_url: "" }), null);
});

test("toArtworkScene rejects non-https image urls", () => {
  assert.equal(toArtworkScene({ ...ROW, image_url: "http://insecure.test/a.jpg" }), null);
  assert.equal(toArtworkScene({ ...ROW, image_url: "javascript:alert(1)" }), null);
});
