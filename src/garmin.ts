/**
 * Garmin Connect Integration — Cloud Garden
 * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 *
 * Uses the DI OAuth Bearer tokens from the browser auth flow.
 * Once tokens are captured, the Worker self-maintains via auto-refresh.
 *
 * API base: https://connectapi.garmin.com (DI OAuth tokens target this domain)
 * All endpoints return JSON with Bearer auth.
 *
 * Context-safe: All tools return compact summaries by default.
 */

import type { Env } from "./types";

// ============================================================================
// Constants
// ============================================================================

const GARMIN_API = "https://connectapi.garmin.com";

// ============================================================================
// Types
// ============================================================================

interface GarminTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

// ============================================================================
// Token Management (stored in R2)
// ============================================================================

const TOKEN_PATH = "system/garmin-tokens.json";

async function getTokens(env: Env): Promise<GarminTokens> {
  try {
    const obj = await env.GARDEN_BUCKET.get(`garden/${TOKEN_PATH}`);
    if (obj) {
      const text = await obj.text();
      return JSON.parse(text) as GarminTokens;
    }
  } catch { /* fall through */ }

  return {
    access_token: env.GARMIN_ACCESS_TOKEN,
    refresh_token: env.GARMIN_REFRESH_TOKEN,
    expires_at: 0,
  };
}

async function storeTokens(env: Env, tokens: GarminTokens): Promise<void> {
  await env.GARDEN_BUCKET.put(`garden/${TOKEN_PATH}`, JSON.stringify(tokens));
}

async function refreshTokens(env: Env, currentTokens: GarminTokens): Promise<GarminTokens> {
  const res = await fetch("https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${currentTokens.refresh_token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "com.garmin.android.apps.connectmobile",
    },
  });

  if (!res.ok) {
    throw new Error(`Garmin token refresh failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as any;
  const newTokens: GarminTokens = {
    access_token: data.access_token || currentTokens.access_token,
    refresh_token: data.refresh_token || currentTokens.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 72000) - 300,
  };
  await storeTokens(env, newTokens);
  return newTokens;
}

async function getValidAccessToken(env: Env): Promise<string> {
  let tokens = await getTokens(env);
  const now = Math.floor(Date.now() / 1000);
  if (now >= tokens.expires_at) {
    try { tokens = await refreshTokens(env, tokens); }
    catch (e) { console.error("Token refresh failed, trying existing:", e); }
  }
  return tokens.access_token;
}

/**
 * Extract the garmin_guid from the JWT access token.
 * The JWT payload contains: { "garmin_guid": "b8ceb665-..." }
 */
function extractGuidFromJwt(jwt: string): string | null {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    // Base64url decode the payload
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(payload);
    const parsed = JSON.parse(decoded);
    return parsed.garmin_guid || null;
  } catch {
    return null;
  }
}

// ============================================================================
// API Request Helper
// ============================================================================

async function garminRequest(env: Env, path: string): Promise<any> {
  const accessToken = await getValidAccessToken(env);

  const res = await fetch(`${GARMIN_API}${path}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "User-Agent": "GCM-iOS-5.7.2.1",
      "DI-Backend": "connectapi.garmin.com",
      "Accept": "application/json",
    },
  });

  if (res.status === 401) {
    const tokens = await getTokens(env);
    const newTokens = await refreshTokens(env, tokens);
    const retryRes = await fetch(`${GARMIN_API}${path}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${newTokens.access_token}`,
        "User-Agent": "GCM-iOS-5.7.2.1",
        "DI-Backend": "connectapi.garmin.com",
        "Accept": "application/json",
      },
    });
    if (!retryRes.ok) throw new Error(`Garmin API error after refresh: ${retryRes.status} ${await retryRes.text()}`);
    return retryRes.json();
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Garmin API error: ${res.status} ${text}`);
  }
  return res.json();
}

// ============================================================================
// Date & Format Helpers
// ============================================================================

function defaultDate(day?: string): string {
  return day || new Date().toISOString().split("T")[0];
}

function defaultDateRange(startDate?: string, endDate?: string, defaultDaysBack = 7): { startStr: string; endStr: string } {
  const now = new Date();
  const endStr = endDate || now.toISOString().split("T")[0];
  const startStr = startDate || new Date(now.getTime() - defaultDaysBack * 86400000).toISOString().split("T")[0];
  return { startStr, endStr };
}

function ts(): string { return new Date().toISOString(); }

function fmtDuration(seconds: number | null | undefined): string {
  if (!seconds) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtDistance(meters: number | null | undefined): string {
  if (!meters) return "—";
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

function fmtCalories(cal: number | null | undefined): string {
  if (!cal && cal !== 0) return "—";
  return `${Math.round(cal)} kcal`;
}

function safe(val: any): string {
  return val == null ? "—" : String(val);
}

function fmtTimestamp(val: any): string {
  if (!val) return "—";
  if (typeof val === "number") {
    // Could be seconds or milliseconds
    const ms = val > 1e12 ? val : val * 1000;
    return new Date(ms).toISOString().split("T")[0];
  }
  if (typeof val === "string" && val.includes("T")) return val.split("T")[0];
  return String(val);
}

// ============================================================================
// Public API — called by MCP tools
// ============================================================================

/**
 * Daily summary — uses GUID from JWT + calendarDate query param.
 * Format: /usersummary-service/usersummary/daily/<GUID>?calendarDate=YYYY-MM-DD
 */
export async function getDailySummary(env: Env, day?: string): Promise<string> {
  const date = defaultDate(day);
  try {
    const accessToken = await getValidAccessToken(env);
    const guid = extractGuidFromJwt(accessToken);

    let data: any;
    if (guid) {
      // Try with GUID in path and date as query param (documented format)
      data = await garminRequest(env, `/usersummary-service/usersummary/daily/${guid}?calendarDate=${date}`);
    } else {
      // Fallback: date in path
      data = await garminRequest(env, `/usersummary-service/usersummary/daily/${date}`);
    }

    if (!data || Object.keys(data).length === 0) return `No Garmin daily summary for ${date}`;

    const lines = [`📊 Garmin Daily Summary: ${date}`, `Data timestamp: ${ts()}`, ""];

    if (data.totalSteps != null) lines.push(`Steps: ${data.totalSteps.toLocaleString()} / ${data.dailyStepGoal?.toLocaleString() || "—"} goal`);
    if (data.totalDistanceMeters != null) lines.push(`Distance: ${fmtDistance(data.totalDistanceMeters)}`);
    if (data.floorsAscended != null) lines.push(`Floors: ${data.floorsAscended} up / ${data.floorsDescended || 0} down`);
    if (data.activeTimeInSeconds != null) lines.push(`Active time: ${fmtDuration(data.activeTimeInSeconds)}`);
    if (data.moderateIntensityMinutes != null || data.vigorousIntensityMinutes != null) {
      lines.push(`Intensity: ${data.moderateIntensityMinutes || 0}m moderate, ${data.vigorousIntensityMinutes || 0}m vigorous`);
    }

    lines.push("");
    if (data.totalKilocalories != null) lines.push(`Calories total: ${fmtCalories(data.totalKilocalories)}`);
    if (data.activeKilocalories != null) lines.push(`Calories active: ${fmtCalories(data.activeKilocalories)}`);
    if (data.bmrKilocalories != null) lines.push(`Calories BMR: ${fmtCalories(data.bmrKilocalories)}`);

    lines.push("");
    if (data.restingHeartRate != null) lines.push(`Resting HR: ${data.restingHeartRate} bpm`);
    if (data.minHeartRate != null) lines.push(`HR range: ${data.minHeartRate} – ${data.maxHeartRate} bpm (avg ${data.averageHeartRate || "—"})`);

    if (data.averageStressLevel != null) {
      lines.push("");
      lines.push(`Avg stress: ${data.averageStressLevel} / ${data.maxStressLevel || "—"} max`);
      if (data.stressDuration != null) lines.push(`Stress time: ${fmtDuration(data.stressDuration)} total`);
    }

    return lines.join("\n");
  } catch (e) {
    return `Garmin daily summary error: ${String(e)}`;
  }
}

export async function getSleep(env: Env, day?: string): Promise<string> {
  const date = defaultDate(day);
  try {
    const data = await garminRequest(env, `/wellness-service/wellness/dailySleepData/${date}`);
    if (!data || !data.dailySleepDTO) return `No Garmin sleep data for ${date}`;

    const sleep = data.dailySleepDTO;
    const lines = [`😴 Garmin Sleep: ${date}`, `Data timestamp: ${ts()}`, ""];

    if (sleep.sleepTimeSeconds != null) lines.push(`Total sleep: ${fmtDuration(sleep.sleepTimeSeconds)}`);
    if (sleep.sleepStartTimestampLocal) {
      const start = new Date(sleep.sleepStartTimestampLocal).toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit" });
      const end = new Date(sleep.sleepEndTimestampLocal).toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit" });
      lines.push(`Window: ${start} → ${end}`);
    }

    if (sleep.deepSleepSeconds != null) {
      lines.push("", "Sleep stages:");
      lines.push(`  Deep: ${fmtDuration(sleep.deepSleepSeconds)}`);
      lines.push(`  Light: ${fmtDuration(sleep.lightSleepSeconds)}`);
      lines.push(`  REM: ${fmtDuration(sleep.remSleepSeconds)}`);
      lines.push(`  Awake: ${fmtDuration(sleep.awakeSleepSeconds)}`);
    }

    if (sleep.sleepScores) {
      const s = sleep.sleepScores;
      lines.push("");
      if (s.overallScore != null) lines.push(`Sleep score: ${s.overallScore}`);
      if (s.qualityScore != null) lines.push(`Quality: ${s.qualityScore} | Duration: ${s.durationScore || "—"} | Recovery: ${s.recoveryScore || "—"}`);
    }

    if (sleep.averageRespiration != null) { lines.push(""); lines.push(`Avg respiration: ${sleep.averageRespiration} breaths/min`); }
    if (sleep.averageSpO2Value != null) lines.push(`Avg SpO2: ${sleep.averageSpO2Value}%`);
    if (sleep.lowestSpO2Value != null) lines.push(`Lowest SpO2: ${sleep.lowestSpO2Value}%`);
    if (sleep.averageSleepStress != null) lines.push(`Avg sleep stress: ${sleep.averageSleepStress.toFixed(1)}`);

    return lines.join("\n");
  } catch (e) {
    return `Garmin sleep error: ${String(e)}`;
  }
}

export async function getStress(env: Env, day?: string): Promise<string> {
  const date = defaultDate(day);
  try {
    const data = await garminRequest(env, `/wellness-service/wellness/dailyStress/${date}`);
    if (!data) return `No Garmin stress data for ${date}`;

    const lines = [`🧠 Garmin Stress: ${date}`, `Data timestamp: ${ts()}`, ""];
    if (data.overallStressLevel != null) lines.push(`Overall stress: ${data.overallStressLevel}`);
    if (data.restStressDuration != null) {
      lines.push(`Rest: ${fmtDuration(data.restStressDuration)}, Low: ${fmtDuration(data.lowStressDuration)}, Medium: ${fmtDuration(data.mediumStressDuration)}, High: ${fmtDuration(data.highStressDuration)}`);
    }
    if (data.bodyBatteryChargedValue != null) {
      lines.push("", `Body Battery: ${safe(data.bodyBatteryLowestValue)} → ${safe(data.bodyBatteryHighestValue)} (charged +${data.bodyBatteryChargedValue}, drained -${data.bodyBatteryDrainedValue || 0})`);
    }
    return lines.join("\n");
  } catch (e) {
    return `Garmin stress error: ${String(e)}`;
  }
}

export async function getBodyBattery(env: Env, startDate?: string, endDate?: string): Promise<string> {
  const { startStr, endStr } = defaultDateRange(startDate, endDate, 1);
  try {
    const data = await garminRequest(env, `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${startStr}&endDate=${endStr}`);
    if (!data || !Array.isArray(data) || data.length === 0) return `No Garmin Body Battery data for ${startStr} → ${endStr}`;
    const lines = [`🔋 Garmin Body Battery: ${startStr} → ${endStr}`, `Data timestamp: ${ts()}`, ""];
    for (const day of data) {
      lines.push(`${day.calendarDate || day.date || "?"}: ${safe(day.lowest)} → ${safe(day.highest)} (charged +${day.charged || 0}, drained -${day.drained || 0})`);
    }
    return lines.join("\n");
  } catch (e) { return `Garmin body battery error: ${String(e)}`; }
}

export async function getHeartRate(env: Env, day?: string): Promise<string> {
  const date = defaultDate(day);
  try {
    const data = await garminRequest(env, `/wellness-service/wellness/dailyHeartRate/${date}`);
    if (!data) return `No Garmin heart rate data for ${date}`;
    const lines = [`❤️ Garmin Heart Rate: ${date}`, `Data timestamp: ${ts()}`, ""];
    if (data.restingHeartRate != null) lines.push(`Resting HR: ${data.restingHeartRate} bpm`);
    if (data.minHeartRate != null) lines.push(`Min HR: ${data.minHeartRate} bpm`);
    if (data.maxHeartRate != null) lines.push(`Max HR: ${data.maxHeartRate} bpm`);
    if (data.lastSevenDaysAvgRestingHeartRate != null) lines.push(`7-day avg resting: ${data.lastSevenDaysAvgRestingHeartRate} bpm`);
    return lines.join("\n");
  } catch (e) { return `Garmin heart rate error: ${String(e)}`; }
}

export async function getHRV(env: Env, day?: string): Promise<string> {
  const date = defaultDate(day);
  try {
    const data = await garminRequest(env, `/hrv-service/hrv/${date}`);
    if (!data || !data.hrvSummary) return `No Garmin HRV data for ${date}`;
    const hrv = data.hrvSummary;
    const lines = [`📈 Garmin HRV: ${date}`, `Data timestamp: ${ts()}`, ""];
    if (hrv.weeklyAvg != null) lines.push(`Weekly avg: ${hrv.weeklyAvg} ms`);
    if (hrv.lastNight != null) lines.push(`Last night: ${hrv.lastNight} ms`);
    if (hrv.lastNightAvg != null) lines.push(`Last night avg: ${hrv.lastNightAvg} ms`);
    if (hrv.lastNight5MinHigh != null) lines.push(`Last night 5min high: ${hrv.lastNight5MinHigh} ms`);
    if (hrv.baseline) {
      const b = hrv.baseline;
      lines.push(`Baseline: ${safe(b.lowUpper)} – ${safe(b.balancedLow)} – ${safe(b.balancedUpper)} ms`);
    }
    if (hrv.status) lines.push(`Status: ${hrv.status}`);
    return lines.join("\n");
  } catch (e) { return `Garmin HRV error: ${String(e)}`; }
}

export async function getSpO2(env: Env, day?: string): Promise<string> {
  const date = defaultDate(day);
  try {
    const data = await garminRequest(env, `/wellness-service/wellness/dailySpo2/${date}`);
    if (!data) return `No Garmin SpO2 data for ${date}`;
    const lines = [`🫁 Garmin SpO2: ${date}`, `Data timestamp: ${ts()}`, ""];
    if (data.averageSpO2 != null) lines.push(`Average SpO2: ${data.averageSpO2}%`);
    if (data.lowestSpO2 != null) lines.push(`Lowest SpO2: ${data.lowestSpO2}%`);
    if (data.latestSpO2 != null) lines.push(`Latest SpO2: ${data.latestSpO2}%`);
    if (data.averageSleepSpO2 != null) { lines.push(""); lines.push(`Sleep avg SpO2: ${data.averageSleepSpO2}%`); }
    if (data.lowestSleepSpO2 != null) lines.push(`Sleep lowest SpO2: ${data.lowestSleepSpO2}%`);
    return lines.join("\n");
  } catch (e) { return `Garmin SpO2 error: ${String(e)}`; }
}

export async function getRespiration(env: Env, day?: string): Promise<string> {
  const date = defaultDate(day);
  try {
    const data = await garminRequest(env, `/wellness-service/wellness/dailyRespiration/${date}`);
    if (!data) return `No Garmin respiration data for ${date}`;
    const lines = [`🌬️ Garmin Respiration: ${date}`, `Data timestamp: ${ts()}`, ""];
    if (data.avgWakingRespirationValue != null) lines.push(`Avg waking: ${data.avgWakingRespirationValue.toFixed(1)} breaths/min`);
    if (data.avgSleepRespirationValue != null) lines.push(`Avg sleep: ${data.avgSleepRespirationValue.toFixed(1)} breaths/min`);
    if (data.highestRespirationValue != null) lines.push(`Highest: ${data.highestRespirationValue.toFixed(1)} breaths/min`);
    if (data.lowestRespirationValue != null) lines.push(`Lowest: ${data.lowestRespirationValue.toFixed(1)} breaths/min`);
    return lines.join("\n");
  } catch (e) { return `Garmin respiration error: ${String(e)}`; }
}

export async function getTrainingStatus(env: Env, day?: string): Promise<string> {
  const date = defaultDate(day);
  const lines = [`🏋️ Garmin Training Status: ${date}`, `Data timestamp: ${ts()}`, ""];

  try {
    const m = await garminRequest(env, `/metrics-service/metrics/maxmet/daily/${date}/${date}`);
    if (m && Array.isArray(m) && m.length > 0) {
      if (m[0].generic?.vo2MaxPreciseValue != null) lines.push(`VO2 Max: ${m[0].generic.vo2MaxPreciseValue.toFixed(1)} ml/kg/min`);
      if (m[0].generic?.fitnessAge != null) lines.push(`Fitness age: ${m[0].generic.fitnessAge}`);
    }
  } catch { lines.push("VO2 Max: unavailable"); }

  try {
    const r = await garminRequest(env, `/metrics-service/metrics/trainingreadiness/${date}`);
    if (r?.score != null) lines.push(`Training readiness: ${r.score} (${r.level || "—"})`);
  } catch { /* skip */ }

  try {
    const s = await garminRequest(env, `/metrics-service/metrics/trainingstatus/aggregated/${date}`);
    if (s?.trainingStatusPhrase) lines.push(`Training status: ${s.trainingStatusPhrase}`);
    if (s?.load?.totalLoad != null) lines.push(`Training load: ${Math.round(s.load.totalLoad)}`);
  } catch { /* skip */ }

  try {
    const e = await garminRequest(env, `/metrics-service/metrics/endurancescore/${date}`);
    if (e?.overallScore != null) lines.push(`Endurance score: ${e.overallScore}`);
  } catch { /* skip */ }

  return lines.join("\n");
}

export async function getActivities(env: Env, startDate?: string, endDate?: string, activityType?: string, limit = 10): Promise<string> {
  const { startStr, endStr } = defaultDateRange(startDate, endDate, 30);
  try {
    let path = `/activitylist-service/activities/search/activities?startDate=${startStr}&endDate=${endStr}&limit=${limit}&start=0`;
    if (activityType) path += `&activityType=${encodeURIComponent(activityType)}`;
    const data = await garminRequest(env, path);
    if (!data || !Array.isArray(data) || data.length === 0) return `No Garmin activities found for ${startStr} → ${endStr}`;

    const lines = [`🏃 Garmin Activities: ${startStr} → ${endStr}`, `Data timestamp: ${ts()}`, `Found: ${data.length} activities`, ""];
    for (const act of data) {
      const name = act.activityName || act.activityType?.typeKey || "Activity";
      const d = act.startTimeLocal ? act.startTimeLocal.split(" ")[0] : "unknown";
      let details = `${d}: **${name}** — ${fmtDuration(act.duration)}`;
      if (act.distance) details += `, ${fmtDistance(act.distance)}`;
      if (act.calories) details += `, ${Math.round(act.calories)} kcal`;
      if (act.averageHR) details += `, avg HR ${act.averageHR}`;
      if (act.maxHR) details += `, max HR ${act.maxHR}`;
      if (act.elevationGain) details += `, +${Math.round(act.elevationGain)}m elevation`;
      lines.push(details);
    }
    return lines.join("\n");
  } catch (e) { return `Garmin activities error: ${String(e)}`; }
}

export async function getDevices(env: Env): Promise<string> {
  try {
    const data = await garminRequest(env, `/device-service/deviceregistration/devices`);
    if (!data || !Array.isArray(data) || data.length === 0) return "No Garmin devices found";

    const lines = [`⌚ Garmin Devices`, `Data timestamp: ${ts()}`, ""];
    for (const d of data) {
      const name = d.displayName || d.deviceName || "Unknown device";
      const model = d.productDisplayName || d.partNumber || "";
      lines.push(`**${name}** ${model ? `(${model})` : ""}`);
      if (d.currentFirmwareVersion) lines.push(`  Firmware: ${d.currentFirmwareVersion}`);
      if (d.registeredDate) lines.push(`  Registered: ${fmtTimestamp(d.registeredDate)}`);
      if (d.lastSyncTime) lines.push(`  Last sync: ${fmtTimestamp(d.lastSyncTime)}`);
    }
    return lines.join("\n");
  } catch (e) { return `Garmin devices error: ${String(e)}`; }
}
