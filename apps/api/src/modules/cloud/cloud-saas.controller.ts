/**
 * Cloud SaaS controller - runs only in CLOUD_MODE.
 *
 * All imports are top-level (no per-request dynamic imports on hot paths).
 * SaaS owns the Oblien master credentials, auth session management, and
 * handoff code generation.
 *
 *   POST /api/cloud/token           - mint namespace-scoped Oblien tokens
 *   POST /api/cloud/analytics       - proxy Oblien analytics (master client)
 *   POST /api/cloud/edge-proxy      - sync Oblien edge proxy for managed domains
 *   POST /api/cloud/pages           - proxy Oblien pages.create (master client)
 *   POST /api/cloud/preflight       - cloud deployment preflight check
 *   GET  /api/cloud/desktop-handoff - OAuth → one-time code → redirect to desktop
 *   GET  /api/cloud/connect-handoff - OAuth → one-time code → redirect to self-hosted
 *   POST /api/cloud/exchange-code   - exchange code for user + session (no auth)
 */

import type { Context } from "hono";
import crypto from "node:crypto";
import { SYSTEM } from "@repo/core";
import { getUserId } from "../../lib/controller-helpers";
import { auth } from "../../lib/auth";
import { issueNamespaceToken, getOblienClient } from "../../lib/openship-cloud";
import { generateHandoffCode, exchangeHandoffCode } from "../../lib/cloud-auth-proxy";
import { runCloudPreflight } from "../../lib/cloud-preflight";
import * as githubAuth from "../github/github.auth";

// ─── Cloud analytics proxy (master client) ───────────────────────────────────

/**
 * POST /api/cloud/analytics  { operation, domain, params }
 *
 * Local/desktop instances call this to get Oblien analytics.
 * Edge proxies + analytics are account-level - namespace tokens can't access them.
 * The SaaS uses the master Oblien client on behalf of the caller.
 */
export async function analyticsProxy(c: Context) {
  const { operation, domain, params } = await c.req.json<{
    operation: "timeseries" | "requests" | "streamToken";
    domain: string;
    params?: Record<string, unknown>;
  }>();

  if (!operation || !domain) {
    return c.json({ error: "operation and domain are required" }, 400);
  }

  const client = getOblienClient();

  try {
    switch (operation) {
      case "timeseries": {
        const result = await client.analytics.timeseries(domain, params as any);
        return c.json(result);
      }
      case "requests": {
        const result = await client.analytics.requests(domain, params as any);
        return c.json(result);
      }
      case "streamToken": {
        const result = await client.analytics.streamToken(domain);
        return c.json(result);
      }
      default:
        return c.json({ error: "Unknown operation" }, 400);
    }
  } catch (err: unknown) {
    const status = typeof err === "object" && err !== null && "status" in err
      ? (err as { status: number }).status
      : 500;
    const message = err instanceof Error ? err.message : "Analytics request failed";
    c.status(status as 400 | 404 | 500);
    return c.json({ error: message });
  }
}

// ─── Namespace token minting ─────────────────────────────────────────────────

export async function getToken(c: Context) {
  const userId = getUserId(c);
  const result = await issueNamespaceToken(userId);
  return c.json({ data: result });
}

export async function preflight(c: Context) {
  const userId = getUserId(c);
  const body = await c.req.json<{ slug?: string; customDomain?: string }>();
  const result = await runCloudPreflight(userId, {
    slug: body.slug,
    customDomain: body.customDomain,
  });
  return c.json({ data: result });
}

export async function account(c: Context) {
  const user = c.get("user") as
    | { name?: string | null; email?: string | null; image?: string | null }
    | undefined;

  if (!user?.email) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return c.json({
    user: {
      name: user.name ?? user.email,
      email: user.email,
      image: user.image ?? null,
    },
  });
}

// ─── Desktop OAuth handoff ───────────────────────────────────────────────────

/**
 * GET /api/cloud/desktop-handoff?redirect=<url>&state=<state>&code_challenge=<challenge>
 *
 * Security:
 *   - redirect MUST be localhost (desktop callback) - no open redirect
 *   - state is passed through unchanged for CSRF protection
 *   - code_challenge (PKCE S256) is bound to the one-time code
 */
export async function desktopHandoff(c: Context) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: "No active session" }, 401);
  }

  const redirect = c.req.query("redirect");
  if (!redirect) {
    return c.json({ error: "Missing redirect parameter" }, 400);
  }

  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    return c.json({ error: "Invalid redirect URL" }, 400);
  }
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    return c.json({ error: "Redirect must target localhost" }, 400);
  }
  const port = parseInt(url.port || "80", 10);
  if (port < 1024 || port > 65535) {
    return c.json({ error: "Redirect port must be ≥ 1024" }, 400);
  }

  const state = c.req.query("state");
  const codeChallenge = c.req.query("code_challenge");

  const code = await generateHandoffCode(
    {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
      image: session.user.image,
    },
    session.session.token,
    codeChallenge || undefined,
  );

  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return c.redirect(url.toString());
}

// ─── Self-hosted connect handoff ─────────────────────────────────────────────

/**
 * GET /api/cloud/connect-handoff?redirect=<url>
 *
 * Security:
 *   - redirect MUST be HTTPS (no downgrade to HTTP), except localhost
 *   - Codes are single-use with 60s TTL
 */
export async function connectHandoff(c: Context) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: "No active session" }, 401);
  }

  const redirect = c.req.query("redirect");
  if (!redirect) {
    return c.json({ error: "Missing redirect parameter" }, 400);
  }

  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    return c.json({ error: "Invalid redirect URL" }, 400);
  }

  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!isLocalhost && url.protocol !== "https:") {
    return c.json({ error: "Redirect must use HTTPS" }, 400);
  }
  if (isLocalhost) {
    const port = parseInt(url.port || "80", 10);
    if (port < 1024 || port > 65535) {
      return c.json({ error: "Redirect port must be ≥ 1024" }, 400);
    }
  }

  const code = await generateHandoffCode(
    {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
      image: session.user.image,
    },
    session.session.token,
  );

  url.searchParams.set("code", code);
  return c.redirect(url.toString());
}

// ─── Code exchange (no auth - code is the credential) ────────────────────────

export async function exchangeCode(c: Context) {
  const body = await c.req.json<{ code: string; code_verifier?: string }>();
  if (!body.code) {
    return c.json({ error: "Code required" }, 400);
  }

  const result = await exchangeHandoffCode(body.code, body.code_verifier);
  if (!result) {
    return c.json({ error: "Invalid or expired code" }, 401);
  }

  return c.json({ data: result });
}

// ─── Managed edge proxy sync ─────────────────────────────────────────────────

/**
 * POST /api/cloud/edge-proxy  { slug: string, target: string }
 *
 * Self-hosted/desktop instances send just the project slug + target IP.
 * SaaS uses the managed base domain (opsh.io) and creates slug.opsh.io.
 */
export async function syncEdgeProxy(c: Context) {
  const body = await c.req.json<{ slug?: string; target?: string }>();
  if (!body.slug || !body.target) {
    return c.json({ error: "slug and target are required" }, 400);
  }

  const slug = body.slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!slug) {
    return c.json({ error: "Invalid slug" }, 400);
  }

  const baseDomain = SYSTEM.DOMAINS.CLOUD_DOMAIN;
  const hostname = `${slug}.${baseDomain}`;
  const target = body.target.startsWith("http://") || body.target.startsWith("https://")
    ? body.target
    : `http://${body.target}`;

  try {
    const client = getOblienClient();
    const { proxies } = await client.edgeProxy.list();
    const existing = proxies.find(
      (p) => p.slug === slug,
    );

    if (!existing) {
      await client.edgeProxy.create({ name: hostname, slug, domain: baseDomain, target });
    } else {
      if (existing.name !== hostname || existing.slug !== slug || existing.target !== target) {
        await client.edgeProxy.update(existing.id, { name: hostname, slug, target });
      }
      if (existing.status === "disabled") {
        await client.edgeProxy.enable(existing.id);
      }
    }

    return c.json({ ok: true, hostname });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to sync edge proxy";
    const status = typeof err === "object" && err !== null && "status" in err && typeof (err as { status?: unknown }).status === "number"
      ? (err as { status: number }).status
      : 500;
    const code = typeof err === "object" && err !== null && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
    const details = typeof err === "object" && err !== null && "details" in err
      ? (err as { details?: unknown }).details
      : undefined;

    console.error("[CLOUD] Edge proxy sync failed", { slug, baseDomain, target, status, code, details, message });
    c.status(status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500);
    return c.json({ error: message, code, details });
  }
}

// ─── Pages proxy (master client) ─────────────────────────────────────────────

/**
 * POST /api/cloud/pages  { workspace_id, path, name, slug, domain? }
 *
 * Local/desktop instances call this to create an Oblien static page on
 * a shared zone (e.g. `opsh.io`). Page creation on `opsh.io` touches
 * the master account's DNS — namespace tokens can't perform it, so
 * the SaaS executes the call with the master client on the user's
 * behalf. Pages without a `domain` (custom-domain or slug-only) don't
 * need this proxy — the namespace token can create them directly.
 *
 * Returns the raw `{ page }` shape the Oblien SDK returns so the
 * caller can drop it straight into the existing CloudRuntime code path.
 */
export async function pagesProxy(c: Context) {
  const body = await c.req.json<{
    workspace_id?: string;
    path?: string;
    name?: string;
    slug?: string;
    domain?: string;
  }>();

  if (!body.workspace_id || !body.path || !body.name || !body.slug) {
    return c.json({ error: "workspace_id, path, name and slug are required" }, 400);
  }

  try {
    const client = getOblienClient();
    const result = await client.pages.create({
      workspace_id: body.workspace_id,
      path: body.path,
      name: body.name,
      slug: body.slug,
      ...(body.domain ? { domain: body.domain } : {}),
    });
    return c.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Page creation failed";
    const status = typeof err === "object" && err !== null && "status" in err && typeof (err as { status?: unknown }).status === "number"
      ? (err as { status: number }).status
      : 500;
    const code = typeof err === "object" && err !== null && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
    const details = typeof err === "object" && err !== null && "details" in err
      ? (err as { details?: unknown }).details
      : undefined;

    console.error("[CLOUD] Pages proxy failed", { slug: body.slug, domain: body.domain, status, code, details, message });
    c.status(status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500);
    return c.json({ error: message, code, details });
  }
}

// ─── GitHub App proxy (cloud-mode only — holds the App private key) ─────────
//
// These endpoints are what self-hosted instances call via cloud-client.ts.
// All App credentials (GITHUB_APP_ID, GITHUB_PRIVATE_KEY) live here in cloud
// mode and never leave — local just hands off (userId, request) and receives
// resolved data back. Local never sees the JWT, never signs anything.
//
// `cloudSessionAuth` middleware (applied on the routes file) resolves the
// caller's Better-Auth user from their session token; `getUserId(c)` returns
// that user's id. Each cloud user's installations / OAuth identity are
// already managed by the existing local github code paths, so we just reuse
// them — this controller is a thin policy/translation layer.

// One-shot install states (in-memory, 5-min TTL). Used to round-trip from
// install-url → exchange-code: cloud mints a state, the GitHub install
// callback comes back to the local instance which presents the state to
// exchange-code; cloud verifies it matches the issuing user. Stops a leaked
// callback URL from being replayed against a different user's account.
interface InstallStateRow {
  userId: string;
  expiresAt: number;
}
const installStates = new Map<string, InstallStateRow>();
const INSTALL_STATE_TTL_MS = 5 * 60 * 1000;

function issueInstallState(userId: string): string {
  // Sweep expired entries on every issue — cheap with a small Map.
  const now = Date.now();
  for (const [k, v] of installStates) {
    if (v.expiresAt <= now) installStates.delete(k);
  }
  const token = crypto.randomBytes(16).toString("base64url");
  installStates.set(token, { userId, expiresAt: now + INSTALL_STATE_TTL_MS });
  return token;
}

function consumeInstallState(state: string, userId: string): boolean {
  const row = installStates.get(state);
  if (!row) return false;
  installStates.delete(state); // single-use
  if (row.expiresAt <= Date.now()) return false;
  return row.userId === userId;
}

/**
 * POST /api/cloud/github/install-url
 * Returns the central App's installation URL plus a one-time state token
 * scoped to this cloud user. Local presents the state back at exchange-code.
 */
export async function githubInstallUrl(c: Context) {
  const userId = getUserId(c);
  const state = issueInstallState(userId);
  return c.json({
    data: {
      url: githubAuth.getInstallUrl(),
      state,
    },
  });
}

/**
 * POST /api/cloud/github/exchange-code  { code, state }
 *
 * The "code" here isn't a GitHub OAuth code — it's the installation_id
 * (or whatever opaque token) the local callback received after the user
 * approved the install on github.com. The state token binds the exchange
 * to the user who initiated the install (CSRF defense + replay defense).
 *
 * After verification, we hit GitHub for the user's full installations
 * list (reusing the standard getUserInstallations path) and return it.
 */
export async function githubExchangeCode(c: Context) {
  const userId = getUserId(c);
  const body = await c.req.json<{ code?: string; state?: string }>();
  if (!body.state || !consumeInstallState(body.state, userId)) {
    return c.json({ error: "Invalid or expired install state" }, 401);
  }

  // Fetch the user's installations fresh from GitHub via the
  // existing helper. The local DB write inside getUserInstallations
  // updates the cloud-side cache; the response shape mirrors what
  // cloudGithubInstallations() will return for subsequent calls.
  const installations = await githubAuth.getUserInstallations(userId);
  return c.json({
    data: {
      installations: installations.map((i) => ({
        id: i.id,
        login: i.account.login,
        avatarUrl: i.account.avatar_url,
        type: i.account.type,
      })),
    },
  });
}

/**
 * GET /api/cloud/github/installations
 * The cloud user's current installations. Read-through to GitHub via the
 * standard getUserInstallations path which also refreshes the DB cache.
 */
export async function githubInstallations(c: Context) {
  const userId = getUserId(c);
  const installations = await githubAuth.getUserInstallations(userId);
  return c.json({
    data: installations.map((i) => ({
      id: i.id,
      login: i.account.login,
      avatarUrl: i.account.avatar_url,
      type: i.account.type,
    })),
  });
}

/**
 * POST /api/cloud/github/installation-token  { installationId?, owner, repos? }
 *
 * Mints a short-lived (~60min) installation access token for the given
 * owner. Cloud signs the JWT with its private key and hits GitHub's
 * /access_tokens endpoint. Local uses the returned token directly
 * against github.com for the actual git clone — cloud never sees the
 * source code.
 */
export async function githubInstallationToken(c: Context) {
  const userId = getUserId(c);
  const body = await c.req.json<{
    installationId?: number;
    owner?: string;
    repos?: string[];
  }>();
  if (!body.owner) {
    return c.json({ error: "owner is required" }, 400);
  }

  const token = await githubAuth
    .getInstallationToken(userId, body.owner, body.installationId)
    .catch(() => null);
  if (!token) {
    return c.json(
      { error: `No GitHub App installation found for ${body.owner}` },
      404,
    );
  }

  // getInstallationToken caches the token for 50min; the returned
  // expiresAt is approximate — clients should not rely on it being
  // exact. The cloud-client refreshes ~5min before this.
  return c.json({
    data: {
      token,
      expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
    },
  });
}

/**
 * GET /api/cloud/github/user-status
 * The cloud-resolved OAuth identity (login, avatar) for the calling user.
 * Local renders this in the GitHub settings panel; the OAuth account itself
 * lives in cloud's Better-Auth, NOT in the self-hosted instance.
 */
export async function githubUserStatus(c: Context) {
  const userId = getUserId(c);
  const status = await githubAuth.getUserStatus(userId);
  if (!status.connected) {
    return c.json({ data: { connected: false as const } });
  }
  return c.json({
    data: {
      connected: true as const,
      login: status.login,
      avatarUrl: status.avatar_url,
      id: status.id,
    },
  });
}

