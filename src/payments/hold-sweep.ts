import { ComplaintClient } from "../complaints/client.js";
import { NotificationClient } from "../notifications/client.js";
import { PaymentRepository } from "./repository.js";
import { logger } from "../logger.js";

function formatCents(amountCents: number): string {
  return `₹${(amountCents / 100).toFixed(2)}`;
}

// resolves every payout whose hold window has passed: releases it (and notifies the recipient)
// if there's no complaint or it was dismissed, leaves it held if a complaint is still open, or
// converts it to withheld if the complaint was upheld. One payout failing (a bad complaint
// lookup, a missing payment row) never blocks the rest of the sweep.
export async function sweepHeldPayouts(
  paymentRepository: PaymentRepository,
  complaintClient: ComplaintClient,
  notificationClient: NotificationClient,
  now: string = new Date().toISOString(),
): Promise<{ released: string[]; withheld: string[]; stillHeld: string[]; failed: string[] }> {
  const released: string[] = [];
  const withheld: string[] = [];
  const stillHeld: string[] = [];
  const failed: string[] = [];

  const duePayouts = await paymentRepository.listHeldPayoutsPastHold(now);
  for (const payout of duePayouts) {
    try {
      const payment = await paymentRepository.getById(payout.paymentId);
      if (!payment) {
        // shouldn't happen (a payout always comes from a real payment), but a missing payment
        // row is exactly the kind of surprise that should stay held for manual review, not
        // silently released
        logger.warn({ payoutId: payout.id, paymentId: payout.paymentId }, "held payout references a missing payment, leaving held");
        stillHeld.push(payout.id);
        continue;
      }

      const complaint = await complaintClient.getComplaintByBooking(payment.referenceId);

      if (!complaint || (complaint.status === "resolved" && complaint.outcome === "dismissed")) {
        await paymentRepository.markPayoutReleased(payout.id);
        released.push(payout.id);
        try {
          await notificationClient.notify({
            userId: payout.userId,
            type: "payout_received",
            referenceType: "payment",
            referenceId: payment.id,
            title: "Payout received",
            body: `You've received a payout of ${formatCents(payout.amountCents)}.`,
          });
        } catch (err) {
          logger.warn({ payoutId: payout.id, err }, "failed to send payout_received notification");
        }
      } else if (complaint.status === "resolved" && complaint.outcome === "upheld") {
        await paymentRepository.markPayoutWithheld(payout.id);
        withheld.push(payout.id);
      } else {
        // complaint still open -- leave held, re-checked again next sweep
        stillHeld.push(payout.id);
      }
    } catch (err) {
      logger.warn({ payoutId: payout.id, err }, "hold-sweep failed to resolve this payout, will retry next sweep");
      failed.push(payout.id);
    }
  }

  return { released, withheld, stillHeld, failed };
}

// long-running Fargate task, same as every other service here -- a plain setInterval is enough
// for a 30-minute-scale hold window, no separate cron/scheduler infra needed
export function startHoldSweeper(
  paymentRepository: PaymentRepository,
  complaintClient: ComplaintClient,
  notificationClient: NotificationClient,
  intervalMs = 60_000,
): NodeJS.Timeout {
  return setInterval(() => {
    sweepHeldPayouts(paymentRepository, complaintClient, notificationClient).catch((err) => {
      logger.error({ err }, "payout hold sweep failed");
    });
  }, intervalMs);
}
