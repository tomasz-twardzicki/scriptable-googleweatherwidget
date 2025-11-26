// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: cyan; icon-glyph: sun;
/**
 * Google Weather API — Forecast Widget (Scriptable)
 *
 * Endpoint:
 *   https://weather.googleapis.com/v1/forecast/days:lookup
 *
 * Layout:
 *   - Header: location | Updated HH:MM
 *   - Today overview:
 *       icon + big current temp (today's max)
 *   - Detail row:
 *       Feels (max/min), Humidity (daytime), Wind (daytime)
 *   - Daily mini-row (today + next 5), in ONE HORIZONTAL ROW:
 *       [icon] [weekday + compact max/min] ···
 *
 * - Uses Keychain-stored API key (GOOGLE_WEATHER_API_KEY).
 * - Uses current GPS location or fixed coords.
 * - Cache updated ONLY after successful response.
 */

//////////////////////// CONFIG ////////////////////////
const USE_CURRENT_LOCATION = true;     // true = GPS; false = FIXED_LAT/LON
const FIXED_LAT = 50.0647;            // Kraków example
const FIXED_LON = 19.9450;
const LANGUAGE = "pl";                // "pl", "en", ...
const UNITS_SYSTEM = "METRIC";        // "METRIC" or "IMPERIAL"
const DAYS = 6;                       // today + next 5
const KEYCHAIN_KEY = "GOOGLE_WEATHER_API_KEY";
const CACHE_MIN = 20;                 // forecast cache lifetime (minutes)
const REFRESH_MIN = 30;               // suggested widget refresh interval
////////////////////////////////////////////////////////

const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), "google_weather_forecast_cache.json");

// ---- API key handling ----
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

// ---- API call: forecast/days:lookup ----
async function fetchForecast(key, lat, lon) {
  const params = [
    `key=${encodeURIComponent(key)}`,
    `location.latitude=${encodeURIComponent(lat)}`,
    `location.longitude=${encodeURIComponent(lon)}`,
    `days=${encodeURIComponent(DAYS)}`,
    `languageCode=${encodeURIComponent(LANGUAGE)}`,
    `unitsSystem=${encodeURIComponent(UNITS_SYSTEM)}`
  ].join("&");

  const url = `https://weather.googleapis.com/v1/forecast/days:lookup?${params}`;
  const req = new Request(url);
  req.timeoutInterval = 12;
  req.headers = { "Accept": "application/json" };

  const json = await req.loadJSON();
  if (req.response && req.response.statusCode && req.response.statusCode >= 400) {
    throw new Error(`HTTP ${req.response.statusCode}`);
  }
  return json;  // { forecastDays: [...], timeZone: {...}, nextPageToken? }
}

// ---- Condition text/type normalisation ----
function normalizeConditionText(weatherCondition) {
  if (!weatherCondition) return null;

  if (typeof weatherCondition === "string") {
    return weatherCondition;
  }

  const desc = weatherCondition.description;
  if (typeof desc === "string") return desc;
  if (desc && typeof desc.text === "string") return desc.text;

  if (typeof weatherCondition.type === "string") return weatherCondition.type;

  return null;
}

function getConditionType(weatherCondition) {
  if (!weatherCondition) return "";
  let type = weatherCondition.type;
  if (!type) return "";
  return String(type).toUpperCase();
}

// ---- Temperature helpers ----
function fmtTemp(tempObj) {
  const val = g(tempObj, "degrees");
  const unit = g(tempObj, "unit");
  if (val == null) return "—";
  const sym = unit === "FAHRENHEIT" ? "°F" : "°C";
  return `${Math.round(val)}${sym}`;
}

// Compact temp for daily row: no unit (but keep °)
function fmtTempCompact(tempObj) {
  const val = g(tempObj, "degrees");
  if (val == null) return "—";
  return `${Math.round(val)}°`;
}

function parseTempC(tempObj) {
  const val = g(tempObj, "degrees");
  const unit = g(tempObj, "unit");
  if (val == null) return null;
  if (unit === "FAHRENHEIT") return Math.round((val - 32) * 5/9);
  return Math.round(val);
}

// ---- Wind helpers ----
function fmtWind(windObj) {
  const spdVal = g(windObj, "speed.value");
  const spdUnit = g(windObj, "speed.unit");
  let sym = "";
  if (spdUnit === "MILE_PER_HOUR") sym = "mph";
  else if (spdUnit === "METER_PER_SECOND") sym = "m/s";
  else sym = "km/h";

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

// ---- Condition → SF Symbol (based on type) ----
function pickSymbol(weatherCondition, isDaytime) {
  const type = getConditionType(weatherCondition);
  const t = type.toUpperCase();
  const day = !!isDaytime;

  // Use documented types: CLOUDY, MOSTLY_CLOUDY, PARTLY_CLOUDY, SNOW_SHOWERS, RAIN_AND_SNOW, etc.
  if (t.includes("THUNDER") || t.includes("STORM")) return "cloud.bolt.rain.fill";
  if (t.includes("SNOW")) return "cloud.snow.fill";
  if (t.includes("RAIN")) return "cloud.rain.fill";
  if (t.includes("SHOWERS")) return "cloud.rain.fill";
  if (t.includes("FOG")) return "cloud.fog.fill";
  if (t.includes("HAZE") || t.includes("MIST")) return "cloud.fog.fill";
  if (t.includes("OVERCAST")) return "smoke.fill";
  if (t.includes("MOSTLY_CLOUDY") || t.includes("CLOUDY")) return day ? "cloud.sun.fill" : "cloud.moon.fill";
  if (t.includes("PARTLY_CLOUDY")) return day ? "cloud.sun.fill" : "cloud.moon.fill";
  if (t.includes("CLEAR") || t.includes("SUNNY")) return day ? "sun.max.fill" : "moon.stars.fill";

  // Fallback: try description string (for unknown types)
  const desc = (normalizeConditionText(weatherCondition) || "").toLowerCase();
  if (desc.includes("storm") || desc.includes("thunder")) return "cloud.bolt.rain.fill";
  if (desc.includes("snow")) return "cloud.snow.fill";
  if (desc.includes("rain")) return "cloud.rain.fill";
  if (desc.includes("fog") || desc.includes("mist") || desc.includes("haze")) return "cloud.fog.fill";
  if (desc.includes("cloud")) return day ? "cloud.sun.fill" : "cloud.moon.fill";
  if (desc.includes("clear") || desc.includes("sunny")) return day ? "sun.max.fill" : "moon.stars.fill";

  return day ? "sun.max.fill" : "moon.stars.fill";
}

// ---- Gradient based on today's max temp ----
function gradientFor(tempC) {
  const cold = [new Color("#1e3c72"), new Color("#2a5298")];
  const mild = [new Color("#396afc"), new Color("#2948ff")];
  const hot  = [new Color("#ff512f"), new Color("#dd2476")];

  let colors = cold;
  if (tempC != null) {
    if (tempC >= 24) colors = hot;
    else if (tempC >= 10) colors = mild;
    else colors = cold;
  }

  const grad = new LinearGradient();
  grad.colors = colors;
  grad.locations = [0, 1];
  return grad;
}

// ---- Build the widget UI ----
async function buildWidget(forecast, placeName) {
  const w = new ListWidget();
  w.setPadding(10, 12, 10, 12);

  const daysArr = g(forecast, "forecastDays", []);
  if (!Array.isArray(daysArr) || daysArr.length === 0) {
    const t = w.addText("No forecast data");
    t.textColor = Color.red();
    t.font = Font.boldSystemFont(14);
    return w;
  }

  const today = daysArr[0];

  const maxTempObj = g(today, "maxTemperature");
  const minTempObj = g(today, "minTemperature");
  const feelsMaxObj = g(today, "feelsLikeMaxTemperature");
  const feelsMinObj = g(today, "feelsLikeMinTemperature");

  const dayPart = g(today, "daytimeForecast");
  const nightPart = g(today, "nighttimeForecast");

  const dayCond = g(dayPart, "weatherCondition");
  const nightCond = g(nightPart, "weatherCondition");

  const dayHum = g(dayPart, "relativeHumidity");
  const dayWindObj = g(dayPart, "wind");

  const maxTempC = parseTempC(maxTempObj);
  w.backgroundGradient = gradientFor(maxTempC);

  const currentTempStr = fmtTemp(maxTempObj);  // using today's max as "current"
  const feelsMaxStr = fmtTemp(feelsMaxObj);
  const feelsMinStr = fmtTemp(feelsMinObj);
  const windStr = fmtWind(dayWindObj);
  const humStr = dayHum != null ? `${dayHum}%` : "—";

  // HEADER: location | Updated HH:MM
  const header = w.addStack();
  header.layoutHorizontally();
  header.centerAlignContent();

  const locTxt = header.addText(placeName || "Location");
  locTxt.font = Font.mediumSystemFont(13);
  locTxt.textColor = Color.white();
  locTxt.lineLimit = 1;

  header.addSpacer();

  const now = new Date();
  const timeTxt = header.addText(
    now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  );
  timeTxt.font = Font.regularSystemFont(11);
  timeTxt.textColor = new Color("#e0e0e0");

  w.addSpacer(4);

  // TODAY OVERVIEW: icon + BIG TEMP
  const todayStack = w.addStack();
  todayStack.layoutHorizontally();
  todayStack.centerAlignContent();

  const todaySymbolName = pickSymbol(dayCond || nightCond, true);
  const todaySymbol = SFSymbol.named(todaySymbolName);
  const icon = todayStack.addImage(todaySymbol.image);
  icon.imageSize = new Size(30, 30);
  icon.tintColor = Color.white();

  todayStack.addSpacer(10);

  const tempTextCol = todayStack.addStack();
  tempTextCol.layoutVertically();

  const bigTemp = tempTextCol.addText(currentTempStr);
  bigTemp.font = Font.systemFont(32);
  bigTemp.textColor = Color.white();

  w.addSpacer(4);

  // DETAILS ROW: Feels, Hum, Wind
  const detailRow = w.addStack();
  detailRow.layoutHorizontally();

  function kv(label, value) {
    const col = detailRow.addStack();
    col.layoutVertically();
    const l = col.addText(label);
    l.font = Font.systemFont(9);
    l.textColor = new Color("#dddddd");
    const v = col.addText(String(value));
    v.font = Font.mediumSystemFont(11);
    v.textColor = Color.white();
    return col;
  }

  kv("Feels", `${feelsMaxStr}/${feelsMinStr}`);
  detailRow.addSpacer();
  kv("Hum", humStr);
  detailRow.addSpacer();
  kv("Wind", windStr);

  w.addSpacer(6);

  // DAILY MINI ROW: one horizontal row, each day as [icon][day+temps]
  const miniRow = w.addStack();
  miniRow.layoutHorizontally();
  miniRow.centerAlignContent();

  const maxDays = Math.min(DAYS, daysArr.length);

  for (let i = 0; i < maxDays; i++) {
    const d = daysArr[i];

    const dd = g(d, "displayDate");
    let weekday = "";
    if (dd && dd.year && dd.month && dd.day) {
      const dt = new Date(dd.year, dd.month - 1, dd.day);
      weekday = dt.toLocaleDateString([], { weekday: "short" });
    }
    if (!weekday) weekday = i === 0 ? "Today" : `+${i}`;

    const dMax = g(d, "maxTemperature");
    const dMin = g(d, "minTemperature");
    const dDayPart = g(d, "daytimeForecast");
    const dNightPart = g(d, "nighttimeForecast");
    const dCond = g(dDayPart, "weatherCondition") || g(dNightPart, "weatherCondition");

    const dSymName = pickSymbol(dCond, true);
    const dSym = SFSymbol.named(dSymName);

    const dayStack = miniRow.addStack();
    dayStack.layoutHorizontally();
    dayStack.centerAlignContent();

    const dayIcon = dayStack.addImage(dSym.image);
    dayIcon.imageSize = new Size(16, 16);
    dayIcon.tintColor = Color.white();

    dayStack.addSpacer(3);

    const textCol = dayStack.addStack();
    textCol.layoutVertically();

    const dayTxt = textCol.addText(weekday);
    dayTxt.font = i === 0 ? Font.boldSystemFont(10) : Font.mediumSystemFont(9);
    dayTxt.textColor = Color.white();
    dayTxt.lineLimit = 1;
    dayTxt.minimumScaleFactor = 0.7;

    const tempsTxt = textCol.addText(`${fmtTempCompact(dMax)} / ${fmtTempCompact(dMin)}`);
    tempsTxt.font = Font.systemFont(9);
    tempsTxt.textColor = new Color("#f5f5f7");
    tempsTxt.lineLimit = 1;
    tempsTxt.minimumScaleFactor = 0.7;

    if (i < maxDays - 1) {
      miniRow.addSpacer(6);
    }
  }

  w.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60 * 1000);
  return w;
}

// ---- MAIN ----
let apiKey, loc, data;
try {
  apiKey = await getApiKey();
  loc = await getLocation();

  // Try cache first
  data = readCache();

  // Try fresh; only update cache on success
  try {
    const fresh = await fetchForecast(apiKey, loc.latitude, loc.longitude);
    data = fresh;
    writeCache(fresh);
  } catch (netErr) {
    if (!data) throw netErr; // no cache, show error widget
    // else fall back silently to cached data
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
  const w = new ListWidget();
  w.setPadding(16, 16, 16, 16);
  const t = w.addText("Forecast error");
  t.font = Font.boldSystemFont(16);
  t.textColor = Color.red();
  w.addSpacer(6);
  const m = w.addText(String(err));
  m.font = Font.systemFont(12);
  m.textColor = Color.white();
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  if (!config.runsInWidget) await w.presentSmall();
  else Script.setWidget(w);
  Script.complete();
}
