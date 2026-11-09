// frozen_part.ts -- the frozen-part wall for the build record, worker-side
// (dispatch 773). The garden keeps its build record in dated parts
// (athena/build-state-YYYY-MM-DD-partNN.md); athena/build-state-INDEX.md names
// the one live part on its "THE LIVE BUILD RECORD IS" line, and every other
// part is frozen -- on 1 Oct a seat appended to part73 for an hour after
// INDEX had moved to part74. Dispatch 692 put the same rule in tools/garden,
// but the MCP memory_append verb and a direct /rw/append never pass through
// that script, and the worker trims the path where the client did not, so a
// trailing space stepped around the client's check (692 break B1). The wall
// belongs where the write happens. One module with no import statements, so
// it transpiles and runs alone, as state_http.ts and lease_http.ts do; the
// hook patch that calls it is README-frozen-part.md in this directory.

// The path as the worker's own roResolve reads it (src/index.ts ~l.1565):
// trimmed, backslash folded to /, trailing / stripped. Percent-decoding is
// already done by the time the worker holds the path (URLSearchParams for
// /rw/append, the MCP SDK for memory_append), so it is not repeated here.
// Used only to decide whether the frozen-part rule applies and to compare
// against the live part: a shape the resolver would refuse anyway -- an empty
// segment from "athena//build-state-...", a leading slash -- never matches
// BUILD_PART_RE and so reads as not a build part, and the resolver has
// already refused it upstream of any write.
function norm(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

const BUILD_PART_RE = /^athena\/build-state-.+\.md$/i;
const INDEX_PATH = "athena/build-state-INDEX.md";
const LIVE_MARK = "THE LIVE BUILD RECORD IS";
// The live-path shape tools/garden (l.411) reads: lazy, stopped by
// whitespace, a backtick, a quote, and the markdown that would wrap a name.
const LIVE_PART_RE = /athena\/build-state-[^\s`'"*<>()]+?\.md/g;

/** True for an athena/build-state-*.md part, never for the INDEX. */
export function isBuildPart(path: string): boolean {
  const p = norm(path);
  return BUILD_PART_RE.test(p) && p.toLowerCase() !== INDEX_PATH.toLowerCase();
}

/**
 * The one athena/build-state-*.md path INDEX names live, or null when the
 * text is null, carries no "THE LIVE BUILD RECORD IS" line, or names no
 * single part (two lines naming two parts, or two parts on one line, are no
 * single live part). The INDEX itself, named on its own LIVE line, is not a
 * candidate.
 */
export function livePart(indexText: string | null): string | null {
  if (indexText === null) return null;
  const lives = new Set<string>();
  for (const line of indexText.split("\n")) {
    if (!line.includes(LIVE_MARK)) continue;
    for (const m of line.matchAll(LIVE_PART_RE)) {
      if (m[0] !== INDEX_PATH) lives.add(m[0]);
    }
  }
  return lives.size === 1 ? [...lives][0] : null;
}

/**
 * The frozen-part rule (773), or null if the append may go: null when the
 * path is not a build part, or when it is the one part INDEX names live
 * (compared as the worker resolves the path, case-insensitively -- an R2 key
 * is case-sensitive, but ".MD" and ".md" of the live part are one record in
 * the INDEX's spelling and the forker's hand). Otherwise one line naming the
 * live part, or -- when INDEX could not be read, carries no LIVE line, or
 * names no single part -- the fail-closed line: an unreadable or ambiguous
 * INDEX refuses every build part, exactly as tools/garden's client check
 * does. The way out is the caller's: --frozen-ok in tools/garden, the
 * estate lease on the memory_append verb.
 */
export function frozenPartFault(
  path: string,
  indexText: string | null
): string | null {
  if (!isBuildPart(path)) return null;
  const live = livePart(indexText);
  if (live === null) {
    return "frozen_part: build-state-INDEX.md names no single live part; refusing (fail closed)";
  }
  if (norm(path).toLowerCase() === live.toLowerCase()) return null;
  return `frozen_part: ${path} is frozen; the live part is ${live}`;
}