import pino from "pino";

const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const TUI_MODE = process.argv.includes("--tui");
const TUI_LOG_FILE = process.env.TUI_LOG_FILE || "/tmp/polygon-arb-tui.log";

function createDestination() {
  if (LOG_LEVEL === "silent") return undefined;
  if (TUI_MODE && process.stdout.isTTY) {
    return pino.destination({ dest: TUI_LOG_FILE });
  }
  return pino.destination();
}

export const logger = pino(
  {
    level: LOG_LEVEL,
    base: undefined,
  },
  createDestination()
);
