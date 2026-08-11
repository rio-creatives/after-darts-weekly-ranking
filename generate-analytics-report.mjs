import fs from "node:fs";
import path from "node:path";

const TIME_ZONE = "Asia/Manila";
const REPORT_HOST = "ranking.gclizer.com";
const OUTPUT_DIR = process.env.OUTPUT_DIR || "generated";
const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

function formatDateInPht(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parseDateOnly(value, fieldName = "date") {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`${fieldName} must use YYYY-MM-DD format.`);
  }

  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }

  return date;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86_400_000);
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function mostRecentCompletedSunday(now = new Date()) {
  const today = parseDateOnly(formatDateInPht(now), "PHT date");
  const weekday = today.getUTCDay();
  const daysBack = weekday === 0 ? 7 : weekday;
  return addDays(today, -daysBack);
}

function phtStartAsIso(date) {
  return new Date(date.getTime() - 8 * 60 * 60 * 1000).toISOString();
}

function escapeGraphql(value) {
  return JSON.stringify(String(value));
}

function buildFilter(start, endExclusive) {
  return `{ AND: [
    { datetime_geq: ${escapeGraphql(phtStartAsIso(start))}, datetime_lt: ${escapeGraphql(phtStartAsIso(endExclusive))} },
    { requestHost: ${escapeGraphql(REPORT_HOST)} },
    { bot: 0 }
  ] }`;
}

function buildQuery(accountId, currentStart, currentEndExclusive, previousStart, previousEndExclusive) {
  const currentFilter = buildFilter(currentStart, currentEndExclusive);
  const previousFilter = buildFilter(previousStart, previousEndExclusive);

  return `query AfterRankingWeeklyAnalytics {
    viewer {
      accounts(filter: { accountTag: ${escapeGraphql(accountId)} }) {
        currentTotal: rumPageloadEventsAdaptiveGroups(filter: ${currentFilter}, limit: 1) {
          count
          sum { visits }
        }
        previousTotal: rumPageloadEventsAdaptiveGroups(filter: ${previousFilter}, limit: 1) {
          count
          sum { visits }
        }
        currentDaily: rumPageloadEventsAdaptiveGroups(
          filter: ${currentFilter}
          limit: 200
          orderBy: [datetimeHour_ASC]
        ) {
          count
          sum { visits }
          dimensions { datetimeHour }
        }
        currentCountries: rumPageloadEventsAdaptiveGroups(
          filter: ${currentFilter}
          limit: 5
          orderBy: [sum_visits_DESC]
        ) {
          count
          sum { visits }
          dimensions { countryName }
        }
        currentDevices: rumPageloadEventsAdaptiveGroups(
          filter: ${currentFilter}
          limit: 5
          orderBy: [sum_visits_DESC]
        ) {
          count
          sum { visits }
          dimensions { deviceType }
        }
        currentReferrers: rumPageloadEventsAdaptiveGroups(
          filter: ${currentFilter}
          limit: 5
          orderBy: [sum_visits_DESC]
        ) {
          count
          sum { visits }
          dimensions { refererHost }
        }
      }
    }
  }`;
}

async function fetchAnalytics(query, token) {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Cloudflare Analytics API returned HTTP ${response.status}.`);
  }
  if (!payload || payload.errors?.length) {
    throw new Error(`Cloudflare Analytics API error: ${JSON.stringify(payload?.errors || payload)}`);
  }

  return payload;
}

function readFixture(fixturePath) {
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

function getAccountData(payload) {
  const account = payload?.data?.viewer?.accounts?.[0];
  if (!account) {
    throw new Error("No Cloudflare Web Analytics account data was returned.");
  }
  return account;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getTotal(rows) {
  const row = rows?.[0] || {};
  return {
    visits: toNumber(row.sum?.visits),
    pageViews: toNumber(row.count),
  };
}

function percentChange(current, previous) {
  if (previous === 0) {
    return current === 0 ? "—" : "New";
  }
  const value = ((current - previous) / previous) * 100;
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? (numerator / denominator).toFixed(2) : "—";
}

function buildDailyRows(rows, startDate) {
  const totals = new Map();

  for (let offset = 0; offset < 7; offset += 1) {
    totals.set(formatDateOnly(addDays(startDate, offset)), { visits: 0, pageViews: 0 });
  }

  for (const row of rows || []) {
    const hour = row.dimensions?.datetimeHour;
    if (!hour) continue;
    const date = formatDateInPht(new Date(hour));
    if (!totals.has(date)) continue;
    const current = totals.get(date);
    current.visits += toNumber(row.sum?.visits);
    current.pageViews += toNumber(row.count);
  }

  return [...totals.entries()].map(([date, values]) => ({ date, ...values }));
}

function buildTopRows(rows, dimension, emptyLabel = "Unknown") {
  return (rows || [])
    .map((row) => ({
      label: row.dimensions?.[dimension] || emptyLabel,
      visits: toNumber(row.sum?.visits),
      pageViews: toNumber(row.count),
    }))
    .filter((row) => row.visits > 0 || row.pageViews > 0)
    .sort((a, b) => b.visits - a.visits || b.pageViews - a.pageViews)
    .slice(0, 5);
}

function topTable(rows, firstColumn) {
  if (!rows.length) return "No data for this period.";
  return [
    `| ${firstColumn} | Visits | Page views |`,
    "|---|---:|---:|",
    ...rows.map((row) => `| ${String(row.label).replaceAll("|", "\\|")} | ${row.visits} | ${row.pageViews} |`),
  ].join("\n");
}

function createReport(account, ranges) {
  const current = getTotal(account.currentTotal);
  const previous = getTotal(account.previousTotal);
  const daily = buildDailyRows(account.currentDaily, ranges.currentStart);
  const countries = buildTopRows(account.currentCountries, "countryName");
  const devices = buildTopRows(account.currentDevices, "deviceType");
  const referrers = buildTopRows(account.currentReferrers, "refererHost", "Direct / unknown");

  const currentStart = formatDateOnly(ranges.currentStart);
  const currentEnd = formatDateOnly(addDays(ranges.currentEndExclusive, -1));
  const previousStart = formatDateOnly(ranges.previousStart);
  const previousEnd = formatDateOnly(addDays(ranges.previousEndExclusive, -1));

  const markdown = `<!-- after-ranking-analytics-report:${currentEnd} -->
# AFTER Ranking Website — Weekly Access Report

**Period:** ${currentStart} to ${currentEnd} (PHT)  
**Comparison:** ${previousStart} to ${previousEnd} (PHT)  
**Site:** https://${REPORT_HOST}/

## Summary

| Metric | This week | Previous week | Change |
|---|---:|---:|---:|
| Visits | ${current.visits} | ${previous.visits} | ${percentChange(current.visits, previous.visits)} |
| Page views | ${current.pageViews} | ${previous.pageViews} | ${percentChange(current.pageViews, previous.pageViews)} |
| Page views / visit | ${ratio(current.pageViews, current.visits)} | ${ratio(previous.pageViews, previous.visits)} | — |

## Daily trend

| Date (PHT) | Visits | Page views |
|---|---:|---:|
${daily.map((row) => `| ${row.date} | ${row.visits} | ${row.pageViews} |`).join("\n")}

## Top countries

${topTable(countries, "Country")}

## Devices

${topTable(devices, "Device")}

## Referrers

${topTable(referrers, "Source")}

## Reading the report

- **Visits** are visit sessions, not a precise count of unique people.
- **Page views** count successful page loads.
- Known bots are excluded by the Cloudflare query.
- The AFTER in-store monitor is excluded after analytics opt-out is enabled on that device.
- Small weekly totals can produce large percentage swings, so use the trend together with actual counts.

_Generated automatically from Cloudflare Web Analytics._
`;

  return {
    current,
    previous,
    daily,
    countries,
    devices,
    referrers,
    period: { currentStart, currentEnd, previousStart, previousEnd },
    markdown,
  };
}

async function main() {
  const explicitEndDate = (process.env.REPORT_END_DATE || "").trim();
  const currentEnd = explicitEndDate
    ? parseDateOnly(explicitEndDate, "REPORT_END_DATE")
    : mostRecentCompletedSunday();
  const currentStart = addDays(currentEnd, -6);
  const currentEndExclusive = addDays(currentEnd, 1);
  const previousEndExclusive = currentStart;
  const previousStart = addDays(previousEndExclusive, -7);

  const ranges = { currentStart, currentEndExclusive, previousStart, previousEndExclusive };
  const fixturePath = (process.env.ANALYTICS_FIXTURE_PATH || "").trim();
  let payload;

  if (fixturePath) {
    payload = readFixture(fixturePath);
  } else {
    const token = (process.env.CLOUDFLARE_API_TOKEN || "").trim();
    const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
    if (!token || !accountId) {
      throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required.");
    }
    if (!/^[a-f0-9]{32}$/i.test(accountId)) {
      throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal ID.");
    }

    payload = await fetchAnalytics(
      buildQuery(accountId, currentStart, currentEndExclusive, previousStart, previousEndExclusive),
      token,
    );
  }

  const report = createReport(getAccountData(payload), ranges);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const endDate = report.period.currentEnd;
  const markdownPath = path.join(OUTPUT_DIR, `analytics-report-${endDate}.md`);
  const jsonPath = path.join(OUTPUT_DIR, `analytics-report-${endDate}.json`);

  fs.writeFileSync(markdownPath, report.markdown, "utf8");
  fs.writeFileSync(jsonPath, `${JSON.stringify({ ...report, markdown: undefined }, null, 2)}\n`, "utf8");

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `report_end_date=${endDate}\nmarkdown_path=${markdownPath}\njson_path=${jsonPath}\n`,
    );
  }

  console.log(`Generated ${markdownPath}`);
  console.log(`Generated ${jsonPath}`);
  console.log(`Visits: ${report.current.visits}; page views: ${report.current.pageViews}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
