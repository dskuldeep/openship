"use client";

/**
 * `useCloneStrategyGate` — hook reporting whether the unified
 * `<DeployCredentialModal>` should prompt the user before this deploy.
 *
 * The actual UI lives in
 * `@/components/deployments/DeployCredentialModal`. This file used to
 * also export `CloneStrategyModalContent`; that was merged into the
 * unified modal and removed.
 *
 * Scope:
 *   - deployTarget === "server" → may prompt
 *   - deployTarget === "cloud"  → never prompts (Opshcloud handles its
 *                                  own connect-account flow via
 *                                  requireCloud)
 *   - deployTarget === "local"  → never prompts (no remote clone)
 *
 * The choice is persisted on `userSettings.cloneStrategyPreference`.
 * Once anything but "prompt" is on the user, `needsPrompt` is false on
 * every subsequent deploy. `<DeployCredentialModal>` writes that
 * preference for us when `trigger="preflight-gate"`.
 */

import { useEffect, useState } from "react";
import { settingsApi, type CloneStrategyPreference } from "@/lib/api";

interface CloneStrategyGateResult {
  /** True when this deploy SHOULD prompt before continuing. */
  needsPrompt: boolean;
  /** Latest preference value (null while initial fetch is in flight). */
  preference: CloneStrategyPreference | null;
  /** True if the user has already saved a global PAT. */
  hasGlobalToken: boolean;
}

export function useCloneStrategyGate(
  deployTarget: "local" | "server" | "cloud" | null | undefined,
): CloneStrategyGateResult {
  const [preference, setPreference] = useState<CloneStrategyPreference | null>(null);
  const [hasGlobalToken, setHasGlobalToken] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await settingsApi.get();
        if (cancelled) return;
        setPreference(res.cloneStrategyPreference);
        setHasGlobalToken(res.cloneToken.hasToken);
      } catch {
        // Silent — gate is purely informational.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ONLY self-hosted server deploys see the prompt. Opshcloud has its
  // own connect-account flow via `requireCloud`; we don't need a clone
  // token there. Local builds never need a remote clone credential.
  const needsPrompt = deployTarget === "server" && preference === "prompt";

  return { needsPrompt, preference, hasGlobalToken };
}
