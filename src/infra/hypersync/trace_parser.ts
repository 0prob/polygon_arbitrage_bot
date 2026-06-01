import type { Logger } from "../observability/logger.ts";

/**
 * Parsed summary of a transaction's internal trace.
 * Designed specifically for the needs of the Polygon arbitrage bot.
 */
export interface ParsedTraceSummary {
  txHash: string;
  callCount: number;
  maxDepth: number;
  touchedProtocols: string[]; // e.g. ["UNISWAP_V3", "BALANCER", "AAVE"]
  usedFlashloan: boolean;
  flashloanProvider?: "BALANCER" | "AAVE" | "OTHER";
  hasInternalReverts: boolean;
  suspiciousPatterns: string[]; // e.g. ["possible_sandwich", "jit_liquidity", "multiple_large_swaps"]
  rawTraceCount: number;

  // Native (MATIC on Polygon / ETH on other chains) transfer signals.
  // Populated from trace.action.value when call_type is "call".
  // See https://docs.envio.dev/blog/tracking-native-eth-transfers-hypersync for efficient HyperSync patterns.
  nativeValueTransferred: bigint; // total wei moved in value-carrying calls
  hasLargeNativeTransfer: boolean;
}

/**
 * Simple but effective trace parser for HyperSync trace data.
 *
 * This is the "trace parser utility" recommended in the Envio audit follow-up.
 * It turns raw traces (from getTransactionTraces) into actionable signals
 * the bot can use for:
 *   - Post-execution analysis
 *   - Mempool competing tx detection
 *   - Risk / quarantine decisions
 *   - Better simulation / dry-run context
 *
 * Native (MATIC) transfer detection follows patterns from
 * https://docs.envio.dev/blog/tracking-native-eth-transfers-hypersync
 * (efficient callType + value filtering on HyperSync traces).
 */
export function parseTransactionTraces(txHash: string, traces: any[], logger?: Logger): ParsedTraceSummary {
  if (!Array.isArray(traces) || traces.length === 0) {
    return createEmptySummary(txHash);
  }

  const summary: ParsedTraceSummary = {
    txHash,
    callCount: traces.length,
    maxDepth: 0,
    touchedProtocols: [],
    usedFlashloan: false,
    flashloanProvider: undefined,
    hasInternalReverts: false,
    suspiciousPatterns: [],
    rawTraceCount: traces.length,
    nativeValueTransferred: 0n,
    hasLargeNativeTransfer: false,
  };

  const protocolSet = new Set<string>();
  let maxDepth = 0;
  let hasRevert = false;
  let sawBalancerFlash = false;
  let sawAaveFlash = false;
  let swapCount = 0;

  // Native value transfer tracking (MATIC on Polygon)
  let totalNativeValue = 0n;
  const LARGE_NATIVE_THRESHOLD = 100_000_000_000_000_000n; // 0.1 MATIC (tune as needed)

  for (const trace of traces) {
    const action = trace.action || {};
    const result = trace.result || {};
    const traceAddress = trace.traceAddress || [];

    // Track call depth
    maxDepth = Math.max(maxDepth, traceAddress.length);

    // Detect flashloans (common patterns)
    const to = (action.to || "").toLowerCase();
    const inputData = (action.input || "").toLowerCase();

    // Native value transfer (from blog: call_type=call with value)
    const value = action.value ? BigInt(action.value) : 0n;
    if (value > 0n) {
      totalNativeValue += value;
    }

    if (to.includes("ba12222222228d8ba445958a75a0704d566bf2c8")) {
      // Balancer Vault
      if (inputData.includes("23b872dd") || inputData.includes("flashloan")) {
        sawBalancerFlash = true;
      }
    }

    if (to.includes("794a61358d6845594f94dc1db02a252b5b4814ad")) {
      // Aave V3 Pool
      if (inputData.includes("flashloan")) {
        sawAaveFlash = true;
      }
    }

    // Count swaps (very rough heuristic)
    if (inputData.includes("swap") || inputData.includes("exactinput")) {
      swapCount++;
    }

    // Protocol fingerprinting (extend as needed)
    if (to.includes("1f98431c8ad98523631ae4a59f267346ea31f984") || to.includes("uniswap")) {
      protocolSet.add("UNISWAP");
    }
    if (to.includes("ba12222222228d8ba445958a75a0704d566bf2c8")) {
      protocolSet.add("BALANCER");
    }
    if (to.includes("794a61358d6845594f94dc1db02a252b5b4814ad")) {
      protocolSet.add("AAVE");
    }
    if (to.includes("c35dadb65012ec5796536bd9864ed8773abc74c4")) {
      protocolSet.add("SUSHI");
    }

    // Internal revert detection
    if (result.error || trace.error) {
      hasRevert = true;
    }
  }

  summary.maxDepth = maxDepth;
  summary.touchedProtocols = Array.from(protocolSet);
  summary.hasInternalReverts = hasRevert;

  summary.nativeValueTransferred = totalNativeValue;
  summary.hasLargeNativeTransfer = totalNativeValue >= LARGE_NATIVE_THRESHOLD;

  if (sawBalancerFlash) {
    summary.usedFlashloan = true;
    summary.flashloanProvider = "BALANCER";
  } else if (sawAaveFlash) {
    summary.usedFlashloan = true;
    summary.flashloanProvider = "AAVE";
  }

  // Simple heuristic suspicious pattern detection
  if (swapCount >= 4 && maxDepth > 6) {
    summary.suspiciousPatterns.push("multiple_large_swaps_deep_callstack");
  }
  if (sawBalancerFlash && swapCount >= 3) {
    summary.suspiciousPatterns.push("flashloan_with_multiple_swaps");
  }

  if (logger) {
    logger.debug({ txHash, summary }, "Parsed transaction traces");
  }

  return summary;
}

function createEmptySummary(txHash: string): ParsedTraceSummary {
  return {
    txHash,
    callCount: 0,
    maxDepth: 0,
    touchedProtocols: [],
    usedFlashloan: false,
    hasInternalReverts: false,
    suspiciousPatterns: [],
    rawTraceCount: 0,
    nativeValueTransferred: 0n,
    hasLargeNativeTransfer: false,
  };
}

/**
 * Convenience helper: safely parse traces coming from HyperSyncService.getTransactionTraces
 */
export function safeParseTraces(txHash: string, traces: any[] | null | undefined, logger?: Logger): ParsedTraceSummary {
  try {
    return parseTransactionTraces(txHash, traces || [], logger);
  } catch (err) {
    logger?.warn({ err, txHash }, "Failed to parse traces, returning empty summary");
    return createEmptySummary(txHash);
  }
}

/**
 * Generate a list of human-readable, useful messages from a ParsedTraceSummary.
 * These are intended for TUI logs, execution result annotations, risk scoring, etc.
 */
export function getTraceMessages(summary: ParsedTraceSummary): string[] {
  const messages: string[] = [];

  if (summary.usedFlashloan && summary.flashloanProvider) {
    messages.push(`Flashloan: ${summary.flashloanProvider}`);
  }

  if (summary.touchedProtocols.length > 0) {
    messages.push(`Protocols: ${summary.touchedProtocols.join(", ")}`);
  }

  if (summary.maxDepth > 8) {
    messages.push(`Deep callstack (depth ${summary.maxDepth})`);
  }

  if (summary.hasInternalReverts) {
    messages.push("Internal reverts detected");
  }

  for (const pattern of summary.suspiciousPatterns) {
    const friendly = pattern.replace(/_/g, " ");
    messages.push(`Suspicious: ${friendly}`);
  }

  if (summary.callCount > 20) {
    messages.push(`High activity (${summary.callCount} calls)`);
  }

  if (summary.hasLargeNativeTransfer) {
    messages.push(`Large native transfer: ${summary.nativeValueTransferred} wei`);
  } else if (summary.nativeValueTransferred > 0n) {
    messages.push(`Native value moved: ${summary.nativeValueTransferred} wei`);
  }

  return messages;
}
