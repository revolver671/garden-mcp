// lease_http.ts -- the garden worker's lease WRITE door (dispatch 147 §2).
// Serves POST /lease/acquire, /lease/release and /lease/renew, keyed exactly
// as /rw/append (the same GARDEN_WRITE_KEY, no new secret), so the chain
// runner can hold a scripted lease without the MCP tools. One module with no
// import statements, so it can be tested without the worker. It never logs a
// body, a token or a key. The order is the order /rw/append uses: the method,
// then the key, then the JSON, then one leaseFetch, then the DO's own status
// passed through unchanged.

export async function handleLeaseHttp(
  request: Request,
  env: { LEASE: DurableObjectNamespace; GARDEN_WRITE_KEY?: string },
  url: URL,
  deps: {
    leaseFetch: (ns: DurableObjectNamespace, path: string, init?: RequestInit) => Promise<{ status: number; body: any }>;
    keyOk: (supplied: string | null, secret?: string) => Promise<boolean>;
  }
): Promise<Response> {
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  // 1. POST only.
  if (request.method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  // 2. The key, before leaseFetch is ever called.
  if (!(await deps.keyOk(request.headers.get("x-garden-write-key"), env.GARDEN_WRITE_KEY))) {
    return json(401, { error: "unauthorized" });
  }

  // 3. The body must be a JSON object.
  let body: any;
  try {
    body = await request.json();
  } catch (e) {
    return json(400, { error: "bad_json" });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json(400, { error: "bad_json" });
  }

  // 4. One leaseFetch to the DO -- the same calls the MCP tools make
  //    (src/index.ts ~650-725). acquire clamps nothing here: the DO clamps
  //    ttl_s; this door only defaults it.
  let path = "";
  let payload: unknown;
  if (url.pathname === "/lease/acquire") {
    if (typeof body.purpose !== "string" || body.purpose === "") {
      return json(400, { error: "purpose_required" });
    }
    path = "/acquire";
    payload = {
      purpose: body.purpose,
      holder: typeof body.holder === "string" && body.holder !== "" ? body.holder : "chain",
      ttl_s: typeof body.ttl_s === "number" ? body.ttl_s : 1200,
    };
  } else if (url.pathname === "/lease/release") {
    path = "/release";
    payload = { token: body.token };
  } else if (url.pathname === "/lease/renew") {
    path = "/renew";
    payload = { token: body.token, ttl_s: body.ttl_s };
  } else {
    return json(404, { error: "no_such_route" });
  }
  const r = await deps.leaseFetch(env.LEASE, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  // 5. The DO's answer with its own status, so a 409 keeps holder, purpose
  //    and expires_at, and a 403 or 410 passes through.
  return json(r.status, r.body);
}