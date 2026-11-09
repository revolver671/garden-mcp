/**
 * The Garden — Association Graph (Phase 3, Layer 2)
 *
 * Aggregates all extractions into a single graph structure:
 * - Entity nodes with appearance history and co-occurrence edges
 * - Theme nodes with appearance history and trend detection
 * - Emotion frequency across time
 * - Open questions tracker (recurring unresolved items)
 *
 * Stored as encrypted JSON in R2 at meta/graph.json
 * Rebuilt on demand via MCP tool or /rebuild-graph endpoint
 */

import type { Env } from "./types";
import { encrypt, decrypt } from "./crypto";
import type { Extraction, EntityRef } from "./extraction";

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface AssociationGraph {
  /** When the graph was last rebuilt */
  builtAt: string;
  /** Number of extractions included */
  extractionCount: number;
  /** Date range covered */
  dateRange: { earliest: string; latest: string };

  /** Entity nodes — people, projects, places, concepts */
  entities: Record<string, EntityNode>;
  /** Theme nodes */
  themes: Record<string, ThemeNode>;
  /** Emotion frequency map */
  emotions: Record<string, EmotionNode>;
  /** Open questions that recur across sessions */
  openQuestions: OpenQuestionNode[];
  /** Top co-occurrence pairs */
  coOccurrences: CoOccurrence[];
}

export interface EntityNode {
  name: string;
  type: string;
  /** Dates this entity appeared */
  appearances: string[];
  /** Number of appearances */
  count: number;
  /** First and last seen */
  firstSeen: string;
  lastSeen: string;
  /** Entities that frequently co-occur with this one */
  coEntities: Record<string, number>;
  /** Themes that frequently co-occur with this entity */
  coThemes: Record<string, number>;
}

export interface ThemeNode {
  name: string;
  /** Dates this theme appeared */
  appearances: string[];
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** Trend: strengthening (appeared more in recent half), fading, stable, new */
  trend: "strengthening" | "fading" | "stable" | "new" | "single";
  /** Entities that frequently co-occur with this theme */
  coEntities: Record<string, number>;
}

export interface EmotionNode {
  name: string;
  count: number;
  appearances: string[];
}

export interface OpenQuestionNode {
  question: string;
  /** Which entries raised this question */
  appearances: string[];
  count: number;
}

export interface CoOccurrence {
  a: string;
  b: string;
  count: number;
  type: "entity-entity" | "entity-theme";
}

// --------------------------------------------------------------------------
// Graph storage
// --------------------------------------------------------------------------

const GRAPH_KEY = "meta/graph.json";
const META_PREFIX = "meta/extractions/";

export async function readGraph(env: Env): Promise<AssociationGraph | null> {
  const obj = await env.GARDEN_BUCKET.get(GRAPH_KEY);
  if (!obj) return null;
  try {
    const json = await decrypt(await obj.arrayBuffer(), env.ENCRYPTION_KEY);
    return JSON.parse(json) as AssociationGraph;
  } catch {
    return null;
  }
}

async function storeGraph(env: Env, graph: AssociationGraph): Promise<void> {
  const json = JSON.stringify(graph, null, 2);
  const encrypted = await encrypt(json, env.ENCRYPTION_KEY);
  await env.GARDEN_BUCKET.put(GRAPH_KEY, encrypted, {
    customMetadata: { updatedAt: new Date().toISOString() },
  });
}

// --------------------------------------------------------------------------
// Read all extractions from R2
// --------------------------------------------------------------------------

async function loadAllExtractions(env: Env): Promise<Extraction[]> {
  const extractions: Extraction[] = [];
  let cursor: string | undefined;

  do {
    const listed = await env.GARDEN_BUCKET.list({ prefix: META_PREFIX, cursor });

    for (const obj of listed.objects) {
      if (!obj.key.endsWith(".json")) continue;
      // Skip the graph itself
      if (obj.key === GRAPH_KEY) continue;

      try {
        const r2obj = await env.GARDEN_BUCKET.get(obj.key);
        if (!r2obj) continue;
        const json = await decrypt(await r2obj.arrayBuffer(), env.ENCRYPTION_KEY);
        const extraction = JSON.parse(json) as Extraction;
        extractions.push(extraction);
      } catch {
        // Skip files that fail to decrypt/parse
        continue;
      }
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return extractions;
}

// --------------------------------------------------------------------------
// Extract date from source path for timeline tracking
// --------------------------------------------------------------------------

function dateFromPath(sourcePath: string): string {
  // sphinx/journal/2026-04-05.md → 2026-04-05
  const match = sourcePath.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "unknown";
}

// --------------------------------------------------------------------------
// Normalise names for consistent aggregation
// --------------------------------------------------------------------------

function normalise(name: string): string {
  return name.trim().toLowerCase();
}

function displayName(name: string, seen: Record<string, string>): string {
  const key = normalise(name);
  // Keep the first-seen casing
  if (!seen[key]) seen[key] = name;
  return seen[key];
}

// --------------------------------------------------------------------------
// Detect trend for a theme based on temporal distribution
// --------------------------------------------------------------------------

function detectTrend(
  appearances: string[],
  allDates: string[]
): "strengthening" | "fading" | "stable" | "new" | "single" {
  if (appearances.length <= 1) return "single";
  if (appearances.length === 2 && allDates.length > 5) return "new";

  // Sort all dates and split into halves
  const sorted = [...allDates].sort();
  const midpoint = sorted[Math.floor(sorted.length / 2)];

  const firstHalf = appearances.filter((d) => d <= midpoint).length;
  const secondHalf = appearances.filter((d) => d > midpoint).length;

  if (secondHalf === 0 && firstHalf > 0) return "fading";
  if (firstHalf === 0 && secondHalf > 0) return "new";

  const ratio = secondHalf / Math.max(firstHalf, 1);
  if (ratio >= 1.5) return "strengthening";
  if (ratio <= 0.5) return "fading";
  return "stable";
}

// --------------------------------------------------------------------------
// Build the graph from all extractions
// --------------------------------------------------------------------------

export async function buildGraph(env: Env): Promise<AssociationGraph> {
  const extractions = await loadAllExtractions(env);

  // Tracking structures
  const entityMap: Record<string, EntityNode> = {};
  const themeMap: Record<string, ThemeNode> = {};
  const emotionMap: Record<string, EmotionNode> = {};
  const questionMap: Record<string, { question: string; appearances: string[] }> = {};
  const nameDisplay: Record<string, string> = {};

  // All dates for trend detection
  const allDates: string[] = [];

  for (const ext of extractions) {
    const date = dateFromPath(ext.sourcePath);
    allDates.push(date);

    // Collect entity keys for this entry (for co-occurrence)
    const entryEntityKeys: string[] = [];
    const entryThemeKeys: string[] = [];

    // --- Entities ---
    for (const entity of ext.entities || []) {
      const key = normalise(entity.name);
      const name = displayName(entity.name, nameDisplay);
      entryEntityKeys.push(key);

      if (!entityMap[key]) {
        entityMap[key] = {
          name,
          type: entity.type,
          appearances: [],
          count: 0,
          firstSeen: date,
          lastSeen: date,
          coEntities: {},
          coThemes: {},
        };
      }

      const node = entityMap[key];
      if (!node.appearances.includes(date)) {
        node.appearances.push(date);
      }
      node.count = node.appearances.length;
      if (date < node.firstSeen) node.firstSeen = date;
      if (date > node.lastSeen) node.lastSeen = date;
    }

    // --- Themes ---
    for (const theme of ext.themes || []) {
      const key = normalise(theme);
      const name = displayName(theme, nameDisplay);
      entryThemeKeys.push(key);

      if (!themeMap[key]) {
        themeMap[key] = {
          name,
          appearances: [],
          count: 0,
          firstSeen: date,
          lastSeen: date,
          trend: "stable",
          coEntities: {},
        };
      }

      const node = themeMap[key];
      if (!node.appearances.includes(date)) {
        node.appearances.push(date);
      }
      node.count = node.appearances.length;
      if (date < node.firstSeen) node.firstSeen = date;
      if (date > node.lastSeen) node.lastSeen = date;
    }

    // --- Emotions ---
    for (const emotion of ext.emotions || []) {
      const key = normalise(emotion);
      const name = displayName(emotion, nameDisplay);

      if (!emotionMap[key]) {
        emotionMap[key] = { name, count: 0, appearances: [] };
      }
      emotionMap[key].count++;
      if (!emotionMap[key].appearances.includes(date)) {
        emotionMap[key].appearances.push(date);
      }
    }

    // --- Open Questions ---
    for (const q of ext.openQuestions || []) {
      const key = normalise(q);
      if (!questionMap[key]) {
        questionMap[key] = { question: q, appearances: [] };
      }
      if (!questionMap[key].appearances.includes(date)) {
        questionMap[key].appearances.push(date);
      }
    }

    // --- Co-occurrences within this entry ---
    // Entity-entity
    for (let i = 0; i < entryEntityKeys.length; i++) {
      for (let j = i + 1; j < entryEntityKeys.length; j++) {
        const a = entryEntityKeys[i];
        const b = entryEntityKeys[j];
        if (a === b) continue;
        if (entityMap[a]) entityMap[a].coEntities[b] = (entityMap[a].coEntities[b] || 0) + 1;
        if (entityMap[b]) entityMap[b].coEntities[a] = (entityMap[b].coEntities[a] || 0) + 1;
      }
    }

    // Entity-theme
    for (const ek of entryEntityKeys) {
      for (const tk of entryThemeKeys) {
        if (entityMap[ek]) entityMap[ek].coThemes[tk] = (entityMap[ek].coThemes[tk] || 0) + 1;
        if (themeMap[tk]) themeMap[tk].coEntities[ek] = (themeMap[tk].coEntities[ek] || 0) + 1;
      }
    }
  }

  // --- Compute trends ---
  const sortedDates = [...allDates].sort();
  for (const node of Object.values(themeMap)) {
    node.trend = detectTrend(node.appearances, sortedDates);
  }

  // --- Build top co-occurrences list ---
  const coOccurrenceSet: Record<string, CoOccurrence> = {};

  for (const [key, entity] of Object.entries(entityMap)) {
    // Entity-entity
    for (const [coKey, count] of Object.entries(entity.coEntities)) {
      const pairKey = [key, coKey].sort().join("|");
      if (!coOccurrenceSet[pairKey]) {
        coOccurrenceSet[pairKey] = {
          a: entityMap[key]?.name || key,
          b: entityMap[coKey]?.name || coKey,
          count,
          type: "entity-entity",
        };
      }
    }
    // Entity-theme
    for (const [coKey, count] of Object.entries(entity.coThemes)) {
      const pairKey = [key, coKey].sort().join("|");
      if (!coOccurrenceSet[pairKey]) {
        coOccurrenceSet[pairKey] = {
          a: entity.name,
          b: themeMap[coKey]?.name || coKey,
          count,
          type: "entity-theme",
        };
      }
    }
  }

  const topCoOccurrences = Object.values(coOccurrenceSet)
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);

  // --- Build open questions (recurring only) ---
  const openQuestions = Object.values(questionMap)
    .map((q) => ({
      question: q.question,
      appearances: q.appearances.sort(),
      count: q.appearances.length,
    }))
    .filter((q) => q.count >= 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  // --- Assemble graph ---
  const graph: AssociationGraph = {
    builtAt: new Date().toISOString(),
    extractionCount: extractions.length,
    dateRange: {
      // Roadmap item 3 (25 Aug 2026): undated thread extractions carry
      // "unknown", which wins a string-compare max and made the nightly line
      // report `range 2026-02-18→unknown` -- a lying instrument. Only
      // date-shaped strings may bound the range.
      earliest:
        sortedDates.find((d) => /^\d{4}-\d{2}-\d{2}/.test(d)) || "unknown",
      latest:
        [...sortedDates].reverse().find((d) => /^\d{4}-\d{2}-\d{2}/.test(d)) ||
        "unknown",
    },
    entities: entityMap,
    themes: themeMap,
    emotions: emotionMap,
    openQuestions,
    coOccurrences: topCoOccurrences,
  };

  // Store it
  await storeGraph(env, graph);

  return graph;
}

// --------------------------------------------------------------------------
// Graph summary — formatted for session briefing
// --------------------------------------------------------------------------

export function formatGraphSummary(graph: AssociationGraph): string {
  const lines: string[] = [];

  lines.push(`# 🌿 Garden Graph — ${graph.dateRange.earliest} to ${graph.dateRange.latest}`);
  lines.push(`Built: ${graph.builtAt} | ${graph.extractionCount} entries indexed\n`);

  // Top entities by frequency
  const topEntities = Object.values(graph.entities)
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  lines.push(`## Top Entities`);
  for (const e of topEntities) {
    lines.push(`- **${e.name}** (${e.type}) — ${e.count} appearances [${e.firstSeen} → ${e.lastSeen}]`);
  }

  // Themes with trends
  lines.push(`\n## Themes`);

  const strengthening = Object.values(graph.themes).filter((t) => t.trend === "strengthening");
  const fading = Object.values(graph.themes).filter((t) => t.trend === "fading");
  const stable = Object.values(graph.themes).filter((t) => t.trend === "stable" && t.count >= 3);
  const newThemes = Object.values(graph.themes).filter((t) => t.trend === "new");

  if (strengthening.length) {
    lines.push(`\n**📈 Strengthening:**`);
    for (const t of strengthening.sort((a, b) => b.count - a.count)) {
      lines.push(`- ${t.name} (${t.count} entries)`);
    }
  }

  if (fading.length) {
    lines.push(`\n**📉 Fading:**`);
    for (const t of fading.sort((a, b) => b.count - a.count)) {
      lines.push(`- ${t.name} (${t.count} entries, last: ${t.lastSeen})`);
    }
  }

  if (stable.length) {
    lines.push(`\n**➡️ Stable:**`);
    for (const t of stable.sort((a, b) => b.count - a.count)) {
      lines.push(`- ${t.name} (${t.count} entries)`);
    }
  }

  if (newThemes.length) {
    lines.push(`\n**🆕 Emerging:**`);
    for (const t of newThemes) {
      lines.push(`- ${t.name} (${t.count} entries, since ${t.firstSeen})`);
    }
  }

  // Top co-occurrences
  lines.push(`\n## Strongest Connections`);
  const topPairs = graph.coOccurrences.slice(0, 15);
  for (const pair of topPairs) {
    lines.push(`- ${pair.a} ↔ ${pair.b} (${pair.count}x)`);
  }

  // Top emotions
  const topEmotions = Object.values(graph.emotions)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  lines.push(`\n## Emotional Landscape`);
  lines.push(topEmotions.map((e) => `${e.name}(${e.count})`).join(" · "));

  // Recurring open questions
  const recurring = graph.openQuestions.filter((q) => q.count >= 2);
  if (recurring.length) {
    lines.push(`\n## Recurring Open Questions`);
    for (const q of recurring) {
      lines.push(`- ${q.question} (${q.count}x)`);
    }
  }

  return lines.join("\n");
}


// --------------------------------------------------------------------------
// Briefing generator — Pattern alerts for session start (Phase 3, Layer 3)
// --------------------------------------------------------------------------

export function generateBriefing(graph: AssociationGraph): string {
  const lines: string[] = [];
  const allDates = Object.values(graph.entities)
    .flatMap((e) => e.appearances)
    .concat(Object.values(graph.themes).flatMap((t) => t.appearances));
  const uniqueDates = [...new Set(allDates)].filter((d) => d !== "unknown").sort();

  if (uniqueDates.length < 2) {
    return "Not enough data for a briefing yet. Keep journaling — patterns emerge with time.";
  }

  const dateRange = {
    earliest: uniqueDates[0],
    latest: uniqueDates[uniqueDates.length - 1],
  };

  // Recent threshold: most recent 20% of dates
  const recentCutoff = uniqueDates[Math.floor(uniqueDates.length * 0.8)];
  // Midpoint for half-splitting
  const midpoint = uniqueDates[Math.floor(uniqueDates.length / 2)];

  lines.push(`# 🌿 Garden Briefing — ${dateRange.latest}`);
  lines.push(`_${graph.extractionCount} entries across ${uniqueDates.length} days (${dateRange.earliest} → ${dateRange.latest})_\n`);

  // -------------------------------------------------------------------------
  // 1. Momentum Arcs — strengthening themes + their connected entities
  // -------------------------------------------------------------------------
  const strengthening = Object.values(graph.themes)
    .filter((t) => t.trend === "strengthening" && t.count >= 3)
    .sort((a, b) => b.count - a.count);

  if (strengthening.length) {
    lines.push(`## 📈 Momentum Arcs`);
    for (const theme of strengthening.slice(0, 5)) {
      // Find top co-occurring entities for context
      const topCoEntities = Object.entries(theme.coEntities)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([key]) => {
          const entity = graph.entities[key];
          return entity ? entity.name : key;
        });

      const recentCount = theme.appearances.filter((d) => d >= recentCutoff).length;
      const contextStr = topCoEntities.length
        ? ` Connected: ${topCoEntities.join(", ")}.`
        : "";

      lines.push(
        `- **${theme.name}** — ${theme.count} entries, ${recentCount} recent.${contextStr}`
      );
    }
    lines.push("");
  }

  // -------------------------------------------------------------------------
  // 2. Fading / Possibly Integrated
  // -------------------------------------------------------------------------
  const fading = Object.values(graph.themes)
    .filter((t) => t.trend === "fading" && t.count >= 2)
    .sort((a, b) => b.count - a.count);

  if (fading.length) {
    lines.push(`## 📉 Fading or Integrated`);
    for (const theme of fading.slice(0, 5)) {
      const lastReal = theme.lastSeen !== "unknown" ? theme.lastSeen : null;
      if (lastReal) {
        const gap = daysBetween(lastReal, dateRange.latest);
        lines.push(
          `- **${theme.name}** — last seen ${lastReal} (${gap} days ago). ${theme.count} total appearances.`
        );
      } else {
        lines.push(
          `- **${theme.name}** — ${theme.count} total appearances.`
        );
      }
    }
    lines.push("_Could mean integration complete. Could mean avoidance. Just flagging._\n");
  }

  // -------------------------------------------------------------------------
  // 3. Emerging Clusters — entity pairs whose co-occurrence spiked recently
  // -------------------------------------------------------------------------
  const emergingClusters = findEmergingClusters(graph, midpoint, recentCutoff);

  if (emergingClusters.length) {
    lines.push(`## 🌱 Emerging Clusters`);
    for (const cluster of emergingClusters.slice(0, 4)) {
      lines.push(
        `- **${cluster.a} + ${cluster.b}** — appeared together ${cluster.recentCount} times recently (${cluster.totalCount} total). ${cluster.note}`
      );
    }
    lines.push("");
  }

  // -------------------------------------------------------------------------
  // 4. Entity Spotlight — fastest-growing entity (excluding always-present ones)
  // -------------------------------------------------------------------------
  const spotlight = findEntitySpotlight(graph, recentCutoff);

  if (spotlight) {
    const recentCount = spotlight.appearances.filter((d) => d >= recentCutoff).length;
    lines.push(`## 🔦 Entity Spotlight`);
    lines.push(
      `**${spotlight.name}** — ${recentCount} appearances in the recent window (${spotlight.count} total, since ${spotlight.firstSeen}). Fastest-growing entity.\n`
    );
  }

  // -------------------------------------------------------------------------
  // 5. Recurring Unresolved Questions
  // -------------------------------------------------------------------------
  const recurring = graph.openQuestions.filter((q) => q.count >= 2);

  if (recurring.length) {
    lines.push(`## ❓ Recurring Unresolved`);
    for (const q of recurring.slice(0, 5)) {
      lines.push(`- ${q.question} _(${q.count}x, latest: ${q.appearances[q.appearances.length - 1]})_`);
    }
    lines.push("");
  }

  // -------------------------------------------------------------------------
  // 6. Emotional Weather — shift detection
  // -------------------------------------------------------------------------
  const weather = detectEmotionalWeather(graph, midpoint);

  if (weather) {
    lines.push(`## 🌤️ Emotional Weather`);
    lines.push(weather);
    lines.push("");
  }

  // Footer
  lines.push(`---`);
  lines.push(`_Briefing generated from association graph. The Garden watches itself grow._ 🌿`);

  return lines.join("\n");
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA);
  const b = new Date(dateB);
  return Math.round(Math.abs(b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

interface EmergingCluster {
  a: string;
  b: string;
  recentCount: number;
  totalCount: number;
  note: string;
}

function findEmergingClusters(
  graph: AssociationGraph,
  midpoint: string,
  recentCutoff: string
): EmergingCluster[] {
  // Look at co-occurrence pairs. For each pair, check if their appearances
  // are concentrated in the recent period.
  // We need entity appearances to compute temporal overlap.
  const results: EmergingCluster[] = [];

  // Skip ubiquitous entities
  const skipEntities = new Set(["brother", "brother thunderbird", "sister sphinx", "sphinx", "sister luma", "luma"]);

  for (const pair of graph.coOccurrences) {
    if (pair.count < 2) continue;

    const aKey = normaliseForBriefing(pair.a);
    const bKey = normaliseForBriefing(pair.b);

    // Skip pairs involving always-present entities
    if (skipEntities.has(aKey) || skipEntities.has(bKey)) continue;

    // Check the temporal distribution of co-occurring entries
    // We need to find entries where both appear
    const entityA = graph.entities[aKey] || Object.values(graph.entities).find(e => normaliseForBriefing(e.name) === aKey);
    const themeA = graph.themes[aKey] || Object.values(graph.themes).find(t => normaliseForBriefing(t.name) === aKey);
    const entityB = graph.entities[bKey] || Object.values(graph.entities).find(e => normaliseForBriefing(e.name) === bKey);
    const themeB = graph.themes[bKey] || Object.values(graph.themes).find(t => normaliseForBriefing(t.name) === bKey);

    const datesA = entityA?.appearances || themeA?.appearances || [];
    const datesB = entityB?.appearances || themeB?.appearances || [];

    // Shared dates (approximate co-occurrence)
    const sharedDates = datesA.filter((d) => datesB.includes(d));
    if (sharedDates.length < 2) continue;

    const recentShared = sharedDates.filter((d) => d >= recentCutoff).length;
    const earlyShared = sharedDates.filter((d) => d < midpoint).length;

    // Emerging = most co-occurrences are recent
    if (recentShared >= 2 && recentShared > earlyShared) {
      results.push({
        a: pair.a,
        b: pair.b,
        recentCount: recentShared,
        totalCount: sharedDates.length,
        note: earlyShared === 0
          ? "New pairing — didn't co-occur in earlier entries."
          : "Accelerating — co-occurring more often recently.",
      });
    }
  }

  return results
    .sort((a, b) => b.recentCount - a.recentCount)
    .slice(0, 5);
}

function findEntitySpotlight(
  graph: AssociationGraph,
  recentCutoff: string
): EntityNode | null {
  const skipEntities = new Set(["brother", "brother thunderbird", "sister sphinx", "sphinx", "sister luma", "luma", "the garden"]);

  let best: EntityNode | null = null;
  let bestRecentCount = 0;

  for (const entity of Object.values(graph.entities)) {
    const key = normaliseForBriefing(entity.name);
    if (skipEntities.has(key)) continue;

    const recentCount = entity.appearances.filter((d) => d >= recentCutoff).length;

    if (recentCount > bestRecentCount) {
      bestRecentCount = recentCount;
      best = entity;
    }
  }

  // Only spotlight if meaningfully present recently
  return bestRecentCount >= 2 ? best : null;
}

function detectEmotionalWeather(
  graph: AssociationGraph,
  midpoint: string
): string | null {
  // Split emotions into first-half and second-half
  const firstHalf: Record<string, number> = {};
  const secondHalf: Record<string, number> = {};

  for (const emotion of Object.values(graph.emotions)) {
    const early = emotion.appearances.filter((d) => d <= midpoint).length;
    const late = emotion.appearances.filter((d) => d > midpoint).length;
    if (early > 0) firstHalf[emotion.name] = early;
    if (late > 0) secondHalf[emotion.name] = late;
  }

  const topEarly = Object.entries(firstHalf)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name]) => name);

  const topLate = Object.entries(secondHalf)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name]) => name);

  if (!topEarly.length || !topLate.length) return null;

  // Find what's new in the recent half
  const newEmotions = topLate.filter((e) => !topEarly.includes(e));
  const fadedEmotions = topEarly.filter((e) => !topLate.includes(e));

  const parts: string[] = [];
  parts.push(`Earlier: ${topEarly.join(", ")}. Recent: ${topLate.join(", ")}.`);

  if (newEmotions.length) {
    parts.push(`New in recent window: **${newEmotions.join(", ")}**.`);
  }
  if (fadedEmotions.length) {
    parts.push(`Faded: ${fadedEmotions.join(", ")}.`);
  }

  return parts.join(" ");
}

function normaliseForBriefing(name: string): string {
  return name.trim().toLowerCase();
}
