(() => {
  "use strict";

  const podium = document.querySelector("#podium");
  if (!podium) return;

  function readScore(card) {
    const rawScore = card?.querySelector(".player-score")?.textContent || "0";
    return Number(rawScore.replace(/[^\d.-]/g, "")) || 0;
  }

  function getLeadMessage(leaderScore, secondScore, hasSecondPlace) {
    if (!hasSecondPlace) return "SETTING THE PACE";

    const lead = Math.max(0, leaderScore - secondScore);
    if (lead === 0) return "TIED FOR THE LEAD";
    if (lead === 1) return "1 PT AHEAD";
    return `${lead.toLocaleString("en-US")} PTS AHEAD`;
  }

  function enhanceLeaderCard() {
    const leader = podium.querySelector(".podium-card.first");
    if (!leader || leader.dataset.leaderEnhanced === "true") return;

    const secondPlace = podium.querySelector(".podium-card.second");
    const leaderScore = readScore(leader);
    const secondScore = readScore(secondPlace);
    const leadMessage = getLeadMessage(
      leaderScore,
      secondScore,
      Boolean(secondPlace),
    );

    const badge = document.createElement("p");
    badge.className = "leader-badge";
    badge.textContent = "CURRENT LEADER";

    const footer = document.createElement("div");
    footer.className = "leader-footer";

    const challenge = document.createElement("span");
    challenge.className = "leader-challenge";
    challenge.textContent = "DEFEND THE THRONE!";

    const gap = document.createElement("span");
    gap.className = "leader-gap";
    gap.textContent = leadMessage;

    const spotlight = document.createElement("span");
    spotlight.className = "leader-spotlight";
    spotlight.setAttribute("aria-hidden", "true");

    const sheen = document.createElement("span");
    sheen.className = "leader-sheen";
    sheen.setAttribute("aria-hidden", "true");

    footer.append(challenge, gap);
    leader.prepend(spotlight, sheen, badge);
    leader.append(footer);
    leader.dataset.leaderEnhanced = "true";

    const playerName =
      leader.querySelector(".player-name")?.textContent?.trim() || "Current leader";
    leader.setAttribute(
      "aria-label",
      `${playerName}, current leader, ${leaderScore.toLocaleString("en-US")} points, ${leadMessage.toLowerCase()}`,
    );
  }

  const observer = new MutationObserver(enhanceLeaderCard);
  observer.observe(podium, { childList: true });
  enhanceLeaderCard();
})();
