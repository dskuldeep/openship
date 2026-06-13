"use client";

import { useCallback, useEffect, useState } from "react";
import { Key, Loader2, Check, Trash2, Eye, EyeOff } from "lucide-react";
import { settingsApi, type CloneCredentialsState } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { SettingsSection } from "./SettingsSection";

/**
 * GitHub clone credentials - user-global PAT for cloning private repos.
 *
 * This is the second tier in the clone resolver chain (after per-project
 * tokens) and the recommended escape hatch when the user doesn't want to
 * install the GitHub App. Stored encrypted server-side; the server never
 * echoes the token back so the UI only sees `{ hasToken, setAt, asDefault }`.
 */
export function CloneCredentials() {
  const { showToast } = useToast();
  const [state, setState] = useState<CloneCredentialsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [tokenInput, setTokenInput] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [togglingDefault, setTogglingDefault] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await settingsApi.get();
      setState(res.cloneToken);
    } catch {
      // Silent - section just shows empty.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    const trimmed = tokenInput.trim();
    if (!trimmed) {
      showToast("Paste a token before saving", "error", "Clone credentials");
      return;
    }
    // Light validation - accept classic ghp_, fine-grained github_pat_, or
    // long opaque tokens (gh CLI / device-flow). We don't reject anything;
    // just warn if the prefix looks off so paste typos don't silently fail.
    const looksLikeGitHubToken =
      /^ghp_/.test(trimmed) || /^github_pat_/.test(trimmed) || trimmed.length >= 40;
    if (!looksLikeGitHubToken) {
      showToast(
        "That doesn't look like a GitHub token. Save anyway if you're sure.",
        "error",
        "Clone credentials",
      );
    }
    setSaving(true);
    try {
      const next = await settingsApi.updateCloneCredentials({
        token: trimmed,
        // Default to using-as-default if user is setting one explicitly.
        // They can toggle off afterward.
        asDefault: state?.asDefault ?? true,
      });
      setState({ hasToken: next.hasToken, setAt: next.setAt, asDefault: next.asDefault });
      setTokenInput("");
      setEditing(false);
      showToast("Clone token saved", "success", "Clone credentials");
    } catch (err) {
      showToast(getApiErrorMessage(err, "Failed to save token"), "error", "Clone credentials");
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    try {
      const next = await settingsApi.updateCloneCredentials({ token: null });
      setState({ hasToken: next.hasToken, setAt: next.setAt, asDefault: next.asDefault });
      setTokenInput("");
      setEditing(false);
      showToast("Clone token cleared", "success", "Clone credentials");
    } catch (err) {
      showToast(getApiErrorMessage(err, "Failed to clear token"), "error", "Clone credentials");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleDefault = async (next: boolean) => {
    setTogglingDefault(true);
    try {
      const updated = await settingsApi.updateCloneCredentials({ asDefault: next });
      setState({ hasToken: updated.hasToken, setAt: updated.setAt, asDefault: updated.asDefault });
    } catch (err) {
      showToast(getApiErrorMessage(err, "Failed to update default"), "error", "Clone credentials");
    } finally {
      setTogglingDefault(false);
    }
  };

  return (
    <SettingsSection
      icon={Key}
      title="GitHub clone credentials"
      description="Personal token used to clone private repos when the GitHub App isn't installed"
      iconBg="bg-violet-500/10"
      iconColor="text-violet-500"
    >
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <Loader2 className="size-4 animate-spin" />
          Loading…
        </div>
      ) : (
        <div className="space-y-3.5">
          <p className="text-sm text-muted-foreground">
            Paste a GitHub personal access token (classic or fine-grained). The
            clone module uses it as the second-priority credential - after any
            per-project override, before the GitHub App installation token.
          </p>

          {!state?.hasToken || editing ? (
            <div className="space-y-2">
              <div className="relative">
                <input
                  type={showToken ? "text" : "password"}
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="ghp_… or github_pat_…"
                  spellCheck={false}
                  autoComplete="off"
                  className="h-10 w-full rounded-xl border border-border/50 bg-muted/20 px-3 pr-10 text-sm font-mono text-foreground outline-none transition-colors focus:border-primary/40"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 size-7 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors"
                  aria-label={showToken ? "Hide token" : "Show token"}
                >
                  {showToken ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || !tokenInput.trim()}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                  Save token
                </button>
                {editing && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(false);
                      setTokenInput("");
                    }}
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-foreground/[0.06] px-3.5 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1]"
                  >
                    Cancel
                  </button>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                For private repos, give the token the <span className="font-mono">repo</span> scope
                (classic) or fine-grained read access to the repos you want to deploy.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-border/50 bg-muted/15 p-3.5 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">Token saved</p>
                  <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                    Last updated{" "}
                    {state.setAt
                      ? new Date(state.setAt).toLocaleString()
                      : "just now"}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-foreground/[0.06] px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1]"
                  >
                    Replace
                  </button>
                  <button
                    type="button"
                    onClick={handleClear}
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-red-500/10 px-3 py-1.5 text-[12px] font-medium text-red-600 transition-colors hover:bg-red-500/20 dark:text-red-400 disabled:opacity-50"
                  >
                    <Trash2 className="size-3" />
                    Clear
                  </button>
                </div>
              </div>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={state.asDefault}
                  onChange={(e) => handleToggleDefault(e.target.checked)}
                  disabled={togglingDefault}
                  className="mt-0.5 size-4 rounded border-border/60 accent-primary"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">
                    Use as default clone token
                  </span>
                  <span className="block text-[12px] text-muted-foreground/80 mt-0.5 leading-relaxed">
                    When on, the clone module uses this token as the second tier in the chain
                    (after per-project overrides). When off, the token is stored but not used -
                    handy if you only want it active for specific deploys.
                  </span>
                </span>
              </label>
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
