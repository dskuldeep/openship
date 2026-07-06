"use client";

import { useMemo } from "react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { usePlatform } from "@/context/PlatformContext";
import { DomainSwitcher } from "@/components/routing/DomainSwitcher";
import { formatDate } from "@/utils/date";
import { getProjectStatus, PROJECT_STATUS_META } from "@/utils/project-status";
import {
  LayoutDashboard,
  Activity,
  Globe,
  Rocket,
  GitBranch,
  Wrench,
  ScrollText,
  AlertTriangle,
  Layers,
  ExternalLink,
  DatabaseBackup,
} from "lucide-react";

const TAB_ICONS: Record<
  string,
  React.ComponentType<{ className?: string; strokeWidth?: number }>
> = {
  overview: LayoutDashboard,
  monitoring: Activity,
  services: Layers,
  domains: Globe,
  deployments: Rocket,
  source: GitBranch,
  runtime: Wrench,
  settings: Wrench,
  logs: ScrollText,
  backup: DatabaseBackup,
  advanced: AlertTriangle,
};

/** Desktop right-column navigation - matches LibrarySidebar / Home pattern */
export const ProjectSidebar = () => {
  const {
    projectData,
    projectNotFound,
    activeTab,
    tabs,
    setActiveTab,
    domain,
    domainsData,
    selectedDomain,
    setSelectedDomain,
  } = useProjectSettings();
  const { selfHosted, baseDomain } = usePlatform();
  const status = getProjectStatus(projectData);
  const meta = PROJECT_STATUS_META[status];
  const localPort = projectData.port || 3000;
  const localUrl = `localhost:${localPort}`;
  const slugDomain = projectData.slug && baseDomain ? `${projectData.slug}.${baseDomain}` : "";

  // Route switch: pick which domain the Production line shows/opens (shared via
  // context so switching here also refetches the overview analytics).
  const domains = useMemo(
    () =>
      (domainsData?.domains ?? [])
        .map((d: any) => d?.domain)
        .filter((d: unknown): d is string => typeof d === "string" && d.length > 0),
    [domainsData?.domains],
  );

  const activeDomain = selectedDomain || domain || "";
  const displayUrl = activeDomain || slugDomain || localUrl;
  const isLocal = !activeDomain && !slugDomain && !selfHosted;
  const siteHref = isLocal ? `http://${displayUrl}` : `https://${displayUrl}`;

  const handleTabChange = (tabId: string) => {
    const scrollY = window.scrollY;
    setActiveTab(tabId);
    window.history.replaceState({}, "", `/projects/${projectData.id}/${tabId}`);
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
  };

  if (!projectData.id || projectNotFound) {
    return null;
  }

  return (
    <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
      <div className="bg-card rounded-2xl border border-border/50 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
              Project
            </p>
            <div className="mt-2 flex items-center gap-2">
              <h3 className="truncate text-base font-semibold text-foreground">
                {projectData.name || "Untitled Project"}
              </h3>
              <a
                href={siteHref}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${projectData.name || "project"}`}
                className="shrink-0 text-muted-foreground transition-colors hover:text-primary"
              >
                <ExternalLink className="size-3.5" />
              </a>
            </div>
          </div>
          <span
            className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${meta.badge}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
            {meta.label}
          </span>
        </div>

        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-muted-foreground">
              {isLocal ? "Local" : "Production"}
            </span>
            <div className="flex min-w-0 items-center gap-1.5">
              {domains.length > 1 ? (
                <DomainSwitcher domains={domains} value={activeDomain} onChange={setSelectedDomain} />
              ) : (
                <span className="truncate text-sm font-medium text-foreground">{displayUrl}</span>
              )}
              <a
                href={siteHref}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open"
                className="shrink-0 text-muted-foreground transition-colors hover:text-primary"
              >
                <ExternalLink className="size-3 shrink-0" />
              </a>
            </div>
          </div>
          {projectData.last_deployed && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-muted-foreground">Last Deploy</span>
              <p className="truncate text-sm font-medium text-foreground">
                {formatDate(projectData.last_deployed)}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="bg-card rounded-2xl border border-border/50 p-3">
        <div className="space-y-1">
          {tabs.map((tab) => {
            const Icon = TAB_ICONS[tab.id] || LayoutDashboard;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] font-medium transition-colors ${
                  isActive
                    ? "bg-foreground/[0.07] text-foreground"
                    : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
                }`}
              >
                <Icon className="size-[17px] shrink-0" strokeWidth={1.7} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

/** Mobile horizontal scroll tabs - rendered above content in left column */
export const ProjectMobileTabs = () => {
  const { projectData, projectNotFound, activeTab, tabs, setActiveTab } = useProjectSettings();

  const handleTabChange = (tabId: string) => {
    const scrollY = window.scrollY;
    setActiveTab(tabId);
    window.history.replaceState({}, "", `/projects/${projectData.id}/${tabId}`);
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
  };

  if (!projectData.id || projectNotFound) {
    return null;
  }

  return (
    <div className="lg:hidden sticky top-0 z-30 bg-background/80 backdrop-blur-md border-b border-border/40 -mx-4 px-4 sm:-mx-6 sm:px-6">
      <div className="flex items-center gap-1 overflow-x-auto py-2.5 scrollbar-hide">
        {tabs.map((tab) => {
          const Icon = TAB_ICONS[tab.id] || LayoutDashboard;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl text-[13px] font-medium whitespace-nowrap transition-colors ${
                isActive
                  ? "bg-foreground/[0.07] text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
              }`}
            >
              <Icon className="size-4 shrink-0" strokeWidth={1.7} />
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
};
