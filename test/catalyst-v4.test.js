const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeOfficialTrumpPosts, normalizeTrumpFmPosts } = require("../catalyst-v4")._test;

test("normalizes the official Truth Social response", () => {
  const items = normalizeOfficialTrumpPosts([{
    id: "123",
    content: "<p>Oil &amp; OPEC update</p>",
    url: "https://truthsocial.com/@realDonaldTrump/123",
    created_at: "2026-04-07T20:14:40.936Z"
  }]);

  assert.deepEqual(items, [{
    id: "truth:123",
    source: "Donald Trump · Truth Social official",
    title: "Oil & OPEC update",
    text: "Oil & OPEC update",
    url: "https://truthsocial.com/@realDonaldTrump/123",
    publishedAt: "2026-04-07T20:14:40.936Z"
  }]);
});

test("keeps stable ids when the mirror fallback is used", () => {
  const items = normalizeTrumpFmPosts({ data: [{
    id: "123",
    content: "Crude oil",
    createdAt: "2026-04-07T20:14:40.936Z"
  }] });

  assert.equal(items[0].id, "truth:123");
  assert.equal(items[0].source, "Donald Trump · Truth Social mirror fallback");
  assert.equal(items[0].url, "https://truthsocial.com/@realDonaldTrump/123");
});

test("uses the repost time while reading the original reposted text", () => {
  const items = normalizeOfficialTrumpPosts([{
    id: "wrapper-9",
    content: "",
    url: "https://truthsocial.com/@realDonaldTrump/wrapper-9",
    created_at: "2026-09-17T12:00:00Z",
    reblog: {
      id: "original-1",
      content: "<p>OPEC statement</p>",
      created_at: "2026-09-16T12:00:00Z"
    }
  }]);

  assert.equal(items[0].id, "truth:wrapper-9");
  assert.equal(items[0].title, "OPEC statement");
  assert.equal(items[0].publishedAt, "2026-09-17T12:00:00Z");
});
