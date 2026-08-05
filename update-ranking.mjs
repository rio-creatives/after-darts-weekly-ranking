import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const SHOP_ID = "5c142ac9a5d39ea9fec1ae84bb28bd87";
const NATIONAL_RANKING_URL = "https://www.dartslive.com/ph/ranking/";
const SHOP_URL =
  `https://search.dartslive.com/ph/shop/${SHOP_ID}/data`;
const TRANSLATE_PROXY_URL =
  "https://search-dartslive-com.translate.goog/ph/shop/" +
  `${SHOP_ID}/data` +
  "?_x_tr_sl=en&_x_tr_tl=fil&_x_tr_hl=en";
const HISTORY_FILE = "data/history.json";
const RANKING_FILE = "data/ranking.json";
const PHT_OFFSET_MS = 8 * 60 * 60 * 1000;
const MAX_HISTORY_MONTHS = 12;
const DISPLAY_RANKING_LIMIT = 11;
const SHOP_PAGE_LIMIT = 10;

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

function correctPlayerName(name) {
  const cleaned = name.normalize("NFKC").trim().replace(/\s+/g, " ");

  // The proxy can return the uppercase "I" in KEISUKE as a lowercase "l".
  if (cleaned === "KElSUKE") return "KEISUKE";

  return cleaned;
}

function parseRows(rows) {
  const players = [];

  for (const cells of rows) {
    const values = cells.map((cell) => cell.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (values.length < 3) continue;

    const rank = Number(values[0].replace(/[^\d]/g, ""));
    const score = Number(values.at(-1).replace(/[^\d]/g, ""));
    const player = correctPlayerName(values.slice(1, -1).join(" "));

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
    .slice(0, SHOP_PAGE_LIMIT);
}

function getClassText(markup, className) {
  const pattern = new RegExp(
    `<[^>]+class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>` +
      `([\\s\\S]*?)<\\/[^>]+>`,
    "i",
  );
  const match = markup.match(pattern);
  return match ? stripHtml(match[1]) : "";
}

function parseNationalRankingHtml(html) {
  const countUpStart = html.search(
    /<div\b(?=[^>]*\bdata-id=["']count-up["'])(?=[^>]*\bclass=["'][^"']*\bposts\b[^"']*["'])[^>]*>/i,
  );
  if (countUpStart < 0) {
    throw new Error("National ranking did not contain the COUNT-UP section.");
  }

  const afterCountUpStart = html.slice(countUpStart);
  const nextCategoryOffset = afterCountUpStart.search(
    /<div\b(?=[^>]*\bdata-id=["'](?:shoot_out|rating|rating2)["'])(?=[^>]*\bclass=["'][^"']*\bposts\b[^"']*["'])[^>]*>/i,
  );
  const countUpHtml =
    nextCategoryOffset >= 0
      ? afterCountUpStart.slice(0, nextCategoryOffset)
      : afterCountUpStart;
  const currentMonthMatch = countUpHtml.match(
    /<dl\b(?=[^>]*\bclass=["'][^"']*\branking-month\b[^"']*\bthis_month\b[^"']*["'])[^>]*>([\s\S]*?)<\/dl>/i,
  );

  if (!currentMonthMatch) {
    throw new Error("National ranking did not contain this month's COUNT-UP list.");
  }

  const rows = [...currentMonthMatch[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)];
  if (rows.length === 0) {
    throw new Error("National ranking's current-month COUNT-UP list was empty.");
  }

  const players = [];
  for (const row of rows) {
    const markup = row[1];
    const shopMarkup = markup.match(
      /<p\b[^>]*class=["'][^"']*\bshop\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
    )?.[1];
    const shopUrl = shopMarkup?.match(/<a\b[^>]*href=["']([^"']+)["']/i)?.[1] || "";
    const player = correctPlayerName(getClassText(markup, "name"));
    const score = Number(getClassText(markup, "price").replace(/[^\d]/g, ""));

    if (
      shopUrl.includes(`/shop/${SHOP_ID}`) &&
      player &&
      Number.isInteger(score) &&
      score > 0 &&
      score <= 2000
    ) {
      players.push({ player, score });
    }
  }

  return players
    .sort((a, b) => b.score - a.score)
    .slice(0, DISPLAY_RANKING_LIMIT)
    .map((entry, index) => ({
      rank: index + 1,
      ...entry,
    }));
}

function requireCompleteNationalRanking(players, method) {
  // Use the national page only when it actually extends the shop page's top 10.
  if (players.length < DISPLAY_RANKING_LIMIT) {
    throw new Error(
      `${method} contained only ${players.length} AFTER entries; ` +
        `at least ${DISPLAY_RANKING_LIMIT} are required to extend the shop ranking.`,
    );
  }

  console.log(
    `${method} found ${players.length} AFTER monthly COUNT-UP entries.`,
  );
  return players;
}

async function scrapeNationalMonthlyRankingWithFetch() {
  const response = await fetch(NATIONAL_RANKING_URL, {
    headers: {
      Accept: "text/html",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`National DARTSLIVE ranking returned HTTP ${response.status}.`);
  }

  const players = parseNationalRankingHtml(await response.text());
  return requireCompleteNationalRanking(players, "National ranking fetch");
}

async function scrapeNationalMonthlyRankingWithBrowser() {
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
    const response = await page.goto(NATIONAL_RANKING_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    if (!response || response.status() >= 400) {
      throw new Error(
        `National DARTSLIVE browser request returned HTTP ` +
          `${response?.status() ?? "unknown"}.`,
      );
    }

    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2_000);

    const players = parseNationalRankingHtml(await page.content());
    return requireCompleteNationalRanking(players, "National ranking browser");
  } finally {
    await browser.close();
  }
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

function decodeHtmlEntities(value) {
  const namedEntities = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (entity, name) => namedEntities[name.toLowerCase()] ?? entity);
}

function stripHtml(value) {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parseProxyHtml(html) {
  const tableMatch = html.match(
    /<tbody[^>]+id=["']count-items-This Month-1["'][^>]*>([\s\S]*?)<\/tbody>/i,
  );
  if (!tableMatch) {
    throw new Error("Proxy response did not contain the current-month COUNT-UP table.");
  }

  const rows = [...tableMatch[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(
    (rowMatch) =>
      [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(
        (cellMatch) => stripHtml(cellMatch[1]),
      ),
  );

  const players = parseRows(rows);
  if (!players.length && !/No Play Data/i.test(tableMatch[1])) {
    throw new Error("Proxy found the monthly table, but its rows could not be parsed.");
  }

  return players;
}

async function scrapeMonthlyRankingWithProxy() {
  const response = await fetch(TRANSLATE_PROXY_URL, {
    headers: {
      Accept: "text/html",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`DARTSLIVE proxy returned HTTP ${response.status}.`);
  }

  const players = parseProxyHtml(await response.text());
  console.log(`DARTSLIVE proxy found ${players.length} monthly ranking entries.`);
  return players;
}

async function scrapeMonthlyRankingWithReader() {
  const readerUrl =
    "https://r.jina.ai/https://search.dartslive.com/ph/shop/" +
    `${SHOP_ID}/data`;
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
    return {
      rankings: await scrapeNationalMonthlyRankingWithFetch(),
      source: NATIONAL_RANKING_URL,
    };
  } catch (fetchError) {
    console.warn(`National DARTSLIVE fetch failed: ${fetchError.message}`);
  }

  try {
    console.log("Trying the national DARTSLIVE ranking with Chromium.");
    return {
      rankings: await scrapeNationalMonthlyRankingWithBrowser(),
      source: NATIONAL_RANKING_URL,
    };
  } catch (browserError) {
    console.warn(`National DARTSLIVE browser failed: ${browserError.message}`);
    console.log("Falling back to the AFTER shop ranking page.");
  }

  try {
    return {
      rankings: await scrapeMonthlyRankingWithBrowser(),
      source: SHOP_URL,
    };
  } catch (browserError) {
    console.warn(`Direct DARTSLIVE access failed: ${browserError.message}`);
  }

  try {
    console.log("Trying the DARTSLIVE proxy fallback.");
    return {
      rankings: await scrapeMonthlyRankingWithProxy(),
      source: SHOP_URL,
    };
  } catch (proxyError) {
    console.warn(`DARTSLIVE proxy access failed: ${proxyError.message}`);
  }

  console.log("Trying the original-text reader fallback.");
  return {
    rankings: await scrapeMonthlyRankingWithReader(),
    source: SHOP_URL,
  };
}

async function readHistory() {
  try {
    return JSON.parse(await readFile(HISTORY_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { months: {} };
    throw error;
  }
}

function getLatestPreviousRanking(history, currentMonthKey) {
  const previousMonthKey = Object.keys(history.months ?? {})
    .filter((key) => key < currentMonthKey)
    .filter((key) => history.months[key]?.rankings?.length > 0)
    .sort()
    .at(-1);

  if (!previousMonthKey) return null;

  return {
    key: previousMonthKey,
    ...history.months[previousMonthKey],
  };
}

function hasRankings(monthRanking) {
  return Array.isArray(monthRanking?.rankings) && monthRanking.rankings.length > 0;
}

function preserveCachedExtendedEntries(rankings, savedCurrentRanking) {
  const savedRankings = Array.isArray(savedCurrentRanking?.rankings)
    ? savedCurrentRanking.rankings
    : [];

  if (
    rankings.length !== SHOP_PAGE_LIMIT ||
    savedRankings.length <= rankings.length
  ) {
    return rankings;
  }

  const currentPlayers = new Set(rankings.map((entry) => entry.player));
  const cachedTail = savedRankings
    .slice(SHOP_PAGE_LIMIT)
    .filter((entry) => !currentPlayers.has(entry.player));

  if (cachedTail.length === 0) return rankings;

  const preserved = [...rankings, ...cachedTail]
    .sort((a, b) => b.score - a.score)
    .slice(0, DISPLAY_RANKING_LIMIT)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));

  console.log(
    `The shop page returned only ${rankings.length} entries; ` +
      `preserving ${preserved.length - rankings.length} cached lower entry.`,
  );
  return preserved;
}

async function main() {
  const now = new Date();
  const updatedAt = toPhtIso(now);
  const month = getMonth(now);
  const fetched = await scrapeMonthlyRanking();
  let rankings = fetched.rankings;
  const { source } = fetched;
  const history = await readHistory();

  history.months ??= {};
  const savedCurrentRanking = history.months[month.key];
  rankings = preserveCachedExtendedEntries(rankings, savedCurrentRanking);
  const fetchedCurrentRanking = {
    periodStart: toPhtIso(month.start),
    periodEnd: toPhtIso(month.end),
    updatedAt,
    rankings,
  };

  // A temporary zero-result response must not erase rankings already saved for
  // the current month. Replace the saved month only when fresh entries exist,
  // or when this month has never been stored before.
  if (rankings.length > 0 || !savedCurrentRanking) {
    history.months[month.key] = fetchedCurrentRanking;
  }

  const retainedKeys = Object.keys(history.months).sort().slice(-MAX_HISTORY_MONTHS);
  history.months = Object.fromEntries(
    retainedKeys.map((key) => [key, history.months[key]]),
  );
  history.lastSuccessfulCheckAt = updatedAt;
  history.source = source;

  const previousRanking = getLatestPreviousRanking(history, month.key);
  const displayedRanking =
    rankings.length > 0
      ? history.months[month.key]
      : hasRankings(savedCurrentRanking)
        ? savedCurrentRanking
        : previousRanking ?? history.months[month.key];

  const ranking = {
    periodType: "monthly",
    periodStart: displayedRanking.periodStart,
    periodEnd: displayedRanking.periodEnd,
    updatedAt,
    source,
    rankings: displayedRanking.rankings,
  };

  await writeFile(HISTORY_FILE, `${JSON.stringify(history, null, 2)}\n`);
  await writeFile(RANKING_FILE, `${JSON.stringify(ranking, null, 2)}\n`);

  if (rankings.length === 0 && hasRankings(savedCurrentRanking)) {
    console.log(
      `No entries found for ${month.key}; keeping the latest saved current-month ranking.`,
    );
  } else if (rankings.length === 0 && previousRanking) {
    console.log(
      `No entries found for ${month.key}; continuing to display ${previousRanking.key}.`,
    );
  } else {
    console.log(`Saved ${rankings.length} monthly entries for ${month.key}.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
