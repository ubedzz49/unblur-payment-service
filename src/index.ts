import { buildApp } from "./app.js";
import { buildDbPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { PostgresPaymentRepository } from "./payments/postgres-repository.js";
import { startHoldSweeper } from "./payments/hold-sweep.js";
import { FakeSandboxGateway } from "./gateway/provider.js";
import { HttpNotificationClient } from "./notifications/client.js";
import { HttpComplaintClient } from "./complaints/client.js";
import { HttpAuditLogClient } from "./admin/audit-log-client.js";
import { logger } from "./logger.js";

const port = Number(process.env.PORT ?? 3006);

// fail closed, same philosophy as JWT_SECRET in the gateway -- an unset internal token would
// otherwise mean this service silently accepts any request to /internal/*
if (!process.env.INTERNAL_SERVICE_TOKEN) {
  logger.fatal("INTERNAL_SERVICE_TOKEN is not set, refusing to start");
  process.exit(1);
}

const dbPool = buildDbPool();
const paymentRepository = new PostgresPaymentRepository(dbPool);

runMigrations(dbPool)
  .then(() => {
    const app = buildApp(
      paymentRepository,
      new FakeSandboxGateway(),
      process.env.INTERNAL_SERVICE_TOKEN,
      new HttpNotificationClient(),
      new HttpAuditLogClient(),
    );

    // Version 5's payout hold window -- only runs against the real Recording Service if
    // configured, same as recording-service's own DAILY_API_KEY-optional pattern
    if (process.env.RECORDING_SERVICE_URL) {
      startHoldSweeper(paymentRepository, new HttpComplaintClient(), new HttpNotificationClient());
    } else {
      logger.warn("RECORDING_SERVICE_URL not set, payout hold sweep disabled");
    }

    return app.listen({ port, host: "0.0.0.0" }).then(() => app.log.info({ port }, "payment-service listening"));
  })
  .catch((err) => {
    logger.error({ err }, "payment-service failed to start");
    process.exit(1);
  });
