"use client";

import { useEffect, useRef, useState } from "react";
import {
  Mail,
  Shield,
  CheckCircle2,
  ExternalLink,
  RotateCcw,
  AlertTriangle,
  Loader2,
  Unplug,
  OctagonX,
  ArrowRightLeft,
  Skull,
  ChevronDown,
} from "lucide-react";
import type {
  MailSetupStatus,
  MailStepStatus,
  DnsRecords,
  PortConflict,
} from "@/lib/api";
import { DnsRecordCard } from "./dns-record-card";
import { StepIcon } from "./step-icon";

interface CompletionData {
  webmailUrl: string;
  adminUrl: string;
  mailDomain: string;
}

interface MailSidebarProps {
  domain: string;
  status: MailSetupStatus | null;
  steps: MailStepStatus[];
  dnsRecords: DnsRecords | null;
  completionData: CompletionData | null;
  portConflicts: PortConflict[] | null;
  resolving: boolean;
  running: boolean;
  isCompleted: boolean;
  resumeStep: number | null;
  /** True while the DNS hold banner is showing - sidebar hides its records card to avoid duplication. */
  dnsBannerActive: boolean;
  onResolveConflict: (conflict: PortConflict, resolutionId: string) => void;
  onResume: (fromStep: number) => void;
}

export function MailSidebar({
  domain,
  status,
  steps,
  dnsRecords,
  completionData,
  portConflicts,
  resolving,
  running,
  isCompleted,
  resumeStep,
  dnsBannerActive,
  onResolveConflict,
  onResume,
}: MailSidebarProps) {
  const completedCount = steps.filter((s) => s.status === "completed").length;
  return (
    <div className="space-y-4">
      {/* Port conflict resolution */}
      {portConflicts && (
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-5">
          <div className="flex items-center gap-3 mb-4">
            <Unplug className="size-5 text-amber-500" />
            <div>
              <h3 className="text-sm font-semibold text-amber-600 dark:text-amber-400">
                Port Conflict Detected
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Ports 80/443 are needed for the mail server
              </p>
            </div>
          </div>

          {portConflicts.length > 0 ? (
            <div className="space-y-4">
              {portConflicts.map((conflict) => (
                <div
                  key={conflict.port}
                  className="rounded-xl border border-border/50 bg-card p-4"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono px-2 py-0.5 rounded-md bg-muted text-muted-foreground">
                        :{conflict.port}
                      </span>
                      <span className="text-sm font-medium text-foreground">
                        {conflict.serviceName ?? conflict.usage.process}
                      </span>
                    </div>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        conflict.type === "traefik"
                          ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                          : conflict.type === "known"
                            ? "bg-violet-500/10 text-violet-600 dark:text-violet-400"
                            : "bg-red-500/10 text-red-600 dark:text-red-400"
                      }`}
                    >
                      {conflict.type === "traefik"
                        ? "Managed"
                        : conflict.type === "known"
                          ? "Known Service"
                          : "Unknown"}
                    </span>
                  </div>

                  {conflict.usage.containerName && (
                    <p className="text-xs text-muted-foreground mb-2">
                      Container: {conflict.usage.containerName}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground mb-3">
                    PID {conflict.usage.pid}
                    {conflict.usage.isDocker ? " (Docker)" : ""}
                  </p>

                  <div className="space-y-2">
                    {conflict.resolutions.map((resolution) => (
                      <button
                        key={resolution.id}
                        onClick={() => onResolveConflict(conflict, resolution.id)}
                        disabled={resolving}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-colors disabled:opacity-50 ${
                          resolution.destructive
                            ? "border-red-500/30 hover:bg-red-500/5"
                            : "border-border/50 hover:bg-muted/50"
                        }`}
                      >
                        {resolution.destructive ? (
                          resolution.id === "kill_process" ? (
                            <Skull className="size-4 text-red-500 shrink-0" />
                          ) : (
                            <OctagonX className="size-4 text-red-500 shrink-0" />
                          )
                        ) : (
                          <ArrowRightLeft className="size-4 text-blue-500 shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p
                            className={`text-sm font-medium ${
                              resolution.destructive
                                ? "text-red-600 dark:text-red-400"
                                : "text-foreground"
                            }`}
                          >
                            {resolution.label}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {resolution.description}
                          </p>
                        </div>
                        {resolving && (
                          <Loader2 className="size-4 animate-spin text-muted-foreground shrink-0" />
                        )}
                      </button>
                    ))}
                  </div>

                  {conflict.type === "unknown" && (
                    <div className="mt-3 flex items-start gap-2 p-2.5 rounded-lg bg-red-500/5">
                      <AlertTriangle className="size-3.5 text-red-500 mt-0.5 shrink-0" />
                      <p className="text-xs text-red-600 dark:text-red-400">
                        Make sure this process is not needed before killing
                        it. This action cannot be undone.
                      </p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
              <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                All conflicts resolved
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Re-run the port check and continue the setup.
              </p>
              <button
                onClick={() => onResume(3)}
                disabled={resolving || running}
                className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                <RotateCcw className="size-3.5" />
                Resume from Step 3
              </button>
            </div>
          )}
        </div>
      )}

      {/* Completion card */}
      {isCompleted && completionData && (
        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-5">
          <div className="flex items-center gap-3 mb-4">
            <CheckCircle2 className="size-5 text-emerald-500" />
            <h3 className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
              Mail Server Ready!
            </h3>
          </div>
          <div className="space-y-3">
            <a
              href={completionData.webmailUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-border/50 bg-card hover:border-border transition-colors"
            >
              <Mail className="size-4 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">Webmail</p>
                <p className="text-xs text-muted-foreground truncate">
                  {completionData.webmailUrl}
                </p>
              </div>
              <ExternalLink className="size-3.5 text-muted-foreground shrink-0" />
            </a>
            <a
              href={completionData.adminUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-border/50 bg-card hover:border-border transition-colors"
            >
              <Shield className="size-4 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">Admin Panel</p>
                <p className="text-xs text-muted-foreground truncate">
                  {completionData.adminUrl}
                </p>
              </div>
              <ExternalLink className="size-3.5 text-muted-foreground shrink-0" />
            </a>
          </div>
        </div>
      )}

      {/* DNS Records - hidden while the top-level DnsHoldBanner is taking
          the entire page width, since duplicating four record cards on
          both surfaces is noise. The banner has the same content + copy
          buttons + auto-configure CTA. This card returns post-install
          as a collapsed reference (the user has already set them; they
          just want to be able to peek without scrolling through walls of
          mono-font value strings). */}
      {dnsRecords && !dnsBannerActive && (
        <DnsRecordsCollapsibleCard dnsRecords={dnsRecords} />
      )}

      {/* All steps - full install plan + roadmap. Auto-scrolls to the
          active step; the user can also scroll up/down freely to review
          finished steps or peek ahead. The failed row carries an inline
          Retry so the action is right where the eye lands. */}
      {steps.length > 0 && (
        <AllStepsCard
          steps={steps}
          completedCount={completedCount}
          resumeStep={resumeStep}
          running={running}
          onResume={onResume}
        />
      )}

      {/* Setup domain info */}
      {domain && (
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <h3 className="text-sm font-semibold text-foreground mb-3">Setup Details</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Domain</dt>
              <dd className="font-medium text-foreground">{domain}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Mail Server</dt>
              <dd className="font-medium text-foreground">mail.{domain}</dd>
            </div>
            {status?.startedAt && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Started</dt>
                <dd className="font-medium text-foreground">
                  {new Date(status.startedAt).toLocaleTimeString()}
                </dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}

// ─── All-steps card ──────────────────────────────────────────────────────────

interface AllStepsCardProps {
  steps: MailStepStatus[];
  completedCount: number;
  resumeStep: number | null;
  running: boolean;
  onResume: (fromStep: number) => void;
}

/**
 * Scrollable plan: completed steps above, current/failed step highlighted,
 * upcoming steps below - with the active row auto-scrolled into view as the
 * pipeline progresses. The container caps height + scrolls so it works on
 * any viewport without bloating the right column.
 */
function AllStepsCard({
  steps,
  completedCount,
  resumeStep,
  running,
  onResume,
}: AllStepsCardProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const activeRowRef = useRef<HTMLLIElement>(null);

  // Pick the row to keep in view: running step beats failed (during a live
  // run) beats just-completed (so finished installs land at the bottom).
  const activeId = pickActiveStepId(steps);

  // "Stalled" = some steps are still pending AND we're not running AND we
  // don't have an explicit resumeStep (e.g. SSE dropped mid-install before
  // the controller could persist a halt state). The first non-completed
  // step is where we'd resume from.
  const firstPendingId = steps.find((s) => s.status !== "completed")?.id;
  const isStalled =
    !running &&
    completedCount < steps.length &&
    firstPendingId !== undefined &&
    resumeStep == null &&
    !steps.some((s) => s.status === "failed");

  useEffect(() => {
    if (!activeRowRef.current || !listRef.current) return;
    // `nearest` keeps user scroll position when the active row is already
    // visible; only scrolls when it's actually off-screen. That way the user
    // can scroll up/down to inspect other steps without being yanked back
    // unless something new happens.
    activeRowRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeId]);

  return (
    <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-border/50 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">All steps</h3>
        <span className="text-xs text-muted-foreground/70 tabular-nums">
          {completedCount} / {steps.length}
        </span>
      </div>

      {isStalled && firstPendingId !== undefined && (
        <div className="px-5 py-3 border-b border-amber-500/20 bg-amber-500/5 flex items-center justify-between gap-3">
          <p className="text-xs text-amber-700 dark:text-amber-400 min-w-0">
            Install was interrupted before step {firstPendingId}. Resume to pick up where it left off.
          </p>
          <button
            onClick={() => onResume(firstPendingId)}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-amber-500 text-white hover:bg-amber-500/90 transition-colors shrink-0"
          >
            <RotateCcw className="size-3" />
            Resume
          </button>
        </div>
      )}

      <ol
        ref={listRef}
        className="divide-y divide-border/30 max-h-[60vh] overflow-y-auto"
      >
        {steps.map((s) => {
          const isActive = s.id === activeId;
          const isFailed = s.status === "failed";
          const isCurrent = s.status === "running";
          const showRetry =
            isFailed && resumeStep === s.id && !running;
          return (
            <li
              key={s.id}
              ref={isActive ? activeRowRef : null}
              className={`flex items-center gap-3 px-4 py-2.5 ${
                isCurrent
                  ? "bg-blue-500/5"
                  : isFailed
                    ? "bg-red-500/5"
                    : ""
              }`}
            >
              <div className="w-6 flex items-center justify-center shrink-0">
                <StepIcon status={s.status} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-xs tabular-nums ${
                      s.status === "completed"
                        ? "text-muted-foreground/60"
                        : "text-muted-foreground/50"
                    }`}
                  >
                    {String(s.id).padStart(2, " ")}
                  </span>
                  <span
                    className={`text-[13px] truncate ${
                      isCurrent
                        ? "text-blue-600 dark:text-blue-400 font-medium"
                        : s.status === "completed"
                          ? "text-foreground"
                          : isFailed
                            ? "text-red-600 dark:text-red-400 font-medium"
                            : "text-muted-foreground/70"
                    }`}
                  >
                    {s.label}
                  </span>
                  {s.warning && (
                    <AlertTriangle className="size-3 text-amber-500 shrink-0" />
                  )}
                </div>
                {(isCurrent || isFailed) && s.message && (
                  <p
                    className={`text-sm mt-0.5 truncate ${
                      isFailed
                        ? "text-red-500/80"
                        : "text-muted-foreground"
                    }`}
                  >
                    {s.message}
                  </p>
                )}
              </div>
              {showRetry && (
                <button
                  onClick={() => onResume(s.id)}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shrink-0"
                >
                  <RotateCcw className="size-3" />
                  Retry
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Collapsed-by-default DNS reference. Once the user has acked the records
 * we don't need to shove the full grid in their face - they just want it
 * a click away if they need to re-verify.
 */
function DnsRecordsCollapsibleCard({ dnsRecords }: { dnsRecords: DnsRecords }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-5 py-3.5 text-left hover:bg-muted/30 transition-colors"
        aria-expanded={open}
      >
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            Required DNS Records
          </h3>
          <p className="text-xs text-muted-foreground/70 mt-0.5">
            Reference - tap to view the records you published
          </p>
        </div>
        <ChevronDown
          className={`size-4 text-muted-foreground shrink-0 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open && (
        <div className="px-5 pb-5 pt-1 space-y-3 border-t border-border/30">
          <DnsRecordCard label="DKIM" record={dnsRecords.dkim} />
          <DnsRecordCard label="MX Record" record={dnsRecords.mx} />
          <DnsRecordCard label="SPF" record={dnsRecords.spf} />
          <DnsRecordCard label="DMARC" record={dnsRecords.dmarc} />
        </div>
      )}
    </div>
  );
}

function pickActiveStepId(steps: MailStepStatus[]): number | null {
  const running = steps.find((s) => s.status === "running");
  if (running) return running.id;
  const failed = steps.find((s) => s.status === "failed");
  if (failed) return failed.id;
  let last: number | null = null;
  for (const s of steps) {
    if (s.status === "completed") last = s.id;
  }
  return last;
}
