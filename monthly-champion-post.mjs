const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;

function parseMonthKey(monthKey) {
  if (!MONTH_KEY_PATTERN.test(monthKey)) {
    throw new Error("monthKey must use YYYY-MM format.");
  }

  const [year, month] = monthKey.split("-").map(Number);

  if (month < 1 || month > 12) {
    throw new Error("monthKey contains an invalid month.");
  }

  return { year, month };
}

function monthDate(monthKey) {
  const { year, month } = parseMonthKey(monthKey);
  return new Date(Date.UTC(year, month - 1, 1));
}

function lastDayKey(monthKey) {
  const { year, month } = parseMonthKey(monthKey);
  const lastDay = new Date(Date.UTC(year, month, 0));

  return [
    lastDay.getUTCFullYear(),
    String(lastDay.getUTCMonth() + 1).padStart(2, "0"),
    String(lastDay.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function validateFinalMonthData(
  monthKey,
  monthData,
  now = new Date()
) {
  const { year, month } = parseMonthKey(monthKey);
  const lastDay = lastDayKey(monthKey);
  const expectedStart = `${monthKey}-01T00:00:00+08:00`;
  const expectedEnd = `${lastDay}T23:59:59+08:00`;
  const errors = [];

  if (!monthData || typeof monthData !== "object") {
    return [`history.months[${monthKey}] is unavailable.`];
  }

  if (monthData.periodStart !== expectedStart) {
    errors.push(`periodStart must equal ${expectedStart}.`);
  }

  if (monthData.periodEnd !== expectedEnd) {
    errors.push(`periodEnd must equal ${expectedEnd}.`);
  } else if (Date.parse(monthData.periodEnd) > now.getTime()) {
    errors.push("periodEnd must be earlier than the generation time.");
  }

  if (
    typeof monthData.updatedAt !== "string" ||
    !monthData.updatedAt.startsWith(lastDay)
  ) {
    errors.push(`updatedAt must be on ${lastDay} PHT.`);
  }

  if (!Array.isArray(monthData.rankings) || monthData.rankings.length === 0) {
    errors.push("rankings must contain at least one entry.");
    return errors;
  }

  const champions = monthData.rankings.filter(
    (entry) => entry?.rank === 1
  );

  if (champions.length !== 1) {
    errors.push("rankings must contain exactly one Rank #1 entry.");
    return errors;
  }

  const [champion] = champions;

  if (
    typeof champion.player !== "string" ||
    champion.player.trim() === ""
  ) {
    errors.push("Rank #1 player is unavailable.");
  }

  if (!Number.isInteger(champion.score)) {
    errors.push("Rank #1 score must be an integer.");
  }

  if (year < 2000 || month < 1 || month > 12) {
    errors.push("monthKey is outside the supported range.");
  }

  return errors;
}

export function formatMonthName(monthKey, casing = "title") {
  const monthName = new Intl.DateTimeFormat("en-US", {
    month: "long",
    timeZone: "UTC",
  }).format(monthDate(monthKey));

  return casing === "upper" ? monthName.toUpperCase() : monthName;
}

export function getNextMonthKey(monthKey) {
  const { year, month } = parseMonthKey(monthKey);
  const nextMonth = new Date(Date.UTC(year, month, 1));

  return [
    nextMonth.getUTCFullYear(),
    String(nextMonth.getUTCMonth() + 1).padStart(2, "0"),
  ].join("-");
}

export function buildMonthlyChampionCaption({
  monthKey,
  player,
  score,
}) {
  if (typeof player !== "string" || player.trim() === "") {
    throw new Error("Monthly Champion player is unavailable.");
  }

  if (!Number.isInteger(score)) {
    throw new Error("Monthly Champion score must be an integer.");
  }

  const championMonth = formatMonthName(monthKey, "upper");
  const newMonth = formatMonthName(getNextMonthKey(monthKey));

  return `🏆 ${championMonth} CHAMPION.

A full month of COUNT-UP battles has come to an end.

👑 ${player} — ${score} PTS

Congratulations on taking the top spot in the
AFTER DARTS LEAGUE. 🔥

Your Monthly Champion Bonus is waiting for you at AFTER.

Drop by and choose 1 FREE bottle from our selected lineup. 🍾

And to everyone else…

${newMonth} starts now.

New month. New ranking.

🎯 Who’s taking No.1 next?

#AfterMakati #AfterDartsLeague #DartsMakati #COUNTUP #MakatiNightlife`;
}

export function buildMonthlyChampionPost({
  monthKey,
  player,
  score,
}) {
  const { year } = parseMonthKey(monthKey);
  const championMonth = formatMonthName(monthKey, "upper");

  return {
    status: "ready",
    monthKey,
    championMonth,
    championMonthLabel: `${championMonth} ${year}`,
    newMonth: formatMonthName(getNextMonthKey(monthKey), "upper"),
    champion: player,
    finalScore: score,
    feedImage:
      `AFTER_DARTS_LEAGUE_${monthKey}_CHAMPION_FEED_4x5.png`,
    storyImage:
      `AFTER_DARTS_LEAGUE_${monthKey}_CHAMPION_STORY_9x16.png`,
    caption: buildMonthlyChampionCaption({
      monthKey,
      player,
      score,
    }),
  };
}

export function createMonthlyChampionMarkdown(post) {
  if (!post || post.status !== "ready") {
    return `---

# MONTHLY CHAMPION POST

Skipped — Previous month final ranking unavailable.

---`;
  }

  return `---

# MONTHLY CHAMPION POST

Champion Month:
${post.championMonthLabel}

Champion:
${post.champion}

Final Score:
${post.finalScore} PTS

FEED IMAGE:
${post.feedImage}

STORY IMAGE:
${post.storyImage}

CAPTION:

${post.caption}

---`;
}
