"use client";

import React from "react";
import Link from "next/link";
import {
  Github,
  Lock,
  Globe,
  Plus,
  Link2,
  BookOpen,
  Zap,
  GitBranch,
  Sparkles,
  Cloud,
  Terminal,
  Shield,
} from "lucide-react";
import type { GitHubRepo, GitHubConnectionState } from "@/context/GitHubContext";

type Tab = "local" | "repositories" | "url" | "template";

interface LibrarySidebarProps {
  selectedOwner: string;
  repos: GitHubRepo[];
  onSwitchTab: (tab: Tab) => void;
  /** Self-hosted or desktop instance — drives the dual-source UI. */
  selfHosted: boolean;
  /** Canonical GitHub connection state — the only thing this card needs. */
  state: GitHubConnectionState;
  /** Whether the local instance is connected to Openship Cloud. Drives
   *  the "safer remote cloning" CTA card. */
  cloudConnected: boolean;
}

export function LibrarySidebar({
  selectedOwner,
  repos,
  onSwitchTab,
  selfHosted,
  state,
  cloudConnected,
}: LibrarySidebarProps) {
  const connected = state.primary !== null;
  const publicCount = repos.filter((r) => !r.private).length;
  const privateCount = repos.filter((r) => r.private).length;

  return (
    <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
      {/* ── Connection status ─────────────────────────────────────
          SaaS mode (!selfHosted) → single card: Openship GitHub App.
          Self-hosted/desktop → gh CLI primary + Openship Cloud optional. */}
      {selfHosted ? (
        <SelfHostedConnectionCard
          state={state}
          cloudConnected={cloudConnected}
          selectedOwner={selectedOwner}
        />
      ) : (
        <SaasConnectionCard state={state} selectedOwner={selectedOwner} />
      )}

      {/* Stats (when connected) */}
      {connected && repos.length > 0 && (
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <div className="flex items-center gap-2 mb-4">
            <BookOpen className="size-4 text-muted-foreground" />
            <h3 className="font-semibold text-foreground text-sm">Overview</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <GitBranch className="size-4 text-primary" />
                </div>
                <span className="text-sm text-muted-foreground">Total</span>
              </div>
              <span className="text-lg font-semibold text-foreground">{repos.length}</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                  <Globe className="size-4 text-blue-500" />
                </div>
                <span className="text-sm text-muted-foreground">Public</span>
              </div>
              <span className="text-lg font-semibold text-foreground">{publicCount}</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-orange-500/10 flex items-center justify-center">
                  <Lock className="size-4 text-orange-500" />
                </div>
                <span className="text-sm text-muted-foreground">Private</span>
              </div>
              <span className="text-lg font-semibold text-foreground">{privateCount}</span>
            </div>
          </div>
        </div>
      )}

      {/* Quick Tip */}
      <div className="bg-gradient-to-br from-primary/5 via-primary/3 to-transparent rounded-2xl border border-primary/10 p-5">
        <div className="flex items-center gap-2 mb-3">
          <Zap className="size-4 text-primary" />
          <h3 className="font-semibold text-foreground text-sm">Quick Tip</h3>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Select any repository to deploy it instantly. Configure automatic deployments on every push.
        </p>
      </div>

      {/* Quick Actions */}
      <div className="bg-card rounded-2xl border border-border/50 p-5">
        <div className="flex items-center gap-2 mb-4">
          <Plus className="size-4 text-muted-foreground" />
          <h3 className="font-semibold text-foreground text-sm">Quick Actions</h3>
        </div>
        <div className="space-y-2">
          <button
            onClick={() => onSwitchTab("repositories")}
            className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-foreground bg-foreground/[0.04] hover:bg-foreground/[0.08] transition-colors"
          >
            <Github className="size-4 text-muted-foreground" />
            Import from GitHub
          </button>
          <button
            onClick={() => onSwitchTab("url")}
            className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] transition-colors"
          >
            <Link2 className="size-4" />
            Import from URL
          </button>
          <button
            onClick={() => onSwitchTab("template")}
            className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] transition-colors"
          >
            <Sparkles className="size-4" />
            Start from Template
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Connection cards ───────────────────────────────────────────────────────

/**
 * SaaS connection card. In CLOUD_MODE the Openship GitHub App is the
 * only credential source — there's no gh CLI on the SaaS server.
 */
function SaasConnectionCard({
  state,
  selectedOwner,
}: {
  state: GitHubConnectionState;
  selectedOwner: string;
}) {
  const connected = state.sources.openshipApp.connected;
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="flex items-center gap-2 mb-4">
        <Github className="size-4 text-muted-foreground" />
        <h3 className="font-semibold text-foreground text-sm">Connection</h3>
      </div>
      <SourceRow
        icon={Github}
        label="Openship GitHub App"
        sublabel={
          connected
            ? state.sources.openshipApp.login ?? selectedOwner ?? "Connected"
            : "Not connected"
        }
        connected={connected}
      />
    </div>
  );
}

/**
 * Self-hosted / desktop connection card. Per the architecture rules:
 *   - gh CLI is the PRIMARY source of truth for listing.
 *   - Openship Cloud App is the OPTIONAL secondary source that mints
 *     safer short-lived install tokens for remote cloning.
 *
 * Both rows read straight from the canonical state — no derivation,
 * no parallel booleans, no suppression-flag handling in the UI.
 */
function SelfHostedConnectionCard({
  state,
  cloudConnected,
  selectedOwner,
}: {
  state: GitHubConnectionState;
  cloudConnected: boolean;
  selectedOwner: string;
}) {
  const cliConnected = state.sources.ghCli.available;
  const cliLogin = state.sources.ghCli.login;
  const appConnected = state.sources.openshipApp.connected;
  const appLogin = state.sources.openshipApp.login;

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="flex items-center gap-2 mb-4">
        <Github className="size-4 text-muted-foreground" />
        <h3 className="font-semibold text-foreground text-sm">Connection</h3>
      </div>

      <div className="space-y-2.5">
        {/* PRIMARY: gh CLI */}
        <SourceRow
          icon={Terminal}
          label="gh CLI"
          sublabel={cliConnected ? `@${cliLogin}` : "Run `gh auth login`"}
          connected={cliConnected}
          tone="primary"
        />

        {/* SECONDARY: Openship Cloud App */}
        <SourceRow
          icon={Cloud}
          label="Openship Cloud App"
          sublabel={
            appConnected
              ? `@${appLogin ?? selectedOwner ?? "connected"}`
              : cloudConnected
                ? "Install the GitHub App"
                : "Connect Openship Cloud for safer remote clones"
          }
          connected={appConnected}
          tone="secondary"
        />
      </div>

      {/* Footnote: tells the user WHY two sources */}
      {!appConnected && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-border/40 bg-muted/30 px-3 py-2.5">
          <Shield className="size-3.5 text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-xs text-muted-foreground leading-relaxed">
            Remote deploys on Openship Cloud use short-lived, App-scoped
            tokens.{" "}
            <Link
              href="/settings"
              className="font-medium text-foreground hover:underline"
            >
              {cloudConnected ? "Install GitHub App" : "Connect Openship Cloud"}
            </Link>
            .
          </p>
        </div>
      )}
    </div>
  );
}

function SourceRow({
  icon: Icon,
  label,
  sublabel,
  connected,
  tone = "primary",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  sublabel: string;
  connected: boolean;
  tone?: "primary" | "secondary";
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2.5 min-w-0">
        <div
          className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
            connected ? "bg-emerald-500/10" : "bg-muted/60"
          }`}
        >
          <Icon
            className={`size-4 ${
              connected
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-muted-foreground"
            }`}
          />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground truncate">
            {label}
            {tone === "secondary" && (
              <span className="ml-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                Optional
              </span>
            )}
          </p>
          <p className="text-xs text-muted-foreground truncate">{sublabel}</p>
        </div>
      </div>
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 ${
          connected
            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "bg-muted/60 text-muted-foreground"
        }`}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            connected ? "bg-emerald-500" : "bg-muted-foreground/40"
          }`}
        />
        {connected ? "Connected" : "—"}
      </span>
    </div>
  );
}
