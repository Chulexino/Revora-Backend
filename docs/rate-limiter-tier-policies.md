# Rate Limiter Tier Policies (BE-011)

## Overview

Revora-Backend enforces a **multi-tier sliding-window rate limit** on the
`POST /api/v1/startup/register` endpoint.  The policy provides three tiers of
access, each with distinct quotas, so internal infrastructure and verified
partners are not penalised by the conservative public default while still
providing a hard upper bound against abuse.

```
 ┌────────────────────────────────────────────────────────────────────────────┐
 │  POST /api/v1/startup/register                                             │
 │                                                                            │
 │  x-revora-rate-tier ──► resolveTier() ──► InMemoryRateLimitStore           │
 │  x-revora-tier-secret      │                    │                          │
 │                            ▼                    ▼                          │
 │           ┌──────────┬──────────┬──────────┐  fixed-window counter        │
 │           │ standard │ trusted  │ internal │  per (keyPrefix + IP)         │
 │           │  5/15min │ 10/15min │ 25/15min │                               │
 │           └──────────┴──────────┴──────────┘                               │
 │                            │                                               │
 │              quota OK? ────┴──► handler (201)                              │
 │              quota exceeded? ──► 429 + Retry-After                         │
 └────────────────────────────────────────────────────────────────────────────┘
```

---

## Tiers and Limits

| Tier         | Request Limit | Window     | Description                                        |
| :----------- | :------------ | :--------- | :------------------------------------------------- |
| **standard** | 5             | 15 minutes | Default for any public IP address.                 |
| **trusted**  | 10            | 15 minutes | Verified external partners with a valid secret.    |
| **internal** | 25            | 15 minutes | Revora internal infrastructure and tooling.        |

---

## Implementation

### Middleware: `createStartupAuthTierLimiter`

Located in [`src/middleware/startupAuthRateTierPolicy.ts`](../src/middleware/startupAuthRateTierPolicy.ts).

```
/**
 * @notice Builds the startup-auth tier resolution and enforcement middleware.
 *
 * @dev    Tier resolution is a two-step process:
 *         1. Read `x-revora-rate-tier` from the request header.
 *         2. Validate the shared secret in `x-revora-tier-secret` against
 *            the `STARTUP_AUTH_TIER_SECRET` environment variable.
 *         Any failure at step 2 silently falls back to "standard".
 *
 * @param  options.store            Optional custom RateLimitStore (default: InMemoryRateLimitStore).
 * @param  options.tierSecretEnvName  Name of the env var holding the shared secret
 *                                  (default: "STARTUP_AUTH_TIER_SECRET").
 * @return { middleware, resolveTier, reset }
 */
```

The returned `middleware` is mounted directly on the route:

```typescript
const startupTierLimiter = createStartupAuthTierLimiter();

apiRouter.post(
  "/startup/register",
  startupTierLimiter.middleware,
  createStartupRegisterHandler(),
);
```

### Core Rate Limit Engine: `createRateLimitMiddleware`

Located in [`src/middleware/rateLimit.ts`](../src/middleware/rateLimit.ts).

```
/**
 * @notice Fixed-window rate-limit middleware.
 *
 * @dev    Window is keyed by `keyPrefix + ":" + "ip:" + req.ip`.
 *         Counters are stored in InMemoryRateLimitStore (process-local).
 *         On every request the middleware sets:
 *           X-RateLimit-Limit     — configured maximum
 *           X-RateLimit-Remaining — remaining in the current window (≥ 0)
 *           X-RateLimit-Reset     — UTC epoch seconds when the window resets
 *         On breach:
 *           Retry-After — seconds until the window resets
 *           429 Too Many Requests — JSON body with error message
 */
```

---

## Request Headers

| Header                   | Required for tier  | Description                                            |
| :----------------------- | :----------------- | :----------------------------------------------------- |
| `x-revora-rate-tier`     | `trusted`, `internal` | Requested tier (`standard`, `trusted`, or `internal`). |
| `x-revora-tier-secret`   | `trusted`, `internal` | Shared secret authenticating the elevated tier.        |

### Tier Resolution Logic (pseudocode)

```
resolveTier(req):
  tier ← lowercase(header("x-revora-rate-tier")) or ""
  if tier not in ["trusted", "internal"]:
    return "standard"
  secret ← env("STARTUP_AUTH_TIER_SECRET").trim()
  provided ← header("x-revora-tier-secret").trim()
  if secret is empty or provided ≠ secret:
    return "standard"      ← fail-safe downgrade, no error revealed
  return tier
```

---

## Response Headers

These headers are set on **every** request, including those that are blocked:

| Header                | Value                                                         |
| :-------------------- | :------------------------------------------------------------ |
| `X-RateLimit-Limit`   | Maximum requests allowed in the window for the resolved tier. |
| `X-RateLimit-Remaining` | Requests remaining (never negative).                        |
| `X-RateLimit-Reset`   | UTC epoch seconds when the window resets.                     |
| `X-RateLimit-Tier`    | The resolved tier name (`standard`, `trusted`, `internal`).   |
| `Retry-After`         | Seconds to wait (**only on 429 responses**).                  |

### 429 Response Body

```json
{
  "code": "TOO_MANY_REQUESTS",
  "message": "Too many registration attempts, please try again after 15 minutes.",
  "details": { "retryAfter": 1234567890 }
}
```

---

## Security Assumptions

The following seven assumptions must hold for the rate limiter to provide its
intended security guarantees:

1. **`x-revora-rate-tier` is untrusted client input** (Req 10.1): The tier
   header is always treated as untrusted input from the network. It is never
   acted upon unless it is accompanied by a valid matching secret. An attacker
   can freely set any value in this header without gaining elevated access.

2. **Elevated tiers require a matching shared secret** (Req 10.2): `trusted`
   and `internal` tiers are activated only when the `x-revora-tier-secret`
   header exactly matches `process.env.STARTUP_AUTH_TIER_SECRET` (after
   trimming). Any other value — including no value — results in a silent
   downgrade.

3. **Missing or invalid secret causes silent downgrade to standard** (Req 10.3):
   An absent, empty, or mismatched secret always results in `standard` tier
   resolution. The server never returns an error that distinguishes "wrong
   secret" from "no secret", preventing oracle attacks. Clients learn only that
   a 201 was returned as standard-tier.

4. **`app.set('trust proxy', 1)` must be set for stable IP keying** (Req 10.4):
   The application must be deployed with `app.set('trust proxy', 1)` for
   `req.ip` to correctly reflect the real client IP behind a reverse proxy. If
   this is not configured, all traffic through a proxy may appear to come from
   a single IP, making per-IP limits ineffective. This setting is already
   applied in `createApp()` in `src/index.ts`.

5. **In-memory store is process-local; multi-instance deployments require a
   shared store** (Req 10.5): The default `InMemoryRateLimitStore` is
   **process-local**. In a multi-instance or horizontally-scaled deployment,
   counters are not shared between instances, so the effective rate limit is
   `numInstances × perInstanceLimit`. Replace the store with a Redis-backed
   implementation (using `INCR`/`EXPIRE`) before horizontal scale-out by
   implementing the `RateLimitStore` interface documented below.

6. **Tier elevation is gated on a shared secret pattern** (Req 10.2,
   additional context): `STARTUP_AUTH_TIER_SECRET` is a shared secret — it
   is not a substitute for request-level JWT authentication. Protect it with
   the same care as a signing key: store in secrets management (not committed
   to VCS), rotate at least quarterly, and use ≥ 32 random bytes of entropy.

7. **No per-user isolation** (informational): The limiter keys by client IP,
   not by user identity. Authenticated user IDs should be layered on top if
   per-account isolation is required in future tiers.

---

## Abuse Scenarios and Failure Paths

### Abuse Scenarios (Req 10.6)

| Scenario | Behaviour | Mitigation |
| :------- | :-------- | :--------- |
| **Header spoofing**: attacker sends `x-revora-rate-tier: trusted` with a wrong secret | Silently downgraded to `standard`; attacker's IP consumes from the standard counter only | No tier privilege gained; attacker burns their own quota |
| **Invalid tier names** (e.g. `vip`, `superadmin`): any value not in `["trusted", "internal"]` | Treated as `standard` | Silently downgraded; no error message leaks tier names |
| **Cross-tier counter exhaustion**: attacker sends spoofed trusted requests to exhaust standard quota | Once standard counter is full, further spoofed requests receive 429. Real trusted requests (correct secret) continue from their own counter. | Key isolation via `keyPrefix` per tier prevents cross-tier bleed |
| **IP rotation**: attacker rotates through many source IPs to bypass per-IP limit | Each IP maintains its own independent counter | Deploy a WAF / IP reputation layer upstream for volumetric attacks |
| **Brute-forcing the tier secret**: attacker submits many trusted-tier requests with guessed secrets | Each attempt consumes a standard-tier slot (5 guesses per 15 min per IP) | Keep the secret ≥ 32 random bytes; rotate regularly |
| **Flooding without a tier header**: attacker sends standard-tier requests at volume | Exhausts their IP quota after 5 requests; 429 thereafter | Intended behaviour; escalate to WAF if volume is infrastructure-level |

### Failure Paths (Req 10.7)

| Failure | Behaviour |
| :------- | :-------- |
| `STARTUP_AUTH_TIER_SECRET` env var not set | All elevated tier requests fall back to `standard` — safe default, no error returned |
| Provided secret contains leading/trailing whitespace | Both the env var value and header value are trimmed before comparison; whitespace-only differences are ignored |
| Process restart | In-memory counters reset; a brief fresh-burst window exists during rolling deploys — mitigated by keeping window ≤ 15 min |
| Store `increment()` throws unexpectedly | Uncaught exception propagates to the Express error handler → 500. Implementors of custom stores should catch internal errors and either re-throw as an `AppError` or fail-open with `{ count: 1, resetAt: Date.now() + windowMs }` |
| Upstream load balancer strips custom headers | `x-revora-rate-tier` absent → `standard` tier (safe); `x-revora-tier-secret` absent → standard downgrade |
| Missing `req.ip` (proxy not configured) | Falls back to `req.socket.remoteAddress`; if also undefined, falls back to the literal key `"unknown"`. All traffic maps to one bucket — tightest possible limit |

---

## `RateLimitStore` Interface for Distributed Deployments (Req 11.2–11.6)

The built-in `InMemoryRateLimitStore` is suitable for single-process
deployments and local development. For production horizontal scale-out,
implement the `RateLimitStore` interface against a shared backing store
(Redis, Memcached, etc.) and pass it via `options.store`.

### Interface Contract

```typescript
/**
 * Interface for rate-limit counter storage.
 *
 * Implementations MUST be safe to call concurrently from multiple async
 * Express handlers within the same process.  For distributed deployments,
 * the store MUST also be safe across multiple process instances.
 */
export interface RateLimitStore {
  /**
   * Increment the counter for `key` within the current fixed window and
   * return the updated state.
   *
   * - If no window exists for `key`, start a new window expiring at
   *   `Date.now() + windowMs` and return `{ count: 1, resetAt }`.
   * - If an active window exists, increment and return its current count
   *   and original `resetAt`.
   * - After expiry (`Date.now() >= resetAt`), start a fresh window.
   *
   * @param key       Scoped rate-limit key (includes `keyPrefix` and IP/sub).
   * @param windowMs  Duration of a single fixed window in milliseconds.
   * @returns         `{ count, resetAt }` — count MUST be ≥ 1; resetAt is
   *                  a UTC epoch millisecond timestamp.
   */
  increment(key: string, windowMs: number): { count: number; resetAt: number };

  /**
   * Reset (delete) the counter for `key`.
   *
   * Called on `limiter.reset()` in tests.  Implementations MUST NOT throw
   * if `key` does not exist.
   *
   * @param key  The key to clear.
   */
  reset(key: string): void;

  /**
   * Clear ALL counters in the store (optional, primarily for tests).
   *
   * Implementations MAY omit this method for production stores where a
   * full flush would be destructive.
   */
  clear?(): void;
}
```

### Redis-backed Example Sketch

```typescript
import Redis from "ioredis";
import { RateLimitStore } from "./rateLimit";

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Redis) {}

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    // NOTE: For a production implementation use a Lua script to make
    //       INCR + PEXPIRE atomic.
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.pexpire(key, windowMs);
    }
    const pttl = await this.redis.pttl(key);
    const resetAt = Date.now() + Math.max(0, pttl);
    return { count, resetAt };
  }

  reset(key: string): void {
    void this.redis.del(key);
  }
}
```

> **Note**: The example above is not atomic. For production use, wrap the
> `INCR`+`PEXPIRE` in a Lua script or use a library such as `rate-limiter-flexible`
> that handles atomicity for you.

### Error Handling for Custom Stores

When a custom store encounters an internal error (network timeout, connection
refused, etc.), it SHOULD either:

- **Fail-open**: Return `{ count: 1, resetAt: Date.now() + windowMs }` — the
  request is allowed; limits become temporarily unenforced but availability
  is preserved.
- **Fail-closed**: Throw an `AppError` (e.g. `Errors.serviceUnavailable(...)`) 
  — the request is rejected with 503; limits are enforced but availability
  is impacted.

The choice depends on your availability vs. security trade-off. For registration
endpoints protecting against brute-force, **fail-closed is preferred**.

---

## Environment Variables

| Variable                  | Required | Description                                                    |
| :------------------------ | :------- | :------------------------------------------------------------- |
| `STARTUP_AUTH_TIER_SECRET` | No      | Shared secret for `trusted`/`internal` tier elevation. Absent = all requests treated as `standard`. |

---

## Deployment Checklist

- [ ] Set `STARTUP_AUTH_TIER_SECRET` in the deployment secrets store (not in `.env` committed to VCS).
- [ ] Configure `app.set('trust proxy', 1)` (already done in `createApp`).
- [ ] For multi-instance deployments: swap `InMemoryRateLimitStore` for a Redis-backed store.
- [ ] Rotate `STARTUP_AUTH_TIER_SECRET` at least once per quarter.
- [ ] Add WAF-level IP rate limiting upstream for large-scale volumetric attack mitigation.

---

## Test Coverage

All behaviours documented above are covered in:

- **Unit tests** (middleware only, no HTTP):
  [`src/middleware/startupAuthRateTierPolicy.test.ts`](../src/middleware/startupAuthRateTierPolicy.test.ts)
  — 454 lines, covers tier resolution, quota enforcement per tier, header
  correctness, spoofed-secret downgrade, and store isolation.

- **Integration tests** (full HTTP stack via `createApp`):
  [`src/routes/health.test.ts`](../src/routes/health.test.ts) — `Rate Limiter Tier
  Policies (BE-011)` describe block covers all three tiers, header presence,
  downgrade on wrong/absent secret, quota boundary conditions, cross-tier
  counter isolation, health-endpoint isolation, and 429 body format.

- **Core rate-limit engine tests**:
  [`src/middleware/rateLimit.test.ts`](../src/middleware/rateLimit.test.ts)
  — 380 lines, covers `InMemoryRateLimitStore` lifecycle, per-IP and per-user
  keying, `Retry-After` header, `keyPrefix` isolation, and IP fallback paths.

---

## Related Documents

- [`docs/startup-auth-brute-force-mitigation.md`](startup-auth-brute-force-mitigation.md)
- [`docs/startup-auth-service.md`](startup-auth-service.md)
- [`docs/password-reset-rate-controls.md`](password-reset-rate-controls.md)
