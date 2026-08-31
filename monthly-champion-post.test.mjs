import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMonthlyChampionPost,
  createMonthlyChampionMarkdown,
  getNextMonthKey,
  validateFinalMonthData,
} from "./monthly-champion-post.mjs";

test("builds the approved AUGUST champion caption and file names", () => {
  const post = buildMonthlyChampionPost({
    monthKey: "2026-08",
    player: "REI",
    score: 732,
  });

  assert.equal(post.championMonthLabel, "AUGUST 2026");
  assert.equal(post.newMonth, "SEPTEMBER");
  assert.equal(post.champion, "REI");
  assert.equal(post.finalScore, 732);
  assert.equal(
    post.feedImage,
    "AFTER_DARTS_LEAGUE_2026-08_CHAMPION_FEED_4x5.png"
  );
  assert.equal(
    post.storyImage,
    "AFTER_DARTS_LEAGUE_2026-08_CHAMPION_STORY_9x16.png"
  );
  assert.match(post.caption, /^🏆 AUGUST CHAMPION\./);
  assert.match(post.caption, /👑 REI — 732 PTS/);
  assert.match(post.caption, /September starts now\./);
  assert.match(
    post.caption,
    /#AfterMakati #AfterDartsLeague #DartsMakati #COUNTUP #MakatiNightlife$/
  );
});

test("adds the champion section without replacing existing content", () => {
  const existing = "# AFTER Monthly Ranking Draft\n\nExisting caption stays here.";
  const post = buildMonthlyChampionPost({
    monthKey: "2026-08",
    player: "REI",
    score: 732,
  });
  const combined = `${existing}\n\n${createMonthlyChampionMarkdown(post)}\n`;

  assert.match(combined, /Existing caption stays here\./);
  assert.match(combined, /# MONTHLY CHAMPION POST/);
  assert.match(combined, /Champion Month:\nAUGUST 2026/);
  assert.match(combined, /Final Score:\n732 PTS/);
});

test("renders the required unavailable-data message", () => {
  const markdown = createMonthlyChampionMarkdown(null);
  assert.match(
    markdown,
    /Skipped — Previous month final ranking unavailable\./
  );
  assert.doesNotMatch(markdown, /CAPTION:/);
});

test("handles the December to January rollover", () => {
  assert.equal(getNextMonthKey("2026-12"), "2027-01");
});

test("accepts only a finalized previous-month history record", () => {
  const errors = validateFinalMonthData(
    "2026-08",
    {
      periodStart: "2026-08-01T00:00:00+08:00",
      periodEnd: "2026-08-31T23:59:59+08:00",
      updatedAt: "2026-08-31T23:17:00+08:00",
      rankings: [{ rank: 1, player: "REI", score: 732 }],
    },
    new Date("2026-09-01T09:00:00+08:00")
  );

  assert.deepEqual(errors, []);
});

test("rejects a stale or ambiguous champion record", () => {
  const errors = validateFinalMonthData(
    "2026-08",
    {
      periodStart: "2026-08-01T00:00:00+08:00",
      periodEnd: "2026-08-31T23:59:59+08:00",
      updatedAt: "2026-08-30T23:17:00+08:00",
      rankings: [
        { rank: 1, player: "REI", score: 732 },
        { rank: 1, player: "RYOTA", score: 731 },
      ],
    },
    new Date("2026-09-01T09:00:00+08:00")
  );

  assert.match(errors.join("\n"), /updatedAt must be on 2026-08-31 PHT/);
  assert.match(errors.join("\n"), /exactly one Rank #1 entry/);
});

test("rejects a month that has not ended yet", () => {
  const errors = validateFinalMonthData(
    "2026-08",
    {
      periodStart: "2026-08-01T00:00:00+08:00",
      periodEnd: "2026-08-31T23:59:59+08:00",
      updatedAt: "2026-08-31T14:59:41+08:00",
      rankings: [{ rank: 1, player: "Rei", score: 750 }],
    },
    new Date("2026-08-31T19:00:00+08:00")
  );

  assert.match(
    errors.join("\n"),
    /periodEnd must be earlier than the generation time/
  );
});
