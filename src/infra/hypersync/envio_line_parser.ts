

/**
 * Parsed information from an Envio process line
 */
export interface EnvioLineParsedInfo {
  chain?: string;
  eventType: 'throughput' | 'pipeline_bottleneck' | 'slow_handler' | 'progress' | 'lifecycle' | 'error' | 'transient_error' | 'unknown';
  
  // Progress info
  syncedBlock?: number;
  remoteBlock?: number;
  
  // Performance info
  eventsPerSec?: number;
  eventCount?: number;
  
  // Status info
  status?: 'syncing' | 'synced' | 'indexer_ready' | 'running' | 'error';
  
  // Error classification
  isTransientError?: boolean;
  shouldSuppress?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  
  // Error suppression info
  flushSummary?: string;
}

/**
 * Manages rate-limited suppression for noisy transient errors
 */
class ErrorSuppressor {
  private suppression: {
    signature: string;
    count: number;
    firstSeen: number;
    lastSeen: number;
  } | null = null;

  private readonly suppressWindowMs = 30_000;

  check(signature: string): { shouldSuppress: boolean; flushSummary?: string } {
    const now = Date.now();
    
    if (!this.suppression || this.suppression.signature !== signature) {
      // New error type or first occurrence - flush previous if any
      const flushSummary = this.flush();
      this.suppression = { signature, count: 0, firstSeen: now, lastSeen: now };
      return { shouldSuppress: false, flushSummary };
    }

    // Same error type - check if we should suppress
    if (now - this.suppression.lastSeen > this.suppressWindowMs) {
      // Window expired - flush and restart
      const flushSummary = this.flush();
      this.suppression = { signature, count: 0, firstSeen: now, lastSeen: now };
      return { shouldSuppress: false, flushSummary };
    }

    // Within window - increment and suppress
    this.suppression.count++;
    this.suppression.lastSeen = now;
    return { shouldSuppress: true };
  }

  flush(): string | undefined {
    if (!this.suppression || this.suppression.count === 0) return undefined;
    
    const summary = `Suppressed ${this.suppression.count} similar errors in ${Math.round((Date.now() - this.suppression.firstSeen) / 1000)}s`;
    this.suppression = null;
    return summary;
  }

  forceFlush(): string | undefined {
    return this.flush();
  }
}

/**
 * Focused, testable parser for Envio process output lines
 */
export class EnvioLineParser {
  private errorSuppressor = new ErrorSuppressor();

  parse(line: string): EnvioLineParsedInfo {
    const chainMatch = line.match(/^\[([^\]]+)\]/);
    const chain = chainMatch && !chainMatch[1].includes(":") ? chainMatch[1].toLowerCase() : undefined;
    
    const trimmedLower = line.replace(/^\[.*?\]\s*/, "").toLowerCase();
    const originalTrimmed = line.replace(/^\[.*?\]\s*/, "");

    // Check for hypersync transient errors first
    if (this.isHypersyncTransientError(originalTrimmed)) {
      const signature = "hypersync_client:transient_fetch_error";
      const { shouldSuppress, flushSummary } = this.errorSuppressor.check(signature);
      
      return {
        eventType: 'transient_error',
        chain,
        isTransientError: true,
        shouldSuppress,
        logLevel: shouldSuppress ? 'debug' : 'warn',
        flushSummary
      };
    }

    // Parse throughput information
    const throughputInfo = this.parseThroughput(originalTrimmed);
    if (throughputInfo) {
      return { ...throughputInfo, chain };
    }

    // Parse progress information  
    const progressInfo = this.parseProgress(trimmedLower);
    if (progressInfo) {
      return { ...progressInfo, chain };
    }

    // Parse pipeline bottlenecks
    if (this.isPipelineBottleneck(originalTrimmed)) {
      return {
        eventType: 'pipeline_bottleneck',
        chain,
        logLevel: 'warn'
      };
    }

    // Parse slow handlers/effects
    const slowInfo = this.parseSlowHandler(originalTrimmed);
    if (slowInfo) {
      return { ...slowInfo, chain };
    }

    // Parse lifecycle events
    const lifecycleInfo = this.parseLifecycle(originalTrimmed);
    if (lifecycleInfo) {
      return { ...lifecycleInfo, chain };
    }

    // Parse errors/warnings
    const errorInfo = this.parseError(originalTrimmed);
    if (errorInfo) {
      // Flush any pending suppressions on real errors
      const flushSummary = this.errorSuppressor.forceFlush();
      return { ...errorInfo, chain, flushSummary };
    }

    return {
      eventType: 'unknown',
      chain,
      logLevel: 'debug'
    };
  }

  private isHypersyncTransientError(line: string): boolean {
    return /hypersync_client.*(failed to get (height|arrow data) from server|error sending request for url.*hypersync|dns error|connection error|timed out)/i.test(line);
  }

  private parseThroughput(line: string): EnvioLineParsedInfo | null {
    // High-value throughput (events per second)
    const epsMatch = line.match(/(\d{2,})\s*(?:events?|evts?)\s*(?:\/\s*s|per\s*s|\/s|@\s*(\d+)|eps|\/sec)/i);
    if (epsMatch) {
      return {
        eventType: 'throughput',
        eventsPerSec: parseInt(epsMatch[1], 10),
        logLevel: 'info'
      };
    }

    // Bare event counts
    const bareEvents = line.match(/(\d{4,})\s*events?/i);
    if (bareEvents) {
      return {
        eventType: 'throughput',
        eventCount: parseInt(bareEvents[1], 10),
        logLevel: 'debug'
      };
    }

    return null;
  }

  private parseProgress(line: string): EnvioLineParsedInfo | null {
    // Block progress patterns: "12345 -> 12350"
    const blockArrow = line.match(/(\d{5,})\s*->\s*(\d{5,})/);
    if (blockArrow) {
      return {
        eventType: 'progress',
        status: 'syncing',
        syncedBlock: parseInt(blockArrow[1], 10),
        remoteBlock: parseInt(blockArrow[2], 10),
        logLevel: 'debug'
      };
    }

    // Block progress patterns: "12345 / 12350"  
    const progressSlash = line.match(/(\d{5,})\s*\/\s*(\d{5,})/);
    if (progressSlash) {
      return {
        eventType: 'progress', 
        status: 'syncing',
        syncedBlock: parseInt(progressSlash[1], 10),
        remoteBlock: parseInt(progressSlash[2], 10),
        logLevel: 'debug'
      };
    }

    return null;
  }

  private isPipelineBottleneck(line: string): boolean {
    return /pipeline\s*split|loaders|handlers|db\s*(?:write|writes)/i.test(line);
  }

  private parseSlowHandler(line: string): EnvioLineParsedInfo | null {
    if (/(V2Factory|V3Factory|PairCreated|PoolCreated|token.*meta|effect|fetchTokenMeta|slow|took\s+\d+ms)/i.test(line)) {
      // Try to extract block info for progress tracking
      const slowEffectBlock = line.match(/"block":\s*(\d{5,})/);
      const syncedBlock = slowEffectBlock ? parseInt(slowEffectBlock[1], 10) : undefined;
      
      return {
        eventType: 'slow_handler',
        syncedBlock,
        logLevel: 'info'
      };
    }
    return null;
  }

  private parseLifecycle(line: string): EnvioLineParsedInfo | null {
    // Sync completion
    if (/(indexed|synced|caught up|caught-up|live tail|following head)/i.test(line)) {
      const nums = line.match(/\d{5,}/g);
      const block = nums ? parseInt(nums[nums.length - 1], 10) : undefined;
      
      return {
        eventType: 'lifecycle',
        status: 'synced',
        syncedBlock: block,
        remoteBlock: block,
        logLevel: 'info'
      };
    }

    // Important milestones
    if (/Starting indexing!/i.test(line)) {
      return {
        eventType: 'lifecycle',
        status: 'indexer_ready',
        logLevel: 'warn'
      };
    }

    // General startup signals
    if (/connected|listening|ready|running|started|backfill (started|complete)|Using Postgres|Using Hasura/i.test(line)) {
      return {
        eventType: 'lifecycle',
        status: 'running',
        logLevel: 'debug'
      };
    }

    // Docker/infrastructure startup
    if (/graphql|hasura|docker|container/i.test(line)) {
      return {
        eventType: 'lifecycle', 
        status: 'running',
        logLevel: 'debug'
      };
    }

    return null;
  }

  private parseError(line: string): EnvioLineParsedInfo | null {
    if (/error|fail|exception|panic|rate limit|quota|429|throttl|slow|stall|metadata-warning/i.test(line)) {
      const isError = /error|fail|panic|429/i.test(line);
      const status = isError ? 'error' : undefined;
      
      return {
        eventType: 'error',
        status,
        logLevel: isError ? 'error' : 'warn'
      };
    }

    return null;
  }
}