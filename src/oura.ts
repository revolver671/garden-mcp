/**
 * The Garden — Oura Ring API Client (Complete Data Lake)
 * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 * Personal Access Token authentication
 *
 * Endpoints (15 total — every Oura API v2 endpoint):
 *   daily_sleep, sleep (detail), daily_readiness, heartrate,
 *   daily_activity, daily_stress, daily_spo2, daily_resilience,
 *   daily_cardiovascular_age, vo2_max, sleep_time, workout,
 *   session, enhanced_tag, personal_info
 *
 * Every response includes:
 *   - Data timestamp (from Oura)
 *   - Fetch timestamp (when we retrieved it)
 *
 * "Leave nothing behind."
 */

const OURA_BASE = "https://api.ouraring.com/v2/usercollection";

interface OuraResponse {
  data?: Array<Record<string, unknown>>;
  error?: string;
}

// For endpoints that return a single object (personal_info)
interface OuraSingleResponse {
  error?: string;
  [key: string]: unknown;
}

async function ouraGet(
  endpoint: string,
  token: string,
  params?: Record<string, string>
): Promise<OuraResponse> {
  if (!token) {
    return { error: "OURA_ACCESS_TOKEN not configured" };
  }

  let url = `${OURA_BASE}/${endpoint}`;
  if (params) {
    url += "?" + new URLSearchParams(params).toString();
  }

  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      return { error: `Oura API error: ${resp.status} ${resp.statusText}` };
    }

    return (await resp.json()) as OuraResponse;
  } catch (e) {
    return { error: `Oura API error: ${String(e)}` };
  }
}

async function ouraGetSingle(
  endpoint: string,
  token: string
): Promise<OuraSingleResponse> {
  if (!token) {
    return { error: "OURA_ACCESS_TOKEN not configured" };
  }

  const url = `${OURA_BASE}/${endpoint}`;

  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      return { error: `Oura API error: ${resp.status} ${resp.statusText}` };
    }

    return (await resp.json()) as OuraSingleResponse;
  } catch (e) {
    return { error: `Oura API error: ${String(e)}` };
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function mins(secs: number): string {
  if (!secs) return "N/A";
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

function yesterdayISO(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

function fetchTimestamp(): string {
  return new Date().toISOString();
}

function val(v: unknown, suffix = ""): string {
  if (v === null || v === undefined) return "N/A";
  return `${v}${suffix}`;
}

function labelKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function contributorBlock(contributors: Record<string, number | null>, keys: string[]): string[] {
  const lines: string[] = [];
  for (const key of keys) {
    if (key in contributors) {
      lines.push(`  ${labelKey(key)}: ${val(contributors[key])}`);
    }
  }
  return lines;
}

// --------------------------------------------------------------------------
// 1. SLEEP (daily_sleep + sleep detail)
// --------------------------------------------------------------------------

export async function getSleep(
  token: string,
  day?: string
): Promise<string> {
  const targetDay = day || yesterdayISO();
  const fetched = fetchTimestamp();

  const daily = await ouraGet("daily_sleep", token, {
    start_date: targetDay,
    end_date: targetDay,
  });

  if (daily.error) return daily.error;
  if (!daily.data?.length) return `No sleep data for ${targetDay}`;

  const s = daily.data[0] as Record<string, unknown>;
  const score = s.score ?? "N/A";
  const contributors = (s.contributors ?? {}) as Record<string, number>;
  const dataTs = s.timestamp ?? "N/A";

  const lines = [
    `# Sleep — ${targetDay}`,
    `**Score:** ${score}/100`,
    `**Data timestamp:** ${dataTs} | **Fetched:** ${fetched}`,
  ];

  lines.push(
    ...contributorBlock(contributors, [
      "deep_sleep", "efficiency", "latency", "rem_sleep",
      "restfulness", "timing", "total_sleep",
    ])
  );

  // Get detailed sleep data
  const detail = await ouraGet("sleep", token, {
    start_date: targetDay,
    end_date: targetDay,
  });

  if (!detail.error && detail.data?.length) {
    const d = detail.data[detail.data.length - 1] as Record<string, unknown>;
    const total = (d.total_sleep_duration ?? 0) as number;
    const deep = (d.deep_sleep_duration ?? 0) as number;
    const rem = (d.rem_sleep_duration ?? 0) as number;
    const light = (d.light_sleep_duration ?? 0) as number;
    const awake = (d.awake_time ?? 0) as number;
    const hrvAvg = d.average_hrv ?? "N/A";
    const hrAvg = d.average_heart_rate ?? "N/A";
    const hrLow = d.lowest_heart_rate ?? "N/A";
    const efficiency = d.efficiency ?? "N/A";
    const onset = d.bedtime_start ?? "N/A";
    const wakeup = d.bedtime_end ?? "N/A";
    const latency = (d.latency ?? 0) as number;
    const breaths = d.average_breath ?? "N/A";
    const restless = d.restless_periods ?? "N/A";
    const sleepType = d.type ?? "N/A";
    const readinessScore = d.readiness_score_delta ?? null;
    const timeInBed = (d.time_in_bed ?? 0) as number;

    lines.push(
      "",
      "**Durations:**",
      `  Total Sleep: ${mins(total)} | Time in Bed: ${mins(timeInBed)}`,
      `  Deep: ${mins(deep)} | REM: ${mins(rem)} | Light: ${mins(light)}`,
      `  Awake: ${mins(awake)} | Latency: ${mins(latency)}`,
      "",
      "**Vitals:**",
      `  Avg HRV: ${val(hrvAvg, "ms")} | Avg HR: ${val(hrAvg, "bpm")} | Lowest HR: ${val(hrLow, "bpm")}`,
      `  Avg Breathing: ${val(breaths, " breaths/min")} | Efficiency: ${val(efficiency, "%")}`,
      "",
      "**Timing:**",
      `  Bedtime: ${onset} | Wake: ${wakeup}`,
      `  Type: ${sleepType} | Restless Periods: ${val(restless)}`
    );

    if (readinessScore !== null && readinessScore !== undefined) {
      lines.push(`  Readiness Delta: ${readinessScore}`);
    }
  }

  return lines.join("\n");
}

// --------------------------------------------------------------------------
// 2. READINESS
// --------------------------------------------------------------------------

export async function getReadiness(
  token: string,
  day?: string
): Promise<string> {
  const targetDay = day || todayISO();
  const fetched = fetchTimestamp();

  const data = await ouraGet("daily_readiness", token, {
    start_date: targetDay,
    end_date: targetDay,
  });

  if (data.error) return data.error;
  if (!data.data?.length) return `No readiness data for ${targetDay}`;

  const r = data.data[0] as Record<string, unknown>;
  const score = r.score ?? "N/A";
  const contributors = (r.contributors ?? {}) as Record<string, number>;
  const temp = r.temperature_deviation ?? "N/A";
  const tempTrend = r.temperature_trend_deviation ?? "N/A";
  const dataTs = r.timestamp ?? "N/A";

  const lines = [
    `# Readiness — ${targetDay}`,
    `**Score:** ${score}/100`,
    `**Temperature Deviation:** ${temp}°C (trend: ${tempTrend}°C)`,
    `**Data timestamp:** ${dataTs} | **Fetched:** ${fetched}`,
    "",
    "**Contributors:**",
    ...contributorBlock(contributors, [
      "activity_balance", "body_temperature", "hrv_balance",
      "previous_day_activity", "previous_night", "recovery_index",
      "resting_heart_rate", "sleep_balance",
    ]),
  ];

  return lines.join("\n");
}

// --------------------------------------------------------------------------
// 3. HEART RATE
// --------------------------------------------------------------------------

export async function getHeartRate(
  token: string,
  day?: string
): Promise<string> {
  const targetDay = day || todayISO();
  const fetched = fetchTimestamp();
  const nextDay = new Date(targetDay + "T00:00:00Z");
  nextDay.setDate(nextDay.getDate() + 1);
  const nextDayISO = nextDay.toISOString().split("T")[0];

  const data = await ouraGet("heartrate", token, {
    start_datetime: `${targetDay}T00:00:00+00:00`,
    end_datetime: `${nextDayISO}T00:00:00+00:00`,
  });

  if (data.error) return data.error;
  if (!data.data?.length) return `No heart rate data for ${targetDay}`;

  const readings = data.data as Array<Record<string, unknown>>;
  const bpms = readings
    .map((e) => e.bpm as number)
    .filter((b) => typeof b === "number");

  if (!bpms.length) return `No heart rate readings for ${targetDay}`;

  const avg = bpms.reduce((a, b) => a + b, 0) / bpms.length;
  const low = Math.min(...bpms);
  const high = Math.max(...bpms);

  // Source breakdown
  const sources: Record<string, number> = {};
  for (const r of readings) {
    const src = (r.source as string) || "unknown";
    sources[src] = (sources[src] || 0) + 1;
  }
  const sourceStr = Object.entries(sources)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  return [
    `# Heart Rate — ${targetDay}`,
    `**Average:** ${avg.toFixed(0)}bpm | **Lowest:** ${low}bpm | **Highest:** ${high}bpm`,
    `**Readings:** ${bpms.length} data points (${sourceStr})`,
    `**Fetched:** ${fetched}`,
  ].join("\n");
}

// --------------------------------------------------------------------------
// 4. DAILY ACTIVITY
// --------------------------------------------------------------------------

export async function getDailyActivity(
  token: string,
  day?: string
): Promise<string> {
  const targetDay = day || todayISO();
  const fetched = fetchTimestamp();

  const data = await ouraGet("daily_activity", token, {
    start_date: targetDay,
    end_date: targetDay,
  });

  if (data.error) return data.error;
  if (!data.data?.length) return `No activity data for ${targetDay}`;

  const a = data.data[0] as Record<string, unknown>;
  const score = a.score ?? "N/A";
  const contributors = (a.contributors ?? {}) as Record<string, number>;
  const dataTs = a.timestamp ?? "N/A";

  const steps = a.steps ?? "N/A";
  const activeCal = a.active_calories ?? "N/A";
  const totalCal = a.total_calories ?? "N/A";
  const targetCal = a.target_calories ?? "N/A";
  const distance = a.equivalent_walking_distance ?? "N/A";
  const targetMeters = a.target_meters ?? "N/A";
  const metersToTarget = a.meters_to_target ?? "N/A";
  const inactivityAlerts = a.inactivity_alerts ?? "N/A";

  // Activity times (in seconds)
  const highTime = (a.high_activity_time ?? 0) as number;
  const medTime = (a.medium_activity_time ?? 0) as number;
  const lowTime = (a.low_activity_time ?? 0) as number;
  const sedTime = (a.sedentary_time ?? 0) as number;
  const restTime = (a.resting_time ?? 0) as number;
  const nonWear = (a.non_wear_time ?? 0) as number;

  // MET minutes
  const highMet = a.high_activity_met_minutes ?? "N/A";
  const medMet = a.medium_activity_met_minutes ?? "N/A";
  const lowMet = a.low_activity_met_minutes ?? "N/A";
  const sedMet = a.sedentary_met_minutes ?? "N/A";
  const avgMet = a.average_met_minutes ?? "N/A";

  const lines = [
    `# Activity — ${targetDay}`,
    `**Score:** ${score}/100`,
    `**Data timestamp:** ${dataTs} | **Fetched:** ${fetched}`,
    "",
    "**Movement:**",
    `  Steps: ${val(steps)} | Distance: ${val(distance, "m")} (target: ${val(targetMeters, "m")}, ${val(metersToTarget, "m")} to target)`,
    `  Active Calories: ${val(activeCal)} | Total Calories: ${val(totalCal)} (target: ${val(targetCal)})`,
    `  Inactivity Alerts: ${val(inactivityAlerts)}`,
    "",
    "**Activity Breakdown:**",
    `  High: ${mins(highTime)} (${val(highMet)} MET min)`,
    `  Medium: ${mins(medTime)} (${val(medMet)} MET min)`,
    `  Low: ${mins(lowTime)} (${val(lowMet)} MET min)`,
    `  Sedentary: ${mins(sedTime)} (${val(sedMet)} MET min)`,
    `  Resting: ${mins(restTime)} | Non-wear: ${mins(nonWear)}`,
    `  Average MET: ${val(avgMet)}`,
    "",
    "**Contributors:**",
    ...contributorBlock(contributors, [
      "meet_daily_targets", "move_every_hour", "recovery_time",
      "stay_active", "training_frequency", "training_volume",
    ]),
  ];

  return lines.join("\n");
}

// --------------------------------------------------------------------------
// 5. DAILY STRESS
// --------------------------------------------------------------------------

export async function getDailyStress(
  token: string,
  day?: string
): Promise<string> {
  const targetDay = day || todayISO();
  const fetched = fetchTimestamp();

  const data = await ouraGet("daily_stress", token, {
    start_date: targetDay,
    end_date: targetDay,
  });

  if (data.error) return data.error;
  if (!data.data?.length) return `No stress data for ${targetDay}`;

  const s = data.data[0] as Record<string, unknown>;
  const stressHigh = s.stress_high ?? "N/A";
  const recoveryHigh = s.recovery_high ?? "N/A";
  const daySum = s.day_summary ?? "N/A";
  const dataTs = s.day ?? targetDay;

  return [
    `# Stress — ${dataTs}`,
    `**Day Summary:** ${val(daySum)}`,
    `**Stress High:** ${val(stressHigh, " min")} | **Recovery High:** ${val(recoveryHigh, " min")}`,
    `**Fetched:** ${fetched}`,
  ].join("\n");
}

// --------------------------------------------------------------------------
// 6. DAILY SpO2
// --------------------------------------------------------------------------

export async function getDailySpo2(
  token: string,
  day?: string
): Promise<string> {
  const targetDay = day || yesterdayISO();
  const fetched = fetchTimestamp();

  const data = await ouraGet("daily_spo2", token, {
    start_date: targetDay,
    end_date: targetDay,
  });

  if (data.error) return data.error;
  if (!data.data?.length) return `No SpO2 data for ${targetDay}`;

  const s = data.data[0] as Record<string, unknown>;
  const avg = s.spo2_percentage ?? "N/A";
  const bdi = s.breathing_disturbance_index ?? "N/A";
  const dataTs = s.day ?? targetDay;

  return [
    `# SpO2 — ${dataTs}`,
    `**Average SpO2:** ${val(avg, "%")}`,
    `**Breathing Disturbance Index:** ${val(bdi)}`,
    `**Fetched:** ${fetched}`,
  ].join("\n");
}

// --------------------------------------------------------------------------
// 7. DAILY RESILIENCE
// --------------------------------------------------------------------------

export async function getDailyResilience(
  token: string,
  day?: string
): Promise<string> {
  const targetDay = day || todayISO();
  const fetched = fetchTimestamp();

  const data = await ouraGet("daily_resilience", token, {
    start_date: targetDay,
    end_date: targetDay,
  });

  if (data.error) return data.error;
  if (!data.data?.length) return `No resilience data for ${targetDay}`;

  const r = data.data[0] as Record<string, unknown>;
  const level = r.level ?? "N/A";
  const contributors = (r.contributors ?? {}) as Record<string, number>;
  const dataTs = r.day ?? targetDay;

  const lines = [
    `# Resilience — ${dataTs}`,
    `**Level:** ${val(level)}`,
    `**Fetched:** ${fetched}`,
    "",
    "**Contributors:**",
    ...contributorBlock(contributors, [
      "sleep_recovery", "daytime_recovery", "stress",
    ]),
  ];

  return lines.join("\n");
}

// --------------------------------------------------------------------------
// 8. DAILY CARDIOVASCULAR AGE
// --------------------------------------------------------------------------

export async function getCardiovascularAge(
  token: string,
  day?: string
): Promise<string> {
  const targetDay = day || todayISO();
  const fetched = fetchTimestamp();

  const data = await ouraGet("daily_cardiovascular_age", token, {
    start_date: targetDay,
    end_date: targetDay,
  });

  if (data.error) return data.error;
  if (!data.data?.length) return `No cardiovascular age data for ${targetDay}`;

  const c = data.data[0] as Record<string, unknown>;
  const cvAge = c.vascular_age ?? "N/A";
  const dataTs = c.day ?? targetDay;

  return [
    `# Cardiovascular Age — ${dataTs}`,
    `**Vascular Age:** ${val(cvAge)}`,
    `**Fetched:** ${fetched}`,
  ].join("\n");
}

// --------------------------------------------------------------------------
// 9. VO2 MAX
// --------------------------------------------------------------------------

export async function getVo2Max(
  token: string,
  day?: string
): Promise<string> {
  const targetDay = day || todayISO();
  const fetched = fetchTimestamp();

  const data = await ouraGet("vo2_max", token, {
    start_date: targetDay,
    end_date: targetDay,
  });

  if (data.error) return data.error;
  if (!data.data?.length) return `No VO2 max data for ${targetDay}`;

  const v = data.data[0] as Record<string, unknown>;
  const vo2 = v.vo2_max ?? "N/A";
  const dataTs = v.day ?? v.timestamp ?? targetDay;

  return [
    `# VO2 Max — ${dataTs}`,
    `**VO2 Max:** ${val(vo2, " ml/kg/min")}`,
    `**Fetched:** ${fetched}`,
  ].join("\n");
}

// --------------------------------------------------------------------------
// 10. SLEEP TIME (recommended bedtime/wake time)
// --------------------------------------------------------------------------

export async function getSleepTime(
  token: string,
  day?: string
): Promise<string> {
  const targetDay = day || todayISO();
  const fetched = fetchTimestamp();

  const data = await ouraGet("sleep_time", token, {
    start_date: targetDay,
    end_date: targetDay,
  });

  if (data.error) return data.error;
  if (!data.data?.length) return `No sleep time data for ${targetDay}`;

  const s = data.data[0] as Record<string, unknown>;
  const recommendation = s.recommendation ?? "N/A";
  const status = s.status ?? "N/A";

  const optimal = s.optimal_bedtime as Record<string, unknown> | null;
  const optStart = optimal?.start ?? "N/A";
  const optEnd = optimal?.end ?? "N/A";

  const dataTs = s.day ?? targetDay;

  return [
    `# Sleep Time — ${dataTs}`,
    `**Recommendation:** ${val(recommendation)}`,
    `**Status:** ${val(status)}`,
    `**Optimal Bedtime Window:** ${optStart} – ${optEnd}`,
    `**Fetched:** ${fetched}`,
  ].join("\n");
}

// --------------------------------------------------------------------------
// 11. WORKOUT (Oura-detected workouts)
// --------------------------------------------------------------------------

export async function getWorkouts(
  token: string,
  day?: string
): Promise<string> {
  const targetDay = day || todayISO();
  const fetched = fetchTimestamp();

  const data = await ouraGet("workout", token, {
    start_date: targetDay,
    end_date: targetDay,
  });

  if (data.error) return data.error;
  if (!data.data?.length) return `No Oura workouts detected for ${targetDay}`;

  const lines = [`# Oura Workouts — ${targetDay}`, `**Fetched:** ${fetched}`, ""];

  for (const w of data.data as Array<Record<string, unknown>>) {
    const activity = w.activity ?? "unknown";
    const calories = w.calories ?? "N/A";
    const distance = w.distance ?? "N/A";
    const intensity = w.intensity ?? "N/A";
    const start = w.start_datetime ?? "N/A";
    const end = w.end_datetime ?? "N/A";
    const source = w.source ?? "N/A";
    const label = w.label ?? "";

    lines.push(
      `## ${labelKey(String(activity))}${label ? ` (${label})` : ""}`,
      `  Time: ${start} → ${end}`,
      `  Calories: ${val(calories)} | Distance: ${val(distance, "m")} | Intensity: ${val(intensity)}`,
      `  Source: ${val(source)}`,
      ""
    );
  }

  return lines.join("\n");
}

// --------------------------------------------------------------------------
// 12. SESSION (guided breathing / meditation)
// --------------------------------------------------------------------------

export async function getSessions(
  token: string,
  day?: string
): Promise<string> {
  const targetDay = day || todayISO();
  const fetched = fetchTimestamp();

  const data = await ouraGet("session", token, {
    start_date: targetDay,
    end_date: targetDay,
  });

  if (data.error) return data.error;
  if (!data.data?.length) return `No sessions for ${targetDay}`;

  const lines = [`# Sessions — ${targetDay}`, `**Fetched:** ${fetched}`, ""];

  for (const s of data.data as Array<Record<string, unknown>>) {
    const type = s.type ?? "unknown";
    const mood = s.mood ?? "N/A";
    const start = s.start_datetime ?? "N/A";
    const end = s.end_datetime ?? "N/A";
    const hrvAvg = s.average_hrv ?? "N/A";
    const hrAvg = s.average_heart_rate ?? "N/A";

    lines.push(
      `## ${labelKey(String(type))}`,
      `  Time: ${start} → ${end}`,
      `  Mood: ${val(mood)} | Avg HRV: ${val(hrvAvg, "ms")} | Avg HR: ${val(hrAvg, "bpm")}`,
      ""
    );
  }

  return lines.join("\n");
}

// --------------------------------------------------------------------------
// 13. ENHANCED TAG
// --------------------------------------------------------------------------

export async function getEnhancedTags(
  token: string,
  day?: string
): Promise<string> {
  const targetDay = day || todayISO();
  const fetched = fetchTimestamp();

  const data = await ouraGet("enhanced_tag", token, {
    start_date: targetDay,
    end_date: targetDay,
  });

  if (data.error) return data.error;
  if (!data.data?.length) return `No tags for ${targetDay}`;

  const lines = [`# Tags — ${targetDay}`, `**Fetched:** ${fetched}`, ""];

  for (const t of data.data as Array<Record<string, unknown>>) {
    const tagType = t.tag_type_code ?? "custom";
    const customName = t.custom_name ?? "";
    const comment = t.comment ?? "";
    const startDay = t.start_day ?? targetDay;
    const startTs = t.start_timestamp ?? "N/A";

    const label = customName || String(tagType);
    lines.push(
      `- **${label}** (${startDay} ${startTs})${comment ? `: ${comment}` : ""}`
    );
  }

  return lines.join("\n");
}

// --------------------------------------------------------------------------
// 14. PERSONAL INFO
// --------------------------------------------------------------------------

export async function getPersonalInfo(
  token: string
): Promise<string> {
  const fetched = fetchTimestamp();

  const data = await ouraGetSingle("personal_info", token);

  if (data.error) return data.error as string;

  const age = data.age ?? "N/A";
  const weight = data.weight ?? "N/A";
  const height = data.height ?? "N/A";
  const sex = data.biological_sex ?? "N/A";
  const email = data.email ?? "N/A";

  return [
    `# Personal Info`,
    `**Age:** ${val(age)} | **Weight:** ${val(weight, "kg")} | **Height:** ${val(height, "m")}`,
    `**Biological Sex:** ${val(sex)} | **Email:** ${val(email)}`,
    `**Fetched:** ${fetched}`,
  ].join("\n");
}

// --------------------------------------------------------------------------
// 15. REST MODE PERIOD
// --------------------------------------------------------------------------

export async function getRestModePeriod(
  token: string,
  day?: string
): Promise<string> {
  const targetDay = day || todayISO();
  const fetched = fetchTimestamp();

  const data = await ouraGet("rest_mode_period", token, {
    start_date: targetDay,
    end_date: targetDay,
  });

  if (data.error) return data.error;
  if (!data.data?.length) return `No rest mode periods for ${targetDay}`;

  const lines = [`# Rest Mode — ${targetDay}`, `**Fetched:** ${fetched}`, ""];

  for (const r of data.data as Array<Record<string, unknown>>) {
    const startDay = r.start_day ?? "N/A";
    const endDay = r.end_day ?? "ongoing";
    const episodes = r.episodes as Array<Record<string, unknown>> | undefined;

    lines.push(`## Period: ${startDay} → ${endDay}`);
    if (episodes?.length) {
      for (const ep of episodes) {
        lines.push(`  - ${ep.timestamp ?? "?"}: ${JSON.stringify(ep.tags ?? [])}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
