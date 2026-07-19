import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { InMemoryPaymentRepository } from "./payments/repository.js";
import { FakeSandboxGateway, FORCE_FAILURE_AMOUNT_CENTS } from "./gateway/provider.js";

const INTERNAL_TOKEN = "test-internal-token";
const PAYER_ID = "11111111-1111-1111-1111-111111111111";
const RECIPIENT_ID = "22222222-2222-2222-2222-222222222222";
const BOOKING_ID = "33333333-3333-3333-3333-333333333333";

function newApp() {
  return buildApp(new InMemoryPaymentRepository(), new FakeSandboxGateway(), INTERNAL_TOKEN);
}

function collectBody(overrides: Record<string, unknown> = {}) {
  return {
    userId: PAYER_ID,
    amountCents: 10000,
    type: "resolution",
    referenceType: "booking",
    referenceId: BOOKING_ID,
    recipientUserId: RECIPIENT_ID,
    ...overrides,
  };
}

async function collect(app: ReturnType<typeof newApp>, body: Record<string, unknown> = collectBody()) {
  return app.inject({
    method: "POST",
    url: "/internal/payments/collect",
    headers: { "x-internal-service-token": INTERNAL_TOKEN },
    payload: body,
  });
}

describe("GET /healthz", () => {
  it("returns ok status", async () => {
    const app = newApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("internal auth", () => {
  it("401s with no internal token", async () => {
    const app = newApp();
    const res = await app.inject({ method: "POST", url: "/internal/payments/collect", payload: collectBody() });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid internal service token" });
  });

  it("401s with a wrong internal token", async () => {
    const app = newApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/payments/collect",
      headers: { "x-internal-service-token": "wrong" },
      payload: collectBody(),
    });
    expect(res.statusCode).toBe(401);
  });

  it("401s an internal route even when a valid X-User-Id header is presented instead of a service token", async () => {
    // proves a compromised/malicious frontend can't call internal routes just by knowing the URL
    const app = newApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/payments/collect",
      headers: { "x-user-id": PAYER_ID },
      payload: collectBody(),
    });
    expect(res.statusCode).toBe(401);
  });

  it("refund also 401s with no internal token", async () => {
    const app = newApp();
    const res = await app.inject({ method: "POST", url: "/internal/payments/some-id/refund" });
    expect(res.statusCode).toBe(401);
  });
});

describe("user-facing auth", () => {
  it("401s GET /payments with no X-User-Id header", async () => {
    const app = newApp();
    const res = await app.inject({ method: "GET", url: "/payments" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "missing X-User-Id header" });
  });
});

describe("POST /internal/payments/collect", () => {
  it("creates a pending payment", async () => {
    const app = newApp();
    const res = await collect(app);
    expect(res.statusCode).toBe(201);
    expect(res.json().paymentId).toBeDefined();
  });

  it("400s with a missing userId", async () => {
    const app = newApp();
    const { userId, ...rest } = collectBody();
    const res = await collect(app, rest);
    expect(res.statusCode).toBe(400);
  });

  it("400s with a missing amountCents", async () => {
    const app = newApp();
    const { amountCents, ...rest } = collectBody();
    const res = await collect(app, rest);
    expect(res.statusCode).toBe(400);
  });

  it("400s with a non-integer amountCents", async () => {
    const app = newApp();
    const res = await collect(app, collectBody({ amountCents: 100.5 }));
    expect(res.statusCode).toBe(400);
  });

  it("400s with a zero amountCents", async () => {
    const app = newApp();
    const res = await collect(app, collectBody({ amountCents: 0 }));
    expect(res.statusCode).toBe(400);
  });

  it("400s with a negative amountCents", async () => {
    const app = newApp();
    const res = await collect(app, collectBody({ amountCents: -500 }));
    expect(res.statusCode).toBe(400);
  });

  it("400s with a wrong type literal", async () => {
    const app = newApp();
    const res = await collect(app, collectBody({ type: "seminar" }));
    expect(res.statusCode).toBe(400);
  });

  it("400s with a missing type", async () => {
    const app = newApp();
    const { type, ...rest } = collectBody();
    const res = await collect(app, rest);
    expect(res.statusCode).toBe(400);
  });

  it("400s with a wrong referenceType literal", async () => {
    const app = newApp();
    const res = await collect(app, collectBody({ referenceType: "gd" }));
    expect(res.statusCode).toBe(400);
  });

  it("400s with a missing referenceType", async () => {
    const app = newApp();
    const { referenceType, ...rest } = collectBody();
    const res = await collect(app, rest);
    expect(res.statusCode).toBe(400);
  });

  it("400s with a missing referenceId", async () => {
    const app = newApp();
    const { referenceId, ...rest } = collectBody();
    const res = await collect(app, rest);
    expect(res.statusCode).toBe(400);
  });

  it("is idempotent for a repeat call with the same referenceType/referenceId", async () => {
    const app = newApp();
    const first = await collect(app);
    const second = await collect(app);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().paymentId).toBe(first.json().paymentId);
  });
});

describe("POST /internal/payments/:id/refund", () => {
  async function collectAndConfirm(app: ReturnType<typeof newApp>, amountCents = 10000) {
    const collected = await collect(app, collectBody({ amountCents, referenceId: crypto.randomUUID() }));
    const paymentId = collected.json().paymentId;
    await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/confirm`,
      headers: { "x-user-id": PAYER_ID },
    });
    return paymentId;
  }

  it("404s for an unknown id", async () => {
    const app = newApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/payments/does-not-exist/refund",
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
    });
    expect(res.statusCode).toBe(404);
  });

  it("409s refunding a pending payment", async () => {
    const app = newApp();
    const collected = await collect(app);
    const paymentId = collected.json().paymentId;
    const res = await app.inject({
      method: "POST",
      url: `/internal/payments/${paymentId}/refund`,
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
    });
    expect(res.statusCode).toBe(409);
  });

  it("409s refunding a failed payment", async () => {
    const app = newApp();
    const collected = await collect(app, collectBody({ amountCents: FORCE_FAILURE_AMOUNT_CENTS }));
    const paymentId = collected.json().paymentId;
    await app.inject({ method: "POST", url: `/payments/${paymentId}/confirm`, headers: { "x-user-id": PAYER_ID } });

    const res = await app.inject({
      method: "POST",
      url: `/internal/payments/${paymentId}/refund`,
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
    });
    expect(res.statusCode).toBe(409);
  });

  it("409s refunding an already-refunded payment", async () => {
    const app = newApp();
    const paymentId = await collectAndConfirm(app);

    const first = await app.inject({
      method: "POST",
      url: `/internal/payments/${paymentId}/refund`,
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/internal/payments/${paymentId}/refund`,
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
    });
    expect(second.statusCode).toBe(409);
  });

  it("succeeds refunding a completed payment and flips its payout to failed", async () => {
    const app = newApp();
    const paymentId = await collectAndConfirm(app);

    const res = await app.inject({
      method: "POST",
      url: `/internal/payments/${paymentId}/refund`,
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const payoutsRes = await app.inject({ method: "GET", url: "/payouts", headers: { "x-user-id": RECIPIENT_ID } });
    const payouts = payoutsRes.json();
    expect(payouts).toHaveLength(1);
    expect(payouts[0].status).toBe("failed");
  });
});

describe("GET /payments/:id", () => {
  it("404s for an unknown id", async () => {
    const app = newApp();
    const res = await app.inject({ method: "GET", url: "/payments/does-not-exist", headers: { "x-user-id": PAYER_ID } });
    expect(res.statusCode).toBe(404);
  });

  it("200s for the payer", async () => {
    const app = newApp();
    const collected = await collect(app);
    const paymentId = collected.json().paymentId;
    const res = await app.inject({ method: "GET", url: `/payments/${paymentId}`, headers: { "x-user-id": PAYER_ID } });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(paymentId);
  });

  it("403s for a non-payer", async () => {
    const app = newApp();
    const collected = await collect(app);
    const paymentId = collected.json().paymentId;
    const res = await app.inject({
      method: "GET",
      url: `/payments/${paymentId}`,
      headers: { "x-user-id": "99999999-9999-9999-9999-999999999999" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("403s the recipient too -- only the payer can view via this endpoint", async () => {
    const app = newApp();
    const collected = await collect(app);
    const paymentId = collected.json().paymentId;
    const res = await app.inject({ method: "GET", url: `/payments/${paymentId}`, headers: { "x-user-id": RECIPIENT_ID } });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /payments", () => {
  it("never returns another user's payments even if their id is guessed", async () => {
    const app = newApp();
    await collect(app, collectBody({ referenceId: crypto.randomUUID() }));
    const res = await app.inject({
      method: "GET",
      url: "/payments",
      headers: { "x-user-id": "99999999-9999-9999-9999-999999999999" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("lists only the caller's own payments", async () => {
    const app = newApp();
    await collect(app, collectBody({ referenceId: crypto.randomUUID() }));
    const res = await app.inject({ method: "GET", url: "/payments", headers: { "x-user-id": PAYER_ID } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });
});

describe("POST /payments/:id/confirm", () => {
  it("404s for an unknown id", async () => {
    const app = newApp();
    const res = await app.inject({ method: "POST", url: "/payments/does-not-exist/confirm", headers: { "x-user-id": PAYER_ID } });
    expect(res.statusCode).toBe(404);
  });

  it("403s a non-payer trying to confirm", async () => {
    const app = newApp();
    const collected = await collect(app);
    const paymentId = collected.json().paymentId;
    const res = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/confirm`,
      headers: { "x-user-id": "99999999-9999-9999-9999-999999999999" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("409s confirming twice", async () => {
    const app = newApp();
    const collected = await collect(app);
    const paymentId = collected.json().paymentId;
    const first = await app.inject({ method: "POST", url: `/payments/${paymentId}/confirm`, headers: { "x-user-id": PAYER_ID } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: `/payments/${paymentId}/confirm`, headers: { "x-user-id": PAYER_ID } });
    expect(second.statusCode).toBe(409);
  });

  it("on gateway failure sets status failed and creates no payout", async () => {
    const app = newApp();
    const collected = await collect(app, collectBody({ amountCents: FORCE_FAILURE_AMOUNT_CENTS }));
    const paymentId = collected.json().paymentId;
    const res = await app.inject({ method: "POST", url: `/payments/${paymentId}/confirm`, headers: { "x-user-id": PAYER_ID } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("failed");

    const payoutsRes = await app.inject({ method: "GET", url: "/payouts", headers: { "x-user-id": RECIPIENT_ID } });
    expect(payoutsRes.json()).toEqual([]);
  });

  it("on success creates the correct 90/10 split for an evenly divisible amount", async () => {
    const app = newApp();
    const collected = await collect(app, collectBody({ amountCents: 10000 }));
    const paymentId = collected.json().paymentId;
    const res = await app.inject({ method: "POST", url: `/payments/${paymentId}/confirm`, headers: { "x-user-id": PAYER_ID } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("completed");
    expect(body.platformFeeCents).toBe(1000);
    expect(body.recipientAmountCents).toBe(9000);
  });

  it("on success creates the correct split for an odd amount that doesn't divide evenly by 10", async () => {
    const app = newApp();
    // 10% of 10001 is 1000.1 -- Math.round takes this to 1000, leaving 9001 for the recipient
    const collected = await collect(app, collectBody({ amountCents: 10001 }));
    const paymentId = collected.json().paymentId;
    const res = await app.inject({ method: "POST", url: `/payments/${paymentId}/confirm`, headers: { "x-user-id": PAYER_ID } });
    const body = res.json();
    expect(body.platformFeeCents).toBe(1000);
    expect(body.recipientAmountCents).toBe(9001);
    expect(body.platformFeeCents + body.recipientAmountCents).toBe(10001);
  });

  it("creates a payout for the recipient on success", async () => {
    const app = newApp();
    const collected = await collect(app, collectBody({ amountCents: 10000 }));
    const paymentId = collected.json().paymentId;
    await app.inject({ method: "POST", url: `/payments/${paymentId}/confirm`, headers: { "x-user-id": PAYER_ID } });

    const payoutsRes = await app.inject({ method: "GET", url: "/payouts", headers: { "x-user-id": RECIPIENT_ID } });
    const payouts = payoutsRes.json();
    expect(payouts).toHaveLength(1);
    expect(payouts[0].amountCents).toBe(9000);
    expect(payouts[0].status).toBe("pending");
  });
});

describe("GET /payouts", () => {
  it("never leaks another user's payouts", async () => {
    const app = newApp();
    const collected = await collect(app, collectBody({ amountCents: 10000 }));
    const paymentId = collected.json().paymentId;
    await app.inject({ method: "POST", url: `/payments/${paymentId}/confirm`, headers: { "x-user-id": PAYER_ID } });

    const res = await app.inject({
      method: "GET",
      url: "/payouts",
      headers: { "x-user-id": "99999999-9999-9999-9999-999999999999" },
    });
    expect(res.json()).toEqual([]);
  });
});
