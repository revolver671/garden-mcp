/**
 * Withings API Integration — Cloud Garden
 * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 *
 * OAuth 2.0 with automatic token refresh.
 * Proper REST API — no GWT hackery needed.
 *
 * Endpoints used:
 *   /measure (action: getmeas)     — body composition (weight, fat, muscle, bone, hydration)
 *   /v2/user (action: getdevice)   — list connected devices
 *
 * Token refresh:
 *   Access tokens expire (~3 hours). When we get a 401 or detect expiry,
 *   we use the refresh token to get new tokens and store them in R2.
 *   This means the initial tokens from the setup script are a one-time thing.
 *
 * Data format:
 *   Withings returns measurements in scientific notation:
 *     { value: 8234, type: 1, unit: -2 } → 82.34 kg (weight)
 *   We parse this into human-readable values.
 */

import type { Env } from "./types";

// ============================================================================
// Constants
// ============================================================================

const API_BASE = "https://wbsapi.withings.net";
const TOKEN_URL = `${API_BASE}/v2/oauth2`;

// Measurement type codes → human names and units
const MEAS_TYPES: Record<number, { name: string; unit: string }> = {
  1: { name: "Weight", unit: "kg" },
  4: { name: "Height", unit: "m" },
  5: { name: "Fat Free Mass", unit: "kg" },
  6: { name: "Fat Ratio", unit: "%" },
  8: { name: "Fat Mass", unit: "kg" },
  9: { name: "Diastolic BP", unit: "mmHg" },
  10: { name: "Systolic BP", unit: "mmHg" },
  11: { name: "Heart Rate", unit: "bpm" },
  12: { name: "Temperature", unit: "°C" },
  54: { name: "SpO2", unit: "%" },
  71: { name: "Body Temperature", unit: "°C" },
  76: { name: "Muscle Mass", unit: "kg" },
  77: { name: "Hydration", unit: "kg" },
  88: { name: "Bone Mass", unit: "kg" },
  91: { name: "Pulse Wave Velocity", unit: "m/s" },
  123: { name: "VO2 Max", unit: "ml/min/kg" },
};

// ============================================================================
// Types
// ============================================================================

interface WithingsTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp
}

interface ParsedMeasurement {
  date: string;
  timestamp: number;
  metrics: Record<string, { value: number; unit: string }>;
}

// ============================================================================
// Token Management (stored in R2, encrypted)
// ============================================================================

const TOKEN_PATH = "system/withings-tokens.json";

async function getTokens(env: Env): Promise<WithingsTokens> {
  // Try to read stored tokens from R2
  try {
    const obj = await env.GARDEN_BUCKET.get(`garden/${TOKEN_PATH}`);
    if (obj) {
      const text = await obj.text();
      // Tokens are stored unencrypted in R2 for now (R2 access is already auth'd)
      // Could add encryption layer if desired
      const tokens = JSON.parse(text) as WithingsTokens;
      return tokens;
    }
  } catch {
    // Fall through to env secrets
  }

  // Fallback: use env secrets (initial setup, before first refresh)
  return {
    access_token: env.WITHINGS_ACCESS_TOKEN,
    refresh_token: env.WITHINGS_REFRESH_TOKEN,
    expires_at: 0, // Force refresh on first use
  };
}

async function storeTokens(env: Env, tokens: WithingsTokens): Promise<void> {
  await env.GARDEN_BUCKET.put(
    `garden/${TOKEN_PATH}`,
    JSON.stringify(tokens)
  );
}

async function refreshTokens(env: Env, currentRefreshToken: string): Promise<WithingsTokens> {
  const body = new URLSearchParams({
    action: "requesttoken",
    grant_type: "refresh_token",
    client_id: env.WITHINGS_CLIENT_ID,
    client_secret: env.WITHINGS_CLIENT_SECRET,
    refresh_token: currentRefreshToken,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const data = await res.json() as any;

  if (data.status !== 0) {
    throw new Error(`Withings token refresh failed: status ${data.status} — ${JSON.stringify(data)}`);
  }

  const newTokens: WithingsTokens = {
    access_token: data.body.access_token,
    refresh_token: data.body.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + data.body.expires_in - 300, // 5min buffer
  };

  // Store new tokens in R2
  await storeTokens(env, newTokens);

  return newTokens;
}

async function getValidAccessToken(env: Env): Promise<string> {
  let tokens = await getTokens(env);

  // Check if token is expired or about to expire
  const now = Math.floor(Date.now() / 1000);
  if (now >= tokens.expires_at) {
    tokens = await refreshTokens(env, tokens.refresh_token);
  }

  return tokens.access_token;
}

// ============================================================================
// API Calls
// ============================================================================

async function withingsRequest(
  env: Env,
  endpoint: string,
  params: Record<string, string>
): Promise<any> {
  const accessToken = await getValidAccessToken(env);

  const body = new URLSearchParams(params);

  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const data = await res.json() as any;

  // If token expired mid-flight, try one refresh
  if (data.status === 401) {
    const tokens = await getTokens(env);
    const newTokens = await refreshTokens(env, tokens.refresh_token);

    const retryBody = new URLSearchParams(params);
    const retryRes = await fetch(`${API_BASE}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${newTokens.access_token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: retryBody.toString(),
    });

    return (await retryRes.json()) as any;
  }

  return data;
}

// ============================================================================
// Measurement Parsing
// ============================================================================

function parseMeasurements(data: any): ParsedMeasurement[] {
  if (data.status !== 0 || !data.body?.measuregrps) {
    return [];
  }

  const grouped = new Map<number, ParsedMeasurement>();

  for (const grp of data.body.measuregrps) {
    // Category 1 = real measurements, 2 = user objectives
    if (grp.category !== 1) continue;

    const timestamp = grp.date;
    const dateStr = new Date(timestamp * 1000).toISOString().split("T")[0];

    // Group by date (multiple weigh-ins same day get merged — last one wins)
    let entry = grouped.get(timestamp);
    if (!entry) {
      entry = { date: dateStr, timestamp, metrics: {} };
      grouped.set(timestamp, entry);
    }

    for (const m of grp.measures) {
      const typeInfo = MEAS_TYPES[m.type];
      if (!typeInfo) continue;

      // Scientific notation: actual = value * 10^unit
      const actual = m.value * Math.pow(10, m.unit);

      entry.metrics[typeInfo.name] = {
        value: actual,
        unit: typeInfo.unit,
      };
    }
  }

  // Sort by date descending (most recent first)
  return Array.from(grouped.values()).sort((a, b) => b.timestamp - a.timestamp);
}

// ============================================================================
// Date Helpers
// ============================================================================

function toUnixTimestamp(dateStr: string): number {
  return Math.floor(new Date(dateStr).getTime() / 1000);
}

function defaultDates(
  startDate?: string,
  endDate?: string,
  defaultDaysBack = 30
): { start: number; end: number; startStr: string; endStr: string } {
  const now = new Date();
  const endStr = endDate || now.toISOString().split("T")[0];
  const startStr =
    startDate ||
    new Date(now.getTime() - defaultDaysBack * 86400000)
      .toISOString()
      .split("T")[0];
  return {
    start: toUnixTimestamp(startStr),
    end: toUnixTimestamp(endStr) + 86400, // Include end date fully
    startStr,
    endStr,
  };
}

// ============================================================================
// Public API — called by MCP tools
// ============================================================================

/**
 * Get body composition — context-safe summary by default.
 * Returns latest values + trends for each tracked metric.
 * Pass metric parameter for full time series of a specific measurement.
 */
export async function getBodyComposition(
  env: Env,
  startDate?: string,
  endDate?: string,
  metric?: string
): Promise<string> {
  const { start, end, startStr, endStr } = defaultDates(startDate, endDate, 30);

  const data = await withingsRequest(env, "/measure", {
    action: "getmeas",
    startdate: start.toString(),
    enddate: end.toString(),
    category: "1", // Real measurements only
  });

  if (data.status !== 0) {
    return `Withings API error: status ${data.status} — ${JSON.stringify(data.error || "unknown")}`;
  }

  const measurements = parseMeasurements(data);

  if (measurements.length === 0) {
    return `No Withings measurements found for ${startStr} to ${endStr}`;
  }

  // If specific metric requested, return time series
  if (metric) {
    return formatSingleMetricSeries(measurements, metric, startStr, endStr);
  }

  // Default: compact summary with trends
  return formatBodyCompSummary(measurements, startStr, endStr);
}

function formatBodyCompSummary(
  measurements: ParsedMeasurement[],
  startStr: string,
  endStr: string
): string {
  const lines = [
    `⚖️ Body Composition Summary: ${startStr} → ${endStr}`,
    `Data timestamp: ${new Date().toISOString()}`,
    `Measurements: ${measurements.length} weigh-ins`,
    "",
  ];

  // Collect all metrics across all measurements
  const metricSeries = new Map<string, { date: string; value: number; unit: string }[]>();

  for (const m of measurements) {
    for (const [name, data] of Object.entries(m.metrics)) {
      const series = metricSeries.get(name) || [];
      series.push({ date: m.date, value: data.value, unit: data.unit });
      metricSeries.set(name, series);
    }
  }

  // Display each metric: latest, range, trend
  // Order: Weight first, then body comp metrics
  const orderedMetrics = ["Weight", "Fat Ratio", "Fat Mass", "Muscle Mass", "Bone Mass", "Hydration", "Fat Free Mass"];
  const allMetrics = [...orderedMetrics.filter(m => metricSeries.has(m)),
                      ...Array.from(metricSeries.keys()).filter(m => !orderedMetrics.includes(m))];

  for (const metricName of allMetrics) {
    const series = metricSeries.get(metricName)!;
    // Sort oldest to newest for trend calculation
    series.sort((a, b) => a.date.localeCompare(b.date));

    const latest = series[series.length - 1];
    const values = series.map((s) => s.value);
    const unit = latest.unit;

    const fmt = (v: number) => {
      if (unit === "%" || unit === "bpm") return v.toFixed(1);
      if (unit === "kg") return v.toFixed(2);
      return v.toFixed(2);
    };

    lines.push(`**${metricName}**`);
    lines.push(`  Latest: ${fmt(latest.value)} ${unit} (${latest.date})`);

    if (series.length >= 2) {
      const earliest = series[0];
      const min = Math.min(...values);
      const max = Math.max(...values);
      const diff = latest.value - earliest.value;

      let trend = "→ stable";
      const pctChange = earliest.value !== 0 ? (diff / earliest.value) * 100 : 0;
      if (Math.abs(pctChange) < 0.3) {
        trend = "→ stable";
      } else if (diff > 0) {
        trend = `↑ +${fmt(diff)} ${unit} (+${pctChange.toFixed(1)}%)`;
      } else {
        trend = `↓ ${fmt(diff)} ${unit} (${pctChange.toFixed(1)}%)`;
      }

      lines.push(`  Range: ${fmt(min)} – ${fmt(max)} ${unit} | ${series.length} readings`);
      lines.push(`  Trend: ${trend}`);
    }
    lines.push("");
  }

  lines.push(
    `_Use metric parameter (e.g. metric: "Weight") for full time series._`
  );

  return lines.join("\n");
}

function formatSingleMetricSeries(
  measurements: ParsedMeasurement[],
  metricFilter: string,
  startStr: string,
  endStr: string
): string {
  const filterLower = metricFilter.toLowerCase();

  // Find matching metric name
  const allMetricNames = new Set<string>();
  for (const m of measurements) {
    for (const name of Object.keys(m.metrics)) {
      allMetricNames.add(name);
    }
  }

  const matchingName = Array.from(allMetricNames).find(
    (n) => n.toLowerCase().includes(filterLower)
  );

  if (!matchingName) {
    return `No metric matching "${metricFilter}". Available: ${Array.from(allMetricNames).join(", ")}`;
  }

  // Extract time series for this metric
  const series: { date: string; value: number; unit: string }[] = [];
  for (const m of measurements) {
    const data = m.metrics[matchingName];
    if (data) {
      series.push({ date: m.date, value: data.value, unit: data.unit });
    }
  }

  series.sort((a, b) => a.date.localeCompare(b.date));

  const unit = series[0].unit;
  const fmt = (v: number) => {
    if (unit === "%" || unit === "bpm") return v.toFixed(1);
    return v.toFixed(2);
  };

  const lines = [
    `⚖️ ${matchingName}: ${startStr} → ${endStr}`,
    `Data timestamp: ${new Date().toISOString()}`,
    `${series.length} readings`,
    "",
  ];

  for (const s of series) {
    lines.push(`  ${s.date}: ${fmt(s.value)} ${unit}`);
  }

  if (series.length >= 2) {
    const values = series.map((s) => s.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    const diff = series[series.length - 1].value - series[0].value;
    lines.push("  ---");
    lines.push(
      `  Min: ${fmt(min)} | Max: ${fmt(max)} | Avg: ${fmt(avg)} | Change: ${diff > 0 ? "+" : ""}${fmt(diff)} ${unit}`
    );
  }

  return lines.join("\n");
}

/**
 * Get connected Withings devices.
 */
export async function getDevices(env: Env): Promise<string> {
  const data = await withingsRequest(env, "/v2/user", {
    action: "getdevice",
  });

  if (data.status !== 0) {
    return `Withings API error: status ${data.status}`;
  }

  const devices = data.body?.devices || [];
  if (devices.length === 0) {
    return "No Withings devices found.";
  }

  const lines = [
    `📱 Withings Devices`,
    `Data timestamp: ${new Date().toISOString()}`,
    "",
  ];

  for (const d of devices) {
    lines.push(`- **${d.model ?? "Unknown"}** (${d.type ?? "unknown type"})`);
    if (d.battery) lines.push(`  Battery: ${d.battery}`);
    if (d.last_session_date) {
      const lastSync = new Date(d.last_session_date * 1000).toISOString().split("T")[0];
      lines.push(`  Last sync: ${lastSync}`);
    }
  }

  return lines.join("\n");
}
