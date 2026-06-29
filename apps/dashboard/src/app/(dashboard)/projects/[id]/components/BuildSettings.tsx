import React, { useState } from "react";
import { Inbox, Layers, ArrowRight, Pencil, KeyRound, Cpu } from "lucide-react";
import { useRouter } from "next/navigation";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { encodeLocalSlug, encodeRepoSlug } from "@/utils/repoSlug";
import { EnvVarsEditor } from "./EnvVarsEditor";

/**
 * Project → Runtime tab. READ-ONLY by design.
 *
 * Config (build/runtime/env) has a single edit owner: the deploy wizard. This
 * tab only DISPLAYS the project's current configuration and links to the wizard
 * (opened with ?projectId) for any change — so editing never lives in two
 * places and every change goes through the create-a-new-version flow.
 *
 * Visual shell (SectionCard + ICON_TONES) mirrors the sibling settings tabs
 * (GitSettings / BackupSettings / DomainSettings) so the tab fills the same
 * column width and reads as part of the same design system.
 */

const ICON_TONES = {
  primary: "bg-primary/10 text-primary",
  emerald: "bg-emerald-500/10 text-emerald-500",
  orange: "bg-orange-500/10 text-orange-500",
  amber: "bg-amber-500/10 text-amber-500",
  red: "bg-red-500/10 text-red-500",
  muted: "bg-muted/60 text-muted-foreground",
} as const;

function SectionCard({
  icon: Icon,
  iconTone = "primary",
  title,
  description,
  actions,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  iconTone?: keyof typeof ICON_TONES;
  title: string;
  description: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-card">
      <div className={`flex items-start gap-3 px-5 py-4 ${children ? "border-b border-border/40" : ""}`}>
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${ICON_TONES[iconTone]}`}>
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      {children ? <div className="px-5 py-4">{children}</div> : null}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value?: React.ReactNode;
  mono?: boolean;
}) {
  const empty = value === undefined || value === null || value === "";
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <span className="shrink-0 text-[12px] text-muted-foreground">{label}</span>
      <span
        className={`min-w-0 break-all text-right text-[13px] font-medium text-foreground ${mono ? "font-mono tabular-nums" : ""}`}
      >
        {empty ? <span className="text-muted-foreground/40">—</span> : value}
      </span>
    </div>
  );
}

export const BuildSettings = () => {
  const { buildData, projectData, servicesData, id } = useProjectSettings();
  const router = useRouter();
  const [envOpen, setEnvOpen] = useState(false);

  const isWebmail = projectData?.framework === "webmail";
  const isCloud = projectData?.deployTarget === "cloud";
  const services = servicesData.services;
  const hasServices = services.length > 0;
  const monorepoCount = services.filter((s) => s.kind === "monorepo").length;
  const composeCount = services.length - monorepoCount;

  // Edit = the deploy wizard, rehydrated from this project. The single place
  // config is editable; this tab never mutates it.
  const hasRepo = Boolean(projectData?.gitOwner && projectData?.gitRepo);
  const editSlug = hasRepo
    ? encodeRepoSlug(projectData!.gitOwner!, projectData!.gitRepo!)
    : projectData?.localPath
      ? encodeLocalSlug(projectData.localPath)
      : null;
  const openWizard = () => {
    // mode=config → the wizard SAVES config (no deploy); see Sidebar handleSave.
    if (editSlug) router.push(`/deploy/${editSlug}?projectId=${id}&mode=config`);
  };

  const EditButton = () =>
    editSlug ? (
      <button
        type="button"
        onClick={openWizard}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
      >
        <Pencil className="size-3.5" />
        Edit
      </button>
    ) : null;

  // ── Webmail: fully managed, nothing to show or edit. ──────────────────
  if (isWebmail) {
    return (
      <div className="space-y-5">
        <SectionCard
          icon={Inbox}
          iconTone="muted"
          title="Managed by openship"
          description="Webmail uses a fixed build and start pipeline — install, build, and run commands are not configurable. Redeploy from the mail overview to pick up upstream changes."
        />
      </div>
    );
  }

  // ── Service-based project: config lives per-service in the Services tab. ──
  if (hasServices) {
    const serviceLabel =
      monorepoCount && composeCount
        ? `${monorepoCount} sub-app${monorepoCount === 1 ? "" : "s"} and ${composeCount} compose service${composeCount === 1 ? "" : "s"}`
        : monorepoCount
          ? `${monorepoCount} sub-app${monorepoCount === 1 ? "" : "s"}`
          : `${composeCount} compose service${composeCount === 1 ? "" : "s"}`;
    return (
      <div className="space-y-5">
        <SectionCard
          icon={Layers}
          iconTone="primary"
          title="Per-service settings"
          description={`This project has ${serviceLabel}. Build commands, framework, ports, and run commands live on each service row — view and edit them in the Services tab.`}
          actions={
            <button
              type="button"
              onClick={() => router.push(`/projects/${id}/services`)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Open Services
              <ArrowRight className="size-3.5" />
            </button>
          }
        />
      </div>
    );
  }

  // ── Single-app: read-only configuration summary. ──────────────────────
  const runtimeModeLabel =
    projectData?.runtimeMode === "docker"
      ? "Sandboxed (container)"
      : projectData?.runtimeMode === "bare"
        ? "Direct (host process)"
        : "Default (resolved at deploy)";

  const cpuCores = projectData?.resources?.production?.cpuCores;
  const memoryMb = projectData?.resources?.production?.memoryMb;

  return (
    <div className="space-y-5">
      <SectionCard
        icon={Cpu}
        iconTone="orange"
        title="Runtime configuration"
        description="Read-only. Edit through the deploy wizard so each change ships as a new version."
        actions={<EditButton />}
      >
        <div className="overflow-hidden rounded-xl border border-border/40 divide-y divide-border/30">
          <Row label="Framework" value={projectData?.framework} />
          <Row label="Package manager" value={projectData?.packageManager} />
          <Row label="Runtime isolation" value={runtimeModeLabel} />
          {isCloud && (
            <Row
              label="Resources"
              value={cpuCores || memoryMb ? `${cpuCores ?? "?"} vCPU · ${memoryMb ?? "?"} MB` : undefined}
            />
          )}
          <Row label="Runtime port" value={buildData.productionPort} mono />
          <Row label="Install command" value={buildData.installCommand} mono />
          <Row
            label="Build command"
            value={buildData.hasBuild ? buildData.buildCommand : "No build step"}
            mono={buildData.hasBuild}
          />
          <Row label="Output directory" value={buildData.outputDirectory} mono />
          <Row label="Root directory" value={buildData.rootDirectory || "."} mono />
          <Row
            label="Start command"
            value={buildData.hasServer ? buildData.startCommand : "Static (no server)"}
            mono={buildData.hasServer}
          />
        </div>
      </SectionCard>

      {/* Environment variables — edited in place via a safe per-variable editor
          (diff-merge; untouched secrets are never re-sent), NOT the wizard. */}
      <SectionCard
        icon={KeyRound}
        iconTone="muted"
        title="Environment variables"
        description="Encrypted at rest. Secrets stay masked — only the values you change are written."
        actions={
          <button
            type="button"
            onClick={() => setEnvOpen(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
          >
            <Pencil className="size-3.5" />
            Edit
          </button>
        }
      />

      <EnvVarsEditor projectId={id} isOpen={envOpen} onClose={() => setEnvOpen(false)} />
    </div>
  );
};
