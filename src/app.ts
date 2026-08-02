import Fastify, { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { FakeSandboxGateway, PaymentGateway } from "./gateway/provider.js";
import { logger } from "./logger.js";
import {
  CreatePaymentInput,
  InMemoryPaymentRepository,
  Payment,
  PaymentRepository,
  PaymentType,
  ReferenceType,
} from "./payments/repository.js";
import { FakeNotificationClient, NotificationClient } from "./notifications/client.js";

interface CollectBody {
  userId?: string;
  amountCents?: number;
  type?: string;
  referenceType?: string;
  referenceId?: string;
  recipientUserId?: string;
}

interface ListPaymentsQuery {
  type?: string;
  status?: string;
}

const VALID_TYPES: PaymentType[] = ["resolution", "seminar_entry", "gd_organizer", "gd_entry"];
const VALID_REFERENCE_TYPES: ReferenceType[] = ["booking", "seminar_registration", "gd", "gd_participant"];

// 10% platform cut, matches the design doc's fee split -- integer cents, rounded rather than
// truncated so the fee+recipient split always sums back to the original amount
function splitFee(amountCents: number): { platformFeeCents: number; recipientAmountCents: number } {
  const platformFeeCents = Math.round(amountCents * 0.1);
  return { platformFeeCents, recipientAmountCents: amountCents - platformFeeCents };
}

function isUuidLike(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// no currency-formatting convention exists elsewhere in this codebase yet -- plain rupee string
function formatCents(amountCents: number): string {
  return `₹${(amountCents / 100).toFixed(2)}`;
}

export function buildApp(
  paymentRepository: PaymentRepository = new InMemoryPaymentRepository(),
  paymentGateway: PaymentGateway = new FakeSandboxGateway(),
  internalServiceToken: string | undefined = process.env.INTERNAL_SERVICE_TOKEN,
  notificationClient: NotificationClient = new FakeNotificationClient(),
): FastifyInstance {
  const app = Fastify(
    process.env.NODE_ENV === "test"
      ? { logger: false }
      : { loggerInstance: logger as unknown as FastifyBaseLogger },
  );

  // Fastify's default JSON parser rejects an empty body when Content-Type: application/json is
  // set, even for methods like POST /confirm (no body needed) -- our own frontend sends that
  // header unconditionally on every request, so this bites any no-body call otherwise.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    if (body === "") {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  // internal routes are only ever called by other services (Resolution Service), never the
  // frontend directly -- gated on a shared secret, not the end-user identity header
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith("/internal/")) return;
    const token = request.headers["x-internal-service-token"];
    if (!token || token !== internalServiceToken) {
      request.log.warn("rejected internal request with missing/invalid service token");
      return reply.code(401).send({ error: "invalid internal service token" });
    }
  });

  const VALID_LOG_LEVELS = ["info", "debug", "error"];

  // runtime-mutable logging verbosity, no redeploy needed -- see src/logger.ts for the custom
  // info<debug<error severity ordering this project uses (not pino's default trace<debug<info<
  // warn<error<fatal). Gated the same as every other /internal/ route.
  app.get("/internal/log-level", async (_request, reply) => {
    return reply.send({ level: logger.level });
  });

  app.post<{ Body: { level?: string } }>("/internal/log-level", async (request, reply) => {
    const { level } = request.body ?? {};
    if (typeof level !== "string" || !VALID_LOG_LEVELS.includes(level)) {
      return reply.code(400).send({ error: `level must be one of ${VALID_LOG_LEVELS.join(", ")}` });
    }
    logger.level = level;
    request.log.info({ level }, "log level changed at runtime");
    return reply.send({ level: logger.level });
  });

  // user-facing routes trust the gateway-verified X-User-Id header, same pattern every other
  // service in this project uses -- this service never verifies JWTs itself
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith("/internal/") || request.url === "/healthz") return;
    const userId = request.headers["x-user-id"];
    if (!userId) {
      return reply.code(401).send({ error: "missing X-User-Id header" });
    }
  });

  app.post<{ Body: CollectBody }>("/internal/payments/collect", async (request, reply) => {
    const { userId, amountCents, type, referenceType, referenceId, recipientUserId } = request.body ?? {};

    if (!isUuidLike(userId)) {
      return reply.code(400).send({ error: "userId is required" });
    }
    if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0) {
      return reply.code(400).send({ error: "amountCents must be a positive integer" });
    }
    if (typeof type !== "string" || !VALID_TYPES.includes(type as PaymentType)) {
      return reply.code(400).send({ error: `type must be one of ${VALID_TYPES.join(", ")}` });
    }
    if (typeof referenceType !== "string" || !VALID_REFERENCE_TYPES.includes(referenceType as ReferenceType)) {
      return reply.code(400).send({ error: `referenceType must be one of ${VALID_REFERENCE_TYPES.join(", ")}` });
    }
    if (!isUuidLike(referenceId)) {
      return reply.code(400).send({ error: "referenceId is required" });
    }
    if (recipientUserId !== undefined && !isUuidLike(recipientUserId)) {
      return reply.code(400).send({ error: "recipientUserId must be a non-empty string when present" });
    }

    // idempotent on (referenceType, referenceId) -- a retried collect call for the same booking
    // returns the existing payment rather than erroring or double-charging
    const existing = await paymentRepository.getByReference(referenceType, referenceId);
    if (existing) {
      request.log.info({ paymentId: existing.id }, "collect: returning existing payment for reference");
      return reply.code(201).send({ paymentId: existing.id });
    }

    const input: CreatePaymentInput = {
      userId,
      amountCents,
      type: type as PaymentType,
      referenceType: referenceType as ReferenceType,
      referenceId,
      recipientUserId: recipientUserId ?? null,
    };
    const payment = await paymentRepository.create(input);
    request.log.info({ paymentId: payment.id }, "payment collected, pending confirmation");
    return reply.code(201).send({ paymentId: payment.id });
  });

  // shared by both refund routes below -- marks the payment refunded and, since this sandbox has
  // no separate "execute payout" step (a payout row is created pending and stays that way, no
  // real money movement to wait on), flips any payout for it to failed regardless of what state
  // it was sitting in. Money already paid out can't be cleanly un-paid-out in a real system
  // either, so this is the honest sandbox equivalent.
  async function refundPayment(payment: Payment) {
    await paymentRepository.markRefunded(payment.id);
    const payout = await paymentRepository.getPayoutByPaymentId(payment.id);
    if (payout && payout.status !== "failed") {
      await paymentRepository.markPayoutFailed(payout.id);
    }
  }

  app.post<{ Params: { id: string } }>("/internal/payments/:id/refund", async (request, reply) => {
    const payment = await paymentRepository.getById(request.params.id);
    if (!payment) {
      return reply.code(404).send({ error: "payment not found" });
    }
    if (payment.status !== "completed") {
      return reply.code(409).send({ error: `cannot refund a payment with status ${payment.status}` });
    }

    await refundPayment(payment);
    request.log.info({ paymentId: payment.id }, "payment refunded");
    return reply.send({ ok: true });
  });

  // admin dashboard: refunds the poster on a booking when a complaint turns out to be genuine.
  // Keyed by booking id (not payment id) since that's what the admin dashboard has on hand from
  // a complaint -- reuses the existing collect-time idempotency key (referenceType/referenceId)
  // to find the payment, same lookup Resolution Service's own collect call relies on.
  app.post<{ Params: { bookingId: string } }>(
    "/admin/payments/refund-by-booking/:bookingId",
    async (request, reply) => {
      if (request.headers["x-user-role"] !== "admin") {
        return reply.code(403).send({ error: "admin access required" });
      }

      const payment = await paymentRepository.getByReference("booking", request.params.bookingId);
      if (!payment) {
        return reply.code(404).send({ error: "no payment found for this booking" });
      }
      if (payment.status !== "completed") {
        return reply.code(409).send({ error: `cannot refund a payment with status ${payment.status}` });
      }

      await refundPayment(payment);
      request.log.info({ paymentId: payment.id, bookingId: request.params.bookingId }, "payment refunded by admin");
      return reply.send({ ok: true, paymentId: payment.id });
    },
  );

  app.get<{ Querystring: ListPaymentsQuery }>("/payments", async (request) => {
    const userId = request.headers["x-user-id"] as string;
    const { type, status } = request.query;
    return paymentRepository.listByUser(userId, { type, status });
  });

  app.get<{ Params: { id: string } }>("/payments/:id", async (request, reply) => {
    const userId = request.headers["x-user-id"] as string;
    const payment = await paymentRepository.getById(request.params.id);
    if (!payment) {
      return reply.code(404).send({ error: "payment not found" });
    }
    // only the payer can view a payment here -- the recipient sees their own payout via
    // GET /payouts under their own identity
    if (payment.userId !== userId) {
      return reply.code(403).send({ error: "not authorized to view this payment" });
    }
    return reply.send(payment);
  });

  app.post<{ Params: { id: string } }>("/payments/:id/confirm", async (request, reply) => {
    const userId = request.headers["x-user-id"] as string;
    const payment = await paymentRepository.getById(request.params.id);
    if (!payment) {
      return reply.code(404).send({ error: "payment not found" });
    }
    if (payment.userId !== userId) {
      return reply.code(403).send({ error: "not authorized to confirm this payment" });
    }
    if (payment.status !== "pending") {
      return reply.code(409).send({ error: `cannot confirm a payment with status ${payment.status}` });
    }

    const outcome = paymentGateway.simulateOutcome(payment.id, payment.amountCents);

    if (outcome === "failed") {
      const updated = await paymentRepository.markFailed(payment.id);
      request.log.info({ paymentId: payment.id }, "payment confirm: gateway simulated failure");
      return reply.send(updated);
    }

    const { platformFeeCents, recipientAmountCents } = splitFee(payment.amountCents);
    const updated = await paymentRepository.markCompleted(payment.id, platformFeeCents, recipientAmountCents);

    // the payout itself no longer happens here -- it's now gated on the resolver's real meeting
    // attendance, decided by Resolution Service at booking-completion time via
    // POST /internal/payments/:id/release-payout (see the under-time payout rule)

    // notifications degrade gracefully -- same pattern as resolution-service's StatsClient,
    // never let this block or fail the confirm itself
    try {
      await notificationClient.notify({
        userId: payment.userId,
        type: "payment_confirmed",
        referenceType: "payment",
        referenceId: payment.id,
        title: "Payment confirmed",
        body: `Your payment of ${formatCents(payment.amountCents)} has been confirmed.`,
      });
    } catch (err) {
      request.log.warn({ paymentId: payment.id, err }, "failed to send payment_confirmed notification");
    }

    request.log.info({ paymentId: payment.id }, "payment confirmed and completed");
    return reply.send(updated);
  });

  app.post<{ Params: { id: string }; Body: { decision?: string; holdUntil?: string } }>(
    "/internal/payments/:id/release-payout",
    async (request, reply) => {
      const { decision, holdUntil } = request.body ?? {};
      if (decision !== "release" && decision !== "withhold" && decision !== "hold") {
        return reply.code(400).send({ error: "decision must be 'release', 'withhold' or 'hold'" });
      }
      if (decision === "hold") {
        if (typeof holdUntil !== "string" || Number.isNaN(new Date(holdUntil).getTime())) {
          return reply.code(400).send({ error: "holdUntil must be a valid ISO date string when decision is 'hold'" });
        }
      }

      const payment = await paymentRepository.getById(request.params.id);
      if (!payment) {
        return reply.code(404).send({ error: "payment not found" });
      }
      if (payment.status !== "completed") {
        return reply.code(409).send({ error: `cannot release a payout for a payment with status ${payment.status}` });
      }

      // idempotent -- a retried complete-booking call must never create a second payout
      const existing = await paymentRepository.getPayoutByPaymentId(payment.id);
      if (existing) {
        request.log.info({ paymentId: payment.id, payoutId: existing.id }, "release-payout: returning existing payout");
        return reply.send({ payoutId: existing.id, status: existing.status });
      }

      if (!payment.recipientUserId || payment.recipientAmountCents === null) {
        request.log.warn({ paymentId: payment.id }, "release-payout called with no recipientUserId, no payout created");
        return reply.send({ payoutId: null, status: "no_recipient" });
      }

      const payoutStatus = decision === "release" ? "pending" : decision === "withhold" ? "withheld" : "held";
      const payout = await paymentRepository.createPayout(
        payment.recipientUserId,
        payment.recipientAmountCents,
        payment.id,
        payoutStatus,
        decision === "hold" ? holdUntil : undefined,
      );

      // "hold" doesn't notify yet -- the recipient is told once the hold-window sweep actually
      // releases it (see hold-sweep.ts). Only an immediate "release" notifies right away.
      if (decision === "release") {
        try {
          await notificationClient.notify({
            userId: payment.recipientUserId,
            type: "payout_received",
            referenceType: "payment",
            referenceId: payment.id,
            title: "Payout received",
            body: `You've received a payout of ${formatCents(payment.recipientAmountCents)}.`,
          });
        } catch (err) {
          request.log.warn({ paymentId: payment.id, err }, "failed to send payout_received notification");
        }
      }

      request.log.info({ paymentId: payment.id, payoutId: payout.id, decision }, "payout decided");
      return reply.code(201).send({ payoutId: payout.id, status: payout.status });
    },
  );

  app.get("/payouts", async (request) => {
    const userId = request.headers["x-user-id"] as string;
    return paymentRepository.listPayoutsByUser(userId);
  });

  return app;
}
