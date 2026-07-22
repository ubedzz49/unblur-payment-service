import { buildApp } from "./app.js";
import { buildDbPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { PostgresPaymentRepository } from "./payments/postgres-repository.js";
import { FakeSandboxGateway } from "./gateway/provider.js";
import { HttpNotificationClient } from "./notifications/client.js";
import { logger } from "./logger.js";

const port = Number(process.env.PORT ?? 3006);

// fail closed, same philosophy as JWT_SECRET in the gateway -- an unset internal token would
// otherwise mean this service silently accepts any request to /internal/*
if (!process.env.INTERNAL_SERVICE_TOKEN) {
  logger.fatal("INTERNAL_SERVICE_TOKEN is not set, refusing to start");
  process.exit(1);
}

const dbPool = buildDbPool();

runMigrations(dbPool)
  .then(() => {
    const app = buildApp(
      new PostgresPaymentRepository(dbPool),
      new FakeSandboxGateway(),
      process.env.INTERNAL_SERVICE_TOKEN,
      new HttpNotificationClient(),
    );
    return app.listen({ port, host: "0.0.0.0" }).then(() => app.log.info({ port }, "payment-service listening"));
  })
  .catch((err) => {
    logger.error({ err }, "payment-service failed to start");
    process.exit(1);
  });
