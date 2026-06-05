import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { toFunctionSelector } from "viem";

export interface AbiRegistry {
  functions: Record<string, { name: string; inputs: Array<{ name: string; type: string }> }>;
  errors: Record<string, { name: string; inputs: Array<{ name: string; type: string }>; signature: string }>;
}

function computeSelector(item: { type: string; name: string; inputs: Array<{ name: string; type: string }> }): string {
  const sig = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
  return toFunctionSelector(sig);
}

export function buildAbiRegistry(abiDir: string, extraAbis?: Record<string, unknown>[]): AbiRegistry {
  const registry: AbiRegistry = { functions: {}, errors: {} };

  if (extraAbis) {
    for (const abi of extraAbis) {
      indexAbi(registry, abi);
    }
  }

  if (existsSync(abiDir)) {
    const files = readdirSync(abiDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const content = JSON.parse(readFileSync(join(abiDir, file), "utf-8"));
        indexAbi(registry, content);
      } catch (err) {
        console.error(`[abi-registry] Failed to parse ${file}:`, err);
      }
    }
  }

  return registry;
}

function indexAbi(registry: AbiRegistry, abi: unknown): void {
  if (!Array.isArray(abi)) return;
  for (const item of abi) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const type = entry.type;
    const name = entry.name;
    const inputs = entry.inputs;
    if (typeof name !== "string" || !Array.isArray(inputs)) continue;

    if (type === "function") {
      try {
        const selector = computeSelector(entry as any);
        registry.functions[selector] = {
          name,
          inputs: inputs.map((i) => ({ name: (i as any).name as string, type: (i as any).type as string })),
        };
      } catch {
        /* skip unresolvable */
      }
    } else if (type === "error") {
      try {
        const selector = computeSelector(entry as any);
        registry.errors[selector] = {
          name,
          inputs: inputs.map((i) => ({ name: (i as any).name as string, type: (i as any).type as string })),
          signature: `${name}(${(entry as any).inputs.map((i: any) => i.type).join(",")})`,
        };
      } catch {
        /* skip unresolvable */
      }
    }
  }
}

export async function decodeRevert(
  data: `0x${string}`,
  registry: AbiRegistry,
): Promise<{ name: string; args: Record<string, unknown>; signature: string } | null> {
  if (data.length < 10) return null;
  const selector = data.slice(0, 10) as `0x${string}`;
  const errorDef = registry.errors[selector];
  if (!errorDef) return null;

  try {
    const { decodeAbiParameters } = await import("viem");
    const args = decodeAbiParameters(errorDef.inputs as any, `0x${data.slice(10)}` as `0x${string}`);
    const named: Record<string, unknown> = {};
    errorDef.inputs.forEach((inp, i) => {
      named[inp.name || `arg${i}`] = args[i];
    });
    return { name: errorDef.name, args: named, signature: errorDef.signature };
  } catch {
    return { name: errorDef.name, args: {}, signature: errorDef.signature };
  }
}
