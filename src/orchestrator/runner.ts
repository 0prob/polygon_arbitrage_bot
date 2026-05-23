import type { RuntimeContext } from "./boot.ts";
import { runPassLoop, type PassLoopDeps, DEFAULT_DEPS } from "./pass_loop.ts";
import type { EventBus } from "../tui/events.ts";

export class PassRunner {
  private deps: PassLoopDeps;
  private bus?: EventBus;

  constructor(private ctx: RuntimeContext, deps?: PassLoopDeps, bus?: EventBus) {
    this.deps = deps ?? DEFAULT_DEPS;
    this.bus = bus;
  }

  async run(): Promise<void> {
    await runPassLoop(this.ctx, this.deps, this.bus);
  }
}
