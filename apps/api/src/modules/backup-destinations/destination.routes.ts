import { Hono } from "hono";
import { authMiddleware } from "../../middleware/auth";
import * as ctrl from "./destination.controller";

export const backupDestinationRoutes = new Hono();

backupDestinationRoutes.use("*", authMiddleware);

backupDestinationRoutes.get("/", ctrl.listAll);
backupDestinationRoutes.post("/", ctrl.create);
backupDestinationRoutes.get("/:id", ctrl.getOne);
backupDestinationRoutes.patch("/:id", ctrl.update);
backupDestinationRoutes.delete("/:id", ctrl.remove);
backupDestinationRoutes.post("/:id/preflight", ctrl.preflight);
