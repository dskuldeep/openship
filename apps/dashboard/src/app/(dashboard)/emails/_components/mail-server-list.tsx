"use client";

import { Mail, Plus, ChevronRight, Globe, Trash2 } from "lucide-react";

export interface MailServerListItem {
  id: string;
  name: string;
  host: string;
  domain: string | null;
  completed: boolean;
  active: boolean;
}

/**
 * The mail-server registry view: one card per server in the `mail_servers`
 * table. Shown when more than one mail server exists (a single one auto-opens).
 * Selecting a card opens that server's admin/status; "Add mail server" routes
 * into the provision/adopt flow; the trash button detaches a stale/mismarked
 * entry (DB-only, re-adoptable).
 */
export function MailServerList({
  servers,
  onOpen,
  onAddNew,
  onRemove,
}: {
  servers: MailServerListItem[];
  onOpen: (serverId: string) => void;
  onAddNew: () => void;
  onRemove: (server: MailServerListItem) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold text-foreground">Mail servers</h2>
        <button
          type="button"
          onClick={onAddNew}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <Plus className="size-4" />
          Add mail server
        </button>
      </div>

      <div className="space-y-3">
        {servers.map((s) => (
          <div
            key={s.id}
            className="group flex items-center rounded-2xl border border-border/50 bg-card transition-colors hover:border-border"
          >
            <button
              type="button"
              onClick={() => onOpen(s.id)}
              className="flex min-w-0 flex-1 items-center gap-4 rounded-l-2xl p-5 text-left transition-colors hover:bg-foreground/[0.02]"
            >
              <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/15">
                <Mail className="size-5 text-primary" />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h3 className="truncate text-base font-semibold text-foreground">
                    {s.domain || s.name}
                  </h3>
                  <StatusPill completed={s.completed} active={s.active} />
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Globe className="size-3.5 shrink-0" />
                  <span className="truncate">{s.host}</span>
                </div>
              </div>

              <ChevronRight className="size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" />
            </button>

            <button
              type="button"
              onClick={() => onRemove(s)}
              title="Remove from list"
              aria-label={`Remove ${s.domain || s.name} from the mail list`}
              className="mr-3 flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground/40 transition-colors hover:bg-red-500/10 hover:text-red-600"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusPill({ completed, active }: { completed: boolean; active: boolean }) {
  const s = active
    ? { dot: "bg-amber-500", badge: "bg-amber-500/10 text-amber-600 dark:text-amber-400", label: "Installing" }
    : completed
      ? { dot: "bg-emerald-500", badge: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", label: "Running" }
      : { dot: "bg-muted-foreground/30", badge: "bg-muted/60 text-muted-foreground/70", label: "Incomplete" };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${s.badge}`}>
      <span className={`size-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

export default MailServerList;
