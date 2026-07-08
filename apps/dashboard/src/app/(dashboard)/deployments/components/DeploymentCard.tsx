"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { DeploymentMenu } from "./DeploymentMenu";
import { CommitDetailsModal } from "./CommitDetailsModal";
import type { Deployment } from "../types";
import { formatDistanceToNow, formatBuildTime, getStatusConfig } from "../utils";
import { GitBranch, Clock, ExternalLink, MoreVertical, Archive, Pin, Activity } from "lucide-react";
import { getFrameworkConfig } from "@/components/import-project/Frameworks";

interface DeploymentCardProps {
  deployment: Deployment;
  onStatusChange?: () => void;
}

/**
 * Pill colors + label for a per-service deploy status. Kept inline here
 * because the only consumer is the deployment card's service-fan-out
 * row; promoting to utils would invite scope creep.
 */
function getServiceStatusChipConfig(
  status: NonNullable<Deployment["serviceDeployments"]>[number]["status"],
) {
  switch (status) {
    case "success":
      return {
        label: "Deployed",
        bgClass: "bg-emerald-500/10",
        textClass: "text-emerald-600 dark:text-emerald-400",
        dotClass: "bg-emerald-500",
      };
    case "failure":
      return {
        label: "Failed",
        bgClass: "bg-red-500/10",
        textClass: "text-red-600 dark:text-red-400",
        dotClass: "bg-red-500",
      };
    case "cancelled":
      return {
        label: "Cancelled",
        bgClass: "bg-muted/60",
        textClass: "text-muted-foreground",
        dotClass: "bg-muted-foreground",
      };
    case "skipped":
      return {
        label: "Skipped",
        bgClass: "bg-muted/40",
        textClass: "text-muted-foreground",
        dotClass: "bg-muted-foreground",
      };
    case "building":
    case "deploying":
    case "in_progress":
      return {
        label: status === "building" ? "Building" : status === "deploying" ? "Deploying" : "Running",
        bgClass: "bg-blue-500/10",
        textClass: "text-blue-600 dark:text-blue-400",
        dotClass: "bg-blue-500",
      };
    case "missing":
      // Drift: the container was removed on the host out-of-band.
      return {
        label: "Removed on host",
        bgClass: "bg-orange-500/10",
        textClass: "text-orange-600 dark:text-orange-400",
        dotClass: "bg-orange-500",
      };
    case "indeterminate":
      // Started but unverified — connection dropped mid-deploy.
      return {
        label: "Verifying",
        bgClass: "bg-amber-500/10",
        textClass: "text-amber-600 dark:text-amber-400",
        dotClass: "bg-amber-500",
      };
    case "pending":
    default:
      return {
        label: "Pending",
        bgClass: "bg-amber-500/10",
        textClass: "text-amber-600 dark:text-amber-400",
        dotClass: "bg-amber-500",
      };
  }
}

export const DeploymentCard: React.FC<DeploymentCardProps> = ({ deployment, onStatusChange }) => {
  const router = useRouter();
  const [isCommitModalOpen, setIsCommitModalOpen] = useState(false);
  const statusConfig = getStatusConfig(deployment.status);
  const frameworkConfig = getFrameworkConfig(deployment.framework);

  const hasCommitData = deployment.commit?.hash && deployment.commit.hash !== "N/A";
  const hasCommitMessage = deployment.commit?.message && deployment.commit.message !== "Manual deployment";

  return (
    <div
      className="group relative flex cursor-pointer items-center gap-4 px-4 py-4 transition-colors hover:bg-muted/25"
      onClick={() => router.push(`/build/${deployment.id}`)}
    >
      {/* Status accent rail — scan a deployment's status at a glance; subtle by
          default, brightens on hover. Uses the same status color as the pill. */}
      <span
        aria-hidden
        className="absolute inset-y-2 left-0 w-0.5 rounded-full opacity-50 transition-opacity group-hover:opacity-100"
        style={{ backgroundColor: statusConfig.color }}
      />

      {/* Framework icon */}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted/45 transition-colors group-hover:bg-muted/65">
        {frameworkConfig.icon ? (
          frameworkConfig.icon("hsl(var(--foreground))")
        ) : (
          <span className="text-xs font-mono font-bold text-muted-foreground">
            {(deployment.framework || "?").slice(0, 2).toUpperCase()}
          </span>
        )}
      </div>

      {/* Main info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
          <p className="text-sm font-semibold text-foreground truncate">
            {deployment.projectName || "Unknown Project"}
          </p>
          {deployment.version != null && (
            <span
              className="shrink-0 rounded-md bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground"
              title={`Version ${deployment.version}`}
            >
              v{deployment.version}
            </span>
          )}
          <span
            className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${statusConfig.bgColor}`}
            style={{ color: statusConfig.color }}
          >
            {statusConfig.label}
          </span>
          {/* Rollback-state chips. Surfaced from the orchestrator-aware
              listing endpoint. Order: Active > Pinned > Snapshotted so
              the highest-signal one sits closest to the title. */}
          {deployment.isActive && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400"
              title="This is the deployment currently serving the project"
            >
              <Activity className="size-2.5" />
              Active
            </span>
          )}
          {deployment.pinned && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400"
              title="Pinned — exempt from retention prune. Stays rollback-restorable indefinitely."
            >
              <Pin className="size-2.5" />
              Pinned
            </span>
          )}
          {!deployment.pinned && deployment.artifactRetainedAt && !deployment.isActive && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
              title="Artifact archived — this version is available to roll back to"
            >
              <Archive className="size-2.5" />
              Snapshotted
            </span>
          )}
        </div>

        {/* Per-service status badges. Surfaced from the
            service_deployment fan-out when the orchestrator-aware
            listing endpoint returns rows for this deployment. */}
        {deployment.serviceDeployments && deployment.serviceDeployments.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {deployment.serviceDeployments.map((sd) => {
              const cfg = getServiceStatusChipConfig(sd.status);
              return (
                <span
                  key={sd.id}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${cfg.bgClass} ${cfg.textClass}`}
                  title={`${sd.serviceName}: ${cfg.label}${sd.reason ? ` (${sd.reason})` : ""}`}
                >
                  <span className={`size-1.5 rounded-full ${cfg.dotClass}`} />
                  {sd.serviceName}
                  <span className="opacity-60">·</span>
                  {cfg.label}
                </span>
              );
            })}
          </div>
        )}
        <div className="flex items-center gap-2 mt-0.5">
          <p className="max-w-[320px] truncate text-xs text-muted-foreground">
            {hasCommitMessage ? deployment.commit.message : "Manual deploy"}
          </p>
          <span className="text-muted-foreground/40">·</span>
          <span className="text-xs text-muted-foreground shrink-0">
            {formatDistanceToNow(new Date(deployment.createdAt))}
          </span>
          {deployment.buildTime ? (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className="text-xs text-muted-foreground shrink-0 flex items-center gap-1">
                <Clock className="size-3" />
                {formatBuildTime(deployment.buildTime)}
              </span>
            </>
          ) : null}
          {deployment.branch && (
            <>
              <span className="text-muted-foreground/40 hidden sm:inline">·</span>
              <span className="text-xs text-muted-foreground shrink-0 items-center gap-1 hidden sm:flex">
                <GitBranch className="size-3" />
                {deployment.branch}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Right side - commit hash + actions */}
      <div className="flex items-center gap-2 shrink-0">
        {hasCommitData && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (deployment.owner && deployment.repo) {
                window.open(
                  `https://github.com/${deployment.owner}/${deployment.repo}/commit/${deployment.commit.fullHash || deployment.commit.hash}`,
                  "_blank",
                );
              } else {
                setIsCommitModalOpen(true);
              }
            }}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            {deployment.commit.hash.slice(0, 7)}
            {deployment.owner && deployment.repo && <ExternalLink className="size-3" />}
          </button>
        )}

        <DeploymentMenu
          deployment={deployment}
          triggerClassName="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground/50 transition-colors hover:bg-muted/50 hover:text-foreground"
          onStatusChange={onStatusChange}
        />
      </div>

      <CommitDetailsModal
        deployment={deployment}
        isOpen={isCommitModalOpen}
        onClose={() => setIsCommitModalOpen(false)}
      />
    </div>
  );
};
