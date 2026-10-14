((window.plausible =
  window.plausible ||
  function () {
    (plausible.q = plausible.q || []).push(arguments);
  }),
  (plausible.init =
    plausible.init ||
    function (i) {
      plausible.o = i || {};
    }));
plausible.init();

const DATA_URL = "./data/restaurant_data.json";
const DEFAULT_CENTER = [-120.482967, 37.302163];
const DEFAULT_ZOOM = 12;
const HOME_CENTER = [-120.472434, 37.313760];
// Keep the original index calculation and card available while hiding it from the UI.
const SHOW_FOOD_DESERT_RISK_INDEX = false;
// Smooth distance-decay settings for the one Food Desert Risk Index score.
// The score is normalized by total nearby distance weight, so it stays interpretable as 0-100.
const DISTANCE_DECAY_FLOOR_MILES = 0.03;

// If the local pin asset is available, the selected point and hover preview will use it.
// If it does not exist or fails to load, the app automatically falls back to simple red dots.
const USE_LOCAL_PIN_IMAGE = true;
const LOCAL_PIN_IMAGE_URL = "./assets/images/pin.png";
let localPinImageAvailable = false;

const BENCHMARK_METRICS = [
  {
    key: "distanceMiles",
    label: "Distance",
    shortLabel: "Miles",
    min: 0,
    max: 2,
    step: 0.25,
    matchStep: 0.25,
    defaultValue: 0.75,
    unit: "mi",
  },
  {
    key: "inspectionRaw",
    label: "Inspection",
    shortLabel: "Inspect",
    min: 0,
    max: 2,
    step: 1,
    matchStep: 1,
    defaultValue: 2,
    unit: "/2",
  },
  {
    key: "ratingStars",
    label: "Google stars",
    shortLabel: "Stars",
    min: 0,
    max: 5,
    step: 0.5,
    matchStep: 1,
    defaultValue: 4,
    unit: "★",
  },
  {
    key: "priceDollars",
    label: "Price bucket",
    shortLabel: "Price",
    min: 0,
    max: 20,
    step: 10,
    matchStep: 10,
    defaultValue: 10,
    prefix: "$",
  },
];

// Fixed buckets make nearby distributions comparable as the pin or radius changes.
// Upper bounds are exclusive, except for the last bucket's inclusive maximum.
const SUMMARY_METRICS = [
  {
    key: "inspectionRaw",
    label: "Inspection quality",
    max: 2,
    formatAverage: (value) => `${value.toFixed(2)}/2`,
    buckets: [
      { label: "0 · Unsat.", description: "0 · Unsatisfactory / missing inspection code", upper: 1 },
      { label: "1 · Sat.", description: "1 · Satisfactory", upper: 2 },
      { label: "2 · Good", upper: Infinity },
    ],
  },
  {
    key: "ratingStars",
    label: "Google rating",
    max: 5,
    formatAverage: (value) => `${value.toFixed(1)}/5 ★`,
    buckets: [
      { label: "<3", upper: 3 },
      { label: "3–<4", upper: 4 },
      { label: "4–<4.5", upper: 4.5 },
      { label: "4.5–5", upper: Infinity },
    ],
  },
  {
    key: "price",
    label: "Estimated meal price",
    max: Infinity,
    formatAverage: (value) => `~$${value.toFixed(0)}`,
    buckets: [
      { label: "<$10", upper: 10 },
      { label: "$10–<20", upper: 20 },
      { label: "$20+", upper: Infinity },
    ],
  },
  {
    key: "distanceMiles",
    label: "Distance from pin",
    max: Infinity,
    formatAverage: (value) => `${value.toFixed(2)} mi`,
    buckets: [
      { label: "<0.25 mi", upper: 0.25 },
      { label: "0.25–<0.5", upper: 0.5 },
      { label: "0.5–<1", upper: 1 },
      { label: "1+ mi", upper: Infinity },
    ],
  },
];

let view = null;
let Graphic = null;
let restaurantLayer = null;
let highlightLayer = null;
let benchmarkLayer = null;
let analysisLayer = null;
let cursorLayer = null;
let restaurants = [];
let currentAnalysisPoint = null;
let dropPinMode = false;
let lastAnalysisResult = null;
let restaurantPopupTimer = null;
let preserveResultsPanelForPopup = false;
let dragMetricKey = null;
let benchmarkTargets = Object.fromEntries(
  BENCHMARK_METRICS.map((metric) => [metric.key, metric.defaultValue]),
);
let benchmarkEnabled = Object.fromEntries(
  BENCHMARK_METRICS.map((metric) => [metric.key, true]),
);
let nearbyAverageProfile = null;

require([
  "esri/Map",
  "esri/views/MapView",
  "esri/layers/GraphicsLayer",
  "esri/Graphic",
  "esri/layers/VectorTileLayer",
  "esri/widgets/Home",
], function (Map, MapView, GraphicsLayer, GraphicClass, VectorTileLayer, Home) {
  Graphic = GraphicClass;

  const labelLayer = new VectorTileLayer({
    portalItem: {
      id: "30d6b8271e1849cd9c3042060001f425",
    },
    title: "Hybrid Reference Labels",
  });

  restaurantLayer = new GraphicsLayer({ title: "Restaurant locations" });
  highlightLayer = new GraphicsLayer({
    title: "Nearby highlighted locations",
  });
  benchmarkLayer = new GraphicsLayer({
    title: "Benchmark matching locations",
  });
  analysisLayer = new GraphicsLayer({
    title: "Analysis point and radius",
  });
  cursorLayer = new GraphicsLayer({ title: "Drop pin cursor" });

  const map = new Map({
    basemap: "satellite",
    layers: [
      labelLayer,
      restaurantLayer,
      highlightLayer,
      benchmarkLayer,
      analysisLayer,
      cursorLayer,
    ],
  });

  view = new MapView({
    container: "viewDiv",
    map,
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    popup: { dockEnabled: false },
  });

  view.when(async () => {
    view.ui.add(new Home({
      id: "home",
      view,
      viewpoint: {
        targetGeometry: {
          type: "point",
          longitude: HOME_CENTER[0],
          latitude: HOME_CENTER[1],
          spatialReference: { wkid: 4326 },
        },
        // Preserve the starting zoom even after the map fits or selects locations.
        scale: view.scale,
        rotation: 0,
      },
    }), "top-right");
    syncZoomControlPlacement();
    bindResponsiveZoomPlacement();
    preloadLocalPinImage();
    bindUiEvents();
    bindLegendEvents();
    updateRangeFilterSummary();
    await loadRestaurantJson();

    // The delayed "click" event can outlive a change to the pin tool's state.
    view.on("immediate-click", (event) => {
      window.clearTimeout(restaurantPopupTimer);
      preserveResultsPanelForPopup = false;
      if (!dropPinMode || !event.mapPoint) return;
      setAnalysisPoint(
        event.mapPoint.latitude,
        event.mapPoint.longitude,
        "Dropped pin",
      );
      setDropPinMode(false);
    });

    view.on("pointer-move", (event) => {
      updateCursorPinFromPointer(event);
    });

    view.on("pointer-leave", () => {
      clearCursorPin();
    });
  });
});

function syncZoomControlPlacement() {
  if (!view?.ui) return;
  view.ui.move(["zoom", "home"], isMobileViewport() ? "bottom-left" : "top-right");
}

function bindResponsiveZoomPlacement() {
  if (!window.matchMedia) return;
  const mediaQuery = window.matchMedia("(max-width: 720px)");
  const handler = () => syncZoomControlPlacement();
  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", handler);
  } else if (typeof mediaQuery.addListener === "function") {
    mediaQuery.addListener(handler);
  }
}

function bindUiEvents() {
  document
    .getElementById("searchButton")
    .addEventListener("click", handleRestaurantSearch);
  document
    .getElementById("removeSelectionButton")
    .addEventListener("click", clearAnalysisSelection);
  document
    .getElementById("restaurantSearchInput")
    .addEventListener("input", handleRestaurantSearchPreview);
  document
    .getElementById("restaurantSearchInput")
    .addEventListener("keydown", handleRestaurantSearchKeydown);
  document.getElementById("pinButton").addEventListener("click", () => {
    setDropPinMode(!dropPinMode);
    if (!dropPinMode && !currentAnalysisPoint) {
      setStatus(
        "Drop pin mode is off. Search for a restaurant or use the pin tool.",
      );
    }
  });
  document
    .getElementById("settingsButton")
    .addEventListener("click", () => toggleDrawer("settingsDrawer"));
  document
    .getElementById("closeSettingsButton")
    .addEventListener("click", () => hideDrawer("settingsDrawer"));
  document
    .getElementById("toggleResultsButton")
    .addEventListener("click", toggleResultsPanel);
  document
    .getElementById("toggleMetricsButton")
    .addEventListener("click", toggleMetricsSummary);
  const resetBenchmarkButton = document.getElementById(
    "resetBenchmarkButton",
  );
  if (resetBenchmarkButton) {
    resetBenchmarkButton.addEventListener("click", resetBenchmarkTargets);
  }

  document.getElementById("pinButton").innerHTML = "&#128205;";
  setFilterButtonState();
  document.getElementById("riskNumber").textContent = "--";
  document.getElementById("scoreMeta").textContent =
    "Search for a restaurant or use the pin tool.";
  const riskMethodMeta = document.getElementById("riskMethodMeta");
  if (riskMethodMeta) {
    riskMethodMeta.textContent =
      "One score: distance-decay qualified access. Filters decide which locations qualify; distance decides how much each one counts.";
  }
  [
    "nearbyCount",
    "benchmarkMatchCount",
    "inspectionScore",
    "avgPrice",
    "avgRating",
  ].forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.textContent = "--";
  });

  const optionIds = [
    "radiusMiles",
    "ratingMode",
    "ratingMin",
    "ratingMax",
    "allowUnknownRating",
    "inspectionMode",
    "inspectionMin",
    "inspectionMax",
    "priceMode",
    "priceMin",
    "priceMax",
    "allowUnknownPrice",
  ];

  optionIds.forEach((id) => {
    const element = document.getElementById(id);
    if (!element) return;

    const handler = () => {
      normalizeFilterInputs(id);
      updateRangeFilterSummary();
      if (currentAnalysisPoint) analyzeCurrentPoint();
    };

    element.addEventListener("input", handler);
    element.addEventListener("change", handler);
  });

  document
    .querySelectorAll(".benchmark-info-button")
    .forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });

  const svg = document.getElementById("benchmarkChart");
  if (svg) {
    svg.addEventListener("pointermove", handleBenchmarkPointerMove);
    svg.addEventListener("pointerup", stopBenchmarkDrag);
    svg.addEventListener("pointerleave", stopBenchmarkDrag);
    svg.addEventListener("pointercancel", stopBenchmarkDrag);
  }

  setStatus(
    "Selection removed. Search for a restaurant or use the pin tool.",
  );
  updateRangeFilterSummary();
}

function bindLegendEvents() {
  const button = document.getElementById("legendToggleButton");
  if (button) {
    button.addEventListener("click", () => toggleLegend());
  }

  setLegendCollapsed(true);
  if (isMobileViewport()) {
    setResultsPanelCollapsed(true);
  }

  // When an ArcGIS popup opens, automatically collapse the map overlays.
  // On mobile this collapses both the results panel and legend; on desktop it keeps only the legend out of the popup's way.
  if (view?.popup?.watch) {
    view.popup.watch("visible", (visible) => {
      if (visible) collapseMapOverlaysForPopup();
    });
  }
}

function toggleLegend(forceCollapsed = null) {
  const card = document.getElementById("legendCard");
  if (!card) return;
  const shouldCollapse =
    typeof forceCollapsed === "boolean"
      ? forceCollapsed
      : !card.classList.contains("collapsed");
  setLegendCollapsed(shouldCollapse);
}

function setLegendCollapsed(collapsed) {
  const card = document.getElementById("legendCard");
  const button = document.getElementById("legendToggleButton");
  const chevron = button?.querySelector(".legend-chevron");
  if (!card || !button) return;
  const isCollapsed = Boolean(collapsed);
  card.classList.toggle("collapsed", isCollapsed);
  button.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
  button.setAttribute(
    "aria-label",
    isCollapsed ? "Expand legend" : "Collapse legend",
  );
  button.title = isCollapsed ? "Expand legend" : "Collapse legend";
  if (chevron) chevron.setAttribute("aria-hidden", "true");
}

function isMobileViewport() {
  return Boolean(
    window.matchMedia && window.matchMedia("(max-width: 720px)").matches,
  );
}

function setResultsPanelCollapsed(collapsed) {
  const panel = document.getElementById("resultsPanel");
  const button = document.getElementById("toggleResultsButton");
  if (!panel || !button) return;
  panel.classList.toggle("collapsed", Boolean(collapsed));
  button.textContent = collapsed ? "Expand" : "Collapse";
  button.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

function setMetricsSummaryCollapsed(collapsed) {
  const card = document.getElementById("metricsCard");
  const button = document.getElementById("toggleMetricsButton");
  if (!card || !button) return;
  const isCollapsed = Boolean(collapsed);
  card.classList.toggle("collapsed", isCollapsed);
  button.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
  button.setAttribute(
    "aria-label",
    `${isCollapsed ? "Expand" : "Collapse"} nearby food metrics`,
  );
  button.textContent = isCollapsed ? "Expand" : "Collapse";
}

function collapseMapOverlaysForPopup() {
  setLegendCollapsed(true);
  if (isMobileViewport() && !preserveResultsPanelForPopup) {
    setResultsPanelCollapsed(true);
    hideSearchSuggestionResults();
  }
}

function toggleDrawer(id) {
  const drawer = document.getElementById(id);
  if (!drawer) return;
  const visible = drawer.classList.toggle("visible");
  if (visible) {
    const panel = document.getElementById("resultsPanel");
    const collapseButton = document.getElementById("toggleResultsButton");
    if (panel) panel.classList.remove("collapsed");
    if (collapseButton) collapseButton.textContent = "Collapse";
  }
  setFilterButtonState();
}

function hideDrawer(id) {
  const drawer = document.getElementById(id);
  if (drawer) drawer.classList.remove("visible");
  setFilterButtonState();
}

function setFilterButtonState() {
  const button = document.getElementById("settingsButton");
  const drawer = document.getElementById("settingsDrawer");
  if (!button || !drawer) return;
  const visible = drawer.classList.contains("visible");
  button.setAttribute("aria-expanded", visible ? "true" : "false");
  button.innerHTML = `
    <span class="filter-glyph" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"></path>
      </svg>
    </span>
    ${visible ? "Hide filters" : "Filters"}
  `;
}

function toggleResultsPanel() {
  const panel = document.getElementById("resultsPanel");
  if (!panel) return;
  setResultsPanelCollapsed(!panel.classList.contains("collapsed"));
}

function setDropPinMode(enabled) {
  dropPinMode = enabled;
  const button = document.getElementById("pinButton");
  button.classList.toggle("pin-active", enabled);
  button.classList.toggle("ghost", !enabled);
  if (view) view.container.style.cursor = enabled ? "none" : "default";
  if (!enabled) clearCursorPin();
  if (enabled)
    setStatus(
      "Drop pin mode is on. Move the mouse over the map, then click to drop the pin.",
    );
  else if (!currentAnalysisPoint)
    setStatus(
      "Drop pin mode is off. Search for a restaurant or use the pin tool.",
    );
}

function updateCursorPinFromPointer(event) {
  if (!dropPinMode || !view || !cursorLayer) return;
  const mapPoint = view.toMap({ x: event.x, y: event.y });
  if (
    !mapPoint ||
    !Number.isFinite(mapPoint.longitude) ||
    !Number.isFinite(mapPoint.latitude)
  )
    return;
  cursorLayer.removeAll();
  cursorLayer.add(
    new Graphic({
      geometry: {
        type: "point",
        longitude: mapPoint.longitude,
        latitude: mapPoint.latitude,
        spatialReference: { wkid: 4326 },
      },
      symbol: dropPinCursorSymbol(),
    }),
  );
}

function clearCursorPin() {
  if (cursorLayer) cursorLayer.removeAll();
}

function syncWeightLabels() {
  // Legacy no-op. Range filters now control the scoring model directly.
  updateRangeFilterSummary();
}

function updateRangeFilterSummary() {
  const radiusValue = document.getElementById("radiusMilesValue");
  const summary = document.getElementById("activeRangeSummary");
  const options = getScoringOptions();

  if (radiusValue)
    radiusValue.textContent = `${formatMiles(options.radiusMiles)} mi`;

  syncOneTrackSlider(
    "rating",
    options.ratingMode,
    options.ratingMin,
    options.ratingMax,
    0,
    5,
    formatStars,
  );
  syncOneTrackSlider(
    "inspection",
    options.inspectionMode,
    options.inspectionMin,
    options.inspectionMax,
    0,
    2,
    formatInspectionValue,
  );
  syncOneTrackSlider(
    "price",
    options.priceMode,
    options.priceMin,
    options.priceMax,
    0,
    20,
    priceBucketLabel,
  );

  const summaryText =
    `Radius ${formatMiles(options.radiusMiles)} mi · ` +
    `Stars ${formatFilterSummary(options.ratingMode, options.ratingMin, options.ratingMax, formatStars)} · ` +
    `Inspection ${formatFilterSummary(options.inspectionMode, options.inspectionMin, options.inspectionMax, formatInspectionValue)} · ` +
    `Price ${formatFilterSummary(options.priceMode, options.priceMin, options.priceMax, priceBucketLabel)}`;

  if (summary) summary.textContent = summaryText;

  const inlineSummary = document.getElementById(
    "activeRangeSummaryInline",
  );
  if (inlineSummary) inlineSummary.textContent = summaryText;
}

function normalizeFilterInputs(changedId) {
  const groups = [
    { prefix: "rating", step: 0.5, minAllowed: 0, maxAllowed: 5 },
    { prefix: "inspection", step: 1, minAllowed: 0, maxAllowed: 2 },
    { prefix: "price", step: 10, minAllowed: 0, maxAllowed: 20 },
  ];

  groups.forEach(({ prefix, step, minAllowed, maxAllowed }) => {
    const mode =
      document.getElementById(`${prefix}Mode`)?.value || "range";
    const minInput = document.getElementById(`${prefix}Min`);
    const maxInput = document.getElementById(`${prefix}Max`);
    if (!minInput || !maxInput) return;

    let minValue = parseNumber(minInput.value) ?? minAllowed;
    let maxValue = parseNumber(maxInput.value) ?? maxAllowed;

    minValue = clamp(minValue, minAllowed, maxAllowed);
    maxValue = clamp(maxValue, minAllowed, maxAllowed);

    if (mode === "exact") {
      if (changedId === `${prefix}Max`) {
        minInput.value = maxValue;
      } else {
        maxInput.value = minValue;
      }
      return;
    }

    // Range mode: do not allow endpoints to overlap.
    if (maxValue - minValue < step) {
      if (changedId === `${prefix}Min`) {
        minValue = clamp(maxValue - step, minAllowed, maxAllowed - step);
        minInput.value = minValue;
      } else {
        maxValue = clamp(minValue + step, minAllowed + step, maxAllowed);
        maxInput.value = maxValue;
      }
    }

    minValue = parseNumber(minInput.value) ?? minAllowed;
    maxValue = parseNumber(maxInput.value) ?? maxAllowed;

    if (maxValue - minValue < step) {
      if (minValue <= minAllowed) {
        maxInput.value = minAllowed + step;
      } else {
        minInput.value = maxAllowed - step;
      }
    }
  });
}

function syncOneTrackSlider(
  prefix,
  mode,
  minValue,
  maxValue,
  axisMin,
  axisMax,
  formatter,
) {
  const slider = document.getElementById(`${prefix}Slider`);
  const fill = document.getElementById(`${prefix}SliderFill`);
  const leftReadout = document.getElementById(`${prefix}LeftReadout`);
  const rightReadout = document.getElementById(`${prefix}RightReadout`);
  const maxInput = document.getElementById(`${prefix}Max`);

  if (!slider || !fill) return;

  slider.classList.toggle("exact", mode === "exact");

  const safeMin = clamp(minValue, axisMin, axisMax);
  const safeMax = clamp(maxValue, axisMin, axisMax);
  const leftPercent = ((safeMin - axisMin) / (axisMax - axisMin)) * 100;
  const rightPercent = ((safeMax - axisMin) / (axisMax - axisMin)) * 100;

  if (mode === "exact") {
    const dotWidth = 2.5;
    fill.style.left = `${clamp(leftPercent - dotWidth / 2, 0, 100)}%`;
    fill.style.width = `${dotWidth}%`;
    if (leftReadout)
      leftReadout.textContent = `Exact ${formatter(safeMin)}`;
    if (rightReadout) rightReadout.textContent = "";
    if (maxInput) maxInput.value = safeMin;
  } else {
    fill.style.left = `${Math.min(leftPercent, rightPercent)}%`;
    fill.style.width = `${Math.abs(rightPercent - leftPercent)}%`;
    if (leftReadout) leftReadout.textContent = formatter(safeMin);
    if (rightReadout) rightReadout.textContent = formatter(safeMax);
  }
}

function formatFilterSummary(mode, minValue, maxValue, formatter) {
  if (mode === "exact") return `exact ${formatter(minValue)}`;
  return `${formatter(minValue)}–${formatter(maxValue)}`;
}

function formatStars(value) {
  const numeric = parseNumber(value) ?? 0;
  return `${numeric.toFixed(1)}★`;
}

function formatInspectionValue(value) {
  const numeric = parseNumber(value) ?? 0;
  if (numeric >= 2) return "2 Good";
  if (numeric >= 1) return "1 Satisfactory";
  return "0 Unsatisfactory";
}

function formatMiles(value) {
  const numeric = parseNumber(value) ?? 0;
  return numeric % 1 === 0
    ? numeric.toFixed(0)
    : numeric.toFixed(2).replace(/0$/, "");
}

function inspectionRangeLabel(minValue, maxValue) {
  const label = (value) => {
    if (value >= 2) return "good";
    if (value >= 1) return "satisfactory";
    return "unsatisfactory";
  };
  return `${label(minValue)}–${label(maxValue)}`;
}

async function loadRestaurantJson() {
  setStatus(`Loading ${DATA_URL}...`);
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok)
      throw new Error(
        `Could not load ${DATA_URL}. HTTP ${response.status}`,
      );
    const data = await response.json();
    restaurants = normalizeRestaurantData(data);
    drawRestaurantPoints(restaurants);
    clearFilteredLocationResults();
    setStatus(
      `Loaded ${restaurants.length} mappable locations from restaurant_data.json.\nSearch for a restaurant or use the pin tool to calculate a score. When drop-pin mode is active, a pin follows your mouse.`,
    );
  } catch (error) {
    console.error(error);
    setStatus(
      "Failed to load restaurant data.\n" +
        `Serve the website folder over HTTP and ensure ${DATA_URL} exists.\n\n` +
        error.message,
    );
  }
}

function normalizeRestaurantData(data) {
  const rawFeatures = Array.isArray(data)
    ? data
    : Array.isArray(data.features)
      ? data.features
      : [];
  const output = [];

  rawFeatures.forEach((item, index) => {
    const geometry = item.geometry || {};
    const attributes = {
      ...(item.properties || {}),
      ...(item.attributes || {}),
    };
    if (!item.properties && !item.attributes)
      Object.assign(attributes, item);

    const lon = firstValidNumber([
      attributes.DisplayX,
      geometry.longitude,
      geometry.x,
      Array.isArray(geometry.coordinates)
        ? geometry.coordinates[0]
        : null,
      attributes.longitude,
      attributes.lon,
      attributes.lng,
      attributes.X,
      attributes.x,

      attributes.displayx,
    ]);

    const lat = firstValidNumber([
      attributes.DisplayY,
      geometry.latitude,
      geometry.y,
      Array.isArray(geometry.coordinates)
        ? geometry.coordinates[1]
        : null,
      attributes.latitude,
      attributes.lat,
      attributes.Y,
      attributes.y,

      attributes.displayy,
    ]);

    if (!isValidLonLat(lon, lat)) return;
    const normalized = normalizeAttributes(attributes, index);
    output.push({
      id: normalized.id,
      searchIndex: output.length,
      lon,
      lat,
      attributes: normalized,
    });
  });

  return output;
}

function resolvePhotoUri(value) {
  const uri = clean(value);
  if (!uri) return "";
  // Local image paths in the dataset are relative to the JSON file.
  return new URL(uri, new URL(DATA_URL, document.baseURI)).href;
}

function normalizeAttributes(attributes, index) {
  const get = (...names) => getField(attributes, names);
  const qualityScore = clean(
    get(
      "quality_score",
      "quality score",
      "Quality_score",
      "QUALITY_SCORE",
    ),
  );
  const normalized = {
    objectid: index + 1,
    id:
      clean(get("id", "google_place_id", "PlaceID")) ||
      `restaurant-${index + 1}`,
    Match_addr: clean(get("Match_addr", "match_addr")),
    Postal: clean(get("Postal", "postal")),
    X: clean(get("X", "x")),
    Y: clean(get("Y", "y")),
    USER_facility: clean(get("USER_facility", "facility", "Facility")),
    USER_current_rating: clean(
      get("USER_current_rating", "USER_current rating", "current_rating"),
    ),
    USER_last_inspection_date: clean(
      get(
        "USER_last_inspection_date",
        "USER_last inspection date",
        "last_inspection_date",
      ),
    ),
    quality_score: qualityScore,
    quality_label:
      clean(get("quality_label")) || qualityLabelFromScore(qualityScore),
    google_status: clean(get("google_status")),
    google_place_id: clean(get("google_place_id")),
    google_name: clean(get("google_name")),
    google_address: clean(get("google_address")),
    google_lat: clean(get("google_lat")),
    google_lng: clean(get("google_lng")),
    google_rating: clean(get("google_rating")),
    google_review_count: clean(get("google_review_count")),
    google_price_label: clean(
      get("google_price_label", "google_price_bucket"),
    ),
    google_price_level: clean(get("google_price_level")),
    google_price_range_start: clean(get("google_price_range_start")),
    google_price_range_end: clean(get("google_price_range_end")),
    google_maps_uri: clean(get("google_maps_uri")),
    google_search_query: clean(get("google_search_query")),
    google_error: clean(get("google_error")),
    google_photo_uri: resolvePhotoUri(get("google_photo_uri")),
    google_photo_name: clean(get("google_photo_name")),
    google_photo_author_attributions: formatPhotoAttribution(
      get("google_photo_author_attributions"),
    ),
  };
  if (!normalized.USER_facility)
    normalized.USER_facility =
      normalized.google_name || "Unnamed food location";
  normalized.popup_title =
    normalized.google_name ||
    normalized.USER_facility ||
    "Unnamed food location";
  return normalized;
}

function drawRestaurantPoints(items) {
  restaurantLayer.removeAll();
  const graphics = items.map((item) => {
    const graphic = new Graphic({
      geometry: {
        type: "point",
        longitude: item.lon,
        latitude: item.lat,
        spatialReference: { wkid: 4326 },
      },
      symbol: baseRestaurantSymbol(item.attributes.quality_score),
      attributes: item.attributes,
      popupTemplate: buildRestaurantPopupTemplate(),
    });
    item.graphic = graphic;
    return graphic;
  });
  restaurantLayer.addMany(graphics);
}

function buildRestaurantPopupTemplate() {
  return {
    title: "{popup_title}",
    outFields: ["*"],
    content: restaurantPopupContent,
  };
}

function restaurantPopupContent(event) {
  const attributes =
    event?.graphic?.attributes || event?.attributes || {};
  return buildRestaurantPopupHtml(attributes);
}

function buildRestaurantPopupHtml(attributes) {
  const a = attributes || {};
  const name = clean(
    a.google_name || a.USER_facility || "Unnamed food location",
  );
  const address = clean(a.google_address || a.Match_addr || "");
  const sourceAddress = clean(a.Match_addr || "");
  const mapsLink = clean(a.google_maps_uri || "");
  const photoUri = clean(a.google_photo_uri || "");
  const photoAttribution = clean(
    a.google_photo_author_attributions || "",
  );
  const inspection =
    qualityLabelFromScore(a.quality_score) ||
    clean(a.quality_label || a.USER_current_rating) ||
    "Unknown";
  const lastInspection = clean(a.USER_last_inspection_date || "");
  const rating = clean(a.google_rating || "");
  const reviews = clean(a.google_review_count || "");
  const price = clean(
    a.google_price_label || a.google_price_bucket || "",
  );
  const distance = clean(a.popup_distance_miles || "");
  const matchType = clean(a.benchmark_match_type || "");
  const confidence = clean(a.benchmark_confidence_note || "");
  const matchBadge = popupMatchBadge(matchType, confidence);
  const metrics = [
    popupMetric("Distance", distance ? `${distance} mi` : ""),
    popupMetric("Inspection", inspection),
    popupMetric(
      "Google",
      rating
        ? `${rating}★${reviews ? ` · ${reviews} reviews` : ""}`
        : "Not available",
    ),
    popupMetric("Price", price || "Not available"),
  ]
    .filter(Boolean)
    .join("");
  const sourceNote =
    sourceAddress &&
    address &&
    sourceAddress.toLowerCase() !== address.toLowerCase()
      ? `<div class="popup-note"><b>Source address:</b> ${escapeHtml(sourceAddress)}</div>`
      : "";
  const inspectionNote = lastInspection
    ? `<div class="popup-note"><b>Last inspection:</b> ${escapeHtml(lastInspection)}</div>`
    : "";
  const photo = photoUri
    ? `<div class="popup-photo-frame"><img class="popup-photo" src="${escapeHtml(photoUri)}" alt="Photo of ${escapeHtml(name)}" /></div>`
    : "";
  const attribution = photoAttribution
    ? `<div class="popup-attribution">${escapeHtml(photoAttribution)}</div>`
    : "";
  const actions = mapsLink
    ? `<div class="popup-actions"><a class="popup-link" href="${escapeHtml(mapsLink)}" target="_blank" rel="noopener noreferrer">Open in Google Maps</a></div>`
    : "";

  return `
    <div class="popup-card">
      ${photo}
      ${attribution}
      ${address ? `<div class="popup-address">${escapeHtml(address)}</div>` : ""}
      ${matchBadge}
      <div class="popup-kpi-grid">${metrics}</div>
      ${inspectionNote}
      ${sourceNote}
      ${actions}
    </div>
  `;
}

function popupMetric(label, value) {
  if (!clean(value)) return "";
  return `<div class="popup-kpi"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`;
}

function popupMatchBadge(matchType, confidence) {
  if (!matchType) return "";
  if (matchType === "full") {
    return `<div class="popup-badge full">Full match for current filters</div>`;
  }
  if (matchType === "partial") {
    const note = confidence ? ` · ${confidence}` : "";
    return `<div class="popup-badge partial">Partial match${escapeHtml(note)}</div>`;
  }
  return `<div class="popup-badge none">Does not match current filters</div>`;
}

function handleRestaurantSearchPreview() {
  const query = document
    .getElementById("restaurantSearchInput")
    .value.trim();
  if (!query) {
    hideSearchSuggestionResults();
    return;
  }
  renderSearchSuggestionResults(query, findRestaurantMatches(query, 12));
}

function handleRestaurantSearchKeydown(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    handleRestaurantSearch();
  }
  if (event.key === "Escape") {
    hideSearchSuggestionResults();
  }
}

function handleRestaurantSearch() {
  const input = document.getElementById("restaurantSearchInput");
  const query = input.value.trim();
  const selectionHint = currentAnalysisPoint
    ? "Use View to browse restaurants without moving the analysis pin."
    : "Use Select to place the analysis pin.";

  if (!query) {
    hideSearchSuggestionResults();
    setStatus(
      `Type a restaurant name or address. ${selectionHint}`,
    );
    return;
  }

  const matches = findRestaurantMatches(query, 12);
  renderSearchSuggestionResults(query, matches);

  if (matches.length === 0) {
    setStatus(`No loaded location matched: ${query}`);
    return;
  }

  if (matches.length === 1) {
    setStatus(
      `Found 1 search suggestion for: ${query}. ${selectionHint}`,
    );
    return;
  }

  setStatus(
    `Found ${matches.length} search suggestion(s) for: ${query}. ${selectionHint}`,
  );
}

function renderSearchSuggestionResults(query, matches) {
  const container = document.getElementById("searchSuggestionResults");
  if (!container) return;

  if (!query) {
    hideSearchSuggestionResults();
    return;
  }

  container.hidden = false;

  if (!matches.length) {
    container.innerHTML = `<div class="search-empty">No loaded location matched this search.</div>`;
    return;
  }

  container.innerHTML = matches
    .map((item) => {
      const name = restaurantDisplayName(item);
      const actionLabel = currentAnalysisPoint ? "View" : "Select";
      const actionTitle = currentAnalysisPoint
        ? `View ${name} on the map`
        : `Select ${name} as the analysis location`;
      const address =
        restaurantDisplayAddress(item) || "Address unavailable";
      return `
        <div
          class="search-suggestion"
          data-restaurant-index="${item.searchIndex}"
          role="button"
          tabindex="0"
          title="${escapeHtml(actionTitle)}"
        >
          ${restaurantResultPhotoMarkup(item.attributes, name, "suggestion-photo")}
          <div class="search-suggestion-copy">
            <b>${escapeHtml(name)}</b>
            <span>${escapeHtml(address)}</span>
          </div>
          <button
            type="button"
            class="select-suggestion-button"
            data-restaurant-index="${item.searchIndex}"
            title="${escapeHtml(actionTitle)}"
          >
            ${actionLabel}
          </button>
        </div>
      `;
    })
    .join("");

  container
    .querySelectorAll(".select-suggestion-button")
    .forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectRestaurantSearchResult(
          Number(button.dataset.restaurantIndex),
        );
      });
      button.addEventListener("keydown", (event) => {
        event.stopPropagation();
      });
    });

  container.querySelectorAll(".search-suggestion").forEach((row) => {
    row.addEventListener("click", () => {
      selectRestaurantSearchResult(Number(row.dataset.restaurantIndex));
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectRestaurantSearchResult(Number(row.dataset.restaurantIndex));
      }
    });
  });
}

function hideSearchSuggestionResults() {
  const container = document.getElementById("searchSuggestionResults");
  if (!container) return;
  container.hidden = true;
  container.innerHTML = "";
}

function findRestaurantMatches(query, limit = Infinity) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return restaurants.map((item) => ({ ...item, searchScore: 0 }));
  }
  const tokens = normalizedQuery.split(" ").filter(Boolean);

  const matches = restaurants
    .map((item) => {
      const name = restaurantDisplayName(item);
      const address = restaurantDisplayAddress(item);
      const haystack = normalizeSearchText(
        [
          name,
          address,
          item.attributes.Match_addr,
          item.attributes.Postal,
        ].join(" "),
      );

      if (!tokens.every((token) => haystack.includes(token))) return null;

      const normalizedName = normalizeSearchText(name);
      const normalizedAddress = normalizeSearchText(address);
      let score = 0;
      if (normalizedName === normalizedQuery) score += 100;
      if (normalizedName.startsWith(normalizedQuery)) score += 50;
      if (normalizedName.includes(normalizedQuery)) score += 25;
      if (normalizedAddress.includes(normalizedQuery)) score += 12;
      score += Math.max(0, 20 - normalizedName.length / 5);

      return { ...item, searchScore: score };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (b.searchScore !== a.searchScore)
        return b.searchScore - a.searchScore;
      return restaurantDisplayName(a).localeCompare(
        restaurantDisplayName(b),
      );
    });

  return Number.isFinite(limit) ? matches.slice(0, limit) : matches;
}

function renderFilteredLocationResults(nearby) {
  const container = document.getElementById("restaurantSearchResults");
  if (!container) return;

  const nearbyItems = [...(nearby || [])];
  const matchedItems = nearbyItems
    .filter((item) => item.benchmarkMatch)
    .sort((a, b) => {
      const aRank = a.benchmarkMatchType === "full" ? 0 : 1;
      const bRank = b.benchmarkMatchType === "full" ? 0 : 1;
      if (aRank !== bRank) return aRank - bRank;
      return a.distanceMiles - b.distanceMiles;
    });
  const nonMatchedItems = nearbyItems
    .filter((item) => !item.benchmarkMatch)
    .sort((a, b) => a.distanceMiles - b.distanceMiles);

  const countElement = document.getElementById("locationMatchCount");
  if (countElement) {
    countElement.textContent = `${nearbyItems.length} shown · ${matchedItems.length} match · ${nonMatchedItems.length} non-match`;
  }

  if (!currentAnalysisPoint) {
    container.innerHTML = `<div class="search-empty">Choose a location from the search suggestions or drop a pin to show nearby locations.</div>`;
    return;
  }

  if (!nearbyItems.length) {
    container.innerHTML = `<div class="search-empty">No locations found inside the selected radius.</div>`;
    return;
  }

  const cardMarkup = (item) => {
    const a = item.attributes || {};
    const name = restaurantDisplayName(item);
    const address =
      restaurantDisplayAddress(item) || "Address unavailable";
    const quality =
      qualityLabelFromScore(a.quality_score) ||
      clean(a.quality_label || a.USER_current_rating) ||
      "Unknown inspection";
    const rating = clean(a.google_rating || "");
    const price = clean(
      a.google_price_label || a.google_price_bucket || "",
    );
    const miles = Number.isFinite(item.distanceMiles)
      ? `${item.distanceMiles.toFixed(2)} mi`
      : "";
    const matchLabel =
      item.benchmarkMatchType === "full"
        ? "Full match"
        : item.benchmarkMatchType === "partial"
          ? "Partial match"
          : "Does not match filters";
    const tags = [
      matchLabel,
      miles,
      quality,
      rating ? `${rating} stars` : "",
      price,
    ].filter(Boolean);
    const itemClass =
      item.benchmarkMatchType === "full"
        ? "benchmark-match"
        : item.benchmarkMatchType === "partial"
          ? "partial-benchmark-match"
          : "non-benchmark-match";

    return `
      <div class="search-result ${itemClass}" data-restaurant-index="${item.searchIndex}">
        ${restaurantResultPhotoMarkup(a, name, "result-photo")}
        <div class="search-result-copy">
          <b>${escapeHtml(name)}</b>
          <span>${escapeHtml(address)}</span>
          <div class="search-result-meta">
            ${tags
              .map(
                (tag) =>
                  `<span class="result-tag">${escapeHtml(tag)}</span>`,
              )
              .join("")}
          </div>
        </div>
        <div class="search-result-actions">
          <button
            type="button"
            class="zoom-result-button"
            data-restaurant-index="${item.searchIndex}"
            title="Zoom to ${escapeHtml(name)}"
          >
            Zoom
          </button>
        </div>
      </div>
    `;
  };

  const matchedMarkup = matchedItems.length
    ? matchedItems.map(cardMarkup).join("")
    : `<div class="search-empty compact-empty">No full or partial matches for the active filters.</div>`;

  const dividerMarkup = `
    <div class="search-results-divider" role="separator" aria-label="Non-matching nearby locations">
      <span></span>
      <b>Remaining nearby locations that do not match</b>
      <span></span>
    </div>
  `;

  const nonMatchedMarkup = nonMatchedItems.length
    ? nonMatchedItems.map(cardMarkup).join("")
    : `<div class="search-empty compact-empty">No non-matching nearby locations inside the selected radius.</div>`;

  // Single flat results list only: matched cards, one divider, then non-matching cards.
  // Do not render a second nearby-list container.
  container.innerHTML = `${matchedMarkup}${dividerMarkup}${nonMatchedMarkup}`;

  container.querySelectorAll(".zoom-result-button").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      zoomToRestaurantSearchResult(
        Number(button.dataset.restaurantIndex),
      );
    });
    button.addEventListener("keydown", (event) => {
      event.stopPropagation();
    });
  });

  container.querySelectorAll(".search-result").forEach((row) => {
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.addEventListener("click", (event) => {
      if (event.target.closest(".zoom-result-button")) return;
      zoomToRestaurantSearchResult(Number(row.dataset.restaurantIndex));
    });
    row.addEventListener("keydown", (event) => {
      if (event.target !== row) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        zoomToRestaurantSearchResult(Number(row.dataset.restaurantIndex));
      }
    });
  });
}

function clearFilteredLocationResults() {
  const container = document.getElementById("restaurantSearchResults");
  if (container) {
    container.innerHTML = `<div class="search-empty">Choose a location from the search suggestions or drop a pin to show filter-selected results.</div>`;
  }
  const countElement = document.getElementById("locationMatchCount");
  if (countElement) countElement.textContent = "0 selected";
}

function restaurantResultPhotoMarkup(attributes, name, className) {
  const photoUri = clean(attributes?.google_photo_uri || "");
  if (photoUri) {
    return `<img class="${className}" src="${escapeHtml(photoUri)}" alt="Photo of ${escapeHtml(name)}" loading="lazy" />`;
  }
  return `<div class="${className} ${className}-placeholder">No image available</div>`;
}

function zoomToRestaurantSearchResult(searchIndex) {
  const item = restaurants.find(
    (restaurant) => restaurant.searchIndex === searchIndex,
  );
  if (!item || !view || !item.graphic) return;

  // Zoom-only behavior: do not select the item, do not move the analysis pin,
  // and do not turn drop-pin mode on/off.
  preserveResultsPanelForPopup = true;
  window.clearTimeout(restaurantPopupTimer);
  view
    .goTo({
      target: item.graphic.geometry,
      zoom: Math.max(view.zoom || DEFAULT_ZOOM, 15),
    })
    .catch((error) => {
      if (error.name !== "AbortError") console.error(error);
    });

  restaurantPopupTimer = window.setTimeout(() => openRestaurantPopup(item, true), 200);
}

function selectRestaurantSearchResult(searchIndex) {
  const item = restaurants.find(
    (restaurant) => restaurant.searchIndex === searchIndex,
  );
  if (!item) return;

  // A search suggestion can establish the first pin. Later picks only browse.
  if (currentAnalysisPoint) {
    hideSearchSuggestionResults();
    zoomToRestaurantSearchResult(searchIndex);
    return;
  }

  window.clearTimeout(restaurantPopupTimer);
  preserveResultsPanelForPopup = false;
  const name = restaurantDisplayName(item);
  document.getElementById("restaurantSearchInput").value = name;
  hideSearchSuggestionResults();
  setDropPinMode(false);
  if (isMobileViewport()) {
    setResultsPanelCollapsed(true);
  }
  setAnalysisPoint(item.lat, item.lon, name);

  if (view && item.graphic) {
    view
      .goTo({
        target: item.graphic.geometry,
        zoom: Math.max(view.zoom || DEFAULT_ZOOM, 14),
      })
      .catch((error) => {
        if (error.name !== "AbortError") console.error(error);
      });

    restaurantPopupTimer = window.setTimeout(() => openRestaurantPopup(item), 250);
  }
}

function openRestaurantPopup(item, preserveResultsPanel = false) {
  if (!view || !item?.graphic) return;
  preserveResultsPanelForPopup = preserveResultsPanel;
  collapseMapOverlaysForPopup();
  const popupOptions = {
    features: [item.graphic],
    location: item.graphic.geometry,
  };
  if (typeof view.openPopup === "function") {
    view.openPopup(popupOptions);
  } else if (view.popup && typeof view.popup.open === "function") {
    view.popup.open(popupOptions);
  }
}

function restaurantDisplayName(item) {
  return clean(
    item?.attributes?.google_name ||
      item?.attributes?.USER_facility ||
      "Unnamed food location",
  );
}

function restaurantDisplayAddress(item) {
  return clean(
    item?.attributes?.google_address ||
      item?.attributes?.Match_addr ||
      "",
  );
}

function normalizeSearchText(value) {
  return clean(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function handleLocationSearch() {
  return handleRestaurantSearch();
  const input = document.getElementById("locationInput").value.trim();
  if (!input) {
    setStatus(
      "Enter an address/place, enter coordinates, or use 📍 drop pin.",
    );
    return;
  }
  const parsed = parseCoordinateInput(input);
  if (parsed) {
    setAnalysisPoint(parsed.lat, parsed.lon, "Coordinate input");
    return;
  }
  setStatus(`Searching location with OpenStreetMap Nominatim:\n${input}`);
  try {
    const result = await geocodeWithNominatim(input);
    if (!result) {
      setStatus(`No location found for:\n${input}`);
      return;
    }
    setAnalysisPoint(result.lat, result.lon, result.label || input);
  } catch (error) {
    console.error(error);
    setStatus(`Location search failed:\n${error.message}`);
  }
}

async function geocodeWithNominatim(query) {
  const url =
    "https://nominatim.openstreetmap.org/search?" +
    new URLSearchParams({
      q: query,
      format: "jsonv2",
      limit: "1",
      addressdetails: "1",
    }).toString();
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
  const results = await response.json();
  if (!Array.isArray(results) || results.length === 0) return null;
  const first = results[0];
  const lat = parseNumber(first.lat);
  const lon = parseNumber(first.lon);
  if (!isValidLonLat(lon, lat)) return null;
  return { lat, lon, label: first.display_name };
}

function setAnalysisPanelsVisible(visible) {
  const scoreCard = document.getElementById("scoreCard");
  const showRisk = visible && SHOW_FOOD_DESERT_RISK_INDEX;
  scoreCard.hidden = !showRisk;
  scoreCard.classList.toggle("visible", showRisk);
  const metricsCard = document.getElementById("metricsCard");
  metricsCard.hidden = !visible;
  metricsCard.classList.toggle("visible", visible);
  document.getElementById("resultsPanel").hidden = !visible;
}

function toggleMetricsSummary() {
  const card = document.getElementById("metricsCard");
  if (!card) return;
  setMetricsSummaryCollapsed(!card.classList.contains("collapsed"));
}

function clearAnalysisSelection() {
  window.clearTimeout(restaurantPopupTimer);
  preserveResultsPanelForPopup = false;
  currentAnalysisPoint = null;
  lastAnalysisResult = null;
  setAnalysisPanelsVisible(false);
  document.getElementById("metricDistributions").replaceChildren();
  document.getElementById("metricsSummaryMeta").textContent = "";
  setDropPinMode(false);
  if (analysisLayer) analysisLayer.removeAll();
  if (highlightLayer) highlightLayer.removeAll();
  if (benchmarkLayer) benchmarkLayer.removeAll();
  resetRestaurantPointStyles();
  clearCursorPin();

  const searchInput = document.getElementById("restaurantSearchInput");
  if (searchInput) searchInput.value = "";
  hideSearchSuggestionResults();
  clearFilteredLocationResults();
  setResultsSubtitle(
    "Search for a location to place the analysis pin, or drop a pin manually.",
  );

  document.getElementById("riskNumber").textContent = "--";
  document.getElementById("riskLabel").textContent = "Select a location";
  document.getElementById("scoreMeta").textContent =
    "Search for a restaurant or use the pin tool.";
  const riskMethodMeta = document.getElementById("riskMethodMeta");
  if (riskMethodMeta) {
    riskMethodMeta.textContent =
      "One score: distance-decay qualified access. Filters decide which locations qualify; distance decides how much each one counts.";
  }

  const metricFallbacks = {
    nearbyCount: "--",
    benchmarkMatchCount: "--",
    inspectionScore: "--",
    avgPrice: "--",
    avgRating: "--",
  };
  Object.entries(metricFallbacks).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  });

  if (view) {
    if (typeof view.closePopup === "function") view.closePopup();
    else if (view.popup && typeof view.popup.close === "function")
      view.popup.close();
  }

  setStatus(
    "Selection removed. Search for a restaurant or use the pin tool.",
  );
  updateRangeFilterSummary();
}

function setAnalysisPoint(lat, lon, label) {
  // Once placed, the analysis origin changes only through an armed pin drop.
  if (currentAnalysisPoint && !dropPinMode) return;

  if (!isValidLonLat(lon, lat)) {
    setStatus(
      "Invalid analysis point. Expected valid longitude/latitude.",
    );
    return;
  }
  currentAnalysisPoint = { lat, lon, label };
  setMetricsSummaryCollapsed(true);
  if (view) {
    view
      .goTo({
        center: [lon, lat],
        zoom: Math.max(view.zoom || DEFAULT_ZOOM, 14),
      })
      .catch((error) => {
        if (error.name !== "AbortError") console.error(error);
      });
  }
  setResultsSubtitle(
    `Selected point: ${label || `${lat.toFixed(4)}, ${lon.toFixed(4)}`}. Filters update the nearby result cards below.`,
  );
  analyzeCurrentPoint();
}

function analyzeCurrentPoint() {
  if (!currentAnalysisPoint) return;
  const options = getScoringOptions();

  const nearby = restaurants
    .map((restaurant) => {
      const distanceMiles = haversineMiles(
        currentAnalysisPoint.lat,
        currentAnalysisPoint.lon,
        restaurant.lat,
        restaurant.lon,
      );
      const proximity = clamp(
        100 * (1 - distanceMiles / options.radiusMiles),
        0,
        100,
      );
      const distanceWeight = clamp(
        1 - 0.5 * (distanceMiles / options.radiusMiles),
        0.5,
        1,
      );
      const inspectionRawValue = inspectionRaw(restaurant.attributes);
      const inspection = inspectionScore(restaurant.attributes);
      const price = estimatedMealPrice(restaurant.attributes);
      const priceDollars =
        price === null ? null : priceBucketValue(price);
      const affordability = affordabilityScore(
        price,
        options.idealPrice,
        options.highPrice,
      );
      const ratingStars = googleRatingStars(restaurant.attributes);
      const popularity = popularityScore(restaurant.attributes);
      const profile = {
        distanceMiles: clamp(distanceMiles, 0, 2),
        inspectionRaw: inspectionRawValue,
        ratingStars,
        priceDollars,
      };

      return {
        ...restaurant,
        distanceMiles,
        distanceWeight,
        proximity,
        inspection,
        inspectionRaw: inspectionRawValue,
        price,
        priceDollars,
        affordability,
        popularity,
        ratingStars,
        profile,
        profileDifference: null,
        benchmarkUnitGap: null,
        benchmarkNormalizedGap: null,
        benchmarkMatch: false,
        benchmarkHighlighted: false,
      };
    })
    .filter(
      (restaurant) => restaurant.distanceMiles <= options.radiusMiles,
    )
    .sort((a, b) => a.distanceMiles - b.distanceMiles);

  nearby.forEach((restaurant) => {
    const benchmark = rangeFilterMatch(restaurant, options);
    restaurant.profileDifference = benchmark.difference;
    restaurant.benchmarkUnitGap = benchmark.unitGap;
    restaurant.benchmarkNormalizedGap = benchmark.normalizedGap;
    restaurant.benchmarkMatch = benchmark.match;
    restaurant.benchmarkMatchType = benchmark.matchType;
    restaurant.benchmarkMissingMetrics = benchmark.missingMetrics || [];
    restaurant.benchmarkKnownAxisCount = benchmark.knownAxisCount;
    restaurant.benchmarkEnabledAxisCount = benchmark.enabledAxisCount;
    restaurant.benchmarkRuleSummary = benchmark.ruleSummary;
  });

  nearby.forEach((restaurant) => {
    restaurant.benchmarkHighlighted =
      restaurant.benchmarkMatchType === "full";
  });

  const result = calculateFoodAccessScore(nearby, options);
  lastAnalysisResult = { result, nearby, options };
  drawAnalysisGraphics(currentAnalysisPoint, options.radiusMiles, nearby);
  updateScoreUi(result, nearby, options);
  updateMetricsSummary(nearby, options);
  updateInfoUi(result, nearby, options);
  updateRangeFilterSummary();
  setAnalysisPanelsVisible(true);
}

function getScoringOptions() {
  normalizeFilterInputs(null);

  const radiusMiles = Math.max(0.25, getNumber("radiusMiles", 1));

  const ratingMode =
    document.getElementById("ratingMode")?.value || "range";
  let ratingMin = getNumber("ratingMin", 3);
  let ratingMax = getNumber("ratingMax", 4.5);
  if (ratingMode === "exact") {
    ratingMax = ratingMin;
    const ratingMaxInput = document.getElementById("ratingMax");
    if (ratingMaxInput) ratingMaxInput.value = ratingMin;
  } else if (ratingMin > ratingMax) {
    [ratingMin, ratingMax] = [ratingMax, ratingMin];
  }

  const inspectionMode =
    document.getElementById("inspectionMode")?.value || "range";
  let inspectionMin = getNumber("inspectionMin", 1);
  let inspectionMax = getNumber("inspectionMax", 2);
  if (inspectionMode === "exact") {
    inspectionMax = inspectionMin;
    const inspectionMaxInput = document.getElementById("inspectionMax");
    if (inspectionMaxInput) inspectionMaxInput.value = inspectionMin;
  } else if (inspectionMin > inspectionMax) {
    [inspectionMin, inspectionMax] = [inspectionMax, inspectionMin];
  }

  const priceMode =
    document.getElementById("priceMode")?.value || "range";
  let priceMin = getNumber("priceMin", 0);
  let priceMax = getNumber("priceMax", 20);
  if (priceMode === "exact") {
    priceMax = priceMin;
    const priceMaxInput = document.getElementById("priceMax");
    if (priceMaxInput) priceMaxInput.value = priceMin;
  } else if (priceMin > priceMax) {
    [priceMin, priceMax] = [priceMax, priceMin];
  }

  const allowUnknownRating =
    document.getElementById("allowUnknownRating")?.checked ?? true;
  const allowUnknownPrice =
    document.getElementById("allowUnknownPrice")?.checked ?? true;

  const idealPrice = 10;
  const highPrice = 30;

  return {
    radiusMiles,
    idealPrice,
    highPrice,
    ratingMode,
    ratingMin,
    ratingMax,
    allowUnknownRating,
    inspectionMode,
    inspectionMin,
    inspectionMax,
    priceMode,
    priceMin,
    priceMax,
    allowUnknownPrice,
  };
}

function calculateFoodAccessScore(nearby, options) {
  if (nearby.length === 0) {
    return {
      accessScore: 0,
      riskScore: 100,
      riskLabel: "Severe risk",
      availabilityScore: 0,
      inspectionScore: 0,
      affordabilityScore: 0,
      popularityScore: 0,
      weightedCount: 0,
      qualifiedEquivalentCount: 0,
      qualifiedOptionShare: 0,
      qualifiedOptionShareAccessScore: 0,
      distanceWeightedAccessRaw: 0,
      distanceWeightedAccessTotal: 0,
      distanceWeightedAccessScore: 0,
      avgInspection: null,
      avgPrice: null,
      avgRating: null,
      avgProfileDiff: null,
      benchmarkMatchCount: 0,
      benchmarkFullMatchCount: 0,
      benchmarkPartialMatchCount: 0,
      benchmarkHighlightedCount: 0,
    };
  }

  const avgInspection = weightedAverage(
    nearby,
    "inspection",
    "distanceWeight",
  );
  const avgAffordability = weightedAverage(
    nearby,
    "affordability",
    "distanceWeight",
  );
  const avgPopularity = weightedAverage(
    nearby,
    "popularity",
    "distanceWeight",
  );
  const avgPrice = weightedAverageNullable(
    nearby,
    "price",
    "distanceWeight",
  );
  const avgRating = averageNullable(
    nearby.map((item) => parseNumber(item.attributes.google_rating)),
  );

  const benchmarkMatchCount = nearby.filter(
    (item) => item.benchmarkMatch,
  ).length;
  const benchmarkFullMatchCount = nearby.filter(
    (item) => item.benchmarkMatchType === "full",
  ).length;
  const benchmarkPartialMatchCount = nearby.filter(
    (item) => item.benchmarkMatchType === "partial",
  ).length;
  const benchmarkHighlightedCount = nearby.filter(
    (item) => item.benchmarkHighlighted,
  ).length;

  const qualifiedEquivalentCount = nearby.reduce(
    (sum, item) => sum + matchWeightForRisk(item),
    0,
  );

  const qualifiedOptionShare =
    nearby.length === 0 ? 0 : qualifiedEquivalentCount / nearby.length;
  const qualifiedOptionShareAccessScore = clamp(
    qualifiedOptionShare * 100,
    0,
    100,
  );

  // One index score: a normalized distance-decay qualified-access score.
  // Full match = 1.0, partial match = 0.5, non-match = 0.
  // Each nearby location is weighted by a smooth kernel so closer places count more.
  // Normalizing by the total nearby distance weight keeps the score bounded and easy to read:
  // 0 = no nearby weighted access qualifies; 100 = all nearby weighted access qualifies.
  const radiusMiles = Math.max(
    options.radiusMiles || 1,
    DISTANCE_DECAY_FLOOR_MILES,
  );
  const bandwidthMiles = Math.max(
    radiusMiles / 2,
    DISTANCE_DECAY_FLOOR_MILES,
  );

  const distanceWeightedAccess = nearby.reduce(
    (acc, item) => {
      const distanceMiles = Math.max(
        item.distanceMiles || 0,
        DISTANCE_DECAY_FLOOR_MILES,
      );
      const distanceKernel = Math.exp(
        -Math.pow(distanceMiles / bandwidthMiles, 2),
      );
      const matchWeight = matchWeightForRisk(item);

      acc.qualified += matchWeight * distanceKernel;
      acc.total += distanceKernel;
      return acc;
    },
    { qualified: 0, total: 0 },
  );

  const distanceWeightedAccessScore =
    distanceWeightedAccess.total <= 0
      ? 0
      : clamp(
          (distanceWeightedAccess.qualified /
            distanceWeightedAccess.total) *
            100,
          0,
          100,
        );

  const accessScore = distanceWeightedAccessScore;
  const riskScore = clamp(100 - accessScore, 0, 100);

  return {
    accessScore,
    riskScore,
    riskLabel: riskLabel(riskScore),
    availabilityScore: accessScore,
    inspectionScore: avgInspection,
    affordabilityScore: avgAffordability,
    popularityScore: avgPopularity,
    weightedCount: distanceWeightedAccess.qualified,
    qualifiedEquivalentCount,
    qualifiedOptionShare,
    qualifiedOptionShareAccessScore,
    distanceWeightedAccessRaw: distanceWeightedAccess.qualified,
    distanceWeightedAccessTotal: distanceWeightedAccess.total,
    distanceWeightedAccessScore,
    avgInspection,
    avgPrice,
    avgRating,
    avgProfileDiff: null,
    benchmarkMatchCount,
    benchmarkFullMatchCount,
    benchmarkPartialMatchCount,
    benchmarkHighlightedCount,
  };
}

function matchWeightForRisk(item) {
  if (item?.benchmarkMatchType === "full") return 1;
  if (item?.benchmarkMatchType === "partial") return 0.5;
  return 0;
}

function rangeFilterMatch(restaurant, options) {
  const missingMetrics = [];
  const failures = [];
  let knownAxisCount = 0;
  let passedAxisCount = 0;

  // Distance is already filtered by radius. Keep it as a known/passed axis for confidence.
  knownAxisCount += 1;
  passedAxisCount += 1;

  const inspection = parseNumber(restaurant.inspectionRaw);
  if (inspection === null) {
    missingMetrics.push("Inspection");
  } else {
    knownAxisCount += 1;
    if (
      inspection >= options.inspectionMin &&
      inspection <= options.inspectionMax
    ) {
      passedAxisCount += 1;
    } else {
      failures.push("Inspection");
    }
  }

  const rating = parseNumber(restaurant.ratingStars);
  if (rating === null) {
    if (options.allowUnknownRating) missingMetrics.push("Google stars");
    else failures.push("Google stars");
  } else {
    knownAxisCount += 1;
    if (rating >= options.ratingMin && rating <= options.ratingMax) {
      passedAxisCount += 1;
    } else {
      failures.push("Google stars");
    }
  }

  const price = parseNumber(restaurant.priceDollars);
  if (price === null) {
    if (options.allowUnknownPrice) missingMetrics.push("Price bucket");
    else failures.push("Price bucket");
  } else {
    knownAxisCount += 1;
    if (price >= options.priceMin && price <= options.priceMax) {
      passedAxisCount += 1;
    } else {
      failures.push("Price bucket");
    }
  }

  const enabledAxisCount = 4;
  const knownAxesPass = failures.length === 0;
  const hasAllowedUnknown = missingMetrics.length > 0;

  const fullMatch = knownAxesPass && !hasAllowedUnknown;
  const partialMatch =
    knownAxesPass && hasAllowedUnknown && knownAxisCount >= 2;

  const ratingGap =
    rating === null
      ? null
      : rating < options.ratingMin
        ? options.ratingMin - rating
        : rating > options.ratingMax
          ? rating - options.ratingMax
          : 0;

  const inspectionGap =
    inspection === null
      ? null
      : inspection < options.inspectionMin
        ? options.inspectionMin - inspection
        : inspection > options.inspectionMax
          ? inspection - options.inspectionMax
          : 0;

  const priceGap =
    price === null
      ? null
      : price < options.priceMin
        ? (options.priceMin - price) / 10
        : price > options.priceMax
          ? (price - options.priceMax) / 10
          : 0;

  const gaps = [ratingGap, inspectionGap, priceGap].filter(
    (value) => value !== null && Number.isFinite(value),
  );
  const difference =
    gaps.length === 0
      ? 0
      : Math.round(
          (gaps.reduce((sum, value) => sum + value, 0) / gaps.length) *
            10,
        ) / 10;

  return {
    difference,
    unitGap: difference,
    normalizedGap: difference,
    match: fullMatch || partialMatch,
    matchType: fullMatch ? "full" : partialMatch ? "partial" : "none",
    missingMetrics,
    enabledAxisCount,
    knownAxisCount,
    passedAxisCount,
    ruleSummary: `rating ${options.ratingMode || "range"}, inspection ${options.inspectionMode || "range"}, price ${options.priceMode || "range"}`,
  };
}

function activeBenchmarkMetrics() {
  return BENCHMARK_METRICS.filter(
    (metric) => benchmarkEnabled[metric.key] !== false,
  );
}

function buildBenchmarkMatchContext(nearby, targets, mode) {
  const context = {};

  activeBenchmarkMetrics().forEach((metric) => {
    const step = metric.matchStep || metric.step || 1;
    const targetValue = snapMetricValue(
      metric,
      parseNumber(targets[metric.key]) ?? metric.defaultValue,
    );
    const distinctValues = uniqueSortedMetricValues(nearby, metric);
    const optionCount = distinctValues.length;
    const valuesWithinNextUnit = distinctValues.filter(
      (value) => Math.abs(value - targetValue) <= step + 1e-9,
    );
    const relaxedShare =
      optionCount === 0 ? 1 : valuesWithinNextUnit.length / optionCount;
    const useRelaxed = optionCount > 0 && relaxedShare < 0.5;

    context[metric.key] = {
      step,
      targetValue,
      distinctValues,
      optionCount,
      valuesWithinNextUnit,
      relaxedShare,
      useRelaxed,
    };
  });

  return context;
}

function uniqueSortedMetricValues(nearby, metric) {
  const values = nearby
    .map((item) => parseNumber(item.profile?.[metric.key]))
    .filter((value) => value !== null && Number.isFinite(value))
    .map((value) => snapMetricValue(metric, value));

  return [...new Set(values)].sort((a, b) => a - b);
}

function benchmarkDifference(profile, targets, mode, context = null) {
  const metrics = activeBenchmarkMetrics();

  if (metrics.length === 0) {
    return {
      difference: null,
      unitGap: null,
      normalizedGap: null,
      match: false,
      matchType: "none",
      missingMetrics: [],
      enabledAxisCount: 0,
      knownAxisCount: 0,
      passedAxisCount: 0,
      ruleSummary: "no enabled axes",
    };
  }

  const axisResults = metrics.map((metric) => {
    const profileValue = parseNumber(profile[metric.key]);
    const targetValue = parseNumber(targets[metric.key]);
    const metricContext = context?.[metric.key];
    const snappedTarget =
      metricContext?.targetValue ??
      snapMetricValue(metric, targetValue ?? metric.defaultValue);
    const step =
      metricContext?.step ?? metric.matchStep ?? metric.step ?? 1;

    if (profileValue === null || targetValue === null) {
      return {
        metric,
        missing: true,
        pass: true,
        unitGap: null,
        normalizedGap: null,
      };
    }

    const snappedProfile = snapMetricValue(metric, profileValue);
    const unitGap = Math.abs(snappedProfile - snappedTarget) / step;
    const normalizedGap = Math.abs(
      normalizeMetric10(metric, profileValue) -
        normalizeMetric10(metric, targetValue),
    );

    let pass;
    if (mode === "unit_average" || mode === "normalized_loose") {
      // These modes are evaluated after the axis-level gaps are known.
      pass = true;
    } else if (mode === "adaptive_unit") {
      const useRelaxed = metricContext?.useRelaxed ?? true;
      pass = useRelaxed
        ? Math.abs(snappedProfile - snappedTarget) <= step + 1e-9
        : Math.abs(snappedProfile - snappedTarget) <= 1e-9;
    } else {
      pass = unitGap <= 1;
    }

    return {
      metric,
      missing: false,
      pass,
      unitGap,
      normalizedGap,
    };
  });

  const knownResults = axisResults.filter((result) => !result.missing);
  const missingResults = axisResults.filter((result) => result.missing);
  const knownAxisCount = knownResults.length;
  const missingAxisCount = missingResults.length;
  const enabledAxisCount = metrics.length;
  const missingMetrics = missingResults.map(
    (result) => result.metric.label,
  );

  if (knownAxisCount === 0) {
    return {
      difference: null,
      unitGap: null,
      normalizedGap: null,
      match: false,
      matchType: "none",
      missingMetrics,
      enabledAxisCount,
      knownAxisCount,
      passedAxisCount: 0,
      ruleSummary: "all enabled axes unknown",
    };
  }

  const averageUnitGap =
    knownResults.reduce((sum, result) => sum + result.unitGap, 0) /
    knownResults.length;
  const maxUnitGap = Math.max(
    ...knownResults.map((result) => result.unitGap),
  );
  const averageNormalizedGap =
    knownResults.reduce((sum, result) => sum + result.normalizedGap, 0) /
    knownResults.length;

  let knownAxesPass = knownResults.every((result) => result.pass);
  let ruleSummary = "";

  if (mode === "unit_average") {
    knownAxesPass = averageUnitGap <= 1;
    ruleSummary = "average ± next unit";
  } else if (mode === "normalized_loose") {
    knownAxesPass = averageNormalizedGap <= 2;
    ruleSummary = "loose normalized profile";
  } else if (mode === "adaptive_unit") {
    const relaxedCount = metrics.filter(
      (metric) => context?.[metric.key]?.useRelaxed,
    ).length;
    ruleSummary = `adaptive: ${relaxedCount} relaxed, ${metrics.length - relaxedCount} exact`;
  } else {
    knownAxesPass = maxUnitGap <= 1;
    ruleSummary = "strict ± next unit";
  }

  const passedAxisCount = knownResults.filter(
    (result) => result.pass,
  ).length;
  const fullMatch = knownAxesPass && missingAxisCount === 0;
  const partialMatch =
    knownAxesPass &&
    missingAxisCount === 1 &&
    knownAxisCount >= Math.max(1, enabledAxisCount - 1);
  const matchType = fullMatch
    ? "full"
    : partialMatch
      ? "partial"
      : "none";

  return {
    difference: Math.round(averageUnitGap * 10) / 10,
    unitGap: Math.round(averageUnitGap * 10) / 10,
    normalizedGap: Math.round(averageNormalizedGap * 10) / 10,
    match: fullMatch || partialMatch,
    matchType,
    missingMetrics,
    enabledAxisCount,
    knownAxisCount,
    passedAxisCount,
    ruleSummary,
  };
}

function computeNearbyAverageProfile(nearby) {
  if (!nearby.length) return null;
  const profile = {};
  BENCHMARK_METRICS.forEach((metric) => {
    const avg = weightedAverageNullable(
      nearby,
      metric.key,
      "distanceWeight",
    );
    profile[metric.key] = avg === null ? null : avg;
  });
  return profile;
}

function inspectionRaw(attributes) {
  const quality = clean(attributes.quality_score).toUpperCase();
  const grade = clean(attributes.USER_current_rating).toUpperCase();

  // Normalize inspection as: 0 = Unsatisfactory, 1 = Satisfactory, 2 = Good.
  if (quality === "2") return 2;
  if (quality === "1") return 1;
  if (quality === "0" || quality === "3" || quality === "4") return 0;

  if (grade === "GOOD" || grade === "A") return 2;
  if (grade === "SATISFACTORY" || grade === "B") return 1;
  if (
    grade === "UNSATISFACTORY" ||
    grade === "C" ||
    grade === "D" ||
    grade === "F"
  )
    return 0;

  const numeric = parseNumber(grade);
  if (numeric !== null) {
    if (numeric <= 2) return clamp(Math.round(numeric), 0, 2);
    if (numeric <= 100)
      return clamp(Math.round((numeric / 100) * 2), 0, 2);
  }

  return null;
}

function inspectionScore(attributes) {
  const raw = inspectionRaw(attributes);
  return raw === null ? 50 : clamp((raw / 2) * 100, 0, 100);
}

function estimatedMealPrice(attributes) {
  const start = parseNumber(attributes.google_price_range_start);
  const end = parseNumber(attributes.google_price_range_end);
  if (start !== null && end !== null) return (start + end) / 2;
  if (start !== null && end === null) return start;
  const label = clean(
    attributes.google_price_label || attributes.google_price_bucket,
  );
  const fromLabel = priceFromLabel(label);
  if (fromLabel !== null) return fromLabel;
  const level = clean(attributes.google_price_level).toUpperCase();
  const levelPrices = {
    PRICE_LEVEL_FREE: 0,
    PRICE_LEVEL_INEXPENSIVE: 9,
    PRICE_LEVEL_MODERATE: 15,
    PRICE_LEVEL_EXPENSIVE: 25,
    PRICE_LEVEL_VERY_EXPENSIVE: 35,
    FREE: 0,
    INEXPENSIVE: 9,
    MODERATE: 15,
    EXPENSIVE: 25,
    VERY_EXPENSIVE: 35,
  };
  if (Object.prototype.hasOwnProperty.call(levelPrices, level))
    return levelPrices[level];
  return null;
}

function priceFromLabel(label) {
  if (!label) return null;
  const cleaned = String(label).replace(/USD/gi, "").replace(/\s/g, "");
  if (cleaned === "$") return 10;
  if (cleaned === "$$") return 18;
  if (cleaned === "$$$") return 30;
  if (cleaned === "$$$$") return 45;
  const numbers = cleaned.match(/\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length === 0) return null;
  const values = numbers.map(Number).filter(Number.isFinite);
  if (values.length >= 2) return (values[0] + values[1]) / 2;
  if (values.length === 1) return values[0];
  return null;
}

function priceBucketValue(price) {
  const numeric = parseNumber(price);
  if (numeric === null) return null;
  if (numeric < 10) return 0;
  if (numeric < 20) return 10;
  return 20;
}

function priceBucketLabel(bucketValue) {
  const bucket = priceBucketValue(bucketValue);
  if (bucket === 0) return "$0–9";
  if (bucket === 10) return "$10–19";
  return "$20+";
}

function preloadLocalPinImage() {
  if (!USE_LOCAL_PIN_IMAGE) {
    localPinImageAvailable = false;
    return;
  }

  const image = new Image();
  image.onload = () => {
    localPinImageAvailable = true;
    if (currentAnalysisPoint) {
      analyzeCurrentPoint();
    }
  };
  image.onerror = () => {
    localPinImageAvailable = false;
    // No console error needed. Missing pin.png is allowed; red-dot fallback is intentional.
  };
  image.src = LOCAL_PIN_IMAGE_URL;
}

function selectedPinSymbol() {
  if (USE_LOCAL_PIN_IMAGE && localPinImageAvailable) {
    return {
      type: "picture-marker",
      url: LOCAL_PIN_IMAGE_URL,
      width: "52px",
      height: "52px",
      yoffset: 26,
    };
  }

  return {
    type: "simple-marker",
    style: "circle",
    color: [220, 38, 38, 1],
    size: 30,
    outline: { color: [0, 0, 0, 1], width: 3 },
  };
}

function dropPinCursorSymbol() {
  if (USE_LOCAL_PIN_IMAGE && localPinImageAvailable) {
    return {
      type: "picture-marker",
      url: LOCAL_PIN_IMAGE_URL,
      width: "42px",
      height: "42px",
      yoffset: 21,
    };
  }

  return {
    type: "simple-marker",
    style: "circle",
    color: [220, 38, 38, 0.35],
    size: 30,
    outline: { color: [0, 0, 0, 1], width: 2.5 },
  };
}

function affordabilityScore(price, idealPrice, highPrice) {
  if (price === null || price === undefined || Number.isNaN(price))
    return 50;
  if (price <= idealPrice) return 100;
  if (price >= highPrice) return 0;
  return clamp(
    100 * (1 - (price - idealPrice) / (highPrice - idealPrice)),
    0,
    100,
  );
}

function googleRatingStars(attributes) {
  const rating = parseNumber(attributes.google_rating);
  return rating === null ? null : clamp(rating, 0, 5);
}

function popularityScore(attributes) {
  // Normalize Google review stars directly to a 0-100 score.
  // Unknown ratings are neutral for food-desert score, but unknown for benchmark matching.
  const stars = googleRatingStars(attributes);
  return stars === null ? 50 : clamp((stars / 5) * 100, 0, 100);
}

function drawAnalysisGraphics(point, radiusMiles, nearby) {
  analysisLayer.removeAll();
  highlightLayer.removeAll();
  benchmarkLayer.removeAll();
  resetRestaurantPointStyles();

  const radiusPolygon = makeCirclePolygon(
    point.lat,
    point.lon,
    radiusMiles,
    96,
  );
  analysisLayer.add(
    new Graphic({
      geometry: radiusPolygon,
      symbol: {
        type: "simple-fill",
        color: [0, 0, 0, 0],
        outline: { color: [0, 255, 255, 1], width: 3 },
      },
    }),
  );

  analysisLayer.add(
    new Graphic({
      geometry: {
        type: "point",
        longitude: point.lon,
        latitude: point.lat,
        spatialReference: { wkid: 4326 },
      },
      symbol: selectedPinSymbol(),
      attributes: {
        label: point.label || "Analysis point",
        latitude: point.lat.toFixed(6),
        longitude: point.lon.toFixed(6),
        radius: `${radiusMiles} mi`,
      },
      popupTemplate: {
        title: "Analysis Point",
        content: [
          {
            type: "fields",
            fieldInfos: [
              { fieldName: "label", label: "Source" },
              { fieldName: "latitude", label: "Latitude" },
              { fieldName: "longitude", label: "Longitude" },
              { fieldName: "radius", label: "Radius" },
            ],
          },
        ],
      },
    }),
  );

  // Do not add duplicate overlay points. Update the existing restaurant
  // graphics in-place so the original marker outline/fill is the only point shown.
  nearby.forEach((item) => {
    if (!item.graphic) return;
    item.graphic.attributes = decorateAttributesForPopup(item);
    item.graphic.popupTemplate = buildRestaurantPopupTemplate();
    item.graphic.symbol =
      item.benchmarkMatchType === "full"
        ? benchmarkMatchSymbol(item)
        : item.benchmarkMatchType === "partial"
          ? partialRangeMatchSymbol()
          : nearbyRestaurantSymbol(item);
  });

  bringFullRangeMatchesToFront(nearby);
}

function benchmarkMatchSymbol(item) {
  if (item.benchmarkMatchType !== "full") {
    return nearbyRestaurantSymbol(item);
  }
  return {
    type: "simple-marker",
    style: "circle",
    // Full range matches are bright purple and solid.
    color: [180, 70, 255, 1],
    size: 28,
    outline: { color: [0, 0, 0, 1], width: 3 },
  };
}

function bringFullRangeMatchesToFront(nearby) {
  if (!restaurantLayer) return;

  nearby
    .filter((item) => item.benchmarkMatchType === "full" && item.graphic)
    .forEach((item) => {
      restaurantLayer.remove(item.graphic);
      restaurantLayer.add(item.graphic);
    });
}

function partialRangeMatchSymbol() {
  return {
    type: "simple-marker",
    style: "circle",
    color: [249, 115, 22, 1],
    size: 21,
    outline: { color: [0, 0, 0, 1], width: 3 },
  };
}

function nearbyRestaurantSymbol(item) {
  // Nearby locations that are not full range matches keep their original
  // inspection color, but become solid so they are visible against imagery.
  return qualityPointSymbol(item.attributes.quality_score, 1, 21, 2.5);
}

function resetRestaurantPointStyles() {
  restaurants.forEach((item) => {
    if (!item.graphic) return;
    item.graphic.symbol = baseRestaurantSymbol(
      item.attributes.quality_score,
    );
    item.graphic.attributes = item.attributes;
    item.graphic.popupTemplate = buildRestaurantPopupTemplate();
  });
}

function decorateAttributesForPopup(item) {
  return {
    ...item.attributes,
    popup_title:
      item.attributes.google_name ||
      item.attributes.USER_facility ||
      "Unnamed food location",
    popup_distance_miles: item.distanceMiles.toFixed(2),
    profile_difference:
      item.profileDifference === null ||
      item.profileDifference === undefined
        ? ""
        : `${item.profileDifference} unit gap`,
    benchmark_match_type: item.benchmarkMatchType || "none",
    benchmark_confidence_note:
      item.benchmarkMatchType === "partial"
        ? `Partial match; unknown: ${(item.benchmarkMissingMetrics || []).join(", ")}`
        : item.benchmarkMatchType === "full"
          ? "Full match"
          : "Not a benchmark match",
  };
}

function makeCirclePolygon(lat, lon, radiusMiles, steps) {
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const bearing = (i / steps) * 360;
    const dest = destinationPoint(lat, lon, bearing, radiusMiles);
    ring.push([dest.lon, dest.lat]);
  }
  return {
    type: "polygon",
    rings: [ring],
    spatialReference: { wkid: 4326 },
  };
}

function destinationPoint(lat, lon, bearingDegrees, distanceMiles) {
  const earthRadiusMiles = 3958.7613;
  const angularDistance = distanceMiles / earthRadiusMiles;
  const bearing = toRad(bearingDegrees);
  const lat1 = toRad(lat);
  const lon1 = toRad(lon);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: toDeg(lat2), lon: ((toDeg(lon2) + 540) % 360) - 180 };
}

function updateScoreUi(result, nearby, options) {
  document.getElementById("riskNumber").textContent = Math.round(
    result.riskScore,
  ).toString();
  document.getElementById("riskLabel").textContent = result.riskLabel;
  document.getElementById("scoreMeta").textContent =
    `${nearby.length} nearby location(s) within ${formatMiles(options.radiusMiles)} mi` +
    ` · ${result.benchmarkFullMatchCount} full + ${result.benchmarkPartialMatchCount} partial match(es)` +
    ` · Qualified access ${Math.round(result.accessScore)}/100`;

  const riskMethodMeta = document.getElementById("riskMethodMeta");
  if (riskMethodMeta) {
    const weightedQualified = result.distanceWeightedAccessRaw ?? 0;
    const weightedTotal = result.distanceWeightedAccessTotal ?? 0;
    riskMethodMeta.textContent =
      `Distance-decay qualified access: ${Math.round(result.accessScore)}/100 ` +
      `(${weightedQualified.toFixed(2)} / ${weightedTotal.toFixed(2)} weighted nearby access).`;
  }
}

function summarizeNearbyMetric(nearby, metric) {
  const counts = metric.buckets.map(() => 0);
  let total = 0;
  let knownCount = 0;
  nearby.forEach((restaurant) => {
    const value = restaurant[metric.key];
    if (!Number.isFinite(value) || value < 0 || value > metric.max) return;
    const bucketIndex = metric.buckets.findIndex((bucket) => value < bucket.upper);
    if (bucketIndex < 0) return;
    counts[bucketIndex] += 1;
    total += value;
    knownCount += 1;
  });
  return {
    average: knownCount ? total / knownCount : null,
    counts,
    knownCount,
    missingCount: nearby.length - knownCount,
  };
}

function updateMetricsSummary(nearby, options) {
  document.getElementById("metricsSummaryMeta").textContent =
    `${nearby.length} nearby location${nearby.length === 1 ? "" : "s"} within ${formatMiles(options.radiusMiles)} mi`;
  document.getElementById("metricDistributions").innerHTML = SUMMARY_METRICS.map((metric) => {
    const summary = summarizeNearbyMetric(nearby, metric);
    const largestCount = Math.max(...summary.counts);
    const average = summary.average === null ? "—" : metric.formatAverage(summary.average);
    const coverage = nearby.length === 0
      ? "No nearby locations"
      : `${summary.knownCount} with data · ${summary.missingCount} unavailable`;
    const buckets = metric.buckets.map((bucket, index) => {
      const count = summary.counts[index];
      const percent = summary.knownCount ? Math.round(100 * count / summary.knownCount) : 0;
      const height = largestCount ? 30 * count / largestCount : 0;
      const description = `${bucket.description || bucket.label}: ${count} location${count === 1 ? "" : "s"} (${percent}% of available values)`;
      return `<li class="metric-bucket${count > 0 && count === largestCount ? " most-common" : ""}" data-count="${count}" title="${escapeHtml(description)}" aria-label="${escapeHtml(description)}">
        <div class="metric-bar-track" aria-hidden="true">
          <span class="metric-bucket-count">${count}</span>
          <span class="metric-bar" style="--bucket-height: ${height.toFixed(2)}px"></span>
        </div>
        <span class="metric-bucket-label" aria-hidden="true">${escapeHtml(bucket.label)}</span>
      </li>`;
    }).join("");
    return `<section class="metric-distribution" data-metric="${metric.key}" aria-labelledby="metric-title-${metric.key}">
      <h3 id="metric-title-${metric.key}" class="metric-distribution-title">${escapeHtml(metric.label)}</h3>
      <div class="metric-average-row"><span class="metric-average">${escapeHtml(average)}</span><span class="metric-average-caption">avg.</span></div>
      <ol class="metric-histogram" aria-label="${escapeHtml(metric.label)} distribution">${buckets}</ol>
      <p class="metric-coverage">${coverage}</p>
    </section>`;
  }).join("");
}

function updateInfoUi(result, nearby, options) {
  setElementText("nearbyCount", nearby.length.toString());
  setElementText(
    "benchmarkMatchCount",
    `${result.benchmarkFullMatchCount} full + ${result.benchmarkPartialMatchCount} partial`,
  );
  setElementText(
    "inspectionScore",
    result.inspectionScore === null ||
      result.inspectionScore === undefined
      ? "Unknown"
      : `${Math.round(result.inspectionScore)}/100`,
  );
  setElementText(
    "avgPrice",
    result.avgPrice === null
      ? "Unknown"
      : `$${result.avgPrice.toFixed(0)}`,
  );
  setElementText(
    "avgRating",
    result.avgRating === null ? "Unknown" : result.avgRating.toFixed(1),
  );

  setStatus(
    `Radius ${formatMiles(options.radiusMiles)} mi · Nearby ${nearby.length} · Matches ${result.benchmarkFullMatchCount} full + ${result.benchmarkPartialMatchCount} partial`,
  );
  setResultsSubtitle(
    `${nearby.length} nearby location(s) within ${formatMiles(options.radiusMiles)} mi. Food metrics summarize all nearby locations; filters classify matches in the list below.`,
  );
  renderFilteredLocationResults(nearby);
}

function updateNearbyList(nearby) {
  // Disabled: the active UI intentionally uses only #restaurantSearchResults.
  // Keeping this no-op prevents any legacy nearby-list renderer from creating a second list.
}

function upgradeNearbyResultCards(container, nearbyItems) {
  // Disabled with updateNearbyList().
}

function drawBenchmarkChart() {
  document
    .querySelectorAll(".benchmark-info-button")
    .forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });

  const svg = document.getElementById("benchmarkChart");
  if (!svg) return;
  const size = 250;
  const center = 125;
  const radius = 82;
  const gridLevels = [0.25, 0.5, 0.75, 1];
  const targetPoints = BENCHMARK_METRICS.map((metric, index) =>
    radarPoint(
      index,
      normalizeMetricValue(metric, benchmarkTargets[metric.key]),
      center,
      radius,
    ),
  );
  const averagePoints = nearbyAverageProfile
    ? BENCHMARK_METRICS.map((metric, index) => {
        const value = nearbyAverageProfile[metric.key];
        return radarPoint(
          index,
          value === null ? 0 : normalizeMetricValue(metric, value),
          center,
          radius,
        );
      })
    : [];

  const polygonPoints = (points) =>
    points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  let markup = "";

  gridLevels.forEach((level) => {
    const points = BENCHMARK_METRICS.map((_, index) =>
      radarPoint(index, level, center, radius),
    );
    markup += `<polygon points="${polygonPoints(points)}" fill="none" stroke="#dedede" stroke-width="1" />`;
  });

  BENCHMARK_METRICS.forEach((metric, index) => {
    const enabled = benchmarkEnabled[metric.key] !== false;
    const end = radarPoint(index, 1, center, radius);
    const label = radarPoint(index, 1.18, center, radius);
    markup += `<line x1="${center}" y1="${center}" x2="${end.x}" y2="${end.y}" stroke="${enabled ? "#d0d0d0" : "#e5e7eb"}" stroke-width="1" stroke-dasharray="${enabled ? "" : "3 3"}" />`;
    markup += `<text x="${label.x}" y="${label.y}" text-anchor="middle" dominant-baseline="middle" font-size="10" font-weight="700" fill="${enabled ? "#444" : "#aaa"}">${escapeSvg(metric.shortLabel)}</text>`;
  });

  if (averagePoints.length) {
    markup += `<polygon points="${polygonPoints(averagePoints)}" fill="rgba(43, 140, 190, 0.13)" stroke="#2b8cbe" stroke-width="2" stroke-dasharray="4 3" />`;
  }

  markup += `<polygon points="${polygonPoints(targetPoints)}" fill="rgba(217, 119, 6, 0.16)" stroke="#d97706" stroke-width="2.5" />`;

  targetPoints.forEach((point, index) => {
    const metric = BENCHMARK_METRICS[index];
    const enabled = benchmarkEnabled[metric.key] !== false;
    markup += `<circle class="benchmark-handle" data-metric="${metric.key}" cx="${point.x}" cy="${point.y}" r="8" fill="${enabled ? "#d97706" : "#9ca3af"}" stroke="white" stroke-width="2" opacity="${enabled ? "1" : "0.55"}" style="cursor: ${enabled ? "grab" : "not-allowed"};" />`;
  });

  markup += `<circle cx="${center}" cy="${center}" r="2" fill="#777" />`;
  svg.innerHTML = markup;

  svg.querySelectorAll(".benchmark-handle").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      const metricKey = event.currentTarget.getAttribute("data-metric");
      if (benchmarkEnabled[metricKey] === false) return;
      dragMetricKey = metricKey;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
  });

  updateBenchmarkValuesUi();
}

function radarPoint(index, normalizedRatio, center, radius) {
  const angle =
    -Math.PI / 2 + (index * 2 * Math.PI) / BENCHMARK_METRICS.length;
  const scaled = clamp(normalizedRatio, 0, 1.2);
  return {
    x: center + Math.cos(angle) * radius * scaled,
    y: center + Math.sin(angle) * radius * scaled,
  };
}

function handleBenchmarkPointerMove(event) {
  if (!dragMetricKey) return;
  document
    .querySelectorAll(".benchmark-info-button")
    .forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });

  const svg = document.getElementById("benchmarkChart");
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const svgPoint = point.matrixTransform(svg.getScreenCTM().inverse());
  const metricIndex = BENCHMARK_METRICS.findIndex(
    (metric) => metric.key === dragMetricKey,
  );
  if (metricIndex < 0) return;
  const metric = BENCHMARK_METRICS[metricIndex];
  const center = 125;
  const radius = 82;
  const angle =
    -Math.PI / 2 + (metricIndex * 2 * Math.PI) / BENCHMARK_METRICS.length;
  const axisX = Math.cos(angle);
  const axisY = Math.sin(angle);
  const dx = svgPoint.x - center;
  const dy = svgPoint.y - center;
  const projection = clamp((dx * axisX + dy * axisY) / radius, 0, 1);
  const rawValue = metric.min + projection * (metric.max - metric.min);
  benchmarkTargets[dragMetricKey] = snapMetricValue(metric, rawValue);
  drawBenchmarkChart();
  if (currentAnalysisPoint) analyzeCurrentPoint();
}

function normalizeMetricValue(metric, value) {
  const numeric = parseNumber(value);
  const safeValue = numeric === null ? metric.defaultValue : numeric;
  return clamp(
    (safeValue - metric.min) / (metric.max - metric.min),
    0,
    1,
  );
}

function normalizeMetric10(metric, value) {
  return normalizeMetricValue(metric, value) * 10;
}

function snapMetricValue(metric, value) {
  const step = metric.step || 1;
  const snapped = Math.round(value / step) * step;
  return clamp(Number(snapped.toFixed(2)), metric.min, metric.max);
}

function formatMetricValue(metric, value) {
  const numeric = parseNumber(value);
  const safeValue = numeric === null ? metric.defaultValue : numeric;
  if (metric.key === "inspectionRaw") {
    if (safeValue >= 1.5) return "2 good";
    if (safeValue >= 0.5) return "1 satisfactory";
    return "0 unsatisfactory";
  }
  if (metric.key === "distanceMiles")
    return `${safeValue.toFixed(safeValue % 1 === 0 ? 0 : 2)} mi`;
  if (metric.key === "ratingStars") return `${safeValue.toFixed(1)}★`;
  if (metric.key === "priceDollars") return priceBucketLabel(safeValue);
  return `${safeValue}`;
}

function roundToStep(value, step) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value / step) * step;
}

function stopBenchmarkDrag() {
  dragMetricKey = null;
}

function updateBenchmarkValuesUi() {
  const container = document.getElementById("benchmarkValues");
  if (!container) return;
  container.innerHTML = BENCHMARK_METRICS.map((metric) => {
    const enabled = benchmarkEnabled[metric.key] !== false;
    const target = benchmarkTargets[metric.key] ?? metric.defaultValue;
    const avg =
      nearbyAverageProfile &&
      Number.isFinite(nearbyAverageProfile[metric.key])
        ? nearbyAverageProfile[metric.key]
        : null;
    return `
      <div class="benchmark-value-row ${enabled ? "" : "disabled"}">
        <input class="benchmark-axis-toggle" type="checkbox" data-metric="${metric.key}" ${enabled ? "checked" : ""} aria-label="Use ${escapeHtml(metric.label)} in benchmark matching" />
        <span class="axis-name">${escapeHtml(metric.label)}</span>
        <b class="axis-value">${formatMetricValue(metric, target)}${avg === null ? "" : ` / avg ${formatMetricValue(metric, avg)}`}</b>
      </div>
    `;
  }).join("");

  container
    .querySelectorAll(".benchmark-axis-toggle")
    .forEach((checkbox) => {
      checkbox.addEventListener("change", (event) => {
        const metricKey = event.currentTarget.getAttribute("data-metric");
        benchmarkEnabled[metricKey] = event.currentTarget.checked;
        drawBenchmarkChart();
        if (currentAnalysisPoint) analyzeCurrentPoint();
      });
    });
}

function resetBenchmarkTargets() {
  benchmarkTargets = Object.fromEntries(
    BENCHMARK_METRICS.map((metric) => [metric.key, metric.defaultValue]),
  );
  benchmarkEnabled = Object.fromEntries(
    BENCHMARK_METRICS.map((metric) => [metric.key, true]),
  );
  drawBenchmarkChart();
  if (currentAnalysisPoint) analyzeCurrentPoint();
}

function riskLabel(riskScore) {
  if (riskScore >= 75) return "Severe risk";
  if (riskScore >= 50) return "High risk";
  if (riskScore >= 25) return "Moderate risk";
  return "Low risk";
}

function qualityPointSymbol(qualityScore, opacity, size, outlineWidth) {
  const cleaned = clean(qualityScore);
  let color;

  if (cleaned === "2") {
    // Good inspection = bright green.
    color = [0, 255, 90, opacity];
  } else if (cleaned === "1") {
    // Satisfactory inspection = bright yellow.
    color = [255, 230, 0, opacity];
  } else {
    // Unsatisfactory/missing/other inspection = red.
    color = [239, 68, 68, opacity];
  }

  return {
    type: "simple-marker",
    style: "circle",
    color,
    size,
    outline: { color: [0, 0, 0, 1], width: outlineWidth },
  };
}

function baseRestaurantSymbol(qualityScore) {
  // Default, outside-radius points stay lightly transparent.
  return qualityPointSymbol(qualityScore, 0.15, 16, 2);
}

// Backward-compatible alias for any older call sites.
function symbolForQualityScore(qualityScore) {
  return baseRestaurantSymbol(qualityScore);
}

function parseCoordinateInput(value) {
  const parts = clean(value)
    .split(/[ ,]+/)
    .map((part) => parseNumber(part))
    .filter((part) => part !== null);
  if (parts.length < 2) return null;
  const a = parts[0];
  const b = parts[1];
  if (Math.abs(a) > 90 && Math.abs(b) <= 90) {
    if (isValidLonLat(a, b)) return { lon: a, lat: b };
  }
  if (isValidLonLat(b, a)) return { lat: a, lon: b };
  if (isValidLonLat(a, b)) return { lon: a, lat: b };
  return null;
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const radiusMiles = 3958.7613;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return radiusMiles * c;
}

function weightedAverage(items, valueKey, weightKey) {
  const valid = items.filter(
    (item) =>
      Number.isFinite(item[valueKey]) && Number.isFinite(item[weightKey]),
  );
  if (valid.length === 0) return 0;
  const numerator = valid.reduce(
    (sum, item) => sum + item[valueKey] * item[weightKey],
    0,
  );
  const denominator = valid.reduce(
    (sum, item) => sum + item[weightKey],
    0,
  );
  return denominator === 0 ? 0 : numerator / denominator;
}

function weightedAverageNullable(items, valueKey, weightKey) {
  const valid = items.filter(
    (item) =>
      item[valueKey] !== null &&
      Number.isFinite(item[valueKey]) &&
      Number.isFinite(item[weightKey]),
  );
  if (valid.length === 0) return null;
  const numerator = valid.reduce(
    (sum, item) => sum + item[valueKey] * item[weightKey],
    0,
  );
  const denominator = valid.reduce(
    (sum, item) => sum + item[weightKey],
    0,
  );
  return denominator === 0 ? null : numerator / denominator;
}

function averageNullable(values) {
  const valid = values.filter(
    (value) => value !== null && Number.isFinite(value),
  );
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function getField(row, possibleNames) {
  for (const name of possibleNames) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  }
  const normalizedLookup = {};
  for (const key of Object.keys(row))
    normalizedLookup[normalizeHeader(key)] = key;
  for (const name of possibleNames) {
    const actualKey = normalizedLookup[normalizeHeader(name)];
    if (actualKey) return row[actualKey];
  }
  return "";
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\-\s]/g, "");
}

function formatPhotoAttribution(value) {
  if (value === null || value === undefined || value === "") return "";

  let parsed = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        return trimmed;
      }
    } else {
      return trimmed;
    }
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items
    .map((item) => {
      if (!item) return "";
      if (typeof item === "string") return item;
      return (
        item.displayName || item.author || item.uri || item.photoUri || ""
      );
    })
    .filter(Boolean)
    .join(", ");
}

function qualityLabelFromScore(score) {
  const cleaned = clean(score);
  if (cleaned === "2") return "Good";
  if (cleaned === "1") return "Satisfactory";
  if (cleaned === "0") return "Unsatisfactory";
  return "";
}

function firstValidNumber(values) {
  for (const value of values) {
    const parsed = parseNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseNumber(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).trim().replace(/,/g, "");
  if (!cleaned) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function isValidLonLat(lon, lat) {
  return (
    typeof lon === "number" &&
    typeof lat === "number" &&
    lon >= -180 &&
    lon <= 180 &&
    lat >= -90 &&
    lat <= 90
  );
}

function getNumber(id, fallback) {
  const value = parseNumber(document.getElementById(id).value);
  return value === null ? fallback : value;
}

function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toRad(degrees) {
  return (degrees * Math.PI) / 180;
}

function toDeg(radians) {
  return (radians * 180) / Math.PI;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeSvg(value) {
  return escapeHtml(value);
}

function setElementText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function setResultsSubtitle(message) {
  const element = document.getElementById("resultsSubtitle");
  if (element) element.textContent = message;
}

function setStatus(message) {
  document.getElementById("status").textContent = message;
}
