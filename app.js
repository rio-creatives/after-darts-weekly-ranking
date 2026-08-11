const DATA_URL =
  "https://raw.githubusercontent.com/rio-creatives/after-darts-weekly-ranking/main/data/ranking.json";
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20 * 1000;
const STALE_SUCCESS_MS = 12 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 60 * 1000;
const RECOVERY_EVENT_DEBOUNCE_MS = 2 * 1000;
const DESKTOP_RANKING_LIMIT = 11;
const MOBILE_RANKING_QUERY = window.matchMedia("(max-width: 720px)");

let lastSuccessfulFetch = Date.now();
let lastReloadAttempt = 0;
let lastRecoveryRefresh = 0;
let activeRankingRequest = null;
let latestRankingData = null;

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Manila",
  month: "short",
  day: "numeric",
  year: "numeric",
});

const updateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Manila",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function ordinal(rank) {
  if (rank === 1) return "ST";
  if (rank === 2) return "ND";
  if (rank === 3) return "RD";
  return "";
}

function podiumClass(rank) {
  if (rank === 1) return "first";
  if (rank === 2) return "second";
  return "third";
}

function renderPodiumEntry(player) {
  const article = document.createElement("article");
  article.className = `podium-card ${podiumClass(player.rank)}`;

  const rank = document.createElement("p");
  rank.className = "podium-rank";
  rank.setAttribute("aria-label", ordinal(player.rank) ? `${player.rank}${ordinal(player.rank)}` : String(player.rank));
  rank.innerHTML = `<strong class="rank-number">${player.rank}</strong><span class="rank-suffix">${ordinal(player.rank)}</span>`;

  const name = document.createElement("p");
  name.className = "player-name";
  name.textContent = player.player;

  const score = document.createElement("p");
  score.className = "player-score";
  score.textContent = Number(player.score).toLocaleString("en-US");

  article.append(rank, name, score);
  return article;
}

function renderListEntry(player) {
  const item = document.createElement("li");
  item.className = "ranking-row";

  const rank = document.createElement("span");
  rank.className = "row-rank";
  rank.textContent = String(player.rank).padStart(2, "0");

  const name = document.createElement("span");
  name.className = "row-name";
  name.textContent = player.player;

  const score = document.createElement("span");
  score.className = "row-score";
  score.textContent = Number(player.score).toLocaleString("en-US");

  item.append(rank, name, score);
  return item;
}

function render(data) {
  latestRankingData = data;

  const rankings = Array.isArray(data.rankings) ? data.rankings : [];
  const allSorted = rankings
    .map((player, index) => ({
      ...player,
      rank: Number(player.rank) || index + 1,
      score: Number(player.score) || 0,
    }))
    .sort((a, b) => a.rank - b.rank);
  const sorted = MOBILE_RANKING_QUERY.matches
    ? allSorted
    : allSorted.slice(0, DESKTOP_RANKING_LIMIT);

  const podium = document.querySelector("#podium");
  const rankingList = document.querySelector("#rankingList");
  const rankingContent = document.querySelector("#rankingContent");
  const emptyState = document.querySelector("#emptyState");

  podium.replaceChildren();
  rankingList.replaceChildren();

  const periodStart = new Date(data.periodStart || data.weekStart);
  const periodEnd = new Date(data.periodEnd || data.weekEnd);
  document.querySelector("#weekRange").textContent =
    `${dateFormatter.format(periodStart)} — ${dateFormatter.format(periodEnd)}`;
  document.querySelector(".footer p:first-child").textContent =
    "PLAYER'S BEST SCORE OF THE MONTH";

  document.querySelector("#updatedAt").textContent = updateFormatter
    .format(new Date(data.updatedAt))
    .toUpperCase();

  if (!sorted.length) {
    rankingContent.hidden = true;
    emptyState.hidden = false;
    return;
  }

  rankingContent.hidden = false;
  emptyState.hidden = true;

  const podiumOrder = [2, 1, 3];
  podiumOrder
    .map((rank) => sorted.find((player) => player.rank === rank))
    .filter(Boolean)
    .forEach((player) => podium.append(renderPodiumEntry(player)));

  const listPlayers = sorted.filter((player) => player.rank > 3);
  listPlayers.forEach((player) => rankingList.append(renderListEntry(player)));
}

function loadRanking() {
  if (activeRankingRequest) {
    return activeRankingRequest;
  }

  activeRankingRequest = (async () => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      FETCH_TIMEOUT_MS,
    );

    try {
      const response = await fetch(`${DATA_URL}?v=${Date.now()}`, {
        cache: "no-store",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Ranking request failed: ${response.status}`);
      }

      render(await response.json());
      lastSuccessfulFetch = Date.now();
    } catch (error) {
      console.error(error);
      document.querySelector("#weekRange").textContent =
        "RANKING DATA TEMPORARILY UNAVAILABLE";
    } finally {
      window.clearTimeout(timeoutId);
      activeRankingRequest = null;
    }
  })();

  return activeRankingRequest;
}

function refreshAfterResume() {
  if (document.hidden) return;

  const now = Date.now();
  if (now - lastRecoveryRefresh < RECOVERY_EVENT_DEBOUNCE_MS) return;

  lastRecoveryRefresh = now;
  loadRanking();
}

function rerenderForViewport() {
  if (latestRankingData) render(latestRankingData);
}

function reloadIfUpdatesStopped() {
  if (!navigator.onLine) return;

  const now = Date.now();
  const updatesAreStale = now - lastSuccessfulFetch > STALE_SUCCESS_MS;
  const reloadRecentlyAttempted = now - lastReloadAttempt < STALE_SUCCESS_MS;

  if (!updatesAreStale || reloadRecentlyAttempted) return;

  lastReloadAttempt = now;
  window.location.reload();
}

loadRanking();
window.setInterval(loadRanking, AUTO_REFRESH_MS);
window.setInterval(reloadIfUpdatesStopped, WATCHDOG_INTERVAL_MS);

document.addEventListener("visibilitychange", refreshAfterResume);
window.addEventListener("pageshow", refreshAfterResume);
window.addEventListener("focus", refreshAfterResume);
window.addEventListener("online", refreshAfterResume);

if (typeof MOBILE_RANKING_QUERY.addEventListener === "function") {
  MOBILE_RANKING_QUERY.addEventListener("change", rerenderForViewport);
} else {
  MOBILE_RANKING_QUERY.addListener(rerenderForViewport);
}
