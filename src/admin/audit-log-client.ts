export interface RecordAuditLogInput {
  adminUserId: string;
  adminUsername: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLogClient {
  record(input: RecordAuditLogInput): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 2000;

// fire-and-forget, same rule as every other cross-service notification call in this project --
// a failed audit-log write should never block the real admin action it's recording
export class HttpAuditLogClient implements AuditLogClient {
  constructor(
    private readonly baseUrl: string = process.env.USER_SERVICE_URL ?? "",
    private readonly internalToken: string = process.env.INTERNAL_SERVICE_TOKEN ?? "",
  ) {}

  async record(input: RecordAuditLogInput): Promise<void> {
    if (!this.baseUrl) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL("/internal/admin-audit-log", this.baseUrl);
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Internal-Service-Token": this.internalToken },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
    } catch {
      // ignore -- never blocks the real admin action
    } finally {
      clearTimeout(timeout);
    }
  }
}

// test-only
export class FakeAuditLogClient implements AuditLogClient {
  public calls: RecordAuditLogInput[] = [];
  async record(input: RecordAuditLogInput): Promise<void> {
    this.calls.push(input);
  }
}
