import { AlertTriangle, KeyRound, RefreshCw, Settings2, Wifi, WifiOff } from "lucide-react";
import { useRouter } from "next/navigation";

export type ConnectionErrorKind =
  | "unreachable"   // can't reach the host at all (ECONNREFUSED / ETIMEDOUT / no route)
  | "auth"          // SSH connected but credentials rejected
  | "no_server"     // no server row / invalid config
  | "unknown";

/**
 * Classify an SSH check error into something the UI can show actionable copy
 * for. The server returns shaped errors via `ApiError.body`, but we also
 * fall back to substring matching the message so genuine ECONNREFUSED /
 * ETIMEDOUT strings get the right kind even when the server skipped the tag.
 */
export function classifyConnectionError(
  body: unknown,
  message: string,
): ConnectionErrorKind {
  const tag = (body && typeof body === "object" && "error" in body)
    ? ((body as { error?: unknown }).error as string | undefined)
    : undefined;
  if (tag === "auth_failed") return "auth";
  if (tag === "no_server") return "no_server";
  if (tag === "connection_failed") return "unreachable";

  const lower = message.toLowerCase();
  if (/(econnrefused|etimedout|enotfound|ehostunreach|connection reset|connection refused|connection timed out|host unreachable|no route to host)/i.test(lower)) {
    return "unreachable";
  }
  if (/(auth|permission denied|publickey|password)/i.test(lower)) return "auth";
  return "unknown";
}

export function ConnectionBanner(props: {
  serverId: string;
  kind: ConnectionErrorKind;
  host: string;
  port: number;
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  const router = useRouter();
  const { kind, host, port, message, retrying, onRetry, serverId } = props;

  const copy = (() => {
    switch (kind) {
      case "unreachable":
        return {
          title: `Can't reach ${host}`,
          body: `Openship couldn't open an SSH connection to ${host}:${port}. Make sure the server is running and that sshd is accepting connections on port ${port}. If it's behind a firewall or NAT, confirm the host is reachable from this machine.`,
          icon: WifiOff,
          tone: "amber",
        };
      case "auth":
        return {
          title: "SSH credentials rejected",
          body: `Reached ${host}:${port} but the server refused authentication. The key or password stored for this server doesn't match what's authorised in ~/.ssh/authorized_keys on the host.`,
          icon: KeyRound,
          tone: "red",
        };
      case "no_server":
        return {
          title: "Server config incomplete",
          body: "This server entry is missing SSH settings. Open Edit to set the host, user and credentials, then run a health check.",
          icon: AlertTriangle,
          tone: "amber",
        };
      default:
        return {
          title: "Health check failed",
          body: message || "Openship couldn't talk to this server.",
          icon: AlertTriangle,
          tone: "amber",
        };
    }
  })();

  const tone = copy.tone === "red"
    ? "bg-red-500/[0.06] border-red-500/25 text-red-700 dark:text-red-400"
    : "bg-amber-500/[0.06] border-amber-500/25 text-amber-700 dark:text-amber-400";
  const iconBg = copy.tone === "red"
    ? "bg-red-500/10 text-red-600 dark:text-red-400"
    : "bg-amber-500/10 text-amber-600 dark:text-amber-400";

  return (
    <div className={`rounded-2xl border p-4 mb-6 ${tone}`}>
      <div className="flex items-start gap-3">
        <div className={`size-9 rounded-lg flex items-center justify-center shrink-0 ${iconBg}`}>
          <copy.icon className="size-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">{copy.title}</p>
          <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">{copy.body}</p>
          {kind === "unreachable" && (
            <ul className="text-[12px] text-muted-foreground/80 mt-2 list-disc pl-5 space-y-0.5">
              <li>Is the VPS / VM powered on?</li>
              <li><code className="font-mono">ping {host}</code> from this machine - does it answer?</li>
              <li><code className="font-mono">nc -zv {host} {port}</code> - is port {port} open?</li>
            </ul>
          )}
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <button
              onClick={onRetry}
              disabled={retrying}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-foreground/[0.06] hover:bg-foreground/[0.1] text-foreground rounded-lg transition-colors disabled:opacity-50"
            >
              {retrying ? <RefreshCw className="size-3 animate-spin" /> : <Wifi className="size-3" />}
              {retrying ? "Checking…" : "Retry"}
            </button>
            <button
              onClick={() => router.push(`/servers/${serverId}?edit=true`)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-foreground/[0.06] hover:bg-foreground/[0.1] text-foreground rounded-lg transition-colors"
            >
              <Settings2 className="size-3" />
              {kind === "auth" ? "Edit credentials" : "Edit server"}
            </button>
          </div>
          {message && kind !== "unknown" && (
            <details className="mt-2.5">
              <summary className="text-[11px] text-muted-foreground/70 cursor-pointer hover:text-muted-foreground">
                Show raw error
              </summary>
              <pre className="text-[11px] font-mono mt-1.5 p-2 rounded-lg bg-foreground/[0.04] text-muted-foreground/80 whitespace-pre-wrap break-all">
                {message}
              </pre>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
