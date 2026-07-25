import { describe, expect, it } from "vitest";
import { sweepHeldPayouts } from "./hold-sweep.js";
import { InMemoryPaymentRepository } from "./repository.js";
import { FakeComplaintClient } from "../complaints/client.js";
import { FakeNotificationClient } from "../notifications/client.js";

const PAYER_ID = "11111111-1111-1111-1111-111111111111";
const RECIPIENT_ID = "22222222-2222-2222-2222-222222222222";
const BOOKING_ID = "33333333-3333-3333-3333-333333333333";

async function setupHeldPayout(overrides: { holdUntil?: string } = {}) {
  const repo = new InMemoryPaymentRepository();
  const payment = await repo.create({
    userId: PAYER_ID,
    amountCents: 10000,
    type: "resolution",
    referenceType: "booking",
    referenceId: BOOKING_ID,
    recipientUserId: RECIPIENT_ID,
  });
  await repo.markCompleted(payment.id, 1000, 9000);
  const holdUntil = overrides.holdUntil ?? new Date(Date.now() - 60_000).toISOString(); // already past
  const payout = await repo.createPayout(RECIPIENT_ID, 9000, payment.id, "held", holdUntil);
  return { repo, payment, payout };
}

describe("sweepHeldPayouts", () => {
  it("releases a held payout with no complaint on file", async () => {
    const { repo, payout } = await setupHeldPayout();
    const complaintClient = new FakeComplaintClient();
    const notificationClient = new FakeNotificationClient();

    const result = await sweepHeldPayouts(repo, complaintClient, notificationClient);
    expect(result.released).toEqual([payout.id]);

    const payouts = await repo.listPayoutsByUser(RECIPIENT_ID);
    expect(payouts[0].status).toBe("pending");
    expect(notificationClient.calls).toEqual([
      expect.objectContaining({ userId: RECIPIENT_ID, type: "payout_received" }),
    ]);
  });

  it("releases a held payout whose complaint was dismissed", async () => {
    const { repo, payout } = await setupHeldPayout();
    const complaintClient = new FakeComplaintClient();
    complaintClient.seed(BOOKING_ID, { status: "resolved", outcome: "dismissed" });

    const result = await sweepHeldPayouts(repo, complaintClient, new FakeNotificationClient());
    expect(result.released).toEqual([payout.id]);
  });

  it("withholds a held payout whose complaint was upheld", async () => {
    const { repo, payout } = await setupHeldPayout();
    const complaintClient = new FakeComplaintClient();
    complaintClient.seed(BOOKING_ID, { status: "resolved", outcome: "upheld" });
    const notificationClient = new FakeNotificationClient();

    const result = await sweepHeldPayouts(repo, complaintClient, notificationClient);
    expect(result.withheld).toEqual([payout.id]);

    const payouts = await repo.listPayoutsByUser(RECIPIENT_ID);
    expect(payouts[0].status).toBe("withheld");
    expect(notificationClient.calls).toHaveLength(0);
  });

  it("leaves a held payout alone while its complaint is still open", async () => {
    const { repo, payout } = await setupHeldPayout();
    const complaintClient = new FakeComplaintClient();
    complaintClient.seed(BOOKING_ID, { status: "open", outcome: null });

    const result = await sweepHeldPayouts(repo, complaintClient, new FakeNotificationClient());
    expect(result.stillHeld).toEqual([payout.id]);

    const payouts = await repo.listPayoutsByUser(RECIPIENT_ID);
    expect(payouts[0].status).toBe("held");
  });

  it("does not touch a held payout whose hold window hasn't passed yet", async () => {
    const { repo } = await setupHeldPayout({ holdUntil: new Date(Date.now() + 60 * 60_000).toISOString() });
    const result = await sweepHeldPayouts(repo, new FakeComplaintClient(), new FakeNotificationClient());
    expect(result).toEqual({ released: [], withheld: [], stillHeld: [], failed: [] });
  });

  it("continues past a complaint-lookup failure for one payout, rather than aborting the whole sweep", async () => {
    const { repo, payout } = await setupHeldPayout();
    const complaintClient = new FakeComplaintClient();
    complaintClient.getComplaintByBooking = async () => {
      throw new Error("recording service unreachable");
    };

    const result = await sweepHeldPayouts(repo, complaintClient, new FakeNotificationClient());
    expect(result.failed).toEqual([payout.id]);

    const payouts = await repo.listPayoutsByUser(RECIPIENT_ID);
    expect(payouts[0].status).toBe("held");
  });

  it("does nothing when there are no held payouts at all", async () => {
    const repo = new InMemoryPaymentRepository();
    const result = await sweepHeldPayouts(repo, new FakeComplaintClient(), new FakeNotificationClient());
    expect(result).toEqual({ released: [], withheld: [], stillHeld: [], failed: [] });
  });
});
