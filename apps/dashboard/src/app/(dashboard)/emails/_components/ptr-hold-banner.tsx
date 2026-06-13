"use client";

/**
 * PTR (reverse DNS) hold gate. Renders AFTER `dnsAcknowledged` flips true
 * but before step 12 (SSL). Same shape as the DNS banner but:
 *
 *   - The records are configured at the VPS provider's panel
 *     (Hostinger / DigitalOcean / AWS / etc.), NOT at the DNS provider.
 *     That's the #1 confusion source - most users assume rDNS lives with
 *     the rest of their DNS. This banner exists to call out the
 *     difference explicitly.
 *
 *   - There's nothing to copy-paste into a "Name → Value" form; PTRs
 *     are usually a single text box per IP on the VPS provider's panel.
 *     We surface each (IP, hostname) pair clearly + a manual-verify hint.
 *
 *   - No "auto-configure" button. The few providers that offer rDNS API
 *     access (AWS Route 53 for EIPs, etc.) need elevated credentials we
 *     don't want to ask for; manual is the right default.
 */

import { useState } from "react";
import { Loader2, Network, Copy, Check } from "lucide-react";

interface PtrHoldBannerProps {
  ipv4: string;
  ipv6: string | null;
  target: string;
  resumeStep: number;
  acknowledging: boolean;
  onAcknowledge: () => void;
}

export function PtrHoldBanner({
  ipv4,
  ipv6,
  target,
  resumeStep,
  acknowledging,
  onAcknowledge,
}: PtrHoldBannerProps) {
  return (
    <div className="bg-sky-500/5 border border-sky-500/30 rounded-2xl p-6 mb-6">
      <div className="flex items-start gap-3 mb-5">
        <div className="w-10 h-10 rounded-xl bg-sky-500/15 flex items-center justify-center shrink-0">
          <Network className="size-5 text-sky-600" strokeWidth={1.75} />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-sky-900 dark:text-sky-100">
            Set reverse DNS (PTR) before continuing
          </h2>
          <p className="text-sm text-sky-900/80 dark:text-sky-100/80 mt-1 leading-snug">
            PTRs are configured at your <strong>VPS provider's panel</strong>{" "}
            (Hostinger, DigitalOcean, AWS, etc.), <strong>not</strong> at your
            DNS provider. Without matching rDNS, Gmail and Outlook reject your
            outbound mail. The install resumes from step {resumeStep} (SSL).
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-5">
        <PtrCard label="IPv4 PTR" ip={ipv4} target={target} required />
        {ipv6 && <PtrCard label="IPv6 PTR" ip={ipv6} target={target} />}
      </div>

      <div className="rounded-xl bg-sky-500/5 border border-sky-500/20 p-3 mb-5">
        <p className="text-xs text-sky-900/80 dark:text-sky-100/80 leading-relaxed">
          <strong>How to set it:</strong> log into your VPS provider, find the
          server's networking / DNS / rDNS settings, and set the PTR record for
          each IP to <code className="font-mono text-foreground">{target}</code>.
          Propagation usually takes 5–15 minutes.
        </p>
        <p className="text-xs text-sky-900/80 dark:text-sky-100/80 leading-relaxed mt-2">
          <strong>Verify with:</strong>{" "}
          <code className="font-mono text-foreground">dig +short -x {ipv4}</code>{" "}
          should return{" "}
          <code className="font-mono text-foreground">{target}.</code>
        </p>
      </div>

      <div className="flex items-center justify-end gap-3 pt-4 border-t border-sky-500/20">
        <button
          onClick={onAcknowledge}
          disabled={acknowledging}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-sky-500 text-white hover:bg-sky-500/90 transition-colors disabled:opacity-50"
        >
          {acknowledging ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Network className="size-4" />
          )}
          I've set the PTRs - continue
        </button>
      </div>
    </div>
  );
}

function PtrCard({
  label,
  ip,
  target,
  required,
}: {
  label: string;
  ip: string;
  target: string;
  required?: boolean;
}) {
  const [copied, setCopied] = useState<"ip" | "target" | null>(null);
  const copy = async (which: "ip" | "target", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      // Non-HTTPS context - silently no-op.
    }
  };
  return (
    <div className="bg-card rounded-xl border border-border/60 p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
          {label}
        </span>
        {!required && (
          <span className="text-[11px] text-muted-foreground/70 ml-auto">
            recommended
          </span>
        )}
      </div>
      <div className="space-y-2 font-mono text-[12px]">
        <PtrField
          fieldLabel="IP"
          value={ip}
          copied={copied === "ip"}
          onCopy={() => copy("ip", ip)}
        />
        <PtrField
          fieldLabel="Set to"
          value={target}
          copied={copied === "target"}
          onCopy={() => copy("target", target)}
        />
      </div>
    </div>
  );
}

function PtrField({
  fieldLabel,
  value,
  copied,
  onCopy,
}: {
  fieldLabel: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-xs text-muted-foreground/70 font-sans w-12 shrink-0 mt-0.5">
        {fieldLabel}
      </span>
      <div className="flex-1 min-w-0 bg-muted/40 rounded-md px-2 py-1.5 text-foreground/90 break-all">
        {value}
      </div>
      <button
        onClick={onCopy}
        className="text-muted-foreground/70 hover:text-foreground transition-colors p-1.5"
        title="Copy"
      >
        {copied ? (
          <Check className="size-3.5 text-emerald-500" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
    </div>
  );
}
