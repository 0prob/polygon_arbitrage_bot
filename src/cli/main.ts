import { loadConfig } from "../config/loader.ts";
import { bootApplication } from "../orchestrator/boot.ts";
import { runPassLoop } from "../orchestrator/pass_loop.ts";
import { shutdownApplication } from "../orchestrator/shutdown.ts";

async function main() {
  const config = loadConfig();
  const ctx = await bootApplication(config);

  process.on("SIGINT", () => {
    ctx.logger.warn({}, "SIGINT received, shutting down");
    shutdownApplication(ctx).then(() => process.exit(0)).catch(() => process.exit(1));
  });

  process.on("SIGTERM", () => {
    ctx.logger.warn({}, "SIGTERM received, shutting down");
    shutdownApplication(ctx).then(() => process.exit(0)).catch(() => process.exit(1));
  });

  await runPassLoop(ctx);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
