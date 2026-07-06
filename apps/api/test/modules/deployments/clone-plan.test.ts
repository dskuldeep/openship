import { describe, expect, it } from "vitest";

import { resolveClonePlan, type ClonePlanInput } from "../../../src/modules/deployments/clone-plan";

const base: ClonePlanInput = {
  effectiveTarget: "server",
  serverId: "srv_1",
  runtimeIsBare: false,
  cloneStrategy: "api-host",
  buildStrategy: "server",
  isDesktop: false,
  forwardGitCredentials: false,
};

describe("resolveClonePlan", () => {
  it("local build → clone runs locally with a local credential", () => {
    const plan = resolveClonePlan({ ...base, effectiveTarget: "server", buildStrategy: "local" });
    expect(plan.runsOnServer).toBe(false);
    expect(plan.runsLocally).toBe(true);
    expect(plan.cloneBuildStrategy).toBe("local");
  });

  it("docker + server + api-host clone → api-host clone (local credential), not on server", () => {
    const plan = resolveClonePlan({ ...base, cloneStrategy: "api-host" });
    expect(plan.runsOnServer).toBe(false);
    expect(plan.runsLocally).toBe(true);
    expect(plan.cloneBuildStrategy).toBe("local");
  });

  it("docker + server + clone-on-server → on-server clone with a shippable (server) credential", () => {
    const plan = resolveClonePlan({ ...base, cloneStrategy: "server" });
    expect(plan.runsOnServer).toBe(true);
    expect(plan.dockerClonesOnServer).toBe(true);
    expect(plan.runsLocally).toBe(false);
    expect(plan.cloneBuildStrategy).toBe("server");
    expect(plan.relayEligible).toBe(false); // non-desktop
  });

  it("bare + server → always clones on the server with a server credential", () => {
    const plan = resolveClonePlan({ ...base, runtimeIsBare: true, cloneStrategy: "api-host" });
    expect(plan.runsOnServer).toBe(true);
    expect(plan.dockerClonesOnServer).toBe(false); // bare excluded from the docker warn-case
    expect(plan.cloneBuildStrategy).toBe("server");
  });

  it("SECURITY: contradictory buildStrategy=local + cloneStrategy=server never emits a LOCAL credential for an on-server clone", () => {
    const plan = resolveClonePlan({ ...base, cloneStrategy: "server", buildStrategy: "local" });
    // The clone physically runs on the remote server...
    expect(plan.runsOnServer).toBe(true);
    // ...so the credential purpose MUST be "server" (shippable) — never "local",
    // which would ship the operator's broad gh/OAuth token off-host.
    expect(plan.runsLocally).toBe(false);
    expect(plan.cloneBuildStrategy).toBe("server");
  });

  it("desktop + forwardGitCredentials + on-server clone → relay eligible", () => {
    const plan = resolveClonePlan({
      ...base,
      cloneStrategy: "server",
      isDesktop: true,
      forwardGitCredentials: true,
    });
    expect(plan.runsOnServer).toBe(true);
    expect(plan.relayEligible).toBe(true);
  });

  it("cloud target without a local build → off-host clone needs a remote credential", () => {
    const plan = resolveClonePlan({
      ...base,
      effectiveTarget: "cloud",
      serverId: null,
      buildStrategy: "server",
    });
    expect(plan.runsOnServer).toBe(false);
    expect(plan.runsLocally).toBe(false);
    expect(plan.cloneBuildStrategy).toBe("server");
  });
});
