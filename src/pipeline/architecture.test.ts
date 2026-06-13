import { describe, it, expect } from "vitest";
import { assertBotIndexerTable, BOT_INDEXER_ENTITIES, INDEXER_HOT_STATE_ENTITIES } from "./architecture.ts";

describe("architecture", () => {
  it("allows bot indexer discovery tables", () => {
    for (const table of BOT_INDEXER_ENTITIES) {
      expect(() => assertBotIndexerTable(table)).not.toThrow();
    }
  });

  it("rejects hot pool state tables from Hasura client", () => {
    for (const table of INDEXER_HOT_STATE_ENTITIES) {
      expect(() => assertBotIndexerTable(table)).toThrow(/Architecture violation/);
    }
  });
});
