import type { Lifecycle } from "../../orchestrator/lifecycle.ts";

interface ServiceEntry<T> {
  instance: T;
  lifecycle?: Lifecycle;
}

export class ServiceRegistry {
  private services = new Map<string, ServiceEntry<unknown>>();

  register<T>(name: string, instance: T, lifecycle?: Lifecycle): void {
    this.services.set(name, { instance, lifecycle });
  }

  resolve<T>(name: string): T {
    const entry = this.services.get(name);
    if (!entry) throw new Error(`Service not found: ${name}`);
    return entry.instance as T;
  }

  has(name: string): boolean {
    return this.services.has(name);
  }

  async prepareAll(): Promise<void> {
    for (const [, entry] of this.services) {
      if (entry.lifecycle) {
        await entry.lifecycle.prepare();
      }
    }
  }

  async startAll(): Promise<void> {
    for (const [, entry] of this.services) {
      if (entry.lifecycle) {
        await entry.lifecycle.start();
      }
    }
  }

  async stopAll(): Promise<void> {
    const reversed = [...this.services.entries()].reverse();
    for (const [, entry] of reversed) {
      if (entry.lifecycle) {
        try {
          await entry.lifecycle.stop();
        } catch {
          /* best effort */
        }
      }
    }
  }
}
