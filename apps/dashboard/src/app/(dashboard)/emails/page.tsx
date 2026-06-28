"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import {
  mailApi,
  systemApi,
  type MailSetupStatus,
  type DnsRecords,
  type MailSSEEvent,
  type PortConflict,
} from "@/lib/api";
import type { ServerOption } from "@/components/shared/ServerSelector";
import { PageContainer } from "@/components/ui/PageContainer";
import { MailSetupForm } from "./_components/mail-setup-form";
import { MailProgress } from "./_components/mail-progress";
import { MailSidebar } from "./_components/mail-sidebar";
import { DnsHoldBanner } from "./_components/dns-hold-banner";
import { PtrHoldBanner } from "./_components/ptr-hold-banner";
import { MailAdminPanel } from "./_components/admin/admin-panel";

export default function EmailsPage() {
  const searchParams = useSearchParams();
  // Pre-select server when the user lands here via the Mail tab's
  // "Provision" button on the server detail page (passes ?serverId=…).
  // Takes precedence over the saved mail-status server until the user
  // explicitly picks a different one.
  const hintedServerId = searchParams.get("serverId");

  const [status, setStatus] = useState<MailSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [domain, setDomain] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [logs, setLogs] = useState<Array<{ stepId: number; level: string; message: string }>>([]);
  const [dnsRecords, setDnsRecords] = useState<DnsRecords | null>(null);
  const [completionData, setCompletionData] = useState<{
    webmailUrl: string;
    adminUrl: string;
    mailDomain: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumeStep, setResumeStep] = useState<number | null>(null);
  const [dnsPendingStep, setDnsPendingStep] = useState<number | null>(null);
  const [acknowledgingDns, setAcknowledgingDns] = useState(false);
  const [ptrPending, setPtrPending] = useState<{
    ipv4: string;
    ipv6: string | null;
    target: string;
    resumeStep: number;
  } | null>(null);
  const [acknowledgingPtr, setAcknowledgingPtr] = useState(false);
  const [portConflicts, setPortConflicts] = useState<PortConflict[] | null>(null);
  const [resolving, setResolving] = useState(false);
  const [selectedServer, setSelectedServer] = useState<ServerOption | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Resolve a Server row → ServerOption (the shape ServerSelector + the
  // setup form expect). Used both for the saved mail-status server and
  // for the ?serverId= URL hint.
  const loadServerOption = useCallback(async (id: string): Promise<ServerOption | null> => {
    try {
      const server = await systemApi.getServerById(id);
      return {
        id: server.id,
        name: server.name || server.sshHost,
        host: server.sshHost,
        user: server.sshUser || "root",
        port: server.sshPort ?? 22,
        raw: server,
      };
    } catch {
      return null;
    }
  }, []);

  // Status now lives on the TARGET server (one JSON file per VPS), so we
  // need to know which server to ask about. The URL hint from the Mail tab
  // gives us that; otherwise we wait for the user to pick from the
  // in-form ServerSelector (which auto-picks if there's exactly one
  // mail-capable server).
  const fetchStatusForServer = useCallback(
    async (serverId: string | null) => {
      try {
        setLoading(true);
        if (!serverId) {
          setStatus(null);
          return;
        }
        const s = await mailApi.getStatus(serverId);
        setStatus(s);
        if (s.domain) setDomain(s.domain);
        if (s.dnsRecords) setDnsRecords(s.dnsRecords as unknown as DnsRecords);
        if (s.active) setRunning(true);
        if (s.resumeStep) setResumeStep(s.resumeStep);
        if (s.errorMessage) setError(s.errorMessage);

        // Rehydrate the live-log panel from the persisted buffer. The
        // backend caps it at MAX_PERSISTED_LOGS; we just render whatever
        // came back. If a live SSE stream attaches afterward (resume),
        // its new lines append to this baseline.
        if (s.logs?.length) {
          setLogs(
            s.logs.map((l) => ({
              stepId: l.stepId,
              level: l.level,
              message: l.message,
            })),
          );
        }

        // Rehydrate the DNS hold banner from on-server state. The live
        // `dns_pending` SSE event only fires once - on refresh we lose
        // that in-memory flag, so we have to derive "should the banner
        // show?" from the persisted state alone.
        //
        // Show the banner only while the user hasn't acknowledged yet:
        //   - We have records (step 11 ran successfully)
        //   - The install isn't currently progressing
        //   - The install isn't fully completed
        //   - The user hasn't already clicked "I've set the records"
        //     (`!dnsAcknowledged`) - `!undefined` is true (older state
        //     files without the field still default to "not ack'd"),
        //     `!false` is true, `!true` is false. Exactly what we want.
        //
        // Post-install, the records live in the Mail tab as a normal
        // reference card - they're not gone, just not blocking.
        const allComplete =
          (s.steps?.length ?? 0) > 0 &&
          s.steps.every((step) => step.status === "completed");
        if (
          s.dnsRecords &&
          !s.active &&
          !allComplete &&
          !s.dnsAcknowledged
        ) {
          setDnsPendingStep(s.resumeStep ?? 12);
        }

        // Rehydrate the PTR gate from on-server state: shown when DNS is
        // ack'd, PTR is NOT yet ack'd, the install isn't done, and we have
        // at least an IPv4 from step 11's IP detection. Same shape as
        // dns_pending rehydration - derive entirely from the persisted
        // state so refresh works.
        if (
          s.dnsRecords &&
          !s.active &&
          !allComplete &&
          s.dnsAcknowledged &&
          !s.ptrAcknowledged
        ) {
          const dns = s.dnsRecords as Record<
            string,
            { type?: unknown; value?: unknown }
          >;
          const a = dns.a;
          const aaaa = dns.aaaa;
          const ipv4 =
            a && typeof a.value === "string" && a.type === "A" ? a.value : null;
          const ipv6 =
            aaaa && typeof aaaa.value === "string" && aaaa.type === "AAAA"
              ? aaaa.value
              : null;
          if (ipv4 && s.domain) {
            setPtrPending({
              ipv4,
              ipv6,
              target: `mail.${s.domain}`,
              resumeStep: s.resumeStep ?? 12,
            });
          }
        }
      } catch {
        // Server unreachable or no state - treat as fresh setup.
        setStatus(null);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // On mount, pick the right server in this order:
  //
  //   1. URL hint (?serverId=…) wins.
  //   2. Otherwise, find servers that already have mail installed
  //      (state file present on disk). Exactly one → silently select it
  //      and jump straight to its admin/progress UI.
  //   3. Otherwise, if the user has exactly ONE openship server at all,
  //      pre-select it in the install form. There's nothing to pick, so
  //      don't make them click.
  //   4. Otherwise (multiple servers, no mail installed) → show picker
  //      so the user chooses where to install.
  //
  // The combined effect: a single-VPS user never sees a picker, and a
  // multi-VPS user only sees it the one time when no mail server exists
  // yet - after that the auto-select kicks in.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (hintedServerId) {
        const opt = await loadServerOption(hintedServerId);
        if (cancelled) return;
        if (opt) setSelectedServer(opt);
        await fetchStatusForServer(hintedServerId);
        return;
      }
      try {
        const { servers: mailServers } = await mailApi.listMailServers();
        if (cancelled) return;
        if (mailServers.length === 1) {
          const opt = await loadServerOption(mailServers[0].id);
          if (cancelled) return;
          if (opt) setSelectedServer(opt);
          await fetchStatusForServer(mailServers[0].id);
          return;
        }
        if (mailServers.length === 0) {
          // No mail installed anywhere yet - fall back to "is there only
          // one openship server total?" and pre-select that one in the
          // install form. Two-or-more openship servers with no mail still
          // surface the picker so the user chooses where to provision.
          const allServers = await systemApi.listServers();
          if (cancelled) return;
          if (allServers.length === 1) {
            const opt = await loadServerOption(allServers[0].id);
            if (cancelled) return;
            if (opt) setSelectedServer(opt);
            await fetchStatusForServer(allServers[0].id);
            return;
          }
        }
      } catch {
        // Listing failed - fall through to the picker. Not fatal.
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [hintedServerId, loadServerOption, fetchStatusForServer]);

  // Whenever the user picks a different server, refetch its state.
  useEffect(() => {
    if (!selectedServer?.id) return;
    if (selectedServer.id === hintedServerId) return; // already loaded above
    fetchStatusForServer(selectedServer.id);
  }, [selectedServer?.id, hintedServerId, fetchStatusForServer]);

  // Start setup
  const handleStart = useCallback(
    async (fromStep?: number) => {
      if (!domain || !selectedServer?.id) return;
      setRunning(true);
      setError(null);
      setLogs([]);
      setPortConflicts(null);
      setCompletionData(null);
      setDnsPendingStep(null);
      setPtrPending(null);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await mailApi.streamSetup(
          selectedServer.id,
          domain,
          fromStep,
          adminPassword ? { adminPassword } : undefined,
          (event: MailSSEEvent) => {
            switch (event.event) {
              case "step_start":
                setStatus((prev) => {
                  if (!prev) return prev;
                  return {
                    ...prev,
                    currentStep: event.stepId,
                    steps: prev.steps.map((s) =>
                      s.id === event.stepId ? { ...s, status: "running" as const } : s,
                    ),
                  };
                });
                break;

              case "log":
                setLogs((prev) => [
                  ...prev,
                  { stepId: event.stepId, level: event.level, message: event.message },
                ]);
                break;

              case "step_done":
                if (event.stepId === 3 && event.success) {
                  setPortConflicts(null);
                }
                setStatus((prev) => {
                  if (!prev) return prev;
                  return {
                    ...prev,
                    steps: prev.steps.map((s) =>
                      s.id === event.stepId
                        ? {
                            ...s,
                            status: event.success ? ("completed" as const) : ("failed" as const),
                            message: event.message,
                            warning: event.warning,
                            data: event.data,
                          }
                        : s,
                    ),
                  };
                });
                break;

              case "dns_records":
                setDnsRecords(event.records);
                break;

              case "dns_pending":
                // Install paused after DKIM step - surface the records and
                // wait for the operator to acknowledge before continuing.
                setDnsRecords(event.records);
                setDnsPendingStep(event.resumeStep);
                setRunning(false);
                break;

              case "ptr_pending":
                // Install paused after DNS ack - show the VPS-provider
                // PTR banner before letting it proceed to step 12 (SSL).
                setPtrPending({
                  ipv4: event.ipv4,
                  ipv6: event.ipv6,
                  target: event.target,
                  resumeStep: event.resumeStep,
                });
                setRunning(false);
                break;

              case "port_conflict":
                setPortConflicts(event.portConflicts);
                break;

              case "complete":
                setCompletionData({
                  webmailUrl: event.webmailUrl,
                  adminUrl: event.adminUrl,
                  mailDomain: event.mailDomain,
                });
                setRunning(false);
                // Refetch status so the ProvisionedView gets credentials,
                // finishedAt, and full step data populated. Without this
                // the page would show its install-completed shell with no
                // credentials/health info until manual refresh.
                if (selectedServer?.id) {
                  fetchStatusForServer(selectedServer.id);
                }
                break;

              case "error":
                setError(event.message);
                if (event.resumeStep) setResumeStep(event.resumeStep);
                setRunning(false);
                break;
            }
          },
          () => setRunning(false),
          controller.signal,
        );
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") {
          setError(err.message);
        }
        setRunning(false);
      }
    },
    [domain, adminPassword, selectedServer, fetchStatusForServer],
  );

  const handleCancel = useCallback(async () => {
    abortRef.current?.abort();
    try {
      await mailApi.cancelSetup();
    } catch {
      // Already stopped
    }
    setRunning(false);
  }, []);

  /**
   * Wipe `/root/.openship-mail-state.json` on the target server, then refetch
   * status. The local working state (logs, errors, resume hints) is cleared
   * here too so the page goes back to a "no install" view immediately.
   *
   * Destructive - caller (MailProgress's Reset button) two-clicks to confirm.
   */
  /**
   * End-to-end Reset:
   *   1. Kill any in-flight SSE (so late events don't re-populate state)
   *   2. Tell the backend to cancel any active session (releases the
   *      in-memory `active` flag - otherwise the reset endpoint returns
   *      409 and the wipe never happens)
   *   3. Wipe `/root/.openship-mail-state.json` on the target VPS
   *   4. Clear every piece of frontend state that touches install UI
   *   5. Refetch /mail/status to confirm - server should return the
   *      empty shell, overwriting anything we missed locally
   *
   * Anything less leaves a window where stale events, stale flags, or
   * a stuck backend session keep the UI on the install view.
   */
  const handleReset = useCallback(async () => {
    if (!selectedServer?.id) return;

    // (1) Kill any open SSE so events stop arriving immediately
    abortRef.current?.abort();

    // (2) Ask the backend to drop its in-memory session pointer. We catch
    // the rejection - it's normal for there to be no active session.
    await mailApi.cancelSetup().catch(() => {});

    // (3) Wipe the on-server state file
    try {
      await mailApi.resetSetup(selectedServer.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
      return;
    }

    // (4) Clear every local state var that drives install UI. Anything
    // missed here would leave the page in a stale "show install view"
    // state until the next refresh.
    setStatus(null);
    setLogs([]);
    setError(null);
    setResumeStep(null);
    setDnsPendingStep(null);
    setPtrPending(null);
    setDnsRecords(null);
    setCompletionData(null);
    setPortConflicts(null);
    setRunning(false);
    setAcknowledgingDns(false);
    setAcknowledgingPtr(false);
    setResolving(false);

    // (5) Source-of-truth refetch - overwrites local state with whatever
    // the (now-empty) server actually returns. Belt-and-suspenders against
    // any race or missed setter above.
    await fetchStatusForServer(selectedServer.id);
  }, [selectedServer, fetchStatusForServer]);

  /**
   * "I've set the DNS records - continue" click. Acks the gate on the
   * backend, then transitions DIRECTLY to the PTR banner without doing a
   * full SSE round-trip first.
   *
   * Why: the old flow was ack → POST /mail/setup → backend SSH connect →
   * readState → persist → fire ptr_pending → halt → persist again. That's
   * 3-5s of "DNS banner gone, PTR banner not yet visible" which felt like
   * the click failed (users clicked again).
   *
   * Since we already have `dnsRecords.a` / `dnsRecords.aaaa` and the
   * domain in local state, the PTR banner content is a pure client-side
   * derivation - no backend round-trip needed to render it. The actual
   * install resume happens when the user acks PTR (`handleAcknowledgePtr`
   * calls `handleStart(resumeStep)`).
   *
   * Fallback: if `dnsRecords.a` is somehow missing (older state that
   * predates A/AAAA detection), defer to the backend gate - it might have
   * augmented IPs we don't, and if not, the SSE just falls through to
   * step 12 and we treat that as "no PTR step needed".
   */
  const handleAcknowledgeDns = useCallback(async () => {
    if (!selectedServer?.id || !dnsPendingStep || !domain) return;
    setAcknowledgingDns(true);
    try {
      await mailApi.acknowledgeDns(selectedServer.id, domain);
      const next = dnsPendingStep;
      setDnsPendingStep(null);

      const aRec = dnsRecords?.a;
      const aaaaRec = dnsRecords?.aaaa;
      const ipv4 =
        aRec && typeof aRec.value === "string" ? aRec.value : null;
      const ipv6 =
        aaaaRec && typeof aaaaRec.value === "string" ? aaaaRec.value : null;

      if (ipv4) {
        // Show PTR banner instantly - no SSE wait.
        setPtrPending({
          ipv4,
          ipv6,
          target: `mail.${domain}`,
          resumeStep: next,
        });
      } else {
        // No IPv4 available client-side - let the backend decide whether
        // to gate on PTR (via augmented host IPs) or fall through.
        await handleStart(next);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not acknowledge DNS");
    } finally {
      setAcknowledgingDns(false);
    }
  }, [selectedServer, domain, dnsPendingStep, dnsRecords, handleStart]);

  /**
   * "I've set the PTRs - continue" click. Acks the gate on the backend,
   * then re-POSTs to /mail/setup with `startStep` = the resume step the
   * ptr_pending event surfaced. Same shape as the DNS ack handler.
   */
  const handleAcknowledgePtr = useCallback(async () => {
    if (!selectedServer?.id || !ptrPending) return;
    setAcknowledgingPtr(true);
    try {
      await mailApi.acknowledgePtr(selectedServer.id);
      const next = ptrPending.resumeStep;
      setPtrPending(null);
      await handleStart(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not acknowledge PTR");
    } finally {
      setAcknowledgingPtr(false);
    }
  }, [selectedServer, ptrPending, handleStart]);

  const handleResolveConflict = useCallback(
    async (conflict: PortConflict, resolutionId: string) => {
      if (!selectedServer?.id) {
        setError("Select a server first");
        return;
      }
      setResolving(true);
      setError(null);
      try {
        const result = await mailApi.resolvePorts(selectedServer.id, conflict, resolutionId);
        if (result.success) {
          // Remove resolved conflict from list
          setPortConflicts((prev) => {
            if (!prev) return [];
            const remaining = prev.filter((c) => c.port !== conflict.port);
            return remaining;
          });
          setLogs((prev) => [
            ...prev,
            { stepId: 3, level: "info", message: result.message },
          ]);
        } else {
          setError(result.message);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Resolution failed");
      } finally {
        setResolving(false);
      }
    },
    [selectedServer],
  );

  // Check if setup has been completed before
  const isCompleted =
    status?.steps?.every((s) => s.status === "completed") || !!completionData;
  const hasStarted = status?.steps?.some(
    (s) => s.status === "completed" || s.status === "failed",
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <PageContainer>
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1
              className="text-2xl font-medium text-foreground/80"
              style={{ letterSpacing: "-0.2px" }}
            >
              Email Server
            </h1>
            <p className="text-sm text-muted-foreground/70 mt-1">
              Set up a self-hosted mail server with a few clicks
            </p>
          </div>
        </div>

        {/* ── Welcome state - server selector + setup form ── */}
        {!hasStarted && !running && (
          <MailSetupForm
            domain={domain}
            adminPassword={adminPassword}
            running={running}
            selectedServerId={selectedServer?.id ?? null}
            onDomainChange={setDomain}
            onPasswordChange={setAdminPassword}
            onServerSelect={setSelectedServer}
            onStart={() => handleStart()}
            onAdopted={async (serverId) => {
              // Re-adopted an existing mail server — select it; the
              // server-change effect refetches its live status.
              const opt = await loadServerOption(serverId);
              if (opt) setSelectedServer(opt);
            }}
          />
        )}

        {/* ── DNS hold gate - dominates the page when active so the user
              can't miss it. Records are surfaced inline with copy buttons
              + an auto-configure escape hatch into the provider modal. ── */}
        {dnsPendingStep && dnsRecords && selectedServer?.id && domain && (
          <DnsHoldBanner
            records={dnsRecords}
            domain={domain}
            resumeStep={dnsPendingStep}
            acknowledging={acknowledgingDns}
            onAcknowledge={handleAcknowledgeDns}
          />
        )}

        {/* ── PTR gate - appears AFTER the DNS banner is dismissed.
              Different colour (sky vs amber) so the user can see at a
              glance that this is a different step (VPS provider, not DNS
              provider). Mutually exclusive with DnsHoldBanner: dns_pending
              must clear first before ptr_pending can fire. ── */}
        {!dnsPendingStep && ptrPending && selectedServer?.id && (
          <PtrHoldBanner
            ipv4={ptrPending.ipv4}
            ipv6={ptrPending.ipv6}
            target={ptrPending.target}
            resumeStep={ptrPending.resumeStep}
            acknowledging={acknowledgingPtr}
            onAcknowledge={handleAcknowledgePtr}
          />
        )}

        {/* ── Fully completed → flip to the admin panel ──
              Once provisioning is green, /emails becomes the mail admin:
              Overview (credentials + health + DNS), Domains, Mailboxes -
              talking to vmail.* on the mail VPS over SSH+psql. The install
              logs / step list are install-time concerns; this is the day-2
              surface. */}
        {isCompleted && status && selectedServer?.id && (
          <MailAdminPanel
            status={status}
            serverId={selectedServer.id}
            onRefresh={() => fetchStatusForServer(selectedServer.id)}
          />
        )}

        {/* ── Setup in progress (or partially failed) ── */}
        {!isCompleted && (hasStarted || running) && (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-6">
            <MailProgress
              logs={logs}
              running={running}
              error={error}
              resumeStep={resumeStep}
              canReset={!!selectedServer?.id}
              onCancel={handleCancel}
              onResume={handleStart}
              onReset={handleReset}
            />
            <MailSidebar
              domain={domain}
              status={status}
              steps={status?.steps ?? []}
              dnsRecords={dnsRecords}
              completionData={completionData}
              portConflicts={portConflicts}
              resolving={resolving}
              running={running}
              isCompleted={isCompleted}
              resumeStep={resumeStep}
              dnsBannerActive={!!dnsPendingStep}
              onResolveConflict={handleResolveConflict}
              onResume={handleStart}
            />
          </div>
        )}
    </PageContainer>
  );
}
