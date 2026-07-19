# unblur-payment-service

Payments and payouts for 1-on-1 resolution bookings. Owns the `payments` and `payouts` tables.

Shares the same RDS Postgres instance and database as the other unblur services (pragmatic
reuse of existing infra) but owns and only touches its own tables.

## No real payment gateway

There is no Razorpay/Stripe integration in this build -- no credentials for either exist yet.
`src/gateway/provider.ts` defines a `PaymentGateway` interface and a `FakeSandboxGateway`
implementation: an in-house sandbox that simulates a `completed`/`failed` outcome without ever
touching real money or a real third-party API. The interface is shaped so a real gateway can be
swapped in later without changing any route handler. See `ARCHITECTURE_DECISIONS.md` for the
full reasoning.

## Auth

- **Internal routes** (`/internal/*`, called by Resolution Service): require header
  `X-Internal-Service-Token` matching the `INTERNAL_SERVICE_TOKEN` env var. The service fails to
  start if this env var is unset (fail closed, same as `JWT_SECRET` in the gateway).
- **User-facing routes** (`/payments*`, `/payouts`): trust the `X-User-Id` header set by the
  gateway, same pattern as every other service in this project. This service never verifies
  JWTs itself.

## Payment flow

1. Resolution Service calls `POST /internal/payments/collect` when a booking is accepted. This
   creates a `pending` payment. Idempotent on `(referenceType, referenceId)` -- a retried call
   for the same booking returns the existing payment rather than creating a duplicate.
2. The frontend's checkout screen calls `POST /payments/:id/confirm` once the (fake) sandbox
   flow finishes. On a simulated success this splits the amount 90/10 (resolver/platform,
   `Math.round` on the fee) and creates a `payouts` row for the resolver. On a simulated failure
   the payment is marked `failed` and no payout is created.
3. `POST /internal/payments/:id/refund` can only refund a `completed` payment. If a payout for
   it was already completed, that payout is flipped to `failed` too -- this sandbox has no way
   to claw back money that was already "paid out", so the payout's status is just updated to
   reflect the refund happened.

`recipientUserId` is captured at collect-time (an optional field on the collect body) and stored
on the payment row, since this service has no way to derive "who resolves this booking" from
`referenceType`/`referenceId` alone -- that's Resolution Service's data.

## Local development

```bash
cp .env.example .env.local
npm install
npm run dev
```

## Scripts

- `npm run dev` -- local dev server
- `npm run build` -- production build
- `npm run migrate` -- run pending migrations
- `npm test` -- unit tests (Vitest)
