import { Hono } from "hono";
import { authMiddleware } from "../../middleware";
import * as billingController from "./billing.controller";

/**
 * Plan info - no Stripe required, works on ALL instances.
 * Registered at `/api/billing` on every deploy mode.
 */
export const billingPlansRoutes = new Hono();
billingPlansRoutes.get("/plans", billingController.listPlans);

/**
 * Stripe-powered billing - SaaS only (CLOUD_MODE=true).
 * Registered at `/api/billing` only when CLOUD_MODE.
 *
 * ⚠ This sub-app shares the `/api/billing` mount prefix with
 * `billingPlansRoutes` (which serves a PUBLIC GET /plans). Using
 * `.use("*", authMiddleware)` here would extend across siblings in
 * Hono v4 — same landmine the backup-routes had. Scope to explicit
 * sub-paths so /plans stays reachable regardless of mount order.
 */
export const billingSaasRoutes = new Hono();

billingSaasRoutes.use("/subscription", authMiddleware);
billingSaasRoutes.use("/usage", authMiddleware);
billingSaasRoutes.use("/payment-methods", authMiddleware);
billingSaasRoutes.use("/invoices", authMiddleware);
// /webhook/stripe is intentionally unauthed — Stripe signs the
// request; verification happens inside the handler. No middleware
// here would have caught it under the old wildcard either.

billingSaasRoutes.get("/subscription", billingController.getSubscription);
billingSaasRoutes.post("/subscription", billingController.createSubscription);
billingSaasRoutes.patch("/subscription", billingController.updateSubscription);
billingSaasRoutes.delete("/subscription", billingController.cancelSubscription);

billingSaasRoutes.get("/usage", billingController.getUsage);

billingSaasRoutes.get("/payment-methods", billingController.listPaymentMethods);
billingSaasRoutes.post("/payment-methods", billingController.addPaymentMethod);

billingSaasRoutes.get("/invoices", billingController.listInvoices);

billingSaasRoutes.post("/webhook/stripe", billingController.stripeWebhook);
