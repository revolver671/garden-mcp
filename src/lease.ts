/**
 * Estate-wide verb-layer lease.
 *
 * Spec: athena/verb-layer-lease-spec-v1.md (rulings landed 29 Aug 2026).
 * One lease for the whole estate (R1). Yield on contention, uniform (R2).
 * TTL 20 min default, 30 ceiling, unlimited renewal (R3).
 *
 * The Durable Object's single-threaded execution is the atomic acquire.
 * One named instance ("estate") holds the only lease. Expired leases die
 * in place: every entry point clears an expired record before acting, so
 * the next acquire finds the slot free without a timer.
 *
 * The refusal log lives here too. Garden-side gate refusals and acquire
 * contentions are recorded (capped ring). Box-side lease_required
 * refusals never reach this object; they live in the box audit logs.
 * That split is stated in the build record, not hidden.
 */

export interface LeaseRecord {
  token: string; // 128-bit random hex, returned only to the acquirer
  holder: string; // free-text label: session kind + slot, or "live"
  purpose: string; // one line
  acquired_at: string; // ISO
  expires_at: string; // ISO
  renewals: number;
}

interface RefusalLine {
  at: string;
  act: string;
  reason: string;
  holder_at_time: string; // current holder label, or "none"
}

const TTL_DEFAULT_S = 1200; // 20 minutes — R3
const TTL_CEILING_S = 1800; // 30 minutes — R3
const REFUSAL_CAP = 200;

function randomToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function clampTtl(ttl_s: number | undefined): number {
  if (!ttl_s || !Number.isFinite(ttl_s) || ttl_s <= 0) return TTL_DEFAULT_S;
  return Math.min(Math.floor(ttl_s), TTL_CEILING_S);
}

export class LeaseDO {
  state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async logRefusal(act: string, reason: string, holder: string): Promise<void> {
    const log = ((await this.state.storage.get<RefusalLine[]>("refusals")) ?? []);
    log.push({ at: new Date().toISOString(), act, reason, holder_at_time: holder });
    while (log.length > REFUSAL_CAP) log.shift();
    await this.state.storage.put("refusals", log);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();

    let lease = (await this.state.storage.get<LeaseRecord>("lease")) ?? null;
    if (lease && Date.parse(lease.expires_at) <= now) {
      await this.state.storage.delete("lease");
      lease = null;
    }

    const json = (o: unknown, status = 200) =>
      new Response(JSON.stringify(o), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    const holderView = lease
      ? {
          held: true,
          holder: lease.holder,
          purpose: lease.purpose,
          acquired_at: lease.acquired_at,
          expires_at: lease.expires_at,
          renewals: lease.renewals,
        }
      : { held: false };

    // ---- reads -----------------------------------------------------------

    if (request.method === "GET" && url.pathname === "/status") {
      return json(holderView);
    }

    if (request.method === "GET" && url.pathname === "/refusals") {
      const log = ((await this.state.storage.get<RefusalLine[]>("refusals")) ?? []);
      return json({ count: log.length, refusals: log });
    }

    if (request.method === "GET" && url.pathname === "/validate") {
      const token = url.searchParams.get("token") ?? "";
      const act = url.searchParams.get("act") ?? "unnamed";
      if (!token) {
        await this.logRefusal(act, "lease_required", lease ? lease.holder : "none");
        return json({ valid: false, reason: "lease_required", ...holderView });
      }
      if (!lease) {
        // No current lease: the caller's token is dead. From a legitimate
        // caller's seat the lease expired; a never-issued token gets the
        // same answer on purpose (no oracle for guessing).
        await this.logRefusal(act, "lease_expired", "none");
        return json({ valid: false, reason: "lease_expired", held: false });
      }
      if (token !== lease.token) {
        await this.logRefusal(act, "lease_invalid", lease.holder);
        return json({ valid: false, reason: "lease_invalid", ...holderView });
      }
      return json({ valid: true, ...holderView });
    }

    // ---- writes ----------------------------------------------------------

    if (request.method === "POST" && url.pathname === "/acquire") {
      const body = (await request.json().catch(() => ({}))) as {
        holder?: string;
        purpose?: string;
        ttl_s?: number;
      };
      const holder = (body.holder ?? "").trim() || "unnamed";
      const purpose = (body.purpose ?? "").trim() || "unstated";
      if (lease) {
        await this.logRefusal("lease_acquire", "lease_held", lease.holder);
        return json(
          {
            error: "lease_held",
            holder: lease.holder,
            purpose: lease.purpose,
            expires_at: lease.expires_at,
          },
          409
        );
      }
      const ttl = clampTtl(body.ttl_s);
      const rec: LeaseRecord = {
        token: randomToken(),
        holder,
        purpose,
        acquired_at: new Date(now).toISOString(),
        expires_at: new Date(now + ttl * 1000).toISOString(),
        renewals: 0,
      };
      await this.state.storage.put("lease", rec);
      return json({
        token: rec.token,
        holder: rec.holder,
        purpose: rec.purpose,
        acquired_at: rec.acquired_at,
        expires_at: rec.expires_at,
        ttl_s: ttl,
      });
    }

    if (request.method === "POST" && url.pathname === "/renew") {
      const body = (await request.json().catch(() => ({}))) as {
        token?: string;
        ttl_s?: number;
      };
      if (!lease) {
        await this.logRefusal("lease_renew", "lease_expired", "none");
        return json({ error: "lease_expired" }, 410);
      }
      if ((body.token ?? "") !== lease.token) {
        await this.logRefusal("lease_renew", "lease_invalid", lease.holder);
        return json({ error: "lease_invalid" }, 403);
      }
      const ttl = clampTtl(body.ttl_s);
      lease.expires_at = new Date(now + ttl * 1000).toISOString();
      lease.renewals += 1;
      await this.state.storage.put("lease", lease);
      return json({
        expires_at: lease.expires_at,
        renewals: lease.renewals,
        ttl_s: ttl,
      });
    }

    if (request.method === "POST" && url.pathname === "/release") {
      const body = (await request.json().catch(() => ({}))) as { token?: string };
      if (!lease) {
        // The TTL already freed it. Refusing tells the caller the truth:
        // their hold ended before they released it.
        await this.logRefusal("lease_release", "lease_expired", "none");
        return json({ error: "lease_expired", note: "lease already free" }, 410);
      }
      if ((body.token ?? "") !== lease.token) {
        await this.logRefusal("lease_release", "lease_invalid", lease.holder);
        return json({ error: "lease_invalid" }, 403);
      }
      await this.state.storage.delete("lease");
      return json({ released: true, holder: lease.holder });
    }

    return json({ error: "no_such_route" }, 404);
  }
}

/** One call shape for the worker side: talk to the single estate instance. */
export async function leaseFetch(
  ns: DurableObjectNamespace,
  path: string,
  init?: RequestInit
): Promise<{ status: number; body: any }> {
  const stub = ns.get(ns.idFromName("estate"));
  const res = await stub.fetch("https://lease.internal" + path, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
