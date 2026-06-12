/** FastLane Atlas bundle relay client (Polygon). */

export interface SolverOperationPayload {
  from: string;
  to: string;
  value: string;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  nonce: string;
  deadline: number;
  userOpHash: string;
  dAppControl: string;
  dAppSigner: string;
  bidToken: string;
  bidAmount: string;
  data: string;
  signature: string;
}

export interface FastLaneBundleRequest {
  id: number;
  jsonrpc: "2.0";
  method: "pfl_addSearcherBundle";
  params: [string, string];
}

export function buildFastLaneBundle(
  opportunityRawTx: string,
  solverOp: SolverOperationPayload,
  bundleId: number = 1,
): FastLaneBundleRequest {
  return {
    id: bundleId,
    jsonrpc: "2.0",
    method: "pfl_addSearcherBundle",
    params: [opportunityRawTx, JSON.stringify(solverOp)],
  };
}

export async function submitFastLaneBundleHttp(
  relayUrl: string,
  bundle: FastLaneBundleRequest,
): Promise<{ ok: boolean; result?: string; error?: string }> {
  try {
    const res = await fetch(relayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bundle),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { result?: string; error?: { message?: string; code?: string } };
    if (body.error) {
      return { ok: false, error: body.error.message ?? body.error.code ?? "relay error" };
    }
    return { ok: true, result: body.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
