import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const SHOP_URL =
  "https://search.dartslive.com/ph/shop/5c142ac9a5d39ea9fec1ae84bb28bd87/data";
const TRANSLATED_SHOP_URL =
  "https://search-dartslive-com.translate.goog/ph/shop/" +
  "5c142ac9a5d39ea9fec1ae84bb28bd87/data" +
  "?_x_tr_sl=auto&_x_tr_tl=en&_x_tr_hl=en-US";
const HISTORY_FILE = "data/history.json";
const RANKING_FILE = "data/ranking.json";
const PHT_OFFSET_MS = 8 * 60 * 60 * 1000;
const MAX_HISTORY_MONTHS = 12;

function pad(number) {
  return String(number).padStart(2, "0");
}

function toPhtIso(date) {
  const local = new Date(date.getTime() + PHT_OFFSET_MS);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}+08:00`
  );
}

function getMonth(now) {
  const phtClock = new Date(now.getTime() + PHT_OFFSET_MS);
  const year = phtClock.getUTCFullYear();
  const month = phtClock.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1) - PHT_OFFSET_MS);
  const end = new Date(Date.UTC(year, month + 1, 1) - PHT_OFFSET_MS - 1000);

  return {
    key: `${year}-${pad(month + 1)}`,
    start,
    end,
  };
}

function normalizePlayerKey(name) {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function parseRows(rows) {
  const players = [];

  for (const cells of rows) {
    const values = cells.map((cell) => cell.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (values.length < 3) continue;

    const rank = Number(values[0].replace(/[^\d]/g, ""));
    const score = Number(values.at(-1).replace(/[^\d]/g, ""));
    const player = values.slice(1, -1).join(" ").trim();

    if (
      Number.isInteger(rank) &&
      rank > 0 &&
      rank <= 100 &&
      player &&
      Number.isInteger(score) &&
      score > 0 &&
      score <= 2000
    ) {
      players.push({ rank, player, score });
    }
  }

  return players
    .sort((a, b) => a.rank - b.rank || b.score - a.score)
    .filter(
      (entry, index, all) =>
        index ===
        all.findIndex(
          (candidate) =>
            normalizePlayerKey(candidate.player) === normalizePlayerKey(entry.player) &&
            candidate.score === entry.score,
        ),
    )
    .slice(0, 10);
}

async function scrapeMonthlyRankingWithBrowser(url = SHOP_URL) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });

  try {
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "Asia/Manila",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    if (!response || response.status() >= 400) {
      throw new Error(
        `${new URL(url).hostname} returned HTTP ${response?.status() ?? "unknown"}.`,
      );
    }

    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2_000);

    const section = await page.evaluate(() => {
      const normalize = (value) => value.replace(/\s+/g, " ").trim();
      const allElements = [...document.querySelectorAll("body *")];

      const findShortestMatch = (pattern, afterElement = null) =>
        allElements
          .filter((element) => {
            const text = normalize(element.textContent || "");
            const after =
              !afterElement ||
              Boolean(
                afterElement.compareDocumentPosition(element) &
                  Node.DOCUMENT_POSITION_FOLLOWING,
              );
            return after && pattern.test(text);
          })
          .sort(
            (a, b) =>
              normalize(a.textContent || "").length - normalize(b.textContent || "").length,
          )[0];

      const monthlyHeading = findShortestMatch(/Monthly Shop Ranking/i);
      if (!monthlyHeading) return { found: false, text: "", rows: [] };

      const thisMonthHeading = findShortestMatch(/^This Month$/i, monthlyHeading);
      if (!thisMonthHeading) return { found: false, text: "", rows: [] };

      const lastMonthHeading = findShortestMatch(/^Last Month$/i, thisMonthHeading);
      const isBetween = (element) => {
        const afterStart = Boolean(
          thisMonthHeading.compareDocumentPosition(element) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        );
        const beforeEnd =
          !lastMonthHeading ||
          Boolean(
            element.compareDocumentPosition(lastMonthHeading) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          );
        return afterStart && beforeEnd;
      };

      const tables = [...document.querySelectorAll("table, [role='table']")].filter(isBetween);
      const rows = tables.flatMap((table) =>
        [...table.querySelectorAll("tr, [role='row']")].map((row) => {
          const cells = [
            ...row.querySelectorAll(
              "th, td, [role='cell'], [role='columnheader'], [role='rowheader']",
            ),
          ];
          return cells.map((cell) => normalize(cell.textContent || ""));
        }),
      );

      let sectionText = "";
      if (lastMonthHeading) {
        const range = document.createRange();
        range.setStartAfter(thisMonthHeading);
        range.setEndBefore(lastMonthHeading);
        sectionText = normalize(range.cloneContents().textContent || "");
      } else {
        sectionText = normalize(thisMonthHeading.parentElement?.textContent || "");
      }

      return { found: true, text: sectionText, rows };
    });

    if (!section.found) {
      throw new Error("Could not find the monthly COUNT-UP ranking section.");
    }

    const players = parseRows(section.rows);
    if (!players.length && !/No Play Data/i.test(section.text)) {
      throw new Error("The monthly ranking section was found, but its rows could not be parsed.");
    }

    console.log(`Found ${players.length} monthly COUNT-UP ranking entries.`);
    return players;
  } finally {
    await browser.close();
  }
}

function parseReaderText(text) {
  const monthlyMatch = text.match(/Monthly Shop Ranking/i);
  if (!monthlyMatch || monthlyMatch.index === undefined) {
    throw new Error("Reader response did not contain the monthly ranking heading.");
  }

  const afterMonthlyHeading = text.slice(monthlyMatch.index + monthlyMatch[0].length);
  const thisMonthMatch = afterMonthlyHeading.match(/This Month/i);
  if (!thisMonthMatch || thisMonthMatch.index === undefined) {
    throw new Error("Reader response did not contain the current-month heading.");
  }

  const afterThisMonth = afterMonthlyHeading.slice(
    thisMonthMatch.index + thisMonthMatch[0].length,
  );
  const lastMonthMatch = afterThisMonth.match(/Last Month/i);
  const sectionText = lastMonthMatch
    ? afterThisMonth.slice(0, lastMonthMatch.index)
    : afterThisMonth.slice(0, 5_000);

  const rows = sectionText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("|"))
    .map((line) =>
      line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    );

  const players = parseRows(rows);
  if (!players.length && !/No Play Data/i.test(sectionText)) {
    throw new Error("Reader found the monthly section, but its rows could not be parsed.");
  }

  return players;
}

async function scrapeMonthlyRankingWithReader() {
  const readerUrl =
    "https://r.jina.ai/http://search.dartslive.com/ph/shop/" +
    "5c142ac9a5d39ea9fec1ae84bb28bd87/data";
  const response = await fetch(readerUrl, {
    headers: {
      Accept: "text/plain",
      "X-No-Cache": "true",
      "X-Return-Format": "markdown",
    },
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`Reader fallback returned HTTP ${response.status}.`);
  }

  const players = parseReaderText(await response.text());
  console.log(`Reader fallback found ${players.length} monthly ranking entries.`);
  return players;
}

async function scrapeMonthlyRanking() {
  try {
    return await scrapeMonthlyRankingWithBrowser();
  } catch (browserError) {
    console.warn(`Direct DARTSLIVE access failed: ${browserError.message}`);
  }

  try {
    console.log("Trying the translated-page fallback.");
    return await scrapeMonthlyRankingWithBrowser(TRANSLATED_SHOP_URL);
  } catch (translatedPageError) {
    console.warn(`Translated-page fallback failed: ${translatedPageError.message}`);
  }

  console.log("Trying the reader fallback.");
  return scrapeMonthlyRankingWithReader();
}

async function readHistory() {
  try {
    return JSON.parse(await readFile(HISTORY_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { months: {} };
    throw error;
  }
}

async function main() {
  const now = new Date();
  const updatedAt = toPhtIso(now);
  const month = getMonth(now);
  const rankings = await scrapeMonthlyRanking();
  const history = await readHistory();

  history.months ??= {};
  history.months[month.key] = {
    periodStart: toPhtIso(month.start),
    periodEnd: toPhtIso(month.end),
    updatedAt,
    rankings,
  };

  const retainedKeys = Object.keys(history.months).sort().slice(-MAX_HISTORY_MONTHS);
  history.months = Object.fromEntries(
    retainedKeys.map((key) => [key, history.months[key]]),
  );
  history.lastSuccessfulCheckAt = updatedAt;
  history.source = SHOP_URL;

  const ranking = {
    periodType: "monthly",
    periodStart: toPhtIso(month.start),
    periodEnd: toPhtIso(month.end),
    updatedAt,
    rankings,
  };

  await writeFile(HISTORY_FILE, `${JSON.stringify(history, null, 2)}\n`);
  await writeFile(RANKING_FILE, `${JSON.stringify(ranking, null, 2)}\n`);

  console.log(`Saved ${rankings.length} monthly entries for ${month.key}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
