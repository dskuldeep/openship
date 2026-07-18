/**
 * Cloud edge proxy service - sync a namespaced edge proxy on Oblien.
 *
 * Extracted from cloud-saas.controller so slug normalization +
 * hostname construction stay in one place and are unit-testable
 * independent of the HTTP layer.
 */

import { SYSTEM } from "@repo/core";
import { getNamespaceClient } from "../../lib/openship-cloud";

export async function syncCloudEdgeProxy(
  organizationId: string,
  input: { slug: string; target: string },
): Promise<{ ok: true; hostname: string } | { ok: false; status: 400; error: string }> {
  const slug = input.slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) {
    return { ok: false, status: 400, error: "Invalid slug" };
  }

  const baseDomain = SYSTEM.DOMAINS.CLOUD_DOMAIN;
  const hostname = `${slug}.${baseDomain}`;
  const target =
    input.target.startsWith("http://") || input.target.startsWith("https://")
      ? input.target
      : `http://${input.target}`;

  const { client, namespace } = await getNamespaceClient(organizationId);

  // Namespace isolation: Oblien scopes edgeProxy.list/update/enable to
  // the namespace token's owner, so the look-up-by-slug + mutate path
  // can't cross orgs. The `create` call additionally passes `namespace`
  // explicitly so Oblien validates the new resource lands in the
  // expected namespace — non-create methods (list/update/enable/disable
  // /delete) identify by id and don't accept a namespace param.
  const { proxies } = await client.edgeProxy.list();
  const existing = proxies.find((p) => p.slug === slug);

  if (!existing) {
    await client.edgeProxy.create({ name: hostname, slug, domain: baseDomain, target, namespace });
  } else {
    if (
      existing.name !== hostname ||
      existing.slug !== slug ||
      existing.target !== target
    ) {
      await client.edgeProxy.update(existing.id, { name: hostname, slug, target });
    }
    if (existing.status === "disabled") {
      await client.edgeProxy.enable(existing.id);
    }
  }

  return { ok: true, hostname };
}
