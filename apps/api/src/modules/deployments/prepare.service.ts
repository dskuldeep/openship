/**
 * Prepare service - resolves project info from a source (GitHub or local path).
 *
 * Pure introspection: reads files, detects stack, returns a unified shape.
 * No database writes, no deployment logic.
 */

import * as githubService from "../github/github.service";
import type { RequestContext } from "../../lib/request-context";
import { MANIFEST_FILES, type RepoFile, type StackResult } from "../../lib/stack-detector";
import { parseComposeEnvFile, parseComposeFile, type ComposeService } from "../../lib/compose-parser";
import {
  applyWorkspaceContext,
  discoverMonorepoApps,
  discoverProjectRootHints,
  normalizeProjectRootDirectory,
  selectPreferredProjectRoot,
  type MonorepoApp,
  type MonorepoWorkspace,
  type ProjectRootSnapshot,
  type ProjectRootSnapshotInput,
  type RepoTreeEntry,
} from "../../lib/project-root-detector";
import type { ProjectType } from "@repo/core";
import { env } from "../../config";
import { createGitHubReader, type ProjectReader } from "./project-reader";

const PREPARE_FILE_CONTENTS = [
  ...MANIFEST_FILES,
  "pnpm-workspace.yaml",
  "vercel.json",
  "turbo.json",
  "nx.json",
  "rush.json",
] as const;
const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"] as const;


export type Source =
  | {
      source: "github";
      owner: string;
      repo: string;
      branch?: string;
      /** Request-scoped context — required when source === "github" so
       *  getRepository can resolve org-scoped install + cache keys.
       *  Optional in the type for back-compat with old callers; the
       *  github resolver throws when it's missing. */
      ctx?: RequestContext;
    }
  | { source: "local"; path: string };

export interface ProjectInfo {
  repository: {
    name: string;
    full_name: string;
    owner: { login: string };
    private: boolean;
    default_branch: string;
    selected_branch?: string;
    clone_url?: string;
    html_url?: string;
    branches?: { name: string }[];
  };
  stack: StackResult["stack"];
  projectType: ProjectType;
  category: string;
  packageManager: string;
  buildCommand: string;
  installCommand: string;
  startCommand: string;
  buildImage: string;
  outputDirectory: string;
  rootDirectory: string;
  productionPaths: string[];
  port: number;
  services?: ComposeService[];
  monorepoApps?: MonorepoApp[];
  monorepoWorkspace?: MonorepoWorkspace;
  rootEnv?: Record<string, string>;
}

function joinProjectPath(rootDirectory: string, name: string): string {
  const normalizedRootDirectory = normalizeProjectRootDirectory(rootDirectory);
  return normalizedRootDirectory ? `${normalizedRootDirectory}/${name}` : name;
}

async function readProjectSnapshot(
  reader: ProjectReader,
  rootDirectory = "",
  source: ProjectRootSnapshotInput["source"] = "root",
): Promise<ProjectRootSnapshotInput> {
  const normalizedRootDirectory = normalizeProjectRootDirectory(rootDirectory);
  const files = await reader.listDirectory(normalizedRootDirectory);
  const packageJson = await reader.readJson(joinProjectPath(normalizedRootDirectory, "package.json"));
  const fileContents: Record<string, string> = {};

  await Promise.all(
    PREPARE_FILE_CONTENTS
      .filter((name) => files.some((file) => file.name.toLowerCase() === name.toLowerCase()))
      .map(async (name) => {
        const content = await reader.readText(joinProjectPath(normalizedRootDirectory, name));
        if (content) {
          fileContents[name] = content;
        }
      }),
  );

  // Workspace manifests with dynamic basenames - PREPARE_FILE_CONTENTS
  // is a static list, but .NET solutions are named per-repo (e.g.
  // `MedicaScopeLMS.sln`) so the lowercase-equality match above would
  // miss them. Without the content here, `detectWorkspaces` finds the
  // filename in `files` but can't pull its body, so workspace
  // discovery (and the whole monorepo flow) silently no-ops.
  await Promise.all(
    files
      .filter((file) => /\.sln$/i.test(file.name))
      .map(async (file) => {
        const content = await reader.readText(joinProjectPath(normalizedRootDirectory, file.name));
        if (content) {
          fileContents[file.name] = content;
        }
      }),
  );

  return {
    rootDirectory: normalizedRootDirectory,
    files,
    packageJson,
    fileContents,
    source,
  };
}

async function loadCandidateSnapshot(
  reader: ProjectReader,
  rootDirectory: string,
  source: ProjectRootSnapshotInput["source"],
): Promise<ProjectRootSnapshotInput | null> {
  const snapshot = await readProjectSnapshot(reader, rootDirectory, source);
  if (!snapshot.rootDirectory || snapshot.files.length === 0) {
    return null;
  }

  return snapshot;
}

interface SelectedProjectSnapshot {
  selected: ProjectRootSnapshot;
  monorepo: { apps: MonorepoApp[]; workspace: MonorepoWorkspace } | null;
}

async function selectProjectSnapshot(
  reader: ProjectReader,
  rootSnapshot: ProjectRootSnapshotInput,
): Promise<SelectedProjectSnapshot> {
  const treeEntries = await reader.listTree().catch(() => [] as RepoTreeEntry[]);
  const hints = discoverProjectRootHints(
    treeEntries,
    rootSnapshot.fileContents,
    rootSnapshot.packageJson,
  );

  const candidates = (await Promise.all(
    hints.map((hint) => loadCandidateSnapshot(reader, hint.rootDirectory, hint.source)),
  )).filter((candidate): candidate is ProjectRootSnapshotInput => Boolean(candidate));

  const selected = applyWorkspaceContext(
    rootSnapshot,
    selectPreferredProjectRoot(rootSnapshot, candidates),
  );
  const monorepo = discoverMonorepoApps(rootSnapshot, candidates);

  return { selected, monorepo };
}


async function readProjectText(
  reader: ProjectReader,
  rootDirectory: string,
  name: string,
): Promise<string | undefined> {
  return reader.readText(joinProjectPath(rootDirectory, name));
}

async function readComposeText(
  reader: ProjectReader,
  rootDirectory: string,
  files: RepoFile[],
): Promise<string | undefined> {
  for (const name of COMPOSE_FILES) {
    if (!files.some((file) => file.name.toLowerCase() === name)) {
      continue;
    }

    const composeContent = await readProjectText(reader, rootDirectory, name);
    if (composeContent) {
      return composeContent;
    }
  }

  return undefined;
}

/**
 * Resolve project info from either a GitHub repo or a local filesystem path.
 * Both paths converge on detectStack and return the same ProjectInfo shape.
 */
export async function resolveProjectInfo(input: Source): Promise<ProjectInfo> {
  if (input.source === "github") {
    if (!input.ctx) {
      throw new Error("resolveProjectInfo(github): ctx is required");
    }
    return resolveFromGitHub(input.ctx, input.owner, input.repo, input.branch);
  }

  if (env.CLOUD_MODE) {
    throw new Error("Local project resolution is not available in cloud mode");
  }

  // Dynamic import keeps local-source (node:fs) out of the cloud module graph.
  const { resolveFromLocal } = await import("./local-source");
  return resolveFromLocal(input.path);
}

type RepoMeta = Parameters<typeof toProjectInfo>[0];

/**
 * Shared resolution pipeline: snapshot → select root → read compose/.env → map.
 * Source-specific work (auth, branch validation, fs stat) lives in the callers.
 */
export async function resolveFromReader(
  reader: ProjectReader,
  repoMeta: RepoMeta,
  selectedBranch: string,
): Promise<ProjectInfo> {
  const rootSnapshot = await readProjectSnapshot(reader);
  const { selected, monorepo } = await selectProjectSnapshot(reader, rootSnapshot);
  const [composeContent, composeEnvContent] = await Promise.all([
    readComposeText(reader, selected.rootDirectory, selected.files),
    readProjectText(reader, selected.rootDirectory, ".env"),
  ]);

  return toProjectInfo(repoMeta, selected, composeContent, selectedBranch, composeEnvContent, monorepo);
}

async function resolveFromGitHub(
  ctx: RequestContext,
  owner: string,
  repo: string,
  branch?: string,
): Promise<ProjectInfo> {
  const repository = await githubService.getRepository(ctx, owner, repo, {
    withBranches: true,
  });
  const requestedBranch = branch?.trim();
  const selectedBranch = requestedBranch || repository.default_branch;

  if (requestedBranch) {
    const head = await githubService.getLatestCommit(ctx, owner, repo, selectedBranch);
    if (!head) {
      throw new Error(`Branch "${selectedBranch}" was not found for ${owner}/${repo}`);
    }
  }

  return resolveFromReader(
    createGitHubReader(ctx, owner, repo, selectedBranch),
    repository,
    selectedBranch,
  );
}

function toProjectInfo(
  repo: {
    name: string;
    full_name: string;
    owner: string;
    private: boolean;
    default_branch: string;
    selected_branch?: string;
    clone_url?: string;
    html_url?: string;
    branches?: { name: string }[];
  },
  projectRoot: ProjectRootSnapshot,
  composeContent?: string,
  selectedBranch?: string,
  composeEnvContent?: string,
  monorepo?: { apps: MonorepoApp[]; workspace: MonorepoWorkspace } | null,
): ProjectInfo {
  const stack = projectRoot.stack;
  const rootEnv = composeEnvContent ? parseComposeEnvFile(composeEnvContent) : {};

  let services: ComposeService[] | undefined;
  if (composeContent && stack.projectType === "services") {
    try {
      const parsed = parseComposeFile(composeContent, { envFileContent: composeEnvContent });
      services = parsed.services;
    } catch {
      // Invalid YAML - continue without services.
    }
  }

  // Monorepo wins over the single-root projectType: when the root has a workspace
  // manifest AND we found 2+ deployable apps, expose the multi-app flow. The
  // `selected` root provides a single-app fallback if the user chooses to deploy
  // just one.
  const isMonorepo = !services && monorepo && monorepo.apps.length >= 2;
  const projectType: ProjectType = isMonorepo ? "monorepo" : stack.projectType;

  return {
    repository: {
      name: repo.name,
      full_name: repo.full_name,
      owner: { login: repo.owner },
      private: repo.private,
      default_branch: repo.default_branch,
      selected_branch: selectedBranch || repo.default_branch,
      clone_url: repo.clone_url,
      html_url: repo.html_url,
      branches: repo.branches,
    },
    stack: stack.stack,
    projectType,
    category: stack.category,
    packageManager: stack.packageManager,
    buildCommand: stack.buildCommand,
    installCommand: stack.installCommand,
    startCommand: stack.startCommand,
    buildImage: stack.buildImage,
    outputDirectory: stack.outputDirectory,
    rootDirectory: projectRoot.rootDirectory || "./",
    productionPaths: stack.productionPaths,
    port: stack.port,
    ...(services && { services }),
    ...(isMonorepo && monorepo
      ? { monorepoApps: monorepo.apps, monorepoWorkspace: monorepo.workspace }
      : {}),
    ...(Object.keys(rootEnv).length > 0 && { rootEnv }),
  };
}
