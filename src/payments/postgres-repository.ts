import { Pool } from "pg";
import {
  CreatePaymentInput,
  Payment,
  PaymentFilters,
  PaymentRepository,
  Payout,
} from "./repository.js";

function rowToPayment(row: any): Payment {
  return {
    id: row.id,
    userId: row.user_id,
    amountCents: row.amount_cents,
    currency: row.currency,
    type: row.type,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    recipientUserId: row.recipient_user_id,
    platformFeeCents: row.platform_fee_cents,
    recipientAmountCents: row.recipient_amount_cents,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPayout(row: any): Payout {
  return {
    id: row.id,
    userId: row.user_id,
    amountCents: row.amount_cents,
    paymentId: row.payment_id,
    status: row.status,
    createdAt: row.created_at,
  };
}

export class PostgresPaymentRepository implements PaymentRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreatePaymentInput): Promise<Payment> {
    const { rows } = await this.pool.query(
      `INSERT INTO payments (user_id, amount_cents, currency, type, reference_type, reference_id, recipient_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.userId,
        input.amountCents,
        input.currency ?? "INR",
        input.type,
        input.referenceType,
        input.referenceId,
        input.recipientUserId ?? null,
      ],
    );
    return rowToPayment(rows[0]);
  }

  async getById(id: string): Promise<Payment | null> {
    const { rows } = await this.pool.query("SELECT * FROM payments WHERE id = $1", [id]);
    return rows[0] ? rowToPayment(rows[0]) : null;
  }

  async getByReference(referenceType: string, referenceId: string): Promise<Payment | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM payments WHERE reference_type = $1 AND reference_id = $2",
      [referenceType, referenceId],
    );
    return rows[0] ? rowToPayment(rows[0]) : null;
  }

  async listByUser(userId: string, filters?: PaymentFilters): Promise<Payment[]> {
    const conditions = ["user_id = $1"];
    const params: unknown[] = [userId];
    if (filters?.type) {
      params.push(filters.type);
      conditions.push(`type = $${params.length}`);
    }
    if (filters?.status) {
      params.push(filters.status);
      conditions.push(`status = $${params.length}`);
    }
    const { rows } = await this.pool.query(
      `SELECT * FROM payments WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
      params,
    );
    return rows.map(rowToPayment);
  }

  async markCompleted(id: string, platformFeeCents: number, recipientAmountCents: number): Promise<Payment> {
    const { rows } = await this.pool.query(
      `UPDATE payments
       SET status = 'completed', platform_fee_cents = $2, recipient_amount_cents = $3, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, platformFeeCents, recipientAmountCents],
    );
    return rowToPayment(rows[0]);
  }

  async markFailed(id: string): Promise<Payment> {
    const { rows } = await this.pool.query(
      `UPDATE payments SET status = 'failed', updated_at = now() WHERE id = $1 RETURNING *`,
      [id],
    );
    return rowToPayment(rows[0]);
  }

  async markRefunded(id: string): Promise<Payment> {
    const { rows } = await this.pool.query(
      `UPDATE payments SET status = 'refunded', updated_at = now() WHERE id = $1 RETURNING *`,
      [id],
    );
    return rowToPayment(rows[0]);
  }

  async createPayout(userId: string, amountCents: number, paymentId: string): Promise<Payout> {
    const { rows } = await this.pool.query(
      `INSERT INTO payouts (user_id, amount_cents, payment_id) VALUES ($1, $2, $3) RETURNING *`,
      [userId, amountCents, paymentId],
    );
    return rowToPayout(rows[0]);
  }

  async getPayoutByPaymentId(paymentId: string): Promise<Payout | null> {
    const { rows } = await this.pool.query("SELECT * FROM payouts WHERE payment_id = $1", [paymentId]);
    return rows[0] ? rowToPayout(rows[0]) : null;
  }

  async markPayoutFailed(id: string): Promise<Payout> {
    const { rows } = await this.pool.query(
      `UPDATE payouts SET status = 'failed' WHERE id = $1 RETURNING *`,
      [id],
    );
    return rowToPayout(rows[0]);
  }

  async listPayoutsByUser(userId: string): Promise<Payout[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM payouts WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    );
    return rows.map(rowToPayout);
  }
}
