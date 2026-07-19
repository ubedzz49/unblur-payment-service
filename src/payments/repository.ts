export type PaymentType = "resolution";
export type ReferenceType = "booking";
export type PaymentStatus = "pending" | "completed" | "failed" | "refunded";
export type PayoutStatus = "pending" | "completed" | "failed";

export interface Payment {
  id: string;
  userId: string;
  amountCents: number;
  currency: string;
  type: PaymentType;
  referenceType: ReferenceType;
  referenceId: string;
  recipientUserId: string | null;
  platformFeeCents: number | null;
  recipientAmountCents: number | null;
  status: PaymentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Payout {
  id: string;
  userId: string;
  amountCents: number;
  paymentId: string;
  status: PayoutStatus;
  createdAt: string;
}

export interface CreatePaymentInput {
  userId: string;
  amountCents: number;
  currency?: string;
  type: PaymentType;
  referenceType: ReferenceType;
  referenceId: string;
  recipientUserId?: string | null;
}

export interface PaymentFilters {
  type?: string;
  status?: string;
}

export interface PaymentRepository {
  create(input: CreatePaymentInput): Promise<Payment>;
  getById(id: string): Promise<Payment | null>;
  getByReference(referenceType: string, referenceId: string): Promise<Payment | null>;
  listByUser(userId: string, filters?: PaymentFilters): Promise<Payment[]>;
  markCompleted(id: string, platformFeeCents: number, recipientAmountCents: number): Promise<Payment>;
  markFailed(id: string): Promise<Payment>;
  markRefunded(id: string): Promise<Payment>;

  createPayout(userId: string, amountCents: number, paymentId: string): Promise<Payout>;
  getPayoutByPaymentId(paymentId: string): Promise<Payout | null>;
  markPayoutFailed(id: string): Promise<Payout>;
  listPayoutsByUser(userId: string): Promise<Payout[]>;
}

// in-memory implementation used by tests -- mirrors the Postgres one's exact behavior
// (idempotency on reference, status transition guards live in app.ts, not here)
export class InMemoryPaymentRepository implements PaymentRepository {
  private payments = new Map<string, Payment>();
  private payouts = new Map<string, Payout>();

  async create(input: CreatePaymentInput): Promise<Payment> {
    const now = new Date().toISOString();
    const payment: Payment = {
      id: crypto.randomUUID(),
      userId: input.userId,
      amountCents: input.amountCents,
      currency: input.currency ?? "INR",
      type: input.type,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      recipientUserId: input.recipientUserId ?? null,
      platformFeeCents: null,
      recipientAmountCents: null,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.payments.set(payment.id, payment);
    return payment;
  }

  async getById(id: string): Promise<Payment | null> {
    return this.payments.get(id) ?? null;
  }

  async getByReference(referenceType: string, referenceId: string): Promise<Payment | null> {
    for (const p of this.payments.values()) {
      if (p.referenceType === referenceType && p.referenceId === referenceId) return p;
    }
    return null;
  }

  async listByUser(userId: string, filters?: PaymentFilters): Promise<Payment[]> {
    return Array.from(this.payments.values()).filter((p) => {
      if (p.userId !== userId) return false;
      if (filters?.type && p.type !== filters.type) return false;
      if (filters?.status && p.status !== filters.status) return false;
      return true;
    });
  }

  async markCompleted(id: string, platformFeeCents: number, recipientAmountCents: number): Promise<Payment> {
    const p = this.payments.get(id);
    if (!p) throw new Error("payment not found");
    const updated: Payment = {
      ...p,
      status: "completed",
      platformFeeCents,
      recipientAmountCents,
      updatedAt: new Date().toISOString(),
    };
    this.payments.set(id, updated);
    return updated;
  }

  async markFailed(id: string): Promise<Payment> {
    const p = this.payments.get(id);
    if (!p) throw new Error("payment not found");
    const updated: Payment = { ...p, status: "failed", updatedAt: new Date().toISOString() };
    this.payments.set(id, updated);
    return updated;
  }

  async markRefunded(id: string): Promise<Payment> {
    const p = this.payments.get(id);
    if (!p) throw new Error("payment not found");
    const updated: Payment = { ...p, status: "refunded", updatedAt: new Date().toISOString() };
    this.payments.set(id, updated);
    return updated;
  }

  async createPayout(userId: string, amountCents: number, paymentId: string): Promise<Payout> {
    const payout: Payout = {
      id: crypto.randomUUID(),
      userId,
      amountCents,
      paymentId,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.payouts.set(payout.id, payout);
    return payout;
  }

  async getPayoutByPaymentId(paymentId: string): Promise<Payout | null> {
    for (const payout of this.payouts.values()) {
      if (payout.paymentId === paymentId) return payout;
    }
    return null;
  }

  async markPayoutFailed(id: string): Promise<Payout> {
    const payout = this.payouts.get(id);
    if (!payout) throw new Error("payout not found");
    const updated: Payout = { ...payout, status: "failed" };
    this.payouts.set(id, updated);
    return updated;
  }

  async listPayoutsByUser(userId: string): Promise<Payout[]> {
    return Array.from(this.payouts.values()).filter((p) => p.userId === userId);
  }
}
