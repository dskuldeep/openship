/**
 * @module github.token
 *
 * THE single source of truth for "what GitHub token do I use for this
 * action?". Every place in the codebase that needs a token reaches into
 * `tokenFor(userId, purpose, ctx)` and that's the whole answer.
 *
 * Two purposes. That's it.
 *
 * ─── purpose: "local" ───────────────────────────────────────────────
 *
 *   The token stays on THIS machine. Used for:
 *     - Repo + org listing
 *     - Reading file contents / branches
 *     - Local-build clones (clone runs on this API host)
 *     - Generic GitHub API calls
 *
 *   Self-hosted priority:
 *     1. Project clone token (per-project override — user explicitly set)
 *     2. User-global clone token (when marked as default)
 *     3. gh CLI                ← source of truth per the user's rule
 *     4. Openship App installation (if owner has one)
 *     5. User OAuth (Better-Auth)
 *     6. null
 *
 *   SaaS priority:
 *     1. Project clone token
 *     2. User-global clone token
 *     3. Openship App installation
 *     4. User OAuth
 *     5. null
 *
 * ─── purpose: "remote" ──────────────────────────────────────────────
 *
 *   The token RIDES OFF this machine to a remote build worker / cloud
 *   workspace. Used for:
 *     - Remote-build clones (cloud workspace clones the repo)
 *
 *   Safest tokens only. **gh CLI is REFUSED** — it's a long-lived,
 *   broad-scope user PAT; shipping it off the host is a real security
 *   hole. Same priority on SaaS + self-hosted:
 *
 *     1. Project clone token
 *     2. User-global clone token
 *     3. Openship App installation (short-lived, repo-scoped)
 *     4. null  ← caller throws "install App or set per-project token"
 *
 * The dispatcher returns `{ token, source }` so callers (logging,
 * audit, metrics) know exactly which step in the chain matched. The
 * full priority chain lives here and ONLY here.
 */

import { repos } from "@repo/db";
import { AppError } from "@repo/core";
import { env } from "../../config/env";
import { decrypt } from "../../lib/encryption";
import { getInstallationId, getInstallationToken, getUserToken } from "./github.auth";
import { getLocalGhToken } from "./github.local-auth";

// ─── Public types ───────────────────────────────────────────────────────────

export type GitHubPurpose = "local" | "remote";

export type GitHubTokenSource =
  | "project"          // per-project clone_token_encrypted
  | "user-pat"         // user_settings clone_token_encrypted (cloneTokenAsDefault=true)
  | "gh-cli"           // local gh CLI token
  | "app-installation" // Openship App installation token (short-lived, scoped)
  | "user-oauth";      // Better-Auth GitHub OAuth (rare fallback)

export interface TokenResult {
  token: string;
  source: GitHubTokenSource;
}

export interface TokenContext {
  /** Repo owner — required for App installation token resolution. */
  owner?: string;
  /** Override the installation id (rare; usually inferred from owner). */
  installationId?: number;
  /** Project id — for per-project clone token lookup. */
  projectId?: string;
}

// ─── The dispatcher ─────────────────────────────────────────────────────────

/**
 * Resolve a GitHub token for the given purpose. Side-effect free —
 * only DB reads + decrypt + (optionally) an installation token mint.
 * Returns null when every chain step came up empty; callers decide
 * whether to throw or proceed (use `requireTokenFor` for the throw).
 */
export async function tokenFor(
  userId: string,
  purpose: GitHubPurpose,
  ctx: TokenContext = {},
): Promise<TokenResult | null> {
  // ── User overrides — same priority in every mode/purpose ──────────
  // These are CLI tokens the user explicitly provisioned. Safe for any
  // purpose (the user accepted the scope policy when they pasted them).
  if (ctx.projectId) {
    const t = await readProjectToken(ctx.projectId);
    if (t) return { token: t, source: "project" };
  }
  const userPat = await readUserGlobalToken(userId);
  if (userPat) return { token: userPat, source: "user-pat" };

  // ── Backend-resolved priority ─────────────────────────────────────
  // CLOUD_MODE = SaaS = no gh CLI on this machine ever; the App is
  // the only auto-resolved source.
  if (env.CLOUD_MODE) {
    if (ctx.owner) {
      const t = await getInstallationToken(userId, ctx.owner, ctx.installationId).catch(
        () => null,
      );
      if (t) return { token: t, source: "app-installation" };
    }
    // For non-owner-scoped calls (e.g. /user/repos in OAuth fallback)
    const oauth = await getUserToken(userId);
    if (oauth) return { token: oauth, source: "user-oauth" };
    return null;
  }

  // SELF-HOSTED — purpose actually matters here.
  if (purpose === "local") {
    // Per user's rule: gh CLI is the source of truth in self-hosted.
    // If logged in, it wins over App. App + OAuth are fallbacks.
    const cli = await getLocalGhToken();
    if (cli) return { token: cli, source: "gh-cli" };
    if (ctx.owner) {
      const t = await getInstallationToken(userId, ctx.owner, ctx.installationId).catch(
        () => null,
      );
      if (t) return { token: t, source: "app-installation" };
    }
    const oauth = await getUserToken(userId);
    if (oauth) return { token: oauth, source: "user-oauth" };
    return null;
  }

  // purpose === "remote" in self-hosted
  // gh CLI is REFUSED. App installation is the only auto-resolved token
  // that's safe to ship to a remote worker (short-lived, repo-scoped).
  if (ctx.owner) {
    const t = await getInstallationToken(userId, ctx.owner, ctx.installationId).catch(
      () => null,
    );
    if (t) return { token: t, source: "app-installation" };
  }
  return null;
}

/**
 * Fast existence check — "could `tokenFor` resolve a token if we asked
 * it to?". Skips the actual installation-token mint (JWT + GitHub API
 * exchange, ~200–500ms) which `tokenFor` does for the App branch; this
 * version only confirms the installation ROW exists in our DB.
 *
 * Use this in preflight where minting is wasteful — the real mint
 * happens later in the build pipeline when we actually need the token.
 *
 * Returns the source that WOULD be matched, or null if none would.
 * The returned source is enough for callers that want to log which
 * credential type was used; an actual token value is NOT exposed.
 */
export async function canResolveTokenFor(
  userId: string,
  purpose: GitHubPurpose,
  ctx: TokenContext = {},
): Promise<GitHubTokenSource | null> {
  // 1. Per-project clone token — DB read only, no mint.
  if (ctx.projectId) {
    const project = await repos.project.findById(ctx.projectId).catch(() => null);
    if (project?.cloneTokenEncrypted) return "project";
  }

  // 2. User-global clone token (DB read only).
  const settings = await repos.settings.findByUser(userId).catch(() => null);
  if (settings?.cloneTokenEncrypted && settings.cloneTokenAsDefault) return "user-pat";

  // 3. Self-hosted "local" purpose — gh CLI wins over App when present.
  //    getLocalGhToken does shell out (~50–150ms) but no GitHub API.
  if (!env.CLOUD_MODE && purpose === "local") {
    const cli = await getLocalGhToken();
    if (cli) return "gh-cli";
  }

  // 4. App installation — existence check only (DB row + small cache).
  //    Both SaaS and self-hosted, both purposes.
  if (ctx.owner) {
    const installId = await getInstallationId(userId, ctx.owner).catch(() => null);
    if (installId) return "app-installation";
  }

  // 5. OAuth fallback — only on the paths where tokenFor uses it.
  //    SaaS: both purposes. Self-hosted: purpose=local only.
  //    Note: purpose=remote in self-hosted does NOT fall through to OAuth.
  if (env.CLOUD_MODE || purpose === "local") {
    const oauth = await getUserToken(userId).catch(() => null);
    if (oauth) return "user-oauth";
  }

  return null;
}

/**
 * Same as `tokenFor`, but throws an actionable AppError when nothing
 * can be resolved. Use this at deploy/clone entry points where missing
 * credentials are a real "do something" condition.
 */
export async function requireTokenFor(
  userId: string,
  purpose: GitHubPurpose,
  ctx: TokenContext = {},
): Promise<TokenResult> {
  const r = await tokenFor(userId, purpose, ctx);
  if (r) return r;

  const hint =
    purpose === "remote"
      ? "Install the Openship GitHub App on this owner, or set a per-project clone token in Settings."
      : "Run `gh auth login`, connect Openship Cloud, or set a per-project clone token in Settings.";

  throw new AppError(
    `No GitHub token available for ${ctx.owner ?? "this request"} (purpose: ${purpose}). ${hint}`,
    403,
    purpose === "remote" ? "GITHUB_REMOTE_TOKEN_REQUIRED" : "GITHUB_TOKEN_REQUIRED",
  );
}

// ─── Internal helpers ──────────────────────────────────────────────────────

async function readProjectToken(projectId: string): Promise<string | null> {
  const project = await repos.project.findById(projectId).catch(() => null);
  if (!project?.cloneTokenEncrypted) return null;
  try {
    return decrypt(project.cloneTokenEncrypted);
  } catch {
    return null;
  }
}

async function readUserGlobalToken(userId: string): Promise<string | null> {
  const settings = await repos.settings.findByUser(userId).catch(() => null);
  if (!settings?.cloneTokenEncrypted) return null;
  if (!settings.cloneTokenAsDefault) return null;
  try {
    return decrypt(settings.cloneTokenEncrypted);
  } catch {
    return null;
  }
}
