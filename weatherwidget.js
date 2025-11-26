/**
 * Google Weather API — Current Conditions Widget (Scriptable)
 * Endpoint:
 *   https://weather.googleapis.com/v1/currentConditions:lookup
 *
 * - Uses current GPS location (or fixed coords).
 * - API key stored securely in iOS Keychain (no hard-coding).
 * - Matches current Google Weather API schema (degrees/unit, description.text).
 * - Suggests refresh every 10 minutes (iOS limits still apply).
 */

//////////////////////// CONFIG ////////////////////////
const USE_CURRENT_LOCATION = true;     // true = use GPS; false = use FIXED_LAT/LON below
const FIXED_LAT = 50.0647;             // Kraków example
const FIXED_LON = 19.9450;
const LANGUAGE = "pl";                 // e.g. "pl", "en"
const UNITS_SYSTEM = "METRIC";         // "METRIC" or "IMPERIAL"
const KEYCHAIN_KEY = "GOOGLE_WEATHER_API_KEY"; // where we store your API key
const CACHE_MIN = 5;                   // cache minutes to avoid over-calling
const REFRESH_MIN = 10;                // widget suggests refresh every N minutes
////////////////////////////////////////////////////////

const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), "google_weather_cache.json");

// ---- API key handling (secure; no hard-coding) ----
async function getApiKey() {
  let key = Keychain.contains(KEYCHAIN_KEY) ? Keychain.get(KEYCHAIN_KEY) : null;
  if (!key) {
    const a = new Alert();
    a.title = "Google Weather API key";
    a.message = "Paste your Google Maps Platform Weather API key.\nIt will be stored securely in Keychain.";
    a.addTextField("YOUR_API_KEY_HERE");
    a.addAction("Save");
    a.addCancelAction("Cancel");
    const idx = await a.present();
    if (idx === -1) { throw new Error("API key input cancelled."); }
    key = a.textFieldValue(0).trim();
    if (!key) throw new Error("Empty API key.");
    Keychain.set(KEYCHAIN_KEY, key);
  }
  return key;
}

// ---- Location (GPS or fixed) ----
async function getLocation() {
  if (!USE_CURRENT_LOCATION) {
    return { latitude: FIXED_LAT, longitude: FIXED_LON, name: null };
  }
  Location.setAccuracyToTenMeters();
  const loc = await Location.current();
  let placemarks = [];
  try { placemarks = await Location.reverseGeocode(loc.latitude, loc.longitude); } catch (_) {}
  const name = placemarks?.[0]?.locality
    || placemarks?.[0]?.subLocality
    || placemarks?.[0]?.administrativeArea
    || null;
  return { latitude: loc.latitude, longitude: loc.longitude, name };
}

// ---- Cache helpers ----
function readCache() {
  if (!fm.fileExists(cachePath)) return null;
  try {
    const obj = JSON.parse(fm.readString(cachePath));
    if (!obj.timestamp) return null;
    const ageMin = (Date.now() - obj.timestamp) / 60000;
    if (ageMin > CACHE_MIN) return null;
    return obj.data;
  } catch (_) { return null; }
}
function writeCache(data) {
  try {
    fm.writeString(cachePath, JSON.stringify({ timestamp: Date.now(), data }));
  } catch (_) {}
}

// ---- Safe getter ----
function g(obj, path, fallback = null) {
  return path.split(".").reduce((o, k) => (o && o[k] !== undefined ? o[k] : null), obj) ?? fallback;
}

// ---- Fetch from Google Weather API ----
async function fetchWeather(key, lat, lon) {
  const params = [
    `key=${encodeURIComponent(key)}`,
    `location.latitude=${encodeURIComponent(lat)}`,
    `location.longitude=${encodeURIComponent(lon)}`,
    `languageCode=${encodeURIComponent(LANGUAGE)}`,
    `unitsSystem=${encodeURIComponent(UNITS_SYSTEM)}`
  ].join("&");

  const url = `https://weather.googleapis.com/v1/currentConditions:lookup?${params}`;
  const req = new Request(url);
  req.timeoutInterval = 12;
  req.headers = { "Accept": "application/json" };

  const json = await req.loadJSON();
  // If Scriptable exposes status code, we can check it:
  if (req.response && req.response.statusCode && req.response.statusCode >= 400) {
    throw new Error(`HTTP ${req.response.statusCode}`);
  }

  return json;
}

// ---- Condition text normalisation ----
function normalizeConditionText(weatherCondition) {
  if (!weatherCondition) return null;

  // Example schema from docs:
  // "weatherCondition": {
  //   "iconBaseUri": "...",
  //   "description": { "text": "Sunny", "languageCode": "en" },
  //   "type": "CLEAR"
  // }

  if (typeof weatherCondition === "string") {
    return weatherCondition;
  }

  const desc = weatherCondition.description;
  if (typeof desc === "string") return desc;
  if (desc && typeof desc.text === "string") return desc.text;

  if (typeof weatherCondition.type === "string") return weatherCondition.type;

  return null;
}

// ---- Unit helpers ----
function fmtTemp(tempObj) {
  // Schema: { degrees: 13.7, unit: "CELSIUS" }
  const val = g(tempObj, "degrees");
  const unit = g(tempObj, "unit");
  if (val == null) return "—";
  const sym = unit === "FAHRENHEIT" ? "°F" : "°C";
  return `${Math.round(val)}${sym}`;
}

function parseTempC(tempObj) {
  const val = g(tempObj, "degrees");
  const unit = g(tempObj, "unit");
  if (val == null) return null;
  if (unit === "FAHRENHEIT") return Math.round((val - 32) * 5/9);
  return Math.round(val);
}

function fmtWind(windObj) {
  // Schema:
  // "wind": {
  //   "direction": { "degrees": 335, "cardinal": "NORTH_NORTHWEST" },
  //   "speed": { "value": 8, "unit": "KILOMETERS_PER_HOUR" },
  //   "gust": { "value": 18, "unit": "KILOMETERS_PER_HOUR" }
  // }
  const spdVal = g(windObj, "speed.value");
  const spdUnit = g(windObj, "speed.unit");
  let sym = "";
  if (spdUnit === "MILE_PER_HOUR") sym = "mph";
  else if (spdUnit === "METER_PER_SECOND") sym = "m/s";
  else sym = "km/h"; // KILOMETERS_PER_HOUR or fallback

  if (spdVal == null) return "—";

  const dirDeg = g(windObj, "direction.degrees");
  const dirTxt = degToDir(dirDeg);
  return `${Math.round(spdVal)} ${sym}${dirTxt ? " " + dirTxt : ""}`;
}

function degToDir(deg) {
  if (deg == null || isNaN(deg)) return "";
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE",
                "S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round((deg % 360) / 22.5) % 16];
}

// ---- Condition → SF Symbol ----
function pickSymbol(weatherCondition, isDaytime) {
  const text = (normalizeConditionText(weatherCondition) || "") + "";
  const t = text.toLowerCase();
  const day = !!isDaytime;

  if (t.includes("thunder") || t.includes("storm")) return "cloud.bolt.rain.fill";
  if (t.includes("snow") || t.includes("sleet")) return "cloud.snow.fill";
  if (t.includes("rain") || t.includes("drizzle")) return "cloud.rain.fill";
  if (t.includes("fog") || t.includes("mist") || t.includes("haze")) return "cloud.fog.fill";
  if (t.includes("overcast")) return "smoke.fill";
  if (t.includes("cloud")) return day ? "cloud.sun.fill" : "cloud.moon.fill";
  if (t.includes("clear") || t.includes("sunny")) return day ? "sun.max.fill" : "moon.stars.fill";

  // Fallback
  return day ? "sun.max.fill" : "moon.stars.fill";
}

// ---- Background gradient based on temp + day/night ----
function gradientFor(tempC, isDay) {
  const cold = [new Color("#1e3c72"), new Color("#2a5298")];
  const mild = [new Color("#396afc"), new Color("#2948ff")];
  const hot  = [new Color("#ff512f"), new Color("#dd2476")];
  let colors = cold;

  if (tempC != null) {
    if (tempC >= 24) colors = hot;
    else if (tempC >= 10) colors = mild;
    else colors = cold;
  }

  if (!isDay) colors = [new Color("#0f2027"), new Color("#203a43")];

  const grad = new LinearGradient();
  grad.colors = colors;
  grad.locations = [0, 1];
  return grad;
}

// ---- Build the widget UI ----
async function buildWidget(data, placeName) {
  const w = new ListWidget();
  w.setPadding(14, 16, 14, 16);

  const weatherCond = g(data, "weatherCondition");
  const condTextNorm = normalizeConditionText(weatherCond);
  const condStr = condTextNorm ? String(condTextNorm) : "—";

  const isDay = !!g(data, "isDaytime");
  const tempObj = g(data, "temperature");
  const feelsObj = g(data, "feelsLikeTemperature");
  const hum = g(data, "relativeHumidity");
  const windObj = g(data, "wind");

  const tempStr = fmtTemp(tempObj);
  const feelsStr = fmtTemp(feelsObj);
  const windStr = fmtWind(windObj);
  const tempC = parseTempC(tempObj);

  w.backgroundGradient = gradientFor(tempC, isDay);

  // Header: location + time
  const top = w.addStack();
  top.layoutHorizontally();
  top.centerAlignContent();

  const locTxt = top.addText(placeName || "Current location");
  locTxt.font = Font.mediumSystemFont(13);
  locTxt.textColor = Color.white();
  locTxt.lineLimit = 1;

  top.addSpacer();

  const now = new Date();
  const timeTxt = top.addText(
    now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  );
  timeTxt.font = Font.regularSystemFont(11);
  timeTxt.textColor = new Color("#eaeaea");

  w.addSpacer(6);

  // Main row: icon + temp
  const mid = w.addStack();
  mid.centerAlignContent();

  const symName = pickSymbol(weatherCond, isDay);
  const sf = SFSymbol.named(symName);
  const icon = mid.addImage(sf.image);
  icon.imageSize = new Size(34, 34);
  icon.tintColor = Color.white();

  mid.addSpacer(10);

  const tempT = mid.addText(tempStr);
  tempT.font = Font.systemFont(40);
  tempT.textColor = Color.white();

  w.addSpacer(2);

  const cond = w.addText(condStr);
  cond.font = Font.mediumSystemFont(14);
  cond.textColor = new Color("#f5f5f7");
  cond.lineLimit = 1;

  w.addSpacer(6);

  // Details row
  const row = w.addStack();
  row.layoutHorizontally();

  function kv(label, value) {
    const col = row.addStack();
    col.layoutVertically();
    const l = col.addText(label);
    l.font = Font.systemFont(10);
    l.textColor = new Color("#dddddd");
    const v = col.addText(String(value));
    v.font = Font.mediumSystemFont(12);
    v.textColor = Color.white();
    return col;
  }

  kv("Feels", feelsStr);
  row.addSpacer();
  kv("Hum", hum != null ? `${hum}%` : "—");
  row.addSpacer();
  kv("Wind", windStr);

  w.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60 * 1000);
  return w;
}

// ---- MAIN ----
let apiKey, loc, data;
try {
  apiKey = await getApiKey();
  loc = await getLocation();

  // Try cache
  data = readCache();

  // Try fresh network
  // SAFEGUARD: cache is only updated if this succeeds.
  try {
    const fresh = await fetchWeather(apiKey, loc.latitude, loc.longitude);
    // If fetch succeeds, overwrite in-memory data AND cache.
    data = fresh;
    writeCache(fresh);
  } catch (netErr) {
    // Network/timeout/HTTP error: keep using existing cache (if any).
    if (!data) {
      // No cache to fall back to – propagate error so user sees error widget.
      throw netErr;
    }
    // If there *is* cache, we silently continue with cached `data`.
  }

  const placeName = loc.name
    ? `${loc.name}`
    : `Lat ${loc.latitude.toFixed(2)}, Lon ${loc.longitude.toFixed(2)}`;

  const widget = await buildWidget(data, placeName);

  if (!config.runsInWidget) {
    await widget.presentMedium();
  } else {
    Script.setWidget(widget);
  }
  Script.complete();

} catch (err) {
  // Fallback error widget
  const w = new ListWidget();
  w.setPadding(16, 16, 16, 16);
  const t = w.addText("Weather error");
  t.font = Font.boldSystemFont(16);
  t.textColor = Color.red();
  w.addSpacer(6);
  const m = w.addText(String(err));
  m.font = Font.systemFont(12);
  m.textColor = Color.white();
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  if (!config.runsInWidget) await w.presentSmall();
  else Script.setWidget(w);
  Script.complete();
}
