/**
 * Requires Playwright with Chromium installed (npm install --no-save playwright;
 * npx playwright install chromium), plus a local website server.
 * Run: node tests/browser_smoke.cjs http://127.0.0.1:8000/restaurant_map.html
 * Set PLAYWRIGHT_CHANNEL=msedge to use an installed Microsoft Edge instead.
 * Screenshots and the report are kept in the ignored .tmp/ directory.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

(async () => {
  const url = process.argv[2] || "http://127.0.0.1:8000/restaurant_map.html";
  const origin = new URL(url).origin;
  const output = path.resolve(__dirname, "../.tmp");
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    const failedAssets = [];
    const remotePhotos = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.url().startsWith(origin) && response.status() >= 400) {
        failedAssets.push(`${response.status()} ${response.url()}`);
      }
    });
    page.on("request", (request) => {
      if (/googleusercontent\.com\/place-photos/.test(request.url())) remotePhotos.push(request.url());
    });
    // QA should not send analytics events to the live site.
    await page.route("https://plausible.io/**", (route) => route.abort());
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof restaurants !== "undefined" && restaurants.length > 0 && view?.ready, null, { timeout: 60000 });
    const loaded = await page.evaluate(async () => ({
      count: restaurants.length,
      graphics: restaurantLayer.graphics.length,
      expected: (await (await fetch(DATA_URL)).json()).features.filter((feature) => feature.geometry).length,
      pinAvailable: localPinImageAvailable,
      css: getComputedStyle(document.querySelector(".hub-nav")).position,
    }));
    assert.equal(loaded.count, loaded.expected);
    assert.equal(loaded.graphics, loaded.count);
    assert.equal(loaded.css, "relative");
    await page.waitForFunction(() => localPinImageAvailable, null, { timeout: 10000 });
    assert.equal(await page.locator("#scoreCard").isVisible(), false);
    assert.equal(await page.locator("#metricsCard").isVisible(), false);
    assert.equal(await page.locator("#resultsPanel").isVisible(), false);

    // Hand-calculated averages and boundary values exercise the distributions.
    const summaries = await page.evaluate(() => {
      const fixture = [
        { inspectionRaw: 0, ratingStars: 2.5, price: 0, distanceMiles: 0 },
        { inspectionRaw: 1, ratingStars: 3.5, price: 10, distanceMiles: 0.25 },
        { inspectionRaw: 2, ratingStars: 4.25, price: 20, distanceMiles: 0.5 },
        { inspectionRaw: null, ratingStars: 4.75, price: 35, distanceMiles: 1 },
        { inspectionRaw: 2, ratingStars: null, price: null, distanceMiles: 2 },
      ];
      return SUMMARY_METRICS.map((metric) => ({
        ...summarizeNearbyMetric(fixture, metric),
        empty: summarizeNearbyMetric([], metric),
        missing: summarizeNearbyMetric([{ [metric.key]: null }], metric),
      }));
    });
    const expectedAverages = [1.25, 3.75, 16.25, 0.75];
    const expectedBuckets = [[1, 1, 2], [1, 1, 1, 1], [1, 1, 2], [1, 1, 1, 2]];
    summaries.forEach((summary, index) => {
      assert.equal(summary.average, expectedAverages[index]);
      assert.deepEqual(summary.counts, expectedBuckets[index]);
      assert.equal(summary.knownCount, index === 3 ? 5 : 4);
      assert.equal(summary.missingCount, index === 3 ? 0 : 1);
      assert.equal(summary.empty.average, null);
      assert.equal(summary.empty.knownCount, 0);
      assert.equal(summary.empty.missingCount, 0);
      assert.equal(summary.missing.average, null);
      assert.equal(summary.missing.missingCount, 1);
    });

    await page.locator("#restaurantSearchInput").fill("88 Bao Bao");
    await page.locator(".select-suggestion-button").first().waitFor();
    await page.waitForFunction(() => {
      const photo = document.querySelector(".suggestion-photo");
      return photo instanceof HTMLImageElement && photo.complete && photo.naturalWidth > 0;
    }, null, { timeout: 15000 });
    const imageSource = await page.locator("img.suggestion-photo").first().getAttribute("src");
    assert.ok(imageSource.startsWith(`${origin}/assets/images/restaurants/`));
    await page.locator(".select-suggestion-button").first().click();
    await page.waitForFunction(() => !!currentAnalysisPoint && !!lastAnalysisResult);
    assert.ok(Number.isFinite(Number(await page.locator("#riskNumber").textContent())));
    assert.equal(await page.locator("#scoreCard").isVisible(), false);
    assert.equal(await page.locator("#metricsCard").isVisible(), true);
    assert.equal(await page.locator(".metric-distribution").count(), 4);
    await page.locator("#toggleMetricsButton").click();
    assert.equal(await page.locator("#toggleMetricsButton").getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator("#metricsSummaryBody").isVisible(), false);
    assert.equal(await page.locator("#resultsPanel").isVisible(), true);
    await page.locator("#toggleMetricsButton").click();
    assert.equal(await page.locator("#metricsSummaryBody").isVisible(), true);
    assert.ok((await page.locator(".search-result").count()) > 0);

    // Clicking a result card must browse it without moving the analysis pin
    // or rebuilding the current result list.
    const resultCard = page.locator(".search-result").nth(1);
    const browseIndex = Number(await resultCard.getAttribute("data-restaurant-index"));
    await resultCard.scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      window.pinnedResultsCheckpoint = {
        point: currentAnalysisPoint,
        analysis: lastAnalysisResult,
        list: document.getElementById("restaurantSearchResults").innerHTML,
        metrics: document.getElementById("metricDistributions").innerHTML,
      };
    });
    await resultCard.locator(".search-result-copy").click();
    await page.waitForFunction((index) => view.popup?.visible &&
      view.popup.selectedFeature?.attributes.objectid === restaurants[index].attributes.objectid,
      browseIndex);
    assert.equal(await page.evaluate(() =>
      currentAnalysisPoint === pinnedResultsCheckpoint.point &&
      lastAnalysisResult === pinnedResultsCheckpoint.analysis &&
      document.getElementById("restaurantSearchResults").innerHTML === pinnedResultsCheckpoint.list &&
      document.getElementById("metricDistributions").innerHTML === pinnedResultsCheckpoint.metrics), true);
    await page.locator("#toggleMetricsButton").click();

    // Adjust the actual filter input and check the analysis uses it.
    await page.locator("#radiusMiles").evaluate((element) => {
      element.value = "0.5";
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(await page.evaluate(() => lastAnalysisResult.options.radiusMiles), 0.5);
    assert.ok((await page.locator("#metricsSummaryMeta").textContent()).includes("within 0.5 mi"));
    assert.equal(await page.locator("#toggleMetricsButton").getAttribute("aria-expanded"), "false");
    await page.locator("#toggleMetricsButton").click();
    await page.locator("#ratingMode").selectOption("exact");
    assert.equal(await page.evaluate(() => lastAnalysisResult.options.ratingMode), "exact");
    await page.locator("#allowUnknownRating").uncheck();
    assert.equal(await page.evaluate(() => lastAnalysisResult.options.allowUnknownRating), false);

    // Selecting a restaurant opens its popup asynchronously and collapses the legend.
    await page.waitForFunction(() => view.popup?.visible && document.getElementById("legendCard").classList.contains("collapsed"));
    const legendBefore = await page.locator("#legendToggleButton").getAttribute("aria-expanded");
    await page.locator("#legendToggleButton").click();
    assert.notEqual(await page.locator("#legendToggleButton").getAttribute("aria-expanded"), legendBefore);
    await page.locator("#legendToggleButton").click();
    await page.locator("#pinButton").click();
    assert.equal(await page.evaluate(() => dropPinMode), true);
    await page.locator("#pinButton").click();
    assert.equal(await page.evaluate(() => dropPinMode), false);

    const popup = await page.evaluate(() => buildRestaurantPopupHtml(restaurants[0].attributes));
    assert.ok(popup.includes("/assets/images/restaurants/"));
    assert.ok(popup.includes("popup-attribution"));
    await page.waitForFunction(() => !view.updating, null, { timeout: 30000 });
    await page.screenshot({ path: path.join(output, "map-desktop.png"), fullPage: true });
    await page.locator("#removeSelectionButton").click();
    assert.equal(await page.evaluate(() => currentAnalysisPoint), null);
    assert.equal(await page.locator("#metricsCard").isVisible(), false);
    assert.equal(await page.locator("#resultsPanel").isVisible(), false);
    assert.equal(await page.locator(".metric-distribution").count(), 0);
    const clearedHeight = await page.evaluate(() => ({
      toolbar: document.querySelector(".toolbar").getBoundingClientRect().height,
      container: document.querySelector(".top-ui").getBoundingClientRect().height,
    }));
    assert.ok(Math.abs(clearedHeight.toolbar - clearedHeight.container) < 1);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof restaurants !== "undefined" && restaurants.length > 0 && view?.ready, null, { timeout: 60000 });
    assert.equal(await page.locator("#legendToggleButton").getAttribute("aria-expanded"), "false");
    const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(layout.scrollWidth <= layout.width);
    await page.locator("#restaurantSearchInput").fill("88 Bao Bao");
    await page.locator(".select-suggestion-button").first().click();
    await page.waitForFunction(() => !!lastAnalysisResult);
    assert.equal(await page.locator("#scoreCard").isVisible(), false);
    assert.equal(await page.locator("#metricsCard").isVisible(), true);
    await page.locator("#toggleMetricsButton").click();
    assert.equal(await page.locator("#metricsSummaryBody").isVisible(), false);
    await page.locator("#toggleMetricsButton").click();
    assert.equal(await page.locator("#metricsSummaryBody").isVisible(), true);
    const chartLayout = await page.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      card: document.getElementById("metricsCard").getBoundingClientRect().toJSON(),
    }));
    assert.ok(chartLayout.scrollWidth <= chartLayout.width);
    assert.ok(chartLayout.card.x >= 0 && chartLayout.card.right <= chartLayout.width);
    await page.waitForFunction(() => !view.updating, null, { timeout: 30000 });
    await page.screenshot({ path: path.join(output, "map-mobile.png"), fullPage: true });
    await page.locator("#toggleResultsButton").click();
    const resultsScroll = await page.evaluate(() => {
      const panel = document.getElementById("resultsPanel");
      const list = document.getElementById("restaurantSearchResults");
      panel.scrollTop = panel.scrollHeight;
      const lastRow = list.querySelector(".search-result:last-child").getBoundingClientRect();
      const panelBox = panel.getBoundingClientRect();
      return {
        listOverflow: getComputedStyle(list).overflowY,
        lastRowBottom: lastRow.bottom,
        panelBottom: panelBox.bottom,
      };
    });
    assert.equal(resultsScroll.listOverflow, "visible");
    assert.ok(resultsScroll.lastRowBottom <= resultsScroll.panelBottom);
    assert.deepEqual(failedAssets, []);
    assert.deepEqual(remotePhotos, []);
    assert.deepEqual(errors, []);
    const report = { ...loaded, searchPhoto: imageSource, desktopAndMobile: "passed", errors, failedAssets, remotePhotoRequests: remotePhotos.length };
    fs.writeFileSync(path.join(output, "browser-smoke.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
