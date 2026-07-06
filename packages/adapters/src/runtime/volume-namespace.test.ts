import { describe, it, expect } from "vitest";
import {
  scopedVolumeName,
  isHostPathSource,
  scopeVolumeBinds,
} from "./volume-namespace";

describe("scopedVolumeName", () => {
  it("prefixes with openship-<slug>-", () => {
    expect(scopedVolumeName("clincai", "postgres_data")).toBe(
      "openship-clincai-postgres_data",
    );
  });
});

describe("isHostPathSource", () => {
  it("flags host paths", () => {
    expect(isHostPathSource("/var/data")).toBe(true);
    expect(isHostPathSource("./data")).toBe(true);
    expect(isHostPathSource("../data")).toBe(true);
    expect(isHostPathSource("~/data")).toBe(true); // the gap the legacy classifier missed
  });
  it("does not flag named volumes", () => {
    expect(isHostPathSource("postgres_data")).toBe(false);
    expect(isHostPathSource("pgdata")).toBe(false);
  });
});

describe("scopeVolumeBinds", () => {
  const slug = "clincai";

  it("scopes a named volume", () => {
    expect(scopeVolumeBinds(slug, ["postgres_data:/var/lib/postgresql/data"], true)).toEqual([
      "openship-clincai-postgres_data:/var/lib/postgresql/data",
    ]);
  });

  it("preserves a trailing mode suffix", () => {
    expect(scopeVolumeBinds(slug, ["pgdata:/data:ro"], true)).toEqual([
      "openship-clincai-pgdata:/data:ro",
    ]);
  });

  it("passes bind mounts through untouched (/, ./, ../, ~)", () => {
    const binds = ["/host/data:/data", "./rel:/data", "../up:/data", "~/home:/data"];
    expect(scopeVolumeBinds(slug, binds, true)).toEqual(binds);
  });

  it("passes anonymous (single-segment) volumes through untouched", () => {
    expect(scopeVolumeBinds(slug, ["/var/lib/postgresql/data"], true)).toEqual([
      "/var/lib/postgresql/data",
    ]);
  });

  it("is a no-op when disabled (grandfathered services keep bare names)", () => {
    const binds = ["postgres_data:/var/lib/postgresql/data"];
    expect(scopeVolumeBinds(slug, binds, false)).toEqual(binds);
  });

  it("is idempotent — does not double-scope an already-scoped source", () => {
    const once = scopeVolumeBinds(slug, ["postgres_data:/data"], true);
    expect(scopeVolumeBinds(slug, once, true)).toEqual(once);
  });

  it("scopes each named volume in a mixed list independently", () => {
    expect(
      scopeVolumeBinds(
        slug,
        ["pgdata:/var/lib/postgresql/data", "/etc/config:/config:ro", "redis_data:/data"],
        true,
      ),
    ).toEqual([
      "openship-clincai-pgdata:/var/lib/postgresql/data",
      "/etc/config:/config:ro",
      "openship-clincai-redis_data:/data",
    ]);
  });
});
