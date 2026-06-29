import { describe, it, expect } from "vitest";
import {
  runDeployPipeline,
  type DeployEnvironment,
  type DeployPipelineInput,
} from "./deploy-pipeline";
import type { BuildLogger } from "./build-pipeline";
import type { DeployConfig } from "../types";

// Minimal logger — the pipeline only calls step()/log()/callback().
function fakeLogger(): BuildLogger {
  return {
    step: () => {},
    log: () => {},
    callback: () => {},
  } as unknown as BuildLogger;
}

// The pipeline reads only config.port (and only when resolveTargetUrl is set,
// which these tests don't use), so a minimal cast is safe.
const config = { deploymentId: "new", projectId: "p", port: 3000 } as unknown as DeployConfig;

function makeInput(over: Partial<DeployPipelineInput> = {}): DeployPipelineInput {
  return { config, previousContainerId: "old", domains: [], ...over };
}

/** Build an env that records the order of lifecycle calls into `events`. */
function recordingEnv(events: string[], over: Partial<DeployEnvironment> = {}): DeployEnvironment {
  return {
    canOverlap: false,
    activate: async () => {
      events.push("activate");
      return { containerId: "new-container" };
    },
    deactivate: async () => {
      events.push("deactivate");
    },
    // resolveRoute is invoked during the route step → lets us assert ordering.
    resolveRoute: async () => {
      events.push("route");
      return { targetUrl: "http://127.0.0.1:3000" };
    },
    ...over,
  };
}

describe("runDeployPipeline cutover ordering", () => {
  it("overlap: activate → health → route → deactivate (old stopped LAST)", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, {
      canOverlap: true,
      healthCheck: async () => {
        events.push("health");
      },
    });

    const res = await runDeployPipeline(env, makeInput(), fakeLogger());

    expect(res.status).toBe("ready");
    expect(events).toEqual(["activate", "health", "route", "deactivate"]);
  });

  it("overlap: activate failure NEVER stops the old deployment (zero-impact auto-revert)", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, {
      canOverlap: true,
      activate: async () => {
        events.push("activate");
        throw new Error("container failed to start");
      },
    });

    const res = await runDeployPipeline(env, makeInput(), fakeLogger());

    expect(res.status).toBe("failed");
    expect(events).toContain("activate");
    expect(events).not.toContain("deactivate"); // old left running + routed
    expect(events).not.toContain("route");
  });

  it("overlap: health-gate failure stops nothing — old keeps serving", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, {
      canOverlap: true,
      healthCheck: async () => {
        events.push("health");
        throw new Error("not healthy");
      },
    });

    const res = await runDeployPipeline(env, makeInput(), fakeLogger());

    expect(res.status).toBe("failed");
    expect(events).toEqual(["activate", "health"]); // never routed, never deactivated
  });

  it("non-overlap (bare): deactivate old FIRST, then activate → route", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, { canOverlap: false });

    const res = await runDeployPipeline(env, makeInput(), fakeLogger());

    expect(res.status).toBe("ready");
    expect(events).toEqual(["deactivate", "activate", "route"]);
  });

  it("non-overlap: activate failure restarts the old deployment exactly once (auto-revert)", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, {
      canOverlap: false,
      activate: async () => {
        events.push("activate");
        throw new Error("port bind failed");
      },
      reactivatePrevious: async () => {
        events.push("reactivate");
      },
    });

    const res = await runDeployPipeline(env, makeInput(), fakeLogger());

    expect(res.status).toBe("failed");
    expect(events).toEqual(["deactivate", "activate", "reactivate"]);
    expect(events.filter((e) => e === "reactivate")).toHaveLength(1);
  });

  it("first deploy (no previous): overlap never calls deactivate", async () => {
    const events: string[] = [];
    const env = recordingEnv(events, { canOverlap: true });

    const res = await runDeployPipeline(env, makeInput({ previousContainerId: undefined }), fakeLogger());

    expect(res.status).toBe("ready");
    expect(events).toEqual(["activate", "route"]);
  });

  it("R1 gate: deactivatePrevious=false leaves the old one running even in overlap mode", async () => {
    // Models build-pipeline's snapshot gate: previousContainerId stays accurate,
    // but deactivatePrevious=false so archivePreviousDeployment can stop+retain
    // the old artifact for rollback. The pipeline must NOT stop it.
    const events: string[] = [];
    const env = recordingEnv(events, { canOverlap: true });

    const res = await runDeployPipeline(
      env,
      makeInput({ previousContainerId: "old", deactivatePrevious: false }),
      fakeLogger(),
    );

    expect(res.status).toBe("ready");
    expect(events).toEqual(["activate", "route"]); // old never stopped
  });
});
