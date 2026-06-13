/**
 * @module clone-auth (compat shim)
 *
 * This file used to be the place for clone-token resolution. That logic
 * now lives in ONE place: `github.token.ts` → `tokenFor(userId, purpose, ctx)`.
 *
 * The exports below are thin wrappers preserved so existing callers
 * (`build.service.ts:resolveBuildGitToken`) don't break in this refactor.
 * Once those callers migrate to `tokenFor` directly, this file can be
 * deleted.
 *
 * Token priority (single source of truth — see github.token.ts):
 *   - purpose: "local"  → project > user-pat > gh CLI > App > OAuth
 *   - purpose: "remote" → project > user-pat > App > REFUSE (no gh CLI)
 */

import { type BuildStrategy } from "@repo/core";
import {
  tokenFor,
  requireTokenFor,
  type GitHubTokenSource,
  type TokenContext,
} from "./github.token";

// ─── Back-compat types ─────────────────────────────────────────────────────

/** Sources the old `resolveCloneToken` could return. The new dispatcher
 *  uses a slightly different union (see GitHubTokenSource in github.token.ts);
 *  this re-export keeps the existing imports stable. */
export type CloneTokenSource = GitHubTokenSource | "mode-default" | "none";

export interface CloneTokenResult {
  token: string | null;
  source: CloneTokenSource;
}

export interface ResolveCloneTokenOpts {
  projectId: string;
  userId: string;
  owner?: string | null;
}

// ─── Wrappers around tokenFor ──────────────────────────────────────────────

/**
 * Resolve a clone token for a LOCAL build.
 * → `tokenFor(userId, "local", ctx)`.
 */
export async function resolveCloneToken(
  opts: ResolveCloneTokenOpts,
): Promise<CloneTokenResult> {
  const ctx: TokenContext = {
    projectId: opts.projectId,
    owner: opts.owner ?? undefined,
  };
  const r = await tokenFor(opts.userId, "local", ctx);
  if (!r) return { token: null, source: "none" };
  return { token: r.token, source: r.source };
}

/**
 * Resolve a clone token for a deploy.
 *   - `buildStrategy="local"`  → `tokenFor(..., "local")`
 *   - `buildStrategy="server"` → `requireTokenFor(..., "remote")` (throws on miss)
 *
 * gh CLI tokens are NEVER returned for `server` builds — that policy is
 * encoded inside `tokenFor("remote", ...)` and refused before this
 * function ever sees a token.
 */
export async function resolveBuildGitToken(opts: {
  userId: string;
  projectId: string;
  owner?: string | null;
  buildStrategy: BuildStrategy;
}): Promise<string | null> {
  const ctx: TokenContext = {
    projectId: opts.projectId,
    owner: opts.owner ?? undefined,
  };

  if (opts.buildStrategy === "local") {
    const r = await tokenFor(opts.userId, "local", ctx);
    return r?.token ?? null;
  }

  // Remote — throw if nothing resolvable. requireTokenFor builds an
  // actionable error message with the right hint per purpose.
  const r = await requireTokenFor(opts.userId, "remote", ctx);
  return r.token;
}
