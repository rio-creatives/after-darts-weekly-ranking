(() => {
  "use strict";

  const podium = document.querySelector("#podium");
  if (!podium) return;

  const MANILA_TIME_ZONE = "Asia/Manila";

  function getManilaMonthStatus(now = new Date()) {
    const dateParts = new Intl.DateTimeFormat("en-US", {
      timeZone: MANILA_TIME_ZONE,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(now);

    const partValue = (type) =>
      Number(dateParts.find((part) => part.type === type)?.value || 0);
    const year = partValue("year");
    const month = partValue("month");
    const day = partValue("day");
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const deadline = new Date(Date.UTC(year, month - 1, lastDay, 12));
    const deadlineLabel = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
    })
      .format(deadline)
      .toUpperCase();
    const daysLeft = Math.max(0, lastDay - day);

    return {
      deadlineLabel,
      showCountdown: daysLeft <= 7,
      countdownLabel:
        daysLeft === 0
          ? "FINAL DAY"
          : `${daysLeft} DAY${daysLeft === 1 ? "" : "S"} LEFT`,
    };
  }

  function monthLabelFromKey(monthKey) {
    const match = String(monthKey || "").match(/^(\d{4})-(\d{2})$/);
    if (!match) return "";

    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "long",
    })
      .format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)))
      .toUpperCase();
  }

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
    const monthStatus = getManilaMonthStatus();
    const screen = document.querySelector(".screen");
    const showingPreviousFinal =
      screen?.dataset.displayMode === "previous_month_final";
    const displayMonthLabel =
      monthLabelFromKey(screen?.dataset.displayMonth) || "PREVIOUS MONTH";
    const currentMonthLabel =
      monthLabelFromKey(screen?.dataset.currentMonth) || "NEW MONTH";
    const playerName =
      leader.querySelector(".player-name")?.textContent?.trim() || "CHAMPION";

    const badge = document.createElement("p");
    badge.className = "leader-badge";
    badge.textContent = showingPreviousFinal ? "FINAL #1" : "CURRENT LEADER";

    const footer = document.createElement("div");
    footer.className = "leader-footer";

    const rewardRow = document.createElement("div");
    rewardRow.className = "leader-reward-row";

    const rewardBadge = document.createElement("span");
    rewardBadge.className = "leader-reward-badge";

    const rewardIcon = document.createElement("span");
    rewardIcon.className = "leader-reward-icon";
    rewardIcon.setAttribute("aria-hidden", "true");
    rewardIcon.textContent = "🎁";

    const rewardText = document.createElement("span");
    rewardText.className = "leader-reward-text";
    rewardText.textContent = showingPreviousFinal
      ? `${displayMonthLabel} MONTHLY CHAMPION`
      : "MONTHLY REWARD WITHIN REACH";

    const countdown = document.createElement("span");
    countdown.className = "leader-countdown";
    countdown.textContent = monthStatus.countdownLabel;

    const challenge = document.createElement("span");
    challenge.className = "leader-challenge";
    challenge.textContent = showingPreviousFinal
      ? `CONGRATS! ${playerName.toUpperCase()}!`
      : `STAY #1 THROUGH ${monthStatus.deadlineLabel}`;

    const gap = document.createElement("span");
    gap.className = "leader-gap";
    gap.textContent = showingPreviousFinal ? "FINAL SCORE" : leadMessage;

    const spotlight = document.createElement("span");
    spotlight.className = "leader-spotlight";
    spotlight.setAttribute("aria-hidden", "true");

    const sheen = document.createElement("span");
    sheen.className = "leader-sheen";
    sheen.setAttribute("aria-hidden", "true");

    rewardBadge.append(rewardIcon, rewardText);
    rewardRow.append(rewardBadge);
    if (!showingPreviousFinal && monthStatus.showCountdown) {
      rewardRow.append(countdown);
    }
    footer.append(challenge, gap);
    leader.prepend(spotlight, sheen, badge);
    leader.append(rewardRow, footer);
    leader.dataset.leaderEnhanced = "true";

    const accessibilityLabel = [
      showingPreviousFinal
        ? `${playerName}, final number one for ${displayMonthLabel}`
        : `${playerName}, current leader`,
      `${leaderScore.toLocaleString("en-US")} points`,
      showingPreviousFinal
        ? `${displayMonthLabel} monthly champion`
        : "monthly reward within reach",
      ...(!showingPreviousFinal && monthStatus.showCountdown
        ? [monthStatus.countdownLabel.toLowerCase()]
        : []),
      showingPreviousFinal
        ? `congratulations, ${playerName}`
        : `stay number one through ${monthStatus.deadlineLabel}`,
      showingPreviousFinal ? "final score" : leadMessage.toLowerCase(),
    ].join(", ");
    leader.setAttribute("aria-label", accessibilityLabel);
  }

  const observer = new MutationObserver(enhanceLeaderCard);
  observer.observe(podium, { childList: true });
  enhanceLeaderCard();
})();
