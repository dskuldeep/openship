/**
 * HTTP handlers for /backup-destinations. All ownership is per-user.
 */

import type { Context } from "hono";
import { getUserId, param } from "../../lib/controller-helpers";
import {
  createDestination,
  deleteDestination,
  getDestination,
  listDestinations,
  preflightDestination,
  updateDestination,
  type CreateDestinationInput,
  type UpdateDestinationInput,
} from "./destination.service";

export async function listAll(c: Context) {
  const userId = getUserId(c);
  const rows = await listDestinations(userId);
  return c.json({ data: rows });
}

export async function getOne(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  try {
    return c.json({ data: await getDestination(id, userId) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
  }
}

export async function create(c: Context) {
  const userId = getUserId(c);
  const body = await c.req.json<CreateDestinationInput>();
  try {
    return c.json({ data: await createDestination(userId, body) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
}

export async function update(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const body = await c.req.json<UpdateDestinationInput>().catch(() => ({}));
  try {
    return c.json({ data: await updateDestination(id, userId, body) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
}

export async function remove(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  try {
    await deleteDestination(id, userId);
    return c.json({ data: { ok: true } });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
}

export async function preflight(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  try {
    const result = await preflightDestination(id, userId);
    return c.json({ data: result });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
  }
}
