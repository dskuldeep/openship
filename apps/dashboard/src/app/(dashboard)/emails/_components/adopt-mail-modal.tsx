"use client";

import { useState } from "react";
import { Search, CheckCircle2, Loader2, MailCheck, AlertCircle } from "lucide-react";
import Modal from "@/components/shared/Modal";
import ServerSelector, { type ServerOption } from "@/components/shared/ServerSelector";
import { mailApi, getApiErrorMessage } from "@/lib/api";

interface ScanResult {
  serverId: string;
  iredmailInstalled: boolean;
  hasState: boolean;
  domain: string | null;
  installComplete: boolean;
  webmailPresent: boolean;
  adoptable: boolean;
}

/**
 * "Adopt existing mail server" — for the disaster-recovery case where the
 * orchestrator (desktop) was lost but the mail server still runs on a VPS.
 * Pick a server → scan (read-only: detects iRedMail + reads the on-server
 * state file) → adopt (repopulates the dashboard's record). No reinstall.
 */
export function AdoptMailModal({
  isOpen,
  onClose,
  onAdopted,
}: {
  isOpen: boolean;
  onClose: () => void;
  onAdopted: (serverId: string) => void;
}) {
  const [server, setServer] = useState<ServerOption | null>(null);
  const [scanning, setScanning] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setServer(null);
    setResult(null);
    setError(null);
    onClose();
  };

  const pickServer = (s: ServerOption | null) => {
    setServer(s);
    setResult(null);
    setError(null);
  };

  const handleScan = async () => {
    if (!server) return;
    setScanning(true);
    setError(null);
    setResult(null);
    try {
      const res = await mailApi.scan(server.id);
      setResult(res);
      if (!res.adoptable) {
        setError("No mail server installation was found on this server.");
      }
    } catch (e) {
      setError(getApiErrorMessage(e, "Scan failed — is the server reachable?"));
    } finally {
      setScanning(false);
    }
  };

  const handleAdopt = async () => {
    if (!server || !result?.adoptable) return;
    setAdopting(true);
    setError(null);
    try {
      const res = await mailApi.adopt(server.id);
      onAdopted(res.serverId);
      close();
    } catch (e) {
      setError(getApiErrorMessage(e, "Adopt failed"));
    } finally {
      setAdopting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={close} title="Adopt existing mail server">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Already set up a mail server with Openship on one of your servers? Pick it and scan — if a
          mail stack is found, it&apos;s re-adopted into the dashboard without reinstalling or
          touching your data.
        </p>

        <ServerSelector value={server?.id ?? null} onSelect={pickServer} compact />

        <button
          type="button"
          onClick={handleScan}
          disabled={!server || scanning || adopting}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-gray-200 bg-white text-sm font-medium text-gray-800 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {scanning ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
          {scanning ? "Scanning…" : "Scan server"}
        </button>

        {result?.adoptable && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-gray-800 space-y-1.5">
            <div className="flex items-center gap-2 font-medium text-emerald-700">
              <CheckCircle2 className="size-4" /> Mail server detected
            </div>
            <p>Domain: <span className="font-semibold">{result.domain ?? "unknown"}</span></p>
            <p className="text-gray-600">
              iRedMail running: {result.iredmailInstalled ? "yes" : "no"} · Install:{" "}
              {result.installComplete ? "complete" : "in progress"} · Webmail:{" "}
              {result.webmailPresent ? "present" : "not deployed"}
            </p>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 text-sm text-red-600">
            <AlertCircle className="size-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={close}
            className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleAdopt}
            disabled={!result?.adoptable || adopting}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {adopting ? <Loader2 className="size-4 animate-spin" /> : <MailCheck className="size-4" />}
            Adopt
          </button>
        </div>
      </div>
    </Modal>
  );
}
