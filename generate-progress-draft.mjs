import fs from "node:fs/promises";
import path from "node:path";

const HISTORY_FILE = "data/history.json";
const RANKING_FILE = "data/ranking.json";
const OUTPUT_DIR = "generated";
const DEFAULT_MODEL = "gemini-3.1-flash-lite";

const targetDate = process.env.TARGET_DATE?.trim();
const apiKey = process.env.GEMINI_API_KEY?.trim();
const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;

if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate ?? "")) {
  throw new Error("TARGET_DATE must use YYYY-MM-DD format.");
}

if (!apiKey) {
  throw new Error("GEMINI_API_KEY is not set.");
}

function parseCalendarDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid TARGET_DATE: ${value}`);
  }

  return { year, month, day, date };
}

function getScheduleContext(value) {
  const parsed = parseCalendarDate(value);
  const lastDay = new Date(
    Date.UTC(parsed.year, parsed.month, 0),
  ).getUTCDate();
  const daysRemaining = lastDay - parsed.day;

  let stage;
  let stageLabel;
  let communicationGoal;

  if (daysRemaining <= 3) {
    stage = "final_challenge";
    stageLabel = "Final challenge";
    communicationGoal =
      "Emphasize the remaining time and invite one final attempt at No.1.";
  } else if (parsed.day >= 22) {
    stage = "final_stretch";
    stageLabel = "Final stretch";
    communicationGoal =
      "Show the current target and remind players that the ranking can still change.";
  } else if (parsed.day >= 15) {
    stage = "mid_month";
    stageLabel = "Mid-month update";
    communicationGoal =
      "Reinforce the current No.1 position and encourage movement before the final stretch.";
  } else {
    stage = "first_week";
    stageLabel = "First-week update";
    communicationGoal =
      "Establish the first score to beat and invite players to enter the monthly race.";
  }

  return {
    ...parsed,
    monthKey: value.slice(0, 7),
    lastDay,
    daysRemaining,
    stage,
    stageLabel,
    communicationGoal,
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Could not read ${file}: ${error.message}`);
  }
}

function normalizeRankings(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => ({
      rank: Number(item?.rank),
      player: String(item?.player ?? "").trim(),
      score: Number(item?.score),
    }))
    .filter(
      (item) =>
        Number.isInteger(item.rank) &&
        item.rank > 0 &&
        item.player.length > 0 &&
        Number.isFinite(item.score) &&
        item.score > 0,
    )
    .sort((a, b) => a.rank - b.rank || b.score - a.score);
}

async function loadRankingForMonth(monthKey) {
  const history = await readJson(HISTORY_FILE);
  const savedMonth = history?.months?.[monthKey];
  const savedRankings = normalizeRankings(savedMonth?.rankings);

  if (savedRankings.length > 0) {
    return {
      source: HISTORY_FILE,
      updatedAt: savedMonth.updatedAt ?? history.lastSuccessfulCheckAt ?? null,
      periodStart: savedMonth.periodStart ?? null,
      periodEnd: savedMonth.periodEnd ?? null,
      rankings: savedRankings,
    };
  }

  const current = await readJson(RANKING_FILE);
  const currentMonth = String(current?.periodStart ?? "").slice(0, 7);
  const currentRankings = normalizeRankings(current?.rankings);

  if (currentMonth === monthKey && currentRankings.length > 0) {
    return {
      source: RANKING_FILE,
      updatedAt: current.updatedAt ?? null,
      periodStart: current.periodStart ?? null,
      periodEnd: current.periodEnd ?? null,
      rankings: currentRankings,
    };
  }

  return {
    source: HISTORY_FILE,
    updatedAt: savedMonth?.updatedAt ?? history?.lastSuccessfulCheckAt ?? null,
    periodStart: savedMonth?.periodStart ?? null,
    periodEnd: savedMonth?.periodEnd ?? null,
    rankings: [],
  };
}

function buildFacts(schedule, rankingData) {
  const top3 = rankingData.rankings.slice(0, 3);
  const leader = top3[0] ?? null;
  const runnerUp = top3[1] ?? null;

  return {
    snapshotDate: targetDate,
    month: schedule.monthKey,
    stage: schedule.stage,
    stageLabel: schedule.stageLabel,
    communicationGoal: schedule.communicationGoal,
    daysRemaining: schedule.daysRemaining,
    rankingEntryCount: rankingData.rankings.length,
    currentTop3: top3,
    leader,
    runnerUp,
    gapBetweenFirstAndSecond:
      leader && runnerUp ? leader.score - runnerUp.score : null,
    dataUpdatedAt: rankingData.updatedAt,
    dataSource: rankingData.source,
    previousSnapshotAvailable: false,
  };
}

const systemInstruction = `
You write social media draft copy for AFTER, a small bar in Makati with fewer than 50 seats.
The campaign is a monthly DARTSLIVE COUNT-UP ranking.

The primary motivation is the status of becoming No.1. Do not make prizes or rewards the main appeal.
This progress post must not mention the bottle reward.

Use only the supplied facts. Never invent visits, attempts, effort, reactions, momentum, score changes,
rank changes, previous-week comparisons, or player relationships.
Do not say the ranking is fierce, intense, close, dramatic, or competitive unless the facts clearly
support that wording. If the gap is not clearly small, present the leader's score as the score to beat.

Keep public copy concise, natural, and suitable for Facebook and Instagram in the Philippines.
Use English for public-facing copy. Do not mention the ranking entry count in public-facing copy.
Use "No.1" consistently. Do not use "winner" or "champion" before the month is complete.
End the caption with a short challenge that encourages players to aim for No.1.

Image copy must be brief and readable on a 4:5 social image. The image headline and image text must
prioritize the current No.1, score to beat, gap when useful, or time remaining. Do not put hashtags in
image copy. The caption may use no more than three relevant hashtags.

There is no previous progress snapshot in this first manual version. Do not imply any change from an
earlier week.

Return valid JSON only. Follow the requested keys exactly.
`;

function buildUserPrompt(facts) {
  return `
Create one ranking progress draft from these verified facts:

${JSON.stringify(facts, null, 2)}

Return this JSON object:
{
  "imageHeadline": "Short uppercase headline",
  "imageText": "Two or three short lines for the post image",
  "caption": "Facebook and Instagram caption with line breaks and up to three hashtags",
  "storyText": "Short Instagram/Facebook Story text",
  "internalReviewNote": "A concise Japanese note explaining the angle used and anything the reviewer should verify",
  "publishRecommendation": "publish or review"
}

Set publishRecommendation to "review" if there is only one ranking entry or the facts are too limited
to present a meaningful current race. Otherwise use "publish".
`;
}

function extractResponseText(payload) {
  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text ?? "")
    .join("")
    .trim();

  if (!text) {
    throw new Error(
      `Gemini returned no text: ${JSON.stringify(payload).slice(0, 1200)}`,
    );
  }

  return text;
}

function parseJsonResponse(text) {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    throw new Error(`Gemini returned invalid JSON: ${error.message}\n${cleaned}`);
  }

  const required = [
    "imageHeadline",
    "imageText",
    "caption",
    "storyText",
    "internalReviewNote",
    "publishRecommendation",
  ];

  for (const key of required) {
    if (typeof parsed[key] !== "string" || parsed[key].trim() === "") {
      throw new Error(`Gemini response is missing a valid ${key}.`);
    }
  }

  if (!new Set(["publish", "review"]).has(parsed.publishRecommendation)) {
    throw new Error('publishRecommendation must be "publish" or "review".');
  }

  return Object.fromEntries(
    required.map((key) => [key, parsed[key].trim()]),
  );
}

async function geminiRequest(facts) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemInstruction }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: buildUserPrompt(facts) }],
        },
      ],
      generationConfig: {
        temperature: 0.4,
        responseMimeType: "application/json",
      },
    }),
  });

  const body = await response.text();
  let payload;

  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`Gemini API returned non-JSON HTTP ${response.status}: ${body}`);
  }

  if (!response.ok) {
    throw new Error(
      `Gemini API failed with HTTP ${response.status}:\n${JSON.stringify(payload, null, 2)}`,
    );
  }

  return parseJsonResponse(extractResponseText(payload));
}

function monthName(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function formatTop3(top3) {
  if (top3.length === 0) return "- No current ranking entries";
  return top3
    .map((item) => `- No.${item.rank}: ${item.player} — ${item.score} points`)
    .join("\n");
}

function buildMarkdown({ schedule, facts, draft, generatedAt }) {
  const gap = facts.gapBetweenFirstAndSecond;

  return `# AFTER Ranking Progress Draft

## Generation information

- Progress date: ${targetDate}
- Ranking month: ${monthName(schedule.monthKey)}
- Posting stage: ${schedule.stageLabel}
- Model: ${model}
- Generated at: ${generatedAt}
- Ranking data updated at: ${facts.dataUpdatedAt ?? "Unknown"}
- Previous snapshot comparison: Not available in this manual version
- Publish recommendation: ${draft.publishRecommendation.toUpperCase()}

## Image headline

${draft.imageHeadline}

## Text for the post image

${draft.imageText}

## Facebook / Instagram caption

${draft.caption}

## Story text

${draft.storyText}

---

# Internal Review

## Generation angle

${draft.internalReviewNote}

## Verified ranking facts

- Days remaining after ${targetDate}: ${facts.daysRemaining}
- Current leader: ${facts.leader ? `${facts.leader.player} — ${facts.leader.score} points` : "None"}
- Runner-up: ${facts.runnerUp ? `${facts.runnerUp.player} — ${facts.runnerUp.score} points` : "None"}
- Gap between No.1 and No.2: ${gap === null ? "Not available" : `${gap} points`}
- Ranking entries: ${facts.rankingEntryCount}

### Current top 3

${formatTop3(facts.currentTop3)}

## Required human check

Confirm the player names, scores, data freshness, and wording before posting. This version does not compare the ranking with a previous progress snapshot.
`;
}

async function writeNoDataDraft(schedule, facts, generatedAt) {
  const draft = {
    imageHeadline: "RANKING DATA REVIEW",
    imageText: "No current-month ranking data was available.",
    caption: "Do not publish this draft.",
    storyText: "Do not publish this draft.",
    internalReviewNote:
      "対象月のランキングデータがないため、投稿を作成せずデータ取得状況を確認してください。",
    publishRecommendation: "review",
  };

  return {
    draft,
    markdown: buildMarkdown({ schedule, facts, draft, generatedAt }),
  };
}

async function main() {
  const schedule = getScheduleContext(targetDate);
  const rankingData = await loadRankingForMonth(schedule.monthKey);
  const facts = buildFacts(schedule, rankingData);
  const generatedAt = new Date().toISOString();

  console.log(`Selected model: ${model}`);
  console.log(`Progress date: ${targetDate}`);
  console.log(`Posting stage: ${schedule.stageLabel}`);
  console.log(`Ranking entries: ${facts.rankingEntryCount}`);

  const result =
    facts.rankingEntryCount === 0
      ? await writeNoDataDraft(schedule, facts, generatedAt)
      : {
          draft: await geminiRequest(facts),
        };

  const markdown =
    result.markdown ??
    buildMarkdown({
      schedule,
      facts,
      draft: result.draft,
      generatedAt,
    });

  const json = {
    generation: {
      targetDate,
      month: schedule.monthKey,
      stage: schedule.stage,
      model,
      generatedAt,
    },
    facts,
    draft: result.draft,
  };

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const baseName = `progress-draft-${targetDate}`;
  const markdownFile = path.join(OUTPUT_DIR, `${baseName}.md`);
  const jsonFile = path.join(OUTPUT_DIR, `${baseName}.json`);

  await Promise.all([
    fs.writeFile(markdownFile, markdown, "utf8"),
    fs.writeFile(jsonFile, `${JSON.stringify(json, null, 2)}\n`, "utf8"),
  ]);

  console.log(`Saved ${markdownFile}`);
  console.log(`Saved ${jsonFile}`);
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? error);
  process.exitCode = 1;
});
