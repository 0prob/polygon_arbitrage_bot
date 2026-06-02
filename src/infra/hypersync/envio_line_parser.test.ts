import { describe, test, expect, beforeEach } from "vitest";
import { EnvioLineParser } from "./envio_line_parser.ts";

describe("EnvioLineParser", () => {
  let parser: EnvioLineParser;

  beforeEach(() => {
    parser = new EnvioLineParser();
  });

  describe("throughput parsing", () => {
    test("parses events per second", () => {
      const result = parser.parse("[polygon] Processed 1234 events/s in batch");
      expect(result.eventType).toBe("throughput");
      expect(result.eventsPerSec).toBe(1234);
      expect(result.chain).toBe("polygon");
      expect(result.logLevel).toBe("info");
    });

    test("parses event counts", () => {
      const result = parser.parse("Processing 5000 events from block");
      expect(result.eventType).toBe("throughput");
      expect(result.eventCount).toBe(5000);
      expect(result.logLevel).toBe("debug");
    });
  });

  describe("progress parsing", () => {
    test("parses block arrow progress", () => {
      const result = parser.parse("[polygon] 123456 -> 123460");
      expect(result.eventType).toBe("progress");
      expect(result.status).toBe("syncing");
      expect(result.syncedBlock).toBe(123456);
      expect(result.remoteBlock).toBe(123460);
      expect(result.chain).toBe("polygon");
    });

    test("parses block slash progress", () => {
      const result = parser.parse("Progress: 123456 / 123500");
      expect(result.eventType).toBe("progress");
      expect(result.status).toBe("syncing");
      expect(result.syncedBlock).toBe(123456);
      expect(result.remoteBlock).toBe(123500);
    });
  });

  describe("lifecycle parsing", () => {
    test("identifies indexer ready state", () => {
      const result = parser.parse("Starting indexing! Ready to process events");
      expect(result.eventType).toBe("lifecycle");
      expect(result.status).toBe("indexer_ready");
      expect(result.logLevel).toBe("warn");
    });

    test("identifies sync completion", () => {
      const result = parser.parse("Indexer caught up with chain head at block 123456");
      expect(result.eventType).toBe("lifecycle");
      expect(result.status).toBe("synced");
      expect(result.syncedBlock).toBe(123456);
    });
  });

  describe("error handling", () => {
    test("identifies hypersync transient errors", () => {
      const result = parser.parse("hypersync_client failed to get height from server");
      expect(result.eventType).toBe("transient_error");
      expect(result.isTransientError).toBe(true);
      expect(result.shouldSuppress).toBe(false); // First occurrence
      expect(result.logLevel).toBe("warn");
    });

    test("suppresses repeated hypersync errors", () => {
      const line = "hypersync_client connection error timeout";
      
      // First occurrence should not be suppressed
      const first = parser.parse(line);
      expect(first.shouldSuppress).toBe(false);
      
      // Second occurrence should be suppressed
      const second = parser.parse(line);
      expect(second.shouldSuppress).toBe(true);
      expect(second.logLevel).toBe("debug");
    });

    test("identifies pipeline bottlenecks", () => {
      const result = parser.parse("Pipeline split detected: handlers waiting for DB writes");
      expect(result.eventType).toBe("pipeline_bottleneck");
      expect(result.logLevel).toBe("warn");
    });

    test("identifies slow handlers", () => {
      const result = parser.parse('Slow effect fetchTokenMeta took 250ms for token, "block":87654321');
      expect(result.eventType).toBe("slow_handler");
      expect(result.syncedBlock).toBe(87654321);
      expect(result.logLevel).toBe("info");
    });
  });

  describe("error categorization", () => {
    test("categorizes errors vs warnings", () => {
      const error = parser.parse("Fatal error: database connection failed");
      expect(error.eventType).toBe("error");
      expect(error.status).toBe("error");
      expect(error.logLevel).toBe("error");

      const warning = parser.parse("Rate limit warning: approaching quota");
      expect(warning.eventType).toBe("error");
      expect(warning.status).toBe(undefined);
      expect(warning.logLevel).toBe("warn");
    });
  });

  describe("unknown input handling", () => {
    test("handles unknown input gracefully", () => {
      const result = parser.parse("Some random log message with no special pattern");
      expect(result.eventType).toBe("unknown");
      expect(result.logLevel).toBe("debug");
    });

    test("handles empty input", () => {
      const result = parser.parse("");
      expect(result.eventType).toBe("unknown");
      expect(result.logLevel).toBe("debug");
    });
  });
});