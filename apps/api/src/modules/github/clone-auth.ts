/**
 * @module clone-auth
 *
 * Thin adapter over the unified token dispatcher in `github.token.ts` for
 * the deploy pipeline. The dispatcher (`tokenFor(userId, purpose, ctx)`)
 * already encodes the full priority chain; this file only translates the
 * deploy-specific `buildStrategy` discriminator into a `purpose`:
 *
 *   - buildStrategy="local"  → tokenFor(..., "local")
 *   - buildStrategy="server" → requireTokenFor(..., "remote")
 *
 * gh CLI tokens are never returned for "remote" — that policy lives in
 * `tokenFor("remote", ...)` and the rejection happens before this
 * function ever sees a token.
 *
 * Token priority (single source of truth — see github.token.ts):
 *   - purpose: "local"  → project > user-pat > gh CLI > App > OAuth
 *   - purpose: "remote" → project > user-pat > App > REFUSE (no gh CLI)
 */

import { type BuildStrategy } from "@repo/core";
import { tokenFor, requireTokenFor, type TokenContext } from "./github.token";
import type { RequestContext } from "../../lib/request-context";

/**
 * Result of build-token resolution:
 *   - `{ token }`        → inject into the clone URL (existing behavior).
 *   - `{ relay: true }`  → no token, but the target server opted into git
 *     credential forwarding: clone via the desktop relay (gh identity, never
 *     persisted on the remote). The orchestrator opens the relay.
 *   - `{}`               → no credential (a local build of a public repo).
 */
export interface BuildGitCredential {
  token?: string;
  relay?: boolean;
}

export async function resolveBuildGitToken(opts: {
  /** Caller's request context. Carries userId + organizationId; org-scoped
   *  App installation lookup uses ctx.organizationId. */
  ctx: RequestContext;
  projectId: string;
  owner?: string | null;
  /** Repo name — threaded to the github-access gate for PER-REPO
   *  authorization (so a member granted only repo X can build X). */
  repo?: string | null;
  buildStrategy: BuildStrategy;
  /**
   * Desktop-only: when a SERVER build has no remote token (no App / PAT),
   * signal `{ relay: true }` instead of throwing — set by the orchestrator only
   * when the operator opted in for THIS deploy (the deploy flow's "Forward my
   * git credentials" choice → `snapshot.forwardGitCredentials`) and it's an
   * eligible (non-docker) server build. The gh token is NOT returned here; it's
   * fetched on demand by the relay's remote helper, so it never lands on the
   * build host.
   */
  allowRelayFallback?: boolean;
}): Promise<BuildGitCredential> {
  const tokenCtx: TokenContext = {
    projectId: opts.projectId,
    owner: opts.owner ?? undefined,
    repo: opts.repo ?? undefined,
  };

  if (opts.buildStrategy === "local") {
    // LOCAL build: clone + build run on THIS host, the token never leaves it,
    // and we're already authenticated via gh — so use the local gh token
    // DIRECTLY, no SaaS App-token fetch. (Same rule as local READS in
    // githubFetch: local op → gh.) Falls through to the full resolver chain
    // (App installation / project PAT / user PAT / OAuth) only when there's no
    // local gh. getLocalGhToken self-guards to null in CLOUD_MODE.
    const { getLocalGhToken } = await import("./github.local-auth");
    const ghToken = await getLocalGhToken();
    if (ghToken) return { token: ghToken };

    const r = await tokenFor(opts.ctx, "local", tokenCtx);
    return r?.token ? { token: r.token } : {};
  }

  // SERVER / REMOTE build: the clone/build runs off this host. Prefer the
  // SaaS-minted App installation token (short-lived, repo-scoped) or a PAT — gh
  // is REFUSED in this chain (HIGH #7: never ship the operator's broad token
  // off-host via the URL).
  const r = await tokenFor(opts.ctx, "remote", tokenCtx);
  if (r?.token) return { token: r.token };

  // No remote token. If the target server opted into credential forwarding,
  // the operator's gh identity is forwarded on demand via the relay (never
  // persisted on the remote) — signal that. Otherwise surface the standard
  // actionable error (requireTokenFor throws when tokenFor is null).
  if (opts.allowRelayFallback) return { relay: true };
  await requireTokenFor(opts.ctx, "remote", tokenCtx);
  // Unreachable: requireTokenFor always throws when no token is resolvable.
  return {};
}
