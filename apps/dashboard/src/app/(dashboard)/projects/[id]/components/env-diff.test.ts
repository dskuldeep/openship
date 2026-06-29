import { describe, it, expect } from "vitest";
import { computeEnvDiff, type EnvEditorRow } from "./env-diff";

// Helpers to build rows tersely.
const loaded = (key: string, opts: Partial<EnvEditorRow> = {}): EnvEditorRow => ({
  key,
  value: "",
  isSecret: false,
  originalKey: key,
  loadedSecret: false,
  ...opts,
});
const loadedSecret = (key: string, opts: Partial<EnvEditorRow> = {}): EnvEditorRow =>
  loaded(key, { isSecret: true, loadedSecret: true, value: "", ...opts });
const added = (key: string, value: string, isSecret = false): EnvEditorRow => ({
  key,
  value,
  isSecret,
  originalKey: null,
  loadedSecret: false,
});

function ok(rows: EnvEditorRow[], originalKeys: string[]) {
  const r = computeEnvDiff(rows, originalKeys);
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r.diff;
}

describe("computeEnvDiff", () => {
  it("untouched masked secret → never in upserts or deletes (no corruption, no wipe)", () => {
    const diff = ok([loadedSecret("API_KEY")], ["API_KEY"]);
    expect(diff.upserts).toEqual([]); // the masked secret value is never re-sent
    expect(diff.deletes).toEqual([]);
  });

  it("a non-secret re-upserts idempotently (same value) — safe, never a wipe", () => {
    // We don't track original non-secret values, so any present value re-writes
    // the same value. Harmless; the critical guarantee is that SECRETS stay out.
    const diff = ok([loaded("PUBLIC", { value: "same" })], ["PUBLIC"]);
    expect(diff.upserts).toEqual([{ key: "PUBLIC", value: "same", isSecret: false }]);
    expect(diff.deletes).toEqual([]);
  });

  it("editing a non-secret value → upsert that key only", () => {
    const diff = ok([loaded("PUBLIC", { value: "new" }), loadedSecret("API_KEY")], ["PUBLIC", "API_KEY"]);
    expect(diff.upserts).toEqual([{ key: "PUBLIC", value: "new", isSecret: false }]);
    expect(diff.deletes).toEqual([]);
  });

  it("re-entering a secret → upsert with the new value (untouched ones stay out)", () => {
    const diff = ok([loadedSecret("API_KEY", { value: "new-secret" })], ["API_KEY"]);
    expect(diff.upserts).toEqual([{ key: "API_KEY", value: "new-secret", isSecret: true }]);
    expect(diff.deletes).toEqual([]);
  });

  it("deleting a var (row removed from the editor) → key appears in deletes", () => {
    // Loaded with KEEP + GONE; user removed GONE so only KEEP remains in rows.
    const diff = ok([loaded("KEEP", { value: "v" })], ["KEEP", "GONE"]);
    expect(diff.deletes).toEqual(["GONE"]);
    // KEEP is a non-secret with its (unchanged) value present → idempotent upsert.
    expect(diff.upserts).toEqual([{ key: "KEEP", value: "v", isSecret: false }]);
  });

  it("renaming a non-secret → delete old key + upsert new key", () => {
    const diff = ok([loaded("OLD", { key: "NEW", value: "v" })], ["OLD"]);
    expect(diff.upserts).toEqual([{ key: "NEW", value: "v", isSecret: false }]);
    expect(diff.deletes).toEqual(["OLD"]);
  });

  it("adding a new var → upsert", () => {
    const diff = ok([added("NEW", "v", true)], []);
    expect(diff.upserts).toEqual([{ key: "NEW", value: "v", isSecret: true }]);
    expect(diff.deletes).toEqual([]);
  });

  it("blank freshly-added row is ignored", () => {
    const diff = ok([added("", ""), loaded("PUBLIC", { value: "x" })], ["PUBLIC"]);
    expect(diff.upserts).toEqual([{ key: "PUBLIC", value: "x", isSecret: false }]);
    expect(diff.deletes).toEqual([]);
  });

  it("rejects a new var with no value", () => {
    expect(computeEnvDiff([added("NEW", "")], [])).toMatchObject({ ok: false });
  });

  it("rejects duplicate keys", () => {
    expect(computeEnvDiff([loaded("DUP", { value: "a" }), added("DUP", "b")], ["DUP"])).toMatchObject({
      ok: false,
    });
  });

  it("rejects renaming a masked secret without re-entering its value", () => {
    expect(computeEnvDiff([loadedSecret("API_KEY", { key: "RENAMED" })], ["API_KEY"])).toMatchObject({
      ok: false,
    });
  });

  it("rejects flipping a masked secret to non-secret without re-entering", () => {
    expect(computeEnvDiff([loadedSecret("API_KEY", { isSecret: false })], ["API_KEY"])).toMatchObject({
      ok: false,
    });
  });
});
