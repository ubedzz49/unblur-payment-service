export type ComplaintStatus = "open" | "resolved";
export type ComplaintOutcome = "upheld" | "dismissed";

export interface ComplaintInfo {
  status: ComplaintStatus;
  outcome: ComplaintOutcome | null;
}

// used by the held-payout sweep to decide whether a booking's hold should release, stay held,
// or convert to withheld -- see app.ts
export interface ComplaintClient {
  getComplaintByBooking(bookingId: string): Promise<ComplaintInfo | null>;
}

const REQUEST_TIMEOUT_MS = 2000;

export class HttpComplaintClient implements ComplaintClient {
  constructor(
    private readonly baseUrl: string | undefined = process.env.RECORDING_SERVICE_URL,
    private readonly internalToken: string | undefined = process.env.INTERNAL_SERVICE_TOKEN,
  ) {}

  async getComplaintByBooking(bookingId: string): Promise<ComplaintInfo | null> {
    if (!this.baseUrl) {
      throw new Error("RECORDING_SERVICE_URL is not configured");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/internal/complaints/by-booking/${bookingId}`, {
        headers: { "x-internal-service-token": this.internalToken ?? "" },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`recording service returned ${res.status} fetching complaint`);
      }
      const body = (await res.json()) as { complaint: ComplaintInfo | null };
      return body.complaint;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// test-only
export class FakeComplaintClient implements ComplaintClient {
  private complaints = new Map<string, ComplaintInfo>();

  seed(bookingId: string, complaint: ComplaintInfo): void {
    this.complaints.set(bookingId, complaint);
  }

  async getComplaintByBooking(bookingId: string): Promise<ComplaintInfo | null> {
    return this.complaints.get(bookingId) ?? null;
  }
}
