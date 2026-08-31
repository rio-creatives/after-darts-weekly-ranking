import fs from "node:fs/promises";
import path from "node:path";

import {
  buildMonthlyChampionPost,
  createMonthlyChampionMarkdown,
  validateFinalMonthData,
} from "./monthly-champion-post.mjs";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const apiKey = process.env.GEMINI_API_KEY;
const targetMonth = process.env.TARGET_MONTH;

if (!apiKey) {
  throw new Error("GEMINI_API_KEY is not registered.");
}

if (!targetMonth || !/^\d{4}-\d{2}$/.test(targetMonth)) {
  throw new Error(
    "TARGET_MONTH must use YYYY-MM format, for example 2026-07."
  );
}

function getPreviousMonth(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 2, 1));

  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
  ].join("-");
}

function formatMonth(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

async function geminiRequest(endpoint, options = {}) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
      ...(options.headers || {}),
    },
  });

  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Gemini API failed with HTTP ${response.status}:\n${bodyText}`
    );
  }

  return JSON.parse(bodyText);
}

async function selectModel() {
  const modelData = await geminiRequest("/models");

  const availableModels = (modelData.models || []).filter((model) => {
    const supportsGenerateContent =
      model.supportedGenerationMethods?.includes("generateContent");

    const isGeminiTextModel =
      model.name?.startsWith("models/gemini") &&
      !/image|embedding|live|audio|tts/i.test(model.name);

    return supportsGenerateContent && isGeminiTextModel;
  });

  if (availableModels.length === 0) {
    throw new Error(
      "No Gemini text model supporting generateContent was found."
    );
  }

  const preferredModels = [
    "models/gemini-3.1-flash-lite",
    "models/gemini-3.5-flash-lite",
    "models/gemini-3.6-flash",
    "models/gemini-3.5-flash",
    "models/gemini-3-flash-preview",
  ];

  const preferredModel = preferredModels.find((name) =>
    availableModels.some((model) => model.name === name)
  );

  if (preferredModel) {
    return preferredModel;
  }

  const fallbackModel = availableModels.find(
    (model) =>
      model.name.startsWith("models/gemini-3") &&
      model.name.includes("flash") &&
      !/image|live|audio|tts/i.test(model.name)
  );

  if (!fallbackModel) {
    console.error("Available Gemini models:");

    for (const model of availableModels) {
      console.error(`- ${model.name}`);
    }

    throw new Error(
      "No supported Gemini 3 Flash model was found."
    );
  }

  return fallbackModel.name;
}

function extractResponseText(response) {
  return (response.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || "")
    .join("")
    .trim();
}

function parseJsonResponse(text) {
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(
      `Gemini did not return valid JSON:\n${text}`
    );
  }
}

function validateDraft(draft) {
  const requiredStrings = [
    "headline",
    "imageText",
    "facebookCaption",
    "storyText",
  ];

  for (const field of requiredStrings) {
    if (
      typeof draft[field] !== "string" ||
      draft[field].trim() === ""
    ) {
      throw new Error(`Missing or invalid field: ${field}`);
    }
  }

  if (!Array.isArray(draft.hashtags)) {
    throw new Error("hashtags must be an array.");
  }

  if (
    !draft.internalReport ||
    typeof draft.internalReport !== "object"
  ) {
    throw new Error("internalReport is missing.");
  }

  const reportFields = [
    "summary",
    "comparison",
    "nextAction",
    "dataLimitations",
  ];

  for (const field of reportFields) {
    if (
      typeof draft.internalReport[field] !== "string" ||
      draft.internalReport[field].trim() === ""
    ) {
      throw new Error(
        `Missing internalReport field: ${field}`
      );
    }
  }
}

function createMarkdown({
  draft,
  facts,
  monthlyChampionPost,
  selectedModel,
  generatedAt,
}) {
  const hashtagText = draft.hashtags
    .slice(0, 3)
    .map((tag) =>
      tag.startsWith("#") ? tag : `#${tag}`
    )
    .join(" ");

  return `# AFTER Monthly Ranking Draft

## Generation information

- Target month: ${facts.monthLabel}
- Model: ${selectedModel}
- Generated at: ${generatedAt}
- Ranking entries: ${facts.rankingEntryCount}

## Image headline

${draft.headline}

## Text for the post image

${draft.imageText}

## Facebook / Instagram caption

${draft.facebookCaption}

${hashtagText}

## Story text

${draft.storyText}

---

# Internal Monthly Report

## Summary

${draft.internalReport.summary}

## Previous-month comparison

${draft.internalReport.comparison}

## One recommended action

${draft.internalReport.nextAction}

## Data limitations

${draft.internalReport.dataLimitations}

---

## Verified ranking facts

- Champion: ${facts.champion.player}
- Winning score: ${facts.champion.score}
- Runner-up: ${facts.runnerUp?.player ?? "None"}
- Runner-up score: ${facts.runnerUp?.score ?? "N/A"}
- Gap: ${facts.gap ?? "N/A"} points
- Ranking entries: ${facts.rankingEntryCount}

${createMonthlyChampionMarkdown(monthlyChampionPost)}
`;
}

async function writeUnavailableMonthlyDraft(validationErrors) {
  const generatedAt = new Date().toISOString();
  const monthlyChampionPost = {
    status: "skipped",
    reason: "Previous month final ranking unavailable.",
    validationErrors,
  };
  const outputDirectory = "generated";
  const markdown = `# AFTER Monthly Ranking Draft

## Generation information

- Target month: ${formatMonth(targetMonth)}
- Generated at: ${generatedAt}
- Status: Previous month final ranking unavailable

${createMonthlyChampionMarkdown(monthlyChampionPost)}
`;

  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(
    path.join(outputDirectory, `monthly-draft-${targetMonth}.json`),
    JSON.stringify(
      {
        targetMonth,
        generatedAt,
        facts: null,
        draft: null,
        monthlyChampionPost,
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(
    path.join(outputDirectory, `monthly-draft-${targetMonth}.md`),
    markdown,
    "utf8"
  );

  console.warn(monthlyChampionPost.reason);
  for (const error of validationErrors) {
    console.warn(`- ${error}`);
  }
}

async function main() {
  const historyText = await fs.readFile(
    "data/history.json",
    "utf8"
  );

  const history = JSON.parse(historyText);
  const monthData = history.months?.[targetMonth];
  const finalDataErrors = validateFinalMonthData(
    targetMonth,
    monthData
  );

  if (finalDataErrors.length > 0) {
    await writeUnavailableMonthlyDraft(finalDataErrors);
    return;
  }

  const rankings = [...(monthData.rankings || [])]
    .filter(
      (entry) =>
        Number.isFinite(entry.rank) &&
        Number.isFinite(entry.score) &&
        typeof entry.player === "string"
    )
    .sort((a, b) => a.rank - b.rank);

  const champion = rankings.find((entry) => entry.rank === 1);
  const runnerUp = rankings[1] || null;
  const gap = runnerUp
    ? champion.score - runnerUp.score
    : null;

  const previousMonthKey = getPreviousMonth(targetMonth);
  const previousRankings =
    history.months?.[previousMonthKey]?.rankings || [];

  const previousChampion =
    previousRankings.length > 0
      ? [...previousRankings].sort(
          (a, b) => a.rank - b.rank
        )[0]
      : null;

  const facts = {
    monthKey: targetMonth,
    monthLabel: formatMonth(targetMonth),
    champion,
    runnerUp,
    gap,
    rankingEntryCount: rankings.length,
    previousMonthKey,
    previousChampion,
    secondaryPrize:
      "The monthly No.1 may choose one bottle from the selected prize lineup.",
    businessContext: {
      storeCount: 1,
      seats: "Fewer than 50",
      location: "Makati, Philippines",
    },
  };

  const systemInstruction = `
You create practical social media drafts and short internal reports
for AFTER, a single small bar in Makati with fewer than 50 seats.

The main appeal of the COUNT-UP ranking is the pride, competition,
recognition, and desire to finish No.1.

The bottle reward is only a secondary bonus.
Do not make the prize the main message.

Use only the supplied ranking facts.
Never invent customer behavior, visits, revenue, quotes,
friendships, personal stories, or events.

The public-facing copy must be in natural English.
The internal report must be in Japanese.

Keep the tone confident and competitive, but not aggressive.
Do not insult or pressure players.

Do not describe the competition as fierce, intense, close,
dramatic, or competitive unless the supplied facts clearly
support that description.

Do not mention the ranking entry count in public-facing copy.
The entry count may only be used in the internal report.

Mention the bottle reward only once, in one short sentence
near the end of the caption.

The internal report's nextAction must be one specific,
low-cost action that can realistically be completed by
one small bar with fewer than 50 seats.

Do not say that an activity will be continued unless the
supplied facts confirm that it is already being performed.

End the public caption with one short sentence encouraging
players to challenge for the No.1 position in the next month.

The image headline and image text must prioritize the champion,
No.1 position, and winning score rather than generic wording
such as "Ranking Results."

The internal nextAction must directly support participation,
competition, or repeat challenges. Do not recommend duplicating
information that is already displayed automatically on the
ranking monitor.

Facebook hashtags must be limited to a maximum of three.

The number supplied is ranking entries, not necessarily
the number of unique people, because the same player name
may appear more than once.

Return valid JSON only.
`;

  const userPrompt = `
Create a monthly ranking result draft using these verified facts:

${JSON.stringify(facts, null, 2)}

Return exactly this JSON structure:

{
  "headline": "Short English headline",
  "imageText": "Short English text suitable for the post image",
  "facebookCaption": "Natural English caption",
  "storyText": "Very short English Story text",
  "hashtags": ["Maximum", "Three", "Hashtags"],
  "internalReport": {
    "summary": "Japanese summary based only on the data",
    "comparison": "Japanese comparison with the previous month, or clearly state that comparison data is unavailable",
    "nextAction": "One specific and realistic action for the following month in Japanese. It must state what to do and when to do it. Do not give a generic recommendation.",
    "dataLimitations": "Japanese explanation of what cannot be concluded from the available data"
  }
}
`;

  const selectedModel = await selectModel();
  const modelId = selectedModel.replace(/^models\//, "");

  console.log(`Selected model: ${modelId}`);
  console.log(`Target month: ${targetMonth}`);

  const response = await geminiRequest(
    `/models/${modelId}:generateContent`,
    {
      method: "POST",
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: systemInstruction,
            },
          ],
        },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: userPrompt,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 1500,
          responseMimeType: "application/json",
        },
      }),
    }
  );

  const responseText = extractResponseText(response);

  if (!responseText) {
    throw new Error(
      `Gemini returned no text:\n${JSON.stringify(
        response,
        null,
        2
      )}`
    );
  }

  const draft = parseJsonResponse(responseText);
  validateDraft(draft);

  const generatedAt = new Date().toISOString();
  const monthlyChampionPost = buildMonthlyChampionPost({
    monthKey: targetMonth,
    player: champion.player,
    score: champion.score,
  });

  const output = {
    targetMonth,
    selectedModel: modelId,
    generatedAt,
    facts,
    draft,
    monthlyChampionPost,
  };

  const outputDirectory = "generated";
  await fs.mkdir(outputDirectory, {
    recursive: true,
  });

  const jsonPath = path.join(
    outputDirectory,
    `monthly-draft-${targetMonth}.json`
  );

  const markdownPath = path.join(
    outputDirectory,
    `monthly-draft-${targetMonth}.md`
  );

  await fs.writeFile(
    jsonPath,
    JSON.stringify(output, null, 2),
    "utf8"
  );

  const markdown = createMarkdown({
    draft,
    facts,
    monthlyChampionPost,
    selectedModel: modelId,
    generatedAt,
  });

  await fs.writeFile(
    markdownPath,
    markdown,
    "utf8"
  );

  console.log("");
  console.log("Monthly draft generated successfully.");
  console.log("");
  console.log(markdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
