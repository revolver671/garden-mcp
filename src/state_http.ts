// state_http.ts -- the garden worker's STATE write door (dispatch 242).
// Serves POST /rw/state?path=athena/STATE.md: the live state page, rewritten
// whole every 15 minutes by athena-state.timer. Since 537 it serves exactly one
// more constant path, athena/deliverables-facts.md (the map's generated facts
// companion, `garden put-facts`), with its own cap. Since 911 it serves
// athena/ARRIVAL.md too, tools/arrive's page put every run by gen_state (881),
// at the same cap as deliverables-facts.md. Keyed exactly as /rw/append
// (the same GARDEN_WRITE_KEY, no new secret). One module with no import
// statements, so it can be transpiled and driven without the worker, as
// lease_http.ts is. The order is the order /rw/append uses: the method, then
// the key, then the destination, then the body -- and it never logs a body,
// a key or a path other than a constant one.

// The door's whole reach: each destination byte for byte, with its body cap.
// A list of pairs, not an object: an object lookup would answer `constructor`
// or `__proto__` with something truthy, and the write must go to the constant
// string found here, never to the query value.
const DOORS: ReadonlyArray<readonly [string, number]> = [
  ["athena/STATE.md", 6144],
  ["athena/deliverables-facts.md", 16384],
  ["athena/ESTATE.md", 40960],
  // 911: athena/ARRIVAL.md, tools/arrive's page put by gen_state every run
  // (881). Same 16384 B cap as deliverables-facts.md.
  ["athena/ARRIVAL.md", 16384],
];

export async function handleStateHttp(
  request: Request,
  env: any,
  url: URL,
  deps: {
    // The annotations are deliberately loose (`any` params): the deps are the
    // worker's own functions (roKeyOk, writeFile) and this module must
    // typecheck against whatever shape the worker's Env gives them at the
    // hook site, not the other way round. Their CONTRACTS are exactly as the
    // design says: keyOk(supplied, secret) -> Promise<boolean>, false for a
    // missing side; writeFile(env, path, content) -> one store write.
    keyOk: (supplied: any, secret?: any) => Promise<boolean>;
    writeFile: (env: any, path: string, content: any) => Promise<unknown>;
  }
): Promise<Response> {
  const deny = (status: number, code: string): Response =>
    new Response(JSON.stringify({ error: code }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  // 1. POST only.
  if (request.method !== "POST") {
    return deny(405, "method_not_allowed");
  }

  // 2. The key, before anything else is looked at.
  if (!(await deps.keyOk(request.headers.get("x-garden-write-key"), env.GARDEN_WRITE_KEY))) {
    return deny(401, "unauthorized");
  }

  // 3. One of the DOORS destinations, byte for byte, with no normalisation.
  //    NOW.md, a sibling room, a subdir, a .bak, lower case, a leading slash,
  //    a backslash, a dot segment, a dot-dot: every one of those is a
  //    DIFFERENT path, and a different path is refused before the body is even
  //    read. There is no canonical form to fall back to: if the caller did not
  //    type one of the constants, it did not mean one.
  const path = url.searchParams.get("path");
  const door = DOORS.find(([p]) => p === path);
  if (door === undefined) {
    return deny(400, "bad_path");
  }
  const [dest, cap] = door;

  // 4. The body, read once, against that destination's cap. The
  //    Content-Length header can lie; the stream cannot.
  const body = await request.text();
  if (body.length > cap) {
    return deny(413, "too_large");
  }

  // 5. One write, to the matched constant, the body as it arrived.
  await deps.writeFile(env, dest, body);
  return new Response(`written: ${dest}\n`, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}