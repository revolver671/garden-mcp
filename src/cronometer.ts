/**
 * Cronometer GWT Bridge — Cloud Garden
 * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 *
 * Fresh login per call. No stale sessions. All 5 exports.
 * When GWT values rotate: update TWO constants, redeploy. 30-second fix.
 *
 * CONTEXT-SAFE DESIGN (v2):
 *   - nutrition_daily defaults to macro summary (compact)
 *   - nutrition_biometrics returns structured summary with trends
 *   - All tools designed to fit comfortably in conversation context
 *   - Full detail available via parameters when needed
 *
 * Export types:
 *   dailySummary  — daily macro/micro totals
 *   servings      — individual food items with full nutrient breakdown
 *   exercises     — logged exercises with calories burned
 *   biometrics    — weight, body fat, blood pressure, etc.
 *   notes         — daily diary notes
 *
 * Flow:
 *   1. GET /login/ → extract anti-CSRF token from HTML
 *   2. POST /login with username/password/CSRF → session cookies + sesnonce
 *   3. POST GWT authenticate → user ID
 *   4. POST GWT generateAuthorizationToken → single-use export token
 *   5. GET /export?nonce=TOKEN&generate=TYPE&start=DATE&end=DATE → CSV
 *   6. Regenerate token between exports (tokens are single-use!)
 */

// ============================================================================
// GWT CONSTANTS — Update these when Cronometer deploys (check Chrome DevTools)
// ============================================================================

const GWT_PERMUTATION = "A71D2DB90F47AAC7C1B480FF9CB24BB9";
const GWT_HEADER = "F074E4C7D41D83A4BC27CA0816B7B731";
const GWT_CONTENT_TYPE = "text/x-gwt-rpc; charset=UTF-8";
const GWT_MODULE_BASE = "https://cronometer.com/cronometer/";

// GWT RPC templates
const GWT_AUTHENTICATE =
  `7|0|5|https://cronometer.com/cronometer/|${GWT_HEADER}` +
  `|com.cronometer.shared.rpc.CronometerService|authenticate|java.lang.Integer/3438268394|1|2|3|4|1|5|5|-300|`;

function gwtGenerateToken(nonce: string, userId: string): string {
  return (
    `7|0|8|https://cronometer.com/cronometer/|${GWT_HEADER}` +
    `|com.cronometer.shared.rpc.CronometerService|generateAuthorizationToken` +
    `|java.lang.String/2004016611|I|com.cronometer.shared.user.AuthScope/2065601159` +
    `|${nonce}|1|2|3|4|4|5|6|6|7|8|${userId}|3600|7|2|`
  );
}

// ============================================================================
// URLs
// ============================================================================

const LOGIN_PAGE_URL = "https://cronometer.com/login/";
const LOGIN_POST_URL = "https://cronometer.com/login";
const GWT_APP_URL = "https://cronometer.com/cronometer/app";
const EXPORT_URL = "https://cronometer.com/export";

// ============================================================================
// Types
// ============================================================================

export type CronometerExportType =
  | "dailySummary"
  | "servings"
  | "exercises"
  | "biometrics"
  | "notes";

interface CronometerSession {
  cookies: Record<string, string>;
  nonce: string;
  userId: string;
  authToken: string;
}

export interface NutritionDay {
  date: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  sugar_g: number;
  sodium_mg: number;
  cholesterol_mg: number;
  saturated_fat_g: number;
  [key: string]: string | number; // additional micronutrients
}

export interface Serving {
  date: string;
  group: string;
  food_name: string;
  amount: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  [key: string]: string | number;
}

export interface Exercise {
  date: string;
  exercise: string;
  minutes: number;
  calories_burned: number;
}

export interface Biometric {
  date: string;
  metric: string;
  value: number;
  unit: string;
}

export interface DailyNote {
  date: string;
  note: string;
}

// ============================================================================
// Cookie helpers (Cloudflare Workers don't have a cookie jar)
// ============================================================================

function parseCookies(setCookieHeaders: string[]): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const header of setCookieHeaders) {
    const match = header.match(/^([^=]+)=([^;]*)/);
    if (match) {
      cookies[match[1].trim()] = match[2].trim();
    }
  }
  return cookies;
}

function cookieString(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function mergeCookies(
  existing: Record<string, string>,
  response: Response
): Record<string, string> {
  const setCookies = response.headers.getAll
    ? response.headers.getAll("set-cookie")
    : [response.headers.get("set-cookie") || ""].filter(Boolean);
  const newCookies = parseCookies(setCookies);
  return { ...existing, ...newCookies };
}

// ============================================================================
// CSV Parsing
// ============================================================================

function parseCSV(csvText: string): Record<string, string>[] {
  const lines = csvText.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const records: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length === 0) continue;
    const record: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      record[headers[j]] = values[j] ?? "";
    }
    records.push(record);
  }

  return records;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function safeFloat(val: string | undefined, fallback = 0): number {
  if (!val || val === "") return fallback;
  const n = parseFloat(val);
  return isNaN(n) ? fallback : n;
}

// ============================================================================
// Login & Authentication
// ============================================================================

async function login(username: string, password: string): Promise<CronometerSession> {
  let cookies: Record<string, string> = {};

  // Step 1: Get anti-CSRF token from login page
  const pageRes = await fetch(LOGIN_PAGE_URL, { redirect: "follow" });
  cookies = mergeCookies(cookies, pageRes);
  const html = await pageRes.text();

  const csrfMatch = html.match(/name="anticsrf"\s+value="([^"]+)"/);
  if (!csrfMatch) {
    throw new Error("Could not find anti-CSRF token on login page");
  }
  const anticsrf = csrfMatch[1];

  // Step 2: POST login
  const loginBody = new URLSearchParams({
    anticsrf,
    username,
    password,
  });

  const loginRes = await fetch(LOGIN_POST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieString(cookies),
    },
    body: loginBody.toString(),
    redirect: "manual",
  });

  cookies = mergeCookies(cookies, loginRes);

  // Check for login success — Cronometer returns JSON with redirect or error
  const loginText = await loginRes.text();
  let loginResult: Record<string, string>;
  try {
    loginResult = JSON.parse(loginText);
  } catch {
    throw new Error(`Login returned non-JSON: ${loginText.slice(0, 200)}`);
  }

  if (loginResult.error) {
    throw new Error(`Login failed: ${loginResult.error}`);
  }

  const nonce = cookies["sesnonce"];
  if (!nonce) {
    throw new Error("No sesnonce cookie after login");
  }

  // Step 3: GWT Authenticate → get user ID
  const gwtAuthRes = await fetch(GWT_APP_URL, {
    method: "POST",
    headers: {
      "Content-Type": GWT_CONTENT_TYPE,
      "X-GWT-Module-Base": GWT_MODULE_BASE,
      "X-GWT-Permutation": GWT_PERMUTATION,
      Cookie: cookieString(cookies),
    },
    body: GWT_AUTHENTICATE,
  });

  cookies = mergeCookies(cookies, gwtAuthRes);
  const gwtAuthText = await gwtAuthRes.text();

  const userIdMatch = gwtAuthText.match(/\/\/OK\[(\d+)/);
  if (!userIdMatch) {
    throw new Error(`GWT authenticate failed: ${gwtAuthText.slice(0, 200)}`);
  }
  const userId = userIdMatch[1];

  // Update nonce (GWT refreshes it)
  const updatedNonce = cookies["sesnonce"] || nonce;

  // Step 4: Generate auth token for exports
  const authToken = await generateAuthToken(cookies, updatedNonce, userId);

  return {
    cookies,
    nonce: updatedNonce,
    userId,
    authToken,
  };
}

async function generateAuthToken(
  cookies: Record<string, string>,
  nonce: string,
  userId: string
): Promise<string> {
  const gwtBody = gwtGenerateToken(nonce, userId);

  const tokenRes = await fetch(GWT_APP_URL, {
    method: "POST",
    headers: {
      "Content-Type": GWT_CONTENT_TYPE,
      "X-GWT-Module-Base": GWT_MODULE_BASE,
      "X-GWT-Permutation": GWT_PERMUTATION,
      Cookie: cookieString(cookies),
    },
    body: gwtBody,
  });

  // Update cookies (nonce may rotate again)
  const newCookies = mergeCookies(cookies, tokenRes);
  Object.assign(cookies, newCookies);

  const tokenText = await tokenRes.text();
  const tokenMatch = tokenText.match(/\/\/OK\[.*?\["([^"]+)"\]/);
  if (!tokenMatch) {
    throw new Error(`GWT generateAuthorizationToken failed: ${tokenText.slice(0, 200)}`);
  }

  return tokenMatch[1];
}

// ============================================================================
// Export fetching
// ============================================================================

async function fetchExport(
  session: CronometerSession,
  exportType: CronometerExportType,
  startDate: string,
  endDate: string
): Promise<string> {
  const url = new URL(EXPORT_URL);
  url.searchParams.set("nonce", session.authToken);
  url.searchParams.set("generate", exportType);
  url.searchParams.set("start", startDate);
  url.searchParams.set("end", endDate);

  const res = await fetch(url.toString(), {
    headers: {
      Cookie: cookieString(session.cookies),
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Export ${exportType} failed (${res.status}): ${errText.slice(0, 200)}`);
  }

  const csv = await res.text();

  // Regenerate auth token for next export (single-use!)
  try {
    session.authToken = await generateAuthToken(
      session.cookies,
      session.nonce,
      session.userId
    );
  } catch (e) {
    // Non-fatal — log but don't fail the current export
    console.warn(`Token regeneration warning: ${e}`);
  }

  return csv;
}

// ============================================================================
// Parsed export functions
// ============================================================================

function parseDailySummary(csv: string): NutritionDay[] {
  const records = parseCSV(csv);
  return records.map((r) => {
    const day: NutritionDay = {
      date: r["Date"] || "",
      calories: safeFloat(r["Energy (kcal)"]),
      protein_g: safeFloat(r["Protein (g)"]),
      carbs_g: safeFloat(r["Carbs (g)"]),
      fat_g: safeFloat(r["Fat (g)"]),
      fiber_g: safeFloat(r["Fiber (g)"]),
      sugar_g: safeFloat(r["Sugars (g)"]),
      sodium_mg: safeFloat(r["Sodium (mg)"]),
      cholesterol_mg: safeFloat(r["Cholesterol (mg)"]),
      saturated_fat_g: safeFloat(r["Saturated (g)"]),
    };

    // Include ALL columns — every micronutrient Cronometer tracks
    for (const [key, val] of Object.entries(r)) {
      if (key === "Date") continue;
      const cleanKey = key
        .replace(/\s*\(.*?\)\s*/g, (match) => match.trim()) // keep units
        .trim();
      if (!(cleanKey in day) && val !== "") {
        day[key] = safeFloat(val as string);
      }
    }

    return day;
  });
}

function parseServings(csv: string): Serving[] {
  const records = parseCSV(csv);
  return records.map((r) => {
    const serving: Serving = {
      date: r["Day"] || r["Date"] || "",
      group: r["Group"] || r["Food Group"] || "",
      food_name: r["Food Name"] || r["Name"] || "",
      amount: r["Amount"] || r["Serving Size"] || "",
      calories: safeFloat(r["Energy (kcal)"]),
      protein_g: safeFloat(r["Protein (g)"]),
      carbs_g: safeFloat(r["Carbs (g)"]),
      fat_g: safeFloat(r["Fat (g)"]),
    };

    // Include all nutrient columns
    for (const [key, val] of Object.entries(r)) {
      if (["Day", "Date", "Group", "Food Group", "Food Name", "Name", "Amount", "Serving Size"].includes(key)) continue;
      if (!(key in serving) && val !== "") {
        serving[key] = safeFloat(val as string);
      }
    }

    return serving;
  });
}

function parseExercises(csv: string): Exercise[] {
  const records = parseCSV(csv);
  return records.map((r) => ({
    date: r["Day"] || r["Date"] || "",
    exercise: r["Exercise"] || r["Name"] || r["Activity"] || "",
    minutes: safeFloat(r["Minutes"] || r["Duration"]),
    calories_burned: safeFloat(r["Calories Burned"] || r["Energy (kcal)"]),
  }));
}

function parseBiometrics(csv: string): Biometric[] {
  const records = parseCSV(csv);
  const biometrics: Biometric[] = [];

  for (const r of records) {
    const date = r["Day"] || r["Date"] || "";
    if (!date) continue;

    // Cronometer biometrics CSV is LONG format:
    // Columns: Day, Group, Metric, Unit, Amount, Time
    // Each row is one metric on one day
    if (r["Metric"] && r["Amount"] !== undefined) {
      const val = safeFloat(r["Amount"]);
      // Skip zero/empty values
      if (val === 0 && r["Amount"] === "") continue;
      biometrics.push({
        date,
        metric: r["Metric"],
        value: val,
        unit: r["Unit"] || "",
      });
    } else {
      // Fallback: WIDE format (one row per day, columns = metrics)
      // Keep this as safety net in case Cronometer changes format
      for (const [key, val] of Object.entries(r)) {
        if (key === "Day" || key === "Date" || !val || val === "") continue;
        const unitMatch = key.match(/\(([^)]+)\)/);
        const unit = unitMatch ? unitMatch[1] : "";
        const metric = key.replace(/\s*\([^)]*\)\s*/, "").trim();
        biometrics.push({
          date,
          metric,
          value: safeFloat(val),
          unit,
        });
      }
    }
  }

  return biometrics;
}

function parseNotes(csv: string): DailyNote[] {
  const records = parseCSV(csv);
  return records.map((r) => ({
    date: r["Day"] || r["Date"] || "",
    note: r["Note"] || r["Notes"] || r["Content"] || "",
  }));
}

// ============================================================================
// Date helpers
// ============================================================================

function defaultDates(
  startDate?: string,
  endDate?: string,
  defaultDaysBack = 1
): { start: string; end: string } {
  const now = new Date();
  const end = endDate || now.toISOString().split("T")[0];
  const start =
    startDate ||
    new Date(now.getTime() - defaultDaysBack * 86400000)
      .toISOString()
      .split("T")[0];
  return { start, end };
}

// ============================================================================
// Public API — called by MCP tools
// ============================================================================

// --- DAILY NUTRITION (context-safe: macros by default, full on request) ---

export async function getDailyNutrition(
  username: string,
  password: string,
  startDate?: string,
  endDate?: string,
  detail: "macros" | "full" = "macros"
): Promise<string> {
  const { start, end } = defaultDates(startDate, endDate, 1);
  const session = await login(username, password);
  const csv = await fetchExport(session, "dailySummary", start, end);
  const data = parseDailySummary(csv);

  if (data.length === 0) {
    return `No nutrition data found for ${start} to ${end}`;
  }

  const lines = [`📊 Daily Nutrition: ${start} → ${end}`, `Data timestamp: ${new Date().toISOString()}`, ""];

  for (const day of data) {
    lines.push(`## ${day.date}`);
    lines.push(`Calories: ${Math.round(day.calories)} kcal`);
    lines.push(`Protein: ${Math.round(day.protein_g)}g | Carbs: ${Math.round(day.carbs_g)}g | Fat: ${Math.round(day.fat_g)}g`);
    lines.push(`Fiber: ${Math.round(day.fiber_g)}g | Sugar: ${Math.round(day.sugar_g)}g`);
    lines.push(`Sodium: ${Math.round(day.sodium_mg)}mg | Cholesterol: ${Math.round(day.cholesterol_mg)}mg | Sat Fat: ${day.saturated_fat_g.toFixed(1)}g`);

    if (detail === "full") {
      // Include ALL micronutrients — only when explicitly requested
      const extras: string[] = [];
      for (const [key, val] of Object.entries(day)) {
        if (
          typeof val === "number" &&
          val > 0 &&
          !["calories", "protein_g", "carbs_g", "fat_g", "fiber_g", "sugar_g", "sodium_mg", "cholesterol_mg", "saturated_fat_g"].includes(key) &&
          key !== "date"
        ) {
          extras.push(`${key}: ${typeof val === "number" ? (val % 1 === 0 ? val : val.toFixed(1)) : val}`);
        }
      }
      if (extras.length > 0) {
        lines.push(`\nMicronutrients: ${extras.join(" | ")}`);
      }
    }
    lines.push("");
  }

  if (detail === "macros" && data.length > 0) {
    lines.push(`_Showing macro summary. Use detail: "full" for all micronutrients._`);
  }

  return lines.join("\n");
}

// --- SERVINGS (context-safe: macros per food by default, full on request) ---

export async function getServings(
  username: string,
  password: string,
  startDate?: string,
  endDate?: string,
  detail: "macros" | "full" = "macros"
): Promise<string> {
  const { start, end } = defaultDates(startDate, endDate, 1);
  const session = await login(username, password);
  const csv = await fetchExport(session, "servings", start, end);
  const data = parseServings(csv);

  if (data.length === 0) {
    return `No servings data found for ${start} to ${end}`;
  }

  const lines = [`🍽️ Food Servings: ${start} → ${end}`, `Data timestamp: ${new Date().toISOString()}`, ""];

  // Group by date
  const byDate = new Map<string, Serving[]>();
  for (const s of data) {
    const existing = byDate.get(s.date) || [];
    existing.push(s);
    byDate.set(s.date, existing);
  }

  for (const [date, servings] of byDate) {
    lines.push(`## ${date}`);
    for (const s of servings) {
      lines.push(`- **${s.food_name}** (${s.amount}) — ${Math.round(s.calories)} kcal | P: ${Math.round(s.protein_g)}g C: ${Math.round(s.carbs_g)}g F: ${Math.round(s.fat_g)}g`);

      if (detail === "full") {
        // Show all micronutrients per food item
        const extras: string[] = [];
        for (const [key, val] of Object.entries(s)) {
          if (
            typeof val === "number" &&
            val > 0 &&
            !["calories", "protein_g", "carbs_g", "fat_g"].includes(key) &&
            !["date", "group", "food_name", "amount"].includes(key)
          ) {
            extras.push(`${key}: ${val % 1 === 0 ? val : val.toFixed(1)}`);
          }
        }
        if (extras.length > 0) {
          lines.push(`  Micros: ${extras.join(" | ")}`);
        }
      }
    }
    const totalCal = servings.reduce((sum, s) => sum + s.calories, 0);
    const totalP = servings.reduce((sum, s) => sum + s.protein_g, 0);
    const totalC = servings.reduce((sum, s) => sum + s.carbs_g, 0);
    const totalF = servings.reduce((sum, s) => sum + s.fat_g, 0);
    lines.push(`  *Total: ${Math.round(totalCal)} kcal | P: ${Math.round(totalP)}g C: ${Math.round(totalC)}g F: ${Math.round(totalF)}g*`);
    lines.push("");
  }

  return lines.join("\n");
}

// --- EXERCISES (unchanged — small data) ---

export async function getExercises(
  username: string,
  password: string,
  startDate?: string,
  endDate?: string
): Promise<string> {
  const { start, end } = defaultDates(startDate, endDate, 7);
  const session = await login(username, password);
  const csv = await fetchExport(session, "exercises", start, end);
  const data = parseExercises(csv);

  if (data.length === 0) {
    return `No exercise data found for ${start} to ${end}`;
  }

  const lines = [`🏋️ Exercises: ${start} → ${end}`, `Data timestamp: ${new Date().toISOString()}`, ""];

  for (const ex of data) {
    lines.push(`- ${ex.date}: **${ex.exercise}** — ${ex.minutes} min, ${Math.round(ex.calories_burned)} kcal burned`);
  }

  return lines.join("\n");
}

// --- BIOMETRICS (context-safe: structured summary with trends) ---

export async function getBiometrics(
  username: string,
  password: string,
  startDate?: string,
  endDate?: string,
  metric?: string
): Promise<string> {
  const { start, end } = defaultDates(startDate, endDate, 30);
  const session = await login(username, password);
  const csv = await fetchExport(session, "biometrics", start, end);
  const data = parseBiometrics(csv);

  if (data.length === 0) {
    return `No biometric data found for ${start} to ${end}`;
  }

  // If a specific metric is requested, return just that time series
  if (metric) {
    return formatSingleMetricSeries(data, metric, start, end);
  }

  // Default: structured summary — compact, safe for context window
  return formatBiometricsSummary(data, start, end);
}

function formatBiometricsSummary(data: Biometric[], start: string, end: string): string {
  const lines = [`📏 Biometrics Summary: ${start} → ${end}`, `Data timestamp: ${new Date().toISOString()}`, ""];

  // Group by metric name
  const byMetric = new Map<string, Biometric[]>();
  for (const b of data) {
    const existing = byMetric.get(b.metric) || [];
    existing.push(b);
    byMetric.set(b.metric, existing);
  }

  for (const [metricName, readings] of byMetric) {
    // Sort by date
    readings.sort((a, b) => a.date.localeCompare(b.date));

    const values = readings.map((r) => r.value);
    const latest = readings[readings.length - 1];
    const earliest = readings[0];
    const unit = latest.unit ? ` ${latest.unit}` : "";

    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((s, v) => s + v, 0) / values.length;

    // Trend direction
    let trend = "→ stable";
    if (readings.length >= 2) {
      const diff = latest.value - earliest.value;
      const pctChange = (diff / earliest.value) * 100;
      if (Math.abs(pctChange) < 0.5) {
        trend = "→ stable";
      } else if (diff > 0) {
        trend = `↑ +${diff % 1 === 0 ? diff : diff.toFixed(1)}${unit} (+${pctChange.toFixed(1)}%)`;
      } else {
        trend = `↓ ${diff % 1 === 0 ? diff : diff.toFixed(1)}${unit} (${pctChange.toFixed(1)}%)`;
      }
    }

    lines.push(`**${metricName}**`);
    lines.push(`  Latest: ${latest.value % 1 === 0 ? latest.value : latest.value.toFixed(1)}${unit} (${latest.date})`);
    if (readings.length > 1) {
      lines.push(`  Range: ${min % 1 === 0 ? min : min.toFixed(1)} – ${max % 1 === 0 ? max : max.toFixed(1)}${unit} | Avg: ${avg.toFixed(1)}${unit} | ${readings.length} readings`);
      lines.push(`  Trend: ${trend}`);
    }
    lines.push("");
  }

  const metricNames = Array.from(byMetric.keys());
  lines.push(`_${metricNames.length} metrics tracked. Use metric parameter (e.g. metric: "Weight") for full time series of a specific metric._`);

  return lines.join("\n");
}

function formatSingleMetricSeries(data: Biometric[], metricFilter: string, start: string, end: string): string {
  // Case-insensitive partial match
  const filterLower = metricFilter.toLowerCase();
  const matching = data.filter((b) => b.metric.toLowerCase().includes(filterLower));

  if (matching.length === 0) {
    const available = [...new Set(data.map((b) => b.metric))];
    return `No biometric data matching "${metricFilter}". Available metrics: ${available.join(", ")}`;
  }

  // Group by exact metric name (in case partial match hits multiple)
  const byMetric = new Map<string, Biometric[]>();
  for (const b of matching) {
    const existing = byMetric.get(b.metric) || [];
    existing.push(b);
    byMetric.set(b.metric, existing);
  }

  const lines = [`📏 Biometrics: "${metricFilter}" — ${start} → ${end}`, `Data timestamp: ${new Date().toISOString()}`, ""];

  for (const [metricName, readings] of byMetric) {
    readings.sort((a, b) => a.date.localeCompare(b.date));
    const unit = readings[0].unit ? ` ${readings[0].unit}` : "";

    lines.push(`**${metricName}** (${readings.length} readings)`);
    for (const r of readings) {
      lines.push(`  ${r.date}: ${r.value % 1 === 0 ? r.value : r.value.toFixed(1)}${unit}`);
    }

    // Stats
    if (readings.length >= 2) {
      const values = readings.map((r) => r.value);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const avg = values.reduce((s, v) => s + v, 0) / values.length;
      const diff = readings[readings.length - 1].value - readings[0].value;
      lines.push(`  ---`);
      lines.push(`  Min: ${min.toFixed(1)} | Max: ${max.toFixed(1)} | Avg: ${avg.toFixed(1)} | Change: ${diff > 0 ? "+" : ""}${diff.toFixed(1)}${unit}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// --- NOTES (unchanged — small data) ---

export async function getNotes(
  username: string,
  password: string,
  startDate?: string,
  endDate?: string
): Promise<string> {
  const { start, end } = defaultDates(startDate, endDate, 7);
  const session = await login(username, password);
  const csv = await fetchExport(session, "notes", start, end);
  const data = parseNotes(csv);

  if (data.length === 0) {
    return `No notes found for ${start} to ${end}`;
  }

  const lines = [`📝 Notes: ${start} → ${end}`, `Data timestamp: ${new Date().toISOString()}`, ""];

  for (const n of data) {
    lines.push(`## ${n.date}`);
    lines.push(n.note);
    lines.push("");
  }

  return lines.join("\n");
}
