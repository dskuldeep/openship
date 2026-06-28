"use client";

import { useState } from "react";
import {
  Server,
  Loader2,
  Check,
  KeyRound,
  Lock,
  ChevronDown,
  Network,
} from "lucide-react";
import { getApiErrorMessage, systemApi } from "@/lib/api";
import type { ServerInfo } from "@/lib/api/system";
import { useToast } from "@/context/ToastContext";

const INPUT =
  "w-full px-3.5 py-2.5 rounded-xl border border-border/50 bg-muted/30 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none transition-all focus:ring-2 focus:ring-primary/20";

const LABEL = "block text-sm font-medium text-muted-foreground mb-1.5";

interface ServerFormProps {
  /** Truthy => edit mode (prefill + PATCH); otherwise create mode (POST). */
  server?: ServerInfo | null;
  /** Called after a successful save with the saved server and the mode used. */
  onSaved: (result: { server: ServerInfo; isEditing: boolean }) => void;
  /** Optional override for the primary button label. */
  submitLabel?: string;
}

// The "SSH Connection" credentials card, shared by the add (/servers/new) and
// edit (/servers/[serverId]?edit=true) flows. It owns all field state plus the
// test/save logic; the surrounding page header and sidebars stay in the pages.
export function ServerForm({ server, onSaved, submitLabel }: ServerFormProps) {
  const { showToast } = useToast();
  const isEditing = !!server;

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [serverName, setServerName] = useState(server?.name ?? "");
  const [sshHost, setSshHost] = useState(server?.sshHost ?? "");
  const [sshPort, setSshPort] = useState(String(server?.sshPort ?? 22));
  const [sshUser, setSshUser] = useState(server?.sshUser ?? "root");
  const [sshAuthMethod, setSshAuthMethod] = useState<"password" | "key" | "agent">(
    server?.sshAuthMethod === "key"
      ? "key"
      : server?.sshAuthMethod === "agent"
        ? "agent"
        : "password",
  );
  const [sshPassword, setSshPassword] = useState("");
  const [sshKeyPath, setSshKeyPath] = useState(server?.sshKeyPath ?? "");
  const [sshKeyPassphrase, setSshKeyPassphrase] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(
    !!(server?.sshJumpHost || server?.sshArgs),
  );
  const [jumpHost, setJumpHost] = useState(server?.sshJumpHost ?? "");
  const [extraArgs, setExtraArgs] = useState(server?.sshArgs ?? "");

  async function handleSave() {
    if (!sshHost.trim()) {
      showToast("Server IP address is required", "error", "Server");
      return;
    }

    const currentPort = parseInt(sshPort, 10) || 22;
    const trimmedServerName = serverName.trim();
    const trimmedHost = sshHost.trim();
    const trimmedUser = sshUser.trim() || "root";
    const trimmedJumpHost = jumpHost.trim();
    const trimmedExtraArgs = extraArgs.trim();

    // When editing and not switching auth method, the stored secret is reused -
    // so a blank password/key is only an error on create or when switching.
    if (sshAuthMethod === "password" && (!isEditing || server?.sshAuthMethod !== "password") && !sshPassword) {
      showToast("Password is required when switching to password auth", "error", "Server");
      return;
    }

    if (sshAuthMethod === "key" && (!isEditing || server?.sshAuthMethod !== "key") && !sshKeyPath) {
      showToast("Key path is required when switching to SSH key auth", "error", "Server");
      return;
    }

    setSaving(true);
    try {
      const data: Record<string, unknown> = {
        name: trimmedServerName || null,
        sshHost: trimmedHost,
        sshPort: currentPort,
        sshUser: trimmedUser,
        sshAuthMethod,
        sshJumpHost: trimmedJumpHost || null,
        sshArgs: trimmedExtraArgs || null,
      };


      if (sshAuthMethod === "password" && sshPassword) {
        data.sshPassword = sshPassword;
      }
      if (sshAuthMethod === "key") {
        if (sshKeyPath) data.sshKeyPath = sshKeyPath;
        if (sshKeyPassphrase) data.sshKeyPassphrase = sshKeyPassphrase;
      }

      const saved = isEditing
        ? await systemApi.updateServerEntry(server!.id, data)
        : await systemApi.createServerEntry(data);

      showToast(isEditing ? "Server updated" : "Server saved", "success", "Server");
      onSaved({ server: saved, isEditing });
    } catch (err) {
      showToast(
        getApiErrorMessage(err, "Failed to save server"),
        "error",
        "Server",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    if (!sshHost.trim()) {
      showToast("Server IP address is required", "error", "Server");
      return;
    }

    if (sshAuthMethod === "password" && !sshPassword && !(isEditing && server?.sshAuthMethod === "password")) {
      showToast("Password is required to test connection", "error", "Server");
      return;
    }

    if (sshAuthMethod === "key" && !sshKeyPath && !(isEditing && server?.sshAuthMethod === "key")) {
      showToast("Key path is required to test connection", "error", "Server");
      return;
    }

    setTesting(true);
    setTestResult(null);
    try {
      const payload: Record<string, unknown> = {
        sshHost: sshHost.trim(),
        sshPort: parseInt(sshPort, 10) || 22,
        sshUser: sshUser.trim() || "root",
        sshAuthMethod,
      };
      if (sshAuthMethod === "password" && sshPassword) {
        payload.sshPassword = sshPassword;
      }
      if (sshAuthMethod === "key") {
        if (sshKeyPath) payload.sshKeyPath = sshKeyPath;
        if (sshKeyPassphrase) payload.sshKeyPassphrase = sshKeyPassphrase;
      }
      const result = await systemApi.testConnection(payload as Parameters<typeof systemApi.testConnection>[0]);
      setTestResult(result);
      if (result.ok) {
        showToast("Connection successful", "success", "Server");
      } else {
        showToast(result.message || "Connection failed", "error", "Server");
      }
    } catch (err) {
      const message = getApiErrorMessage(err, "Connection test failed");
      setTestResult({ ok: false, message });
      showToast(message, "error", "Server");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
        <div className="w-9 h-9 bg-blue-500/10 rounded-xl flex items-center justify-center">
          <Server className="size-[18px] text-blue-500" />
        </div>
        <div>
          <h2 className="font-semibold text-foreground text-[15px]">
            SSH Connection
          </h2>
          <p className="text-xs text-muted-foreground">
            Connect to your server via SSH
          </p>
        </div>
      </div>

      <div className="p-5 space-y-[18px]">
        <div>
          <label className={LABEL}>Server Name</label>
          <input
            type="text"
            value={serverName}
            onChange={(e) => setServerName(e.target.value)}
            placeholder={sshHost.trim() || "e.g. Production, Staging, Dev..."}
            spellCheck={false}
            autoComplete="off"
            className={INPUT}
          />
          <p className="text-xs text-muted-foreground/60 mt-1.5">
            Optional label shown in the server list and header.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px] gap-3">
          <div>
            <label className={LABEL}>Server IP Address</label>
            <input
              type="text"
              value={sshHost}
              onChange={(e) => setSshHost(e.target.value)}
              placeholder="123.45.67.89"
              spellCheck={false}
              autoComplete="off"
              className={INPUT}
            />
          </div>
          <div>
            <label className={LABEL}>Port</label>
            <input
              type="text"
              value={sshPort}
              onChange={(e) => setSshPort(e.target.value)}
              placeholder="e.g. 22"
              className={INPUT}
            />
          </div>
        </div>

        <div>
          <label className={LABEL}>Username</label>
          <input
            type="text"
            value={sshUser}
            onChange={(e) => setSshUser(e.target.value)}
            placeholder="e.g. root"
            spellCheck={false}
            autoComplete="off"
            className={INPUT}
          />
        </div>

        <div>
          <label className={LABEL}>Authentication</label>
          <div className="flex gap-1 bg-muted/50 rounded-[10px] p-[3px] mb-3">
            <button
              type="button"
              onClick={() => setSshAuthMethod("password")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 text-[13px] font-medium rounded-lg transition-all ${
                sshAuthMethod === "password"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground/70"
              }`}
            >
              <Lock className="size-3.5" />
              Password
            </button>
            <button
              type="button"
              onClick={() => setSshAuthMethod("key")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 text-[13px] font-medium rounded-lg transition-all ${
                sshAuthMethod === "key"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground/70"
              }`}
            >
              <KeyRound className="size-3.5" />
              SSH Key
            </button>
            <button
              type="button"
              onClick={() => setSshAuthMethod("agent")}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 text-[13px] font-medium rounded-lg transition-all ${
                sshAuthMethod === "agent"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground/70"
              }`}
            >
              <Network className="size-3.5" />
              Agent
            </button>
          </div>

          {sshAuthMethod === "password" ? (
            <div>
              <label className={LABEL}>Password</label>
              <input
                type="password"
                value={sshPassword}
                onChange={(e) => setSshPassword(e.target.value)}
                placeholder={
                  isEditing && server?.sshAuthMethod === "password"
                    ? "Leave blank to keep current password"
                    : "Enter server password"
                }
                autoComplete="off"
                className={INPUT}
              />
            </div>
          ) : sshAuthMethod === "agent" ? (
            <div className="flex items-start gap-2.5 rounded-xl border border-border/50 bg-muted/30 px-3.5 py-3">
              <Network className="size-4 shrink-0 mt-0.5 text-primary" />
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                Connects using this machine&apos;s SSH agent — like
                VSCode, no password or key needed. The host running
                Openship must already have access to this server (a key
                loaded in its <span className="text-foreground/80">ssh-agent</span>).
              </p>
            </div>
          ) : (
            <div className="space-y-[18px]">
              <div>
                <label className={LABEL}>Key Path</label>
                <input
                  type="text"
                  value={sshKeyPath}
                  onChange={(e) => setSshKeyPath(e.target.value)}
                  placeholder="~/.ssh/id_rsa"
                  spellCheck={false}
                  autoComplete="off"
                  className={INPUT}
                />
              </div>
              <div>
                <label className={LABEL}>
                  Passphrase{" "}
                  <span className="text-muted-foreground/50 font-normal">
                    (optional)
                  </span>
                </label>
                <input
                  type="password"
                  value={sshKeyPassphrase}
                  onChange={(e) => setSshKeyPassphrase(e.target.value)}
                  placeholder="Enter passphrase or leave blank"
                  autoComplete="off"
                  className={INPUT}
                />
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
        >
          <ChevronDown
            className={`size-3.5 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
          />
          Advanced
        </button>

        {showAdvanced && (
          <div className="space-y-[18px]">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={LABEL}>
                  Jump Host{" "}
                  <span className="text-muted-foreground/50 font-normal">
                    (optional)
                  </span>
                </label>
                <input
                  type="text"
                  value={jumpHost}
                  onChange={(e) => setJumpHost(e.target.value)}
                  placeholder="user@bastion.example.com"
                  spellCheck={false}
                  autoComplete="off"
                  className={INPUT}
                />
              </div>
              <div>
                <label className={LABEL}>
                  Extra SSH Arguments{" "}
                  <span className="text-muted-foreground/50 font-normal">
                    (optional)
                  </span>
                </label>
                <input
                  type="text"
                  value={extraArgs}
                  onChange={(e) => setExtraArgs(e.target.value)}
                  placeholder="-o StrictHostKeyChecking=no"
                  spellCheck={false}
                  autoComplete="off"
                  className={INPUT}
                />
              </div>
            </div>
          </div>
        )}

        <div className="pt-1 space-y-2.5">
          <button
            onClick={handleTestConnection}
            disabled={testing || saving || !sshHost.trim()}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 border border-border/50 bg-muted/30 text-foreground text-sm font-medium rounded-xl hover:bg-muted/60 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {testing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : testResult?.ok ? (
              <Check className="size-4 text-emerald-500" />
            ) : (
              <Network className="size-4" />
            )}
            {testing ? "Testing…" : testResult?.ok ? "Connected" : "Test Connection"}
          </button>
          {testResult && !testResult.ok && (
            <p className="text-xs text-red-500 text-center">{testResult.message}</p>
          )}
          <button
            onClick={handleSave}
            disabled={saving || !sshHost.trim()}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            {submitLabel ?? (isEditing ? "Save Changes" : "Save & Continue to Setup")}
          </button>
        </div>
      </div>
    </div>
  );
}
