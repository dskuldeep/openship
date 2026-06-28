"use client";

import { useState } from "react";
import {
  Mail,
  Play,
  Server,
  Shield,
  Globe,
  Key,
  AlertTriangle,
  Eye,
  EyeOff,
  Sparkles,
} from "lucide-react";
import ServerSelector, { type ServerOption } from "@/components/shared/ServerSelector";
import { AdoptMailModal } from "./adopt-mail-modal";

/**
 * Browser-side strong-password generation. 18 random bytes →
 * base64url-encoded (24-char). Same scheme used in the change-password
 * modal so behavior is consistent across "set" and "rotate" flows.
 */
function generatePassword(): string {
  const buf = new Uint8Array(18);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

interface MailSetupFormProps {
  domain: string;
  adminPassword: string;
  running: boolean;
  selectedServerId: string | null;
  onDomainChange: (v: string) => void;
  onPasswordChange: (v: string) => void;
  onServerSelect: (s: ServerOption | null) => void;
  onStart: () => void;
  /** Called after an existing mail server is re-adopted from a scan. */
  onAdopted: (serverId: string) => void;
}

export function MailSetupForm({
  domain,
  adminPassword,
  running,
  selectedServerId,
  onDomainChange,
  onPasswordChange,
  onServerSelect,
  onStart,
  onAdopted,
}: MailSetupFormProps) {
  const [adoptOpen, setAdoptOpen] = useState(false);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6">
      {/* Setup form */}
      <div className="bg-card rounded-2xl border border-border/50 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center">
            <Mail className="size-5 text-violet-500" />
          </div>
          <div>
            <h2 className="text-lg font-medium text-foreground">Mail Server Setup</h2>
            <p className="text-sm text-muted-foreground">
              Deploy a complete self-hosted mail stack on this server
            </p>
          </div>
        </div>

        {/* Only show the selector when no server has been pre-picked. The
            page-level effect auto-selects when there's one mail-installed
            server (or one openship server total) - showing the picker on
            top of an already-resolved choice is just visual noise. */}
        {!selectedServerId && (
          <ServerSelector
            value={selectedServerId}
            onSelect={onServerSelect}
          />
        )}

        <div className="space-y-4 mb-6">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Domain
            </label>
            <input
              type="text"
              value={domain}
              onChange={(e) => onDomainChange(e.target.value)}
              placeholder="example.com"
              className="w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
            <p className="text-xs text-muted-foreground mt-1.5">
              Your mail server will be at <strong>mail.{domain || "example.com"}</strong>
            </p>
          </div>

          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <label className="block text-sm font-medium text-foreground">
                Admin Password
              </label>
              <span className="text-xs text-muted-foreground/70">
                postmaster@{domain || "your-domain.com"}
              </span>
            </div>
            <PasswordField
              value={adminPassword}
              onChange={onPasswordChange}
              placeholder="Strong password - or click Generate"
            />
            <p className="text-xs text-muted-foreground mt-1.5">
              Used to log into the mailbox after setup. You can change it later from
              the admin panel below.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            onClick={onStart}
            disabled={!domain || !adminPassword || !selectedServerId || running}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Play className="size-4" />
            Start Setup
          </button>
          {/* Disaster recovery: re-adopt a mail server already installed on a
              server (e.g. after losing the orchestrator PC) without reinstalling. */}
          <button
            type="button"
            onClick={() => setAdoptOpen(true)}
            disabled={running}
            className="text-sm text-muted-foreground hover:text-foreground underline-offset-2 hover:underline disabled:opacity-50"
          >
            Already have a mail server? Adopt it
          </button>
        </div>
      </div>

      <AdoptMailModal
        isOpen={adoptOpen}
        onClose={() => setAdoptOpen(false)}
        onAdopted={onAdopted}
      />

      {/* Info sidebar */}
      <div className="space-y-4">
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <p className="text-xs text-muted-foreground/60 uppercase tracking-wider font-semibold mb-4">
            What gets installed
          </p>
          <div className="space-y-3">
            {[
              { icon: Server, label: "Mail server stack", desc: "Postfix, Dovecot, anti-spam" },
              { icon: Shield, label: "SSL Certificate", desc: "Let's Encrypt auto-SSL" },
              { icon: Globe, label: "DNS Configuration", desc: "DKIM, SPF, DMARC records" },
              { icon: Key, label: "Admin Panel", desc: "Manage mailboxes, domains, and aliases" },
            ].map((item) => (
              <div key={item.label} className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                  <item.icon className="size-4 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{item.label}</p>
                  <p className="text-xs text-muted-foreground">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="size-4 text-amber-500 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-foreground">Prerequisites</p>
              <ul className="text-xs text-muted-foreground mt-1.5 space-y-1 list-disc list-inside">
                <li>A domain with DNS access</li>
                <li>Port 25 not blocked by your provider</li>
                <li>Clean Ubuntu/Debian server (recommended)</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Password field with reveal + generate ───────────────────────────────────

/**
 * Password input bundled with two affordances the user expects from a
 * "create credentials" form: a reveal toggle (so you can verify what you
 * typed) and a Generate button (so you can opt out of choosing one). The
 * generated value is auto-revealed so the user can read + copy it from
 * the field before submitting.
 */
function PasswordField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [revealed, setRevealed] = useState(false);

  const generate = () => {
    onChange(generatePassword());
    setRevealed(true);
  };

  return (
    <div className="relative flex items-stretch gap-2">
      <div className="relative flex-1">
        <input
          type={revealed ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full px-3 py-2.5 pr-10 rounded-xl border border-border bg-background text-sm font-mono placeholder:font-sans placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
        />
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-muted-foreground/70 hover:text-foreground transition-colors"
          title={revealed ? "Hide" : "Reveal"}
        >
          {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      <button
        type="button"
        onClick={generate}
        className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl border border-border/60 bg-background text-xs font-medium text-foreground hover:bg-muted/40 transition-colors"
        title="Generate a strong random password"
      >
        <Sparkles className="size-3.5" />
        Generate
      </button>
    </div>
  );
}
