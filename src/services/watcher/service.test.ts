import { describe, it, expect } from "vitest";
import { WatcherService } from "./service.ts";

describe("WatcherService", () => {
  it("executes tasks in enrichment queue when drained", () => {
    const service = new WatcherService({} as any, new Map() as any);
    const queue = (service as any)._enrichmentDrain;
    
    let executedCount = 0;
    queue.enqueue("0x123", () => { executedCount++; });
    queue.enqueue("0x456", () => { executedCount++; });
    
    expect((service as any)._enrichmentQueue.size).toBe(2);
    
    queue.drain();
    
    expect(executedCount).toBe(2);
    expect((service as any)._enrichmentQueue.size).toBe(0);
  });

  it("continues executing tasks even if one fails", () => {
    const service = new WatcherService({} as any, new Map() as any);
    const queue = (service as any)._enrichmentDrain;
    
    let executedCount = 0;
    queue.enqueue("0x123", () => { throw new Error("fail"); });
    queue.enqueue("0x456", () => { executedCount++; });
    
    expect((service as any)._enrichmentQueue.size).toBe(2);
    
    queue.drain();
    
    expect(executedCount).toBe(1);
    expect((service as any)._enrichmentQueue.size).toBe(0);
  });
});
