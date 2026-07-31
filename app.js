const DATA_URL =
  "https://raw.githubusercontent.com/rio-creatives/after-darts-weekly-ranking/main/data/ranking.json";
const AUTO_REFRESH_MS = 5 * 60 * 1000;

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
  if (rank === 1) return "1ST";
  if (rank === 2) return "2ND";
  if (rank === 3) return "3RD";
  return String(rank);
}

function podiumClass(rank) {
  if (rank === 1) return "first";
  if (rank === 2) return "second";
  return "third";
}

function podiumGraphic(rank) {
  if (rank === 1) return "podium-gold.png";
  if (rank === 2) return "podium-silver.png";
  return "podium-bronze.png";
}

function renderPodiumEntry(player) {
  const article = document.createElement("article");
  article.className = `podium-card ${podiumClass(player.rank)}`;

  const rank = document.createElement("p");
  rank.className = "podium-rank";
  rank.innerHTML = `<strong>${player.rank}</strong> ${ordinal(player.rank)}`;

  const name = document.createElement("p");
  name.className = "player-name";
  name.textContent = player.player;

  const score = document.createElement("p");
  score.className = "player-score";
  score.textContent = Number(player.score).toLocaleString("en-US");

  const graphic = document.createElement("img");
  graphic.className = "podium-graphic";
  graphic.src = podiumGraphic(player.rank);
  graphic.alt = "";
  graphic.setAttribute("aria-hidden", "true");

  article.append(rank, name, score, graphic);
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
  const rankings = Array.isArray(data.rankings) ? data.rankings : [];
  const sorted = rankings
    .map((player, index) => ({
      ...player,
      rank: Number(player.rank) || index + 1,
      score: Number(player.score) || 0,
    }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 10);

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

  sorted
    .filter((player) => player.rank > 3)
    .forEach((player) => rankingList.append(renderListEntry(player)));
}

async function loadRanking() {
  try {
    const response = await fetch(`${DATA_URL}?v=${Date.now()}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Ranking request failed: ${response.status}`);
    }

    render(await response.json());
  } catch (error) {
    console.error(error);
    document.querySelector("#weekRange").textContent =
      "RANKING DATA TEMPORARILY UNAVAILABLE";
  }
}

loadRanking();
window.setInterval(loadRanking, AUTO_REFRESH_MS);
