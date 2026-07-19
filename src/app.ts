import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { FakeSandboxGateway, PaymentGateway } from "./gateway/provider.js";
import {
  CreatePaymentInput,
  InMemoryPaymentRepository,
  PaymentRepository,
  PaymentType,
  ReferenceType,
} from "./payments/repository.js";

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

const VALID_TYPES: PaymentType[] = ["resolution"];
const VALID_REFERENCE_TYPES: ReferenceType[] = ["booking"];

// 10% platform cut, matches the design doc's fee split -- integer cents, rounded rather than
// truncated so the fee+recipient split always sums back to the original amount
function splitFee(amountCents: number): { platformFeeCents: number; recipientAmountCents: number } {
  const platformFeeCents = Math.round(amountCents * 0.1);
  return { platformFeeCents, recipientAmountCents: amountCents - platformFeeCents };
}

function isUuidLike(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function buildApp(
  paymentRepository: PaymentRepository = new InMemoryPaymentRepository(),
  paymentGateway: PaymentGateway = new FakeSandboxGateway(),
  internalServiceToken: string | undefined = process.env.INTERNAL_SERVICE_TOKEN,
): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV === "test" ? false : { level: process.env.LOG_LEVEL ?? "info" },
  });

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

  app.post<{ Params: { id: string } }>("/internal/payments/:id/refund", async (request, reply) => {
    const payment = await paymentRepository.getById(request.params.id);
    if (!payment) {
      return reply.code(404).send({ error: "payment not found" });
    }
    if (payment.status !== "completed") {
      return reply.code(409).send({ error: `cannot refund a payment with status ${payment.status}` });
    }

    await paymentRepository.markRefunded(payment.id);

    // this sandbox has no separate "execute payout" step -- a payout row is created pending
    // and stays that way, there's no real money movement to wait on. Money already paid out
    // can't be cleanly un-paid-out in a real system either, so we just flip the payout's status
    // to reflect the refund happened, regardless of what state it was sitting in
    const payout = await paymentRepository.getPayoutByPaymentId(payment.id);
    if (payout && payout.status !== "failed") {
      await paymentRepository.markPayoutFailed(payout.id);
    }

    request.log.info({ paymentId: payment.id }, "payment refunded");
    return reply.send({ ok: true });
  });

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

    // resolver payout -- recipientUserId was captured at collect-time since this service has
    // no way to derive "who resolved this booking" from referenceType/referenceId alone
    if (payment.recipientUserId) {
      await paymentRepository.createPayout(payment.recipientUserId, recipientAmountCents, payment.id);
    } else {
      request.log.warn({ paymentId: payment.id }, "payment completed with no recipientUserId, no payout created");
    }

    request.log.info({ paymentId: payment.id }, "payment confirmed and completed");
    return reply.send(updated);
  });

  app.get("/payouts", async (request) => {
    const userId = request.headers["x-user-id"] as string;
    return paymentRepository.listPayoutsByUser(userId);
  });

  return app;
}
