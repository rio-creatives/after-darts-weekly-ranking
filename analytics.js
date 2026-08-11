(() => {
  "use strict";

  const OPT_OUT_KEY = "after-ranking-analytics-opt-out";
  const currentScript = document.currentScript;
  const params = new URLSearchParams(window.location.search);
  const analyticsMode = params.get("analytics");

  if (analyticsMode === "off") {
    window.localStorage.setItem(OPT_OUT_KEY, "1");
  } else if (analyticsMode === "on") {
    window.localStorage.removeItem(OPT_OUT_KEY);
  }

  if (analyticsMode === "off" || analyticsMode === "on") {
    params.delete("analytics");
    const query = params.toString();
    const cleanedUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", cleanedUrl);
  }

  if (window.localStorage.getItem(OPT_OUT_KEY) === "1") {
    console.info("AFTER analytics is disabled on this display.");
    return;
  }

  const token = currentScript?.dataset.cfBeaconToken?.trim() || "";
  if (!token || token.startsWith("REPLACE_WITH_")) {
    console.info("AFTER analytics is not configured yet.");
    return;
  }

  const beacon = document.createElement("script");
  beacon.defer = true;
  beacon.src = "https://static.cloudflareinsights.com/beacon.min.js";
  beacon.dataset.cfBeacon = JSON.stringify({ token, spa: false });
  document.head.appendChild(beacon);
})();
