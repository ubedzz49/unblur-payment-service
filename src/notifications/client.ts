export interface NotifyInput {
  userId: string;
  type: string;
  referenceType: string;
  referenceId: string;
  title: string;
  body?: string;
}

// sibling service, not live yet in every env -- caller is expected to catch/log rather than
// let a notification failure affect the actual money-moving operation
export interface NotificationClient {
  notify(input: NotifyInput): Promise<void>;
}

// real client -- talks to unblur-notification-service over the same internal-service-token
// pattern every other cross-service call in this project uses
export class HttpNotificationClient implements NotificationClient {
  constructor(
    private readonly baseUrl: string | undefined = process.env.NOTIFICATION_SERVICE_URL,
    private readonly internalServiceToken: string | undefined = process.env.INTERNAL_SERVICE_TOKEN,
    private readonly timeoutMs = 2000,
  ) {}

  async notify(input: NotifyInput): Promise<void> {
    if (!this.baseUrl) {
      throw new Error("NOTIFICATION_SERVICE_URL is not configured");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/internal/notifications`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-service-token": this.internalServiceToken ?? "",
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (res.status !== 201) {
        throw new Error(`notification service responded with status ${res.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

// test double -- records every call so tests can assert on what would've been sent, and can be
// flipped to throw so the degrade-gracefully path can be exercised deterministically
export class FakeNotificationClient implements NotificationClient {
  calls: NotifyInput[] = [];
  private shouldThrow = false;

  setShouldThrow(value: boolean): void {
    this.shouldThrow = value;
  }

  async notify(input: NotifyInput): Promise<void> {
    this.calls.push(input);
    if (this.shouldThrow) {
      throw new Error("simulated notification service failure");
    }
  }
}
