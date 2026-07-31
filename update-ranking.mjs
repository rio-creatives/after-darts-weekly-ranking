import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const SHOP_URL =
  "https://search.dartslive.com/ph/shop/5c142ac9a5d39ea9fec1ae84bb28bd87/data";
const HISTORY_FILE = "data/history.json";
const RANKING_FILE = "data/ranking.json";
const PHT_OFFSET_MS = 8 * 60 * 60 * 1000;
const WEEK_START_HOUR = 6;
const MAX_HISTORY_WEEKS = 12;

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

function getWeek(now) {
  const phtClock = new Date(now.getTime() + PHT_OFFSET_MS);
  const shifted = new Date(phtClock.getTime() - WEEK_START_HOUR * 60 * 60 * 1000);
  const daysSinceMonday = (shifted.getUTCDay() + 6) % 7;

  const startOnPhtClock = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() - daysSinceMonday,
    WEEK_START_HOUR,
    0,
    0,
  );

  const start = new Date(startOnPhtClock - PHT_OFFSET_MS);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000 - 1000);

  return {
    key: toPhtIso(start).slice(0, 10),
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
    .sort((a, b) => a.rank - b.rank)
    .filter(
      (player, index, all) =>
        index === all.findIndex((candidate) => candidate.rank === player.rank),
    )
    .slice(0, 10);
}

async function scrapeTodayRanking() {
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
    const response = await page.goto(SHOP_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    if (!response || response.status() >= 400) {
      throw new Error(`DARTSLIVE returned HTTP ${response?.status() ?? "unknown"}.`);
    }

    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2_000);

    const section = await page.evaluate(() => {
      const normalize = (value) => value.replace(/\s+/g, " ").trim();
      const allElements = [...document.querySelectorAll("body *")];
      const todayPattern = /COUNT-UP RANKING\s*\(Today\)/i;
      const monthlyPattern = /Monthly Shop Ranking/i;

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

      const heading = findShortestMatch(todayPattern);
      if (!heading) return { found: false, text: "", rows: [] };

      const monthlyHeading = findShortestMatch(monthlyPattern, heading);
      const isBetween = (element) => {
        const afterHeading = Boolean(
          heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
        );
        const beforeMonthly =
          !monthlyHeading ||
          Boolean(
            element.compareDocumentPosition(monthlyHeading) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          );
        return afterHeading && beforeMonthly;
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
      if (monthlyHeading) {
        const range = document.createRange();
        range.setStartAfter(heading);
        range.setEndBefore(monthlyHeading);
        sectionText = normalize(range.cloneContents().textContent || "");
      } else {
        sectionText = normalize(heading.parentElement?.textContent || "");
      }

      return { found: true, text: sectionText, rows };
    });

    if (!section.found) {
      throw new Error("Could not find the COUNT-UP RANKING (Today) section.");
    }

    const players = parseRows(section.rows);
    if (!players.length && !/No Play Data/i.test(section.text)) {
      throw new Error("The daily ranking section was found, but its rows could not be parsed.");
    }

    console.log(`Found ${players.length} daily COUNT-UP ranking entries.`);
    return players;
  } finally {
    await browser.close();
  }
}

async function readHistory() {
  try {
    return JSON.parse(await readFile(HISTORY_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { weeks: {} };
    throw error;
  }
}

function makeCurrentRanking(weekRecord, updatedAt) {
  const rankings = Object.values(weekRecord.players)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.bestRecordedAt.localeCompare(b.bestRecordedAt) ||
        a.player.localeCompare(b.player, "en"),
    )
    .slice(0, 10)
    .map((player, index) => ({
      rank: index + 1,
      player: player.player,
      score: player.score,
    }));

  return {
    weekStart: weekRecord.weekStart,
    weekEnd: weekRecord.weekEnd,
    updatedAt,
    rankings,
  };
}

async function main() {
  const now = new Date();
  const updatedAt = toPhtIso(now);
  const week = getWeek(now);
  const dailyPlayers = await scrapeTodayRanking();
  const history = await readHistory();

  history.weeks ??= {};
  history.weeks[week.key] ??= {
    weekStart: toPhtIso(week.start),
    weekEnd: toPhtIso(week.end),
    players: {},
  };

  const currentWeek = history.weeks[week.key];

  for (const entry of dailyPlayers) {
    const key = normalizePlayerKey(entry.player);
    const existing = currentWeek.players[key];

    if (!existing || entry.score > existing.score) {
      currentWeek.players[key] = {
        player: entry.player,
        score: entry.score,
        bestRecordedAt: updatedAt,
        lastSeenAt: updatedAt,
      };
    } else {
      existing.lastSeenAt = updatedAt;
    }
  }

  const retainedKeys = Object.keys(history.weeks).sort().slice(-MAX_HISTORY_WEEKS);
  history.weeks = Object.fromEntries(
    retainedKeys.map((key) => [key, history.weeks[key]]),
  );
  history.lastSuccessfulCheckAt = updatedAt;
  history.source = SHOP_URL;

  const ranking = makeCurrentRanking(currentWeek, updatedAt);
  await writeFile(HISTORY_FILE, `${JSON.stringify(history, null, 2)}\n`);
  await writeFile(RANKING_FILE, `${JSON.stringify(ranking, null, 2)}\n`);

  console.log(
    `Saved ${ranking.rankings.length} weekly entries for week ${week.key}.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
