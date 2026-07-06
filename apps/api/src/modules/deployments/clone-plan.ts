/**
 * Single source of truth for the CLONE decision: where the repo gets cloned and
 * what credential that clone needs.
 *
 * This was previously derived independently in two places — the build pipeline
 * (`cloneOnServer` + the git-token purpose) and preflight (`dockerClonesOnServer`
 * + the remote-clone credential checks). Because the same decision was computed
 * from slightly different expressions, they drifted: preflight would pass a
 * config the pipeline then rejected (e.g. an api-host clone that preflight knew
 * was local, but the pipeline demanded a remote App/PAT token for). Both callers
 * now go through `resolveClonePlan`, so preflight verifies exactly what the
 * pipeline will do.
 *
 * The "credential actually available? → fall back to api-host" adjustment stays
 * in the pipeline (`effectiveCloneOnServer`) because it depends on the resolved
 * token, which is runtime state, not config.
 */

export interface ClonePlanInput {
  /** Resolved deploy target for this build. */
  effectiveTarget: "local" | "server" | "cloud";
  /** Target server id (server deploys only). */
  serverId?: string | null;
  /** Resolved runtime is bare (host process) vs docker (sandbox). The pipeline
   *  passes `runtime.name === "bare"`; preflight passes `runtimeMode === "bare"`
   *  — each from its own source, kept as an input so neither has to know the
   *  other's variable. */
  runtimeIsBare: boolean;
  /** Per-deploy clone strategy for docker/server deploys ("api-host" default). */
  cloneStrategy?: "api-host" | "server" | null;
  /** Where the BUILD runs — used only to decide the clone's credential purpose
   *  (a local build always clones on this machine). */
  buildStrategy?: "local" | "server";
  /** Whether this instance is the desktop app (relay is desktop-only). */
  isDesktop: boolean;
  /** Per-deploy opt-in to forward the operator's git identity to the server. */
  forwardGitCredentials?: boolean | null;
}

export interface ClonePlan {
  /** The clone runs directly on the deploy server — bare always, docker on the
   *  explicit "clone on the server" opt-in. (Pipeline's `cloneOnServer`.) */
  runsOnServer: boolean;
  /** The DOCKER-only on-server clone (excludes bare, which has its own hard-fail
   *  preflight checks). This is preflight's warn-case. */
  dockerClonesOnServer: boolean;
  /** The clone runs on the api-host / orchestrator (local to it) — so the local
   *  gh identity is valid and no shippable token is required. */
  runsLocally: boolean;
  /** BuildStrategy to resolve the clone credential with (resolveBuildGitToken):
   *  "local" → local gh / broad resolver chain; "server" → shippable App/PAT. */
  cloneBuildStrategy: "local" | "server";
  /** Desktop relay eligible: forward the operator's gh identity to the server for
   *  an on-server clone (nothing persisted). Requires the desktop app + opt-in. */
  relayEligible: boolean;
}

export function resolveClonePlan(input: ClonePlanInput): ClonePlan {
  const onServer = input.effectiveTarget === "server";

  // Pipeline: the clone runs on the server (bare always; docker on opt-in).
  const runsOnServer =
    onServer && !!input.serverId && (input.runtimeIsBare || input.cloneStrategy === "server");

  // Preflight warn-case: DOCKER (non-bare) opted into an on-server clone. Bare is
  // handled by the separate hard-fail remote-build checks, so it's excluded here.
  const dockerClonesOnServer =
    onServer && !input.runtimeIsBare && input.cloneStrategy === "server";

  // The clone's credential purpose follows WHERE THE CLONE RUNS, not where the
  // build runs: a local build clones on this machine, and a server deploy that
  // isn't cloning on the server clones on the api-host (both local → gh OK).
  // Everything else (on-server clone, cloud workspace clone) is off-host → remote.
  //
  // runsLocally MUST imply !runsOnServer — otherwise a contradictory config
  // (buildStrategy="local" + cloneStrategy="server") would tag an on-server clone
  // as local and ship the operator's local gh/OAuth token off-host to the remote.
  const runsLocally = !runsOnServer && (input.buildStrategy === "local" || onServer);

  return {
    runsOnServer,
    dockerClonesOnServer,
    runsLocally,
    cloneBuildStrategy: runsLocally ? "local" : "server",
    relayEligible: runsOnServer && input.isDesktop && input.forwardGitCredentials === true,
  };
}
