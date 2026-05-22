export type ActivityLog = (component: string, message: string) => void;

export function createActivityLog(onUpdate?: (update: Record<string, unknown>) => void, quiet?: boolean): ActivityLog {
  return (component, message) => {
    if (!quiet) {
      const time = new Date().toLocaleTimeString("en-US", { hour12: false });
      process.stdout.write(`[${time}] ${component}  ${message}\n`);
    }
    onUpdate?.({
      currentActivity: component,
      currentActivityDetail: message,
      currentActivityUpdatedMs: Date.now(),
    });
  };
}
