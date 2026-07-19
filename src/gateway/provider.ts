// Placeholder for a real payment gateway (Razorpay/Stripe) integration -- no credentials for
// either exist in this project yet. This interface is shaped so a real implementation can be
// swapped in later (buildApp's caller just passes a different PaymentGateway) without touching
// any route handler.
export interface PaymentGateway {
  simulateOutcome(paymentId: string, amountCents: number): "completed" | "failed";
}

// a magic amount that forces a failure outcome, so tests/integrations can exercise the failure
// path deterministically without relying on randomness
export const FORCE_FAILURE_AMOUNT_CENTS = 999999;

// in-house fake sandbox -- never touches real money or a real third-party API. Every payment
// "succeeds" unless the caller used the reserved test amount to force a failure, which keeps
// the happy path deterministic for tests while still giving us a way to exercise the failed
// branch on demand.
export class FakeSandboxGateway implements PaymentGateway {
  simulateOutcome(_paymentId: string, amountCents: number): "completed" | "failed" {
    return amountCents === FORCE_FAILURE_AMOUNT_CENTS ? "failed" : "completed";
  }
}
