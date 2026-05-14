import os from "os";
import fs from "fs";
import path from "path";

export type ThermalState = "unknown" | "normal" | "warm" | "critical";

export type ResourceSnapshot = {
  cpuCores: number;
  loadAverage1m?: number;
  totalMemoryBytes?: number;
  freeMemoryBytes?: number;
  maxCpuTemperatureC?: number;
};

export type RunParameterBudget = {
  workerCount: number;
  enrichConcurrency: number;
  v2PollConcurrency: number;
  v3PollConcurrency: number;
  maxPathsToOptimize: number;
  maxExecutionBatch: number;
  quietPoolSweepBatchSize: number;
  quietPoolSweepCatchupBatchSize: number;
  maxTotalPaths: number;
};

export type TunedRunParameters = RunParameterBudget & {
  thermalState: ThermalState;
  allowIntensiveWork: boolean;
  cpuHeadroomConcurrency: number;
  memoryPressure: boolean;
  loadPressure: boolean;
  reasons: string[];
};

type SystemProbe = {
  cpuCores?: number;
  loadAverage?: number[];
  totalMemory?: () => number;
  freeMemory?: () => number;
  maxCpuTemperatureC?: number;
  thermalRoots?: string[];
};

function positiveInteger(value: unknown, fallback: number) {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
  return n > 0 ? n : fallback;
}

function nonNegativeFinite(value: unknown): number | null {
  if (typeof value !== "number") return null;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function detectThermalState(maxCpuTemperatureC: number | undefined): ThermalState {
  if (maxCpuTemperatureC == null) return "unknown";
  if (maxCpuTemperatureC >= 90) return "critical";
  if (maxCpuTemperatureC >= 75) return "warm";
  return "normal";
}

function normalizeThermalMilliC(raw: string) {
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return undefined;
  const celsius = n >= 1_000 ? n / 1_000 : n;
  if (celsius < 0 || celsius > 150) return undefined;
  return celsius;
}

function readHwmonTemperatureInputs(root: string, entries: string[]) {
  const values: number[] = [];
  for (const entry of entries) {
    if (!/^temp\d+_input$/.test(entry)) continue;
    try {
      const temp = normalizeThermalMilliC(fs.readFileSync(path.join(root, entry), "utf8"));
      if (temp != null) values.push(temp);
    } catch {}
  }
  return values;
}

function readTemperatureInputs(root: string) {
  const values: number[] = [];
  try {
    if (!fs.existsSync(root)) return values;
  } catch {
    return values;
  }

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return values;
  }

  values.push(...readHwmonTemperatureInputs(root, entries));

  for (const entry of entries) {
    const entryPath = path.join(root, entry);
    if (/^thermal_zone\d+$/.test(entry)) {
      const tempPath = path.join(entryPath, "temp");
      try {
        if (fs.existsSync(tempPath)) {
          const temp = normalizeThermalMilliC(fs.readFileSync(tempPath, "utf8"));
          if (temp != null) values.push(temp);
        }
      } catch {}
      continue;
    }

    if (/^hwmon\d+$/.test(entry)) {
      let hwEntries: string[] = [];
      try {
        hwEntries = fs.readdirSync(entryPath);
      } catch {
        continue;
      }
      values.push(...readHwmonTemperatureInputs(entryPath, hwEntries));
    }
  }

  return values;
}

export function detectMaxCpuTemperatureC(thermalRoots?: string[]) {
  const roots = thermalRoots?.length ? thermalRoots : ["/sys/class/thermal", "/sys/class/hwmon"];
  const readings = roots.flatMap((root) => readTemperatureInputs(root));
  if (readings.length === 0) return undefined;
  return Math.max(...readings);
}

export function detectSystemResources(probe: SystemProbe = {}): ResourceSnapshot {
  const cpuCores = positiveInteger(probe.cpuCores ?? os.cpus().length, 1);
  const loadAverage = probe.loadAverage ?? os.loadavg();
  return {
    cpuCores,
    loadAverage1m: nonNegativeFinite(loadAverage[0]) ?? 0,
    totalMemoryBytes: nonNegativeFinite(probe.totalMemory?.() ?? os.totalmem()) ?? 0,
    freeMemoryBytes: nonNegativeFinite(probe.freeMemory?.() ?? os.freemem()) ?? 0,
    maxCpuTemperatureC: probe.maxCpuTemperatureC ?? detectMaxCpuTemperatureC(probe.thermalRoots),
  };
}

function memoryPressure(snapshot: ResourceSnapshot): boolean {
  const total = snapshot.totalMemoryBytes;
  const free = snapshot.freeMemoryBytes;
  if (total == null || total <= 0 || free == null) return false;
  return free / total < 0.1 || free < 512 * 1024 ** 2;
}

function cpuHeadroomConcurrency(snapshot: ResourceSnapshot, thermalState: ThermalState, reasons: string[]): number {
  const cores = positiveInteger(snapshot.cpuCores, 1);
  let headroom = Math.max(1, Math.floor(cores * 0.7));
  if (cores >= 2) reasons.push("reserve_cpu_headroom");
  const load = nonNegativeFinite(snapshot.loadAverage1m);
  if (load != null && load / cores >= 0.9) {
    headroom = Math.max(1, Math.floor(headroom * 0.5));
    reasons.push("load_pressure");
  }
  if (thermalState === "warm") {
    headroom = Math.max(1, Math.floor(headroom * 0.5));
    reasons.push("thermal_warm");
  } else if (thermalState === "critical") {
    headroom = 1;
    reasons.push("thermal_critical");
  }
  return headroom;
}

export function computeResourceTunedRunParameters(
  requested: RunParameterBudget,
  snapshot: ResourceSnapshot = detectSystemResources(),
): TunedRunParameters {
  const reasons: string[] = [];
  const thermalState = detectThermalState(snapshot.maxCpuTemperatureC);
  const cpuBudget = cpuHeadroomConcurrency(snapshot, thermalState, reasons);
  const hasMemoryPressure = memoryPressure(snapshot);
  const load = nonNegativeFinite(snapshot.loadAverage1m);
  const loadPressure = load != null && load / positiveInteger(snapshot.cpuCores, 1) >= 0.9;

  let tuned: RunParameterBudget = {
    workerCount: Math.min(positiveInteger(requested.workerCount, 1), cpuBudget),
    enrichConcurrency: Math.min(positiveInteger(requested.enrichConcurrency, 1), Math.max(1, cpuBudget + 1)),
    v2PollConcurrency: Math.min(positiveInteger(requested.v2PollConcurrency, 1), Math.max(1, cpuBudget * 2)),
    v3PollConcurrency: Math.min(positiveInteger(requested.v3PollConcurrency, 1), Math.max(1, cpuBudget)),
    maxPathsToOptimize: Math.min(positiveInteger(requested.maxPathsToOptimize, 1), Math.max(1, cpuBudget * 3)),
    maxExecutionBatch: Math.min(positiveInteger(requested.maxExecutionBatch, 1), Math.max(1, Math.ceil(cpuBudget / 2))),
    quietPoolSweepBatchSize: positiveInteger(requested.quietPoolSweepBatchSize, 1),
    quietPoolSweepCatchupBatchSize: positiveInteger(requested.quietPoolSweepCatchupBatchSize, 1),
    maxTotalPaths: positiveInteger(requested.maxTotalPaths, 1),
  };

  const catchupCap = Math.max(tuned.quietPoolSweepBatchSize, tuned.quietPoolSweepBatchSize * 8);
  if (tuned.quietPoolSweepCatchupBatchSize > catchupCap) {
    tuned = { ...tuned, quietPoolSweepCatchupBatchSize: catchupCap };
    reasons.push("decompose_catchup_sweep");
  }

  if (hasMemoryPressure) {
    tuned = {
      ...tuned,
      maxTotalPaths: Math.min(tuned.maxTotalPaths, 5_000),
      maxPathsToOptimize: Math.min(tuned.maxPathsToOptimize, 5),
      workerCount: Math.min(tuned.workerCount, Math.ceil(cpuBudget / 2)),
      enrichConcurrency: Math.min(tuned.enrichConcurrency, 2),
      quietPoolSweepBatchSize: Math.min(tuned.quietPoolSweepBatchSize, 8),
      quietPoolSweepCatchupBatchSize: Math.min(tuned.quietPoolSweepCatchupBatchSize, 60),
    };
    reasons.push("memory_pressure");
  }

  if (loadPressure) {
    tuned = {
      ...tuned,
      quietPoolSweepBatchSize: Math.min(tuned.quietPoolSweepBatchSize, 12),
      quietPoolSweepCatchupBatchSize: Math.min(tuned.quietPoolSweepCatchupBatchSize, 72),
    };
  }

  if (thermalState === "warm") {
    tuned = {
      ...tuned,
      maxExecutionBatch: Math.min(tuned.maxExecutionBatch, 2),
      quietPoolSweepBatchSize: Math.min(tuned.quietPoolSweepBatchSize, 12),
      quietPoolSweepCatchupBatchSize: Math.min(tuned.quietPoolSweepCatchupBatchSize, 72),
      maxPathsToOptimize: Math.min(tuned.maxPathsToOptimize, 8),
    };
  } else if (thermalState === "critical") {
    tuned = {
      ...tuned,
      workerCount: 1,
      enrichConcurrency: Math.min(tuned.enrichConcurrency, 2),
      v2PollConcurrency: Math.min(tuned.v2PollConcurrency, 2),
      v3PollConcurrency: 1,
      maxPathsToOptimize: Math.min(tuned.maxPathsToOptimize, 3),
      maxExecutionBatch: 1,
      quietPoolSweepBatchSize: Math.min(tuned.quietPoolSweepBatchSize, 6),
      quietPoolSweepCatchupBatchSize: Math.min(tuned.quietPoolSweepCatchupBatchSize, 24),
      maxTotalPaths: Math.min(tuned.maxTotalPaths, 3_000),
    };
  }

  if (tuned.workerCount <= 0) {
    tuned = { ...tuned, workerCount: 1, v2PollConcurrency: 1, v3PollConcurrency: 1 };
    reasons.push("floor_worker_count");
  }

  return {
    ...tuned,
    thermalState,
    allowIntensiveWork: thermalState !== "critical" && !loadPressure && !hasMemoryPressure,
    cpuHeadroomConcurrency: cpuBudget,
    memoryPressure: hasMemoryPressure,
    loadPressure,
    reasons: Array.from(new Set(reasons)),
  };
}
