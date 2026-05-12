import type { PublicClient, Hex } from 'viem';
import { decodeErrorResult } from 'viem';

export type RevertContext = {
  to?: Hex;
  data?: Hex;
  from?: Hex;
  value?: bigint;
};

/**
 * Tries to extract the real revert reason via re-simulation, with correct ABI
 * decoding of the standard Error(string) and Panic(uint256) revert formats.
 *
 * Fix: the previous implementation sliced raw hex at position 10 and decoded
 * as UTF-8, skipping the 32-byte ABI offset and 32-byte length fields that
 * precede the string payload in Error(string) encoding. This produced garbage
 * strings. We now use viem's decodeErrorResult for robust decoding, with a
 * manual fallback for non-standard revert data.
 *
 * Falls back to fallbackReason when client/context is unavailable or when
 * re-simulation does not revert (race condition — tx succeeded by then).
 */
export async function getRevertReason(
  client: PublicClient | null | undefined,
  ctx: RevertContext,
  fallbackReason: string
): Promise<string> {
  if (!client || !ctx.to || !ctx.data) {
    return fallbackReason;
  }

  try {
    await client.call({
      account: ctx.from,
      to: ctx.to,
      data: ctx.data,
      value: ctx.value ?? 0n,
    });
    // No revert on re-simulation — race condition, tx succeeded. Use fallback.
    return fallbackReason;
  } catch (err: unknown) {
    const viemErr = err as {
      shortMessage?: string;
      message?: string;
      data?: unknown;
      cause?: { data?: unknown };
    } | null | undefined;

    // 1. viem's shortMessage is already human-readable when available.
    if (viemErr?.shortMessage && !viemErr.shortMessage.includes('execution reverted')) {
      return viemErr.shortMessage;
    }

    // 2. Try to decode the revert data using viem's ABI decoder.
    const rawData = viemErr?.data ?? viemErr?.cause?.data;
    if (typeof rawData === 'string' && rawData.startsWith('0x') && rawData.length > 10) {
      // Standard Error(string) and Panic(uint256) selectors.
      const ERROR_SELECTOR = '0x08c379a0'; // keccak256("Error(string)")[:4]
      const PANIC_SELECTOR = '0x4e487b71'; // keccak256("Panic(uint256)")[:4]

      const selector = rawData.slice(0, 10).toLowerCase();

      if (selector === ERROR_SELECTOR) {
        try {
          const decoded = decodeErrorResult({
            abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string', name: 'message' }] }],
            data: rawData as Hex,
          });
          const msg = (decoded?.args as [string] | undefined)?.[0];
          if (msg && msg.length > 0) return msg;
        } catch {
          // Fall through to manual decode.
        }
      }

      if (selector === PANIC_SELECTOR) {
        try {
          const decoded = decodeErrorResult({
            abi: [{ type: 'error', name: 'Panic', inputs: [{ type: 'uint256', name: 'code' }] }],
            data: rawData as Hex,
          });
          const code = (decoded?.args as [bigint] | undefined)?.[0];
          return `Panic(0x${(code ?? 0n).toString(16)})`;
        } catch {
          // Fall through.
        }
      }

      // Unknown custom error — return the hex data.
      return rawData.length <= 200 ? rawData : rawData.slice(0, 200) + '…';
    }

    // 3. Parse "execution reverted: <reason>" from message text.
    const message = viemErr?.shortMessage ?? viemErr?.message ?? '';
    if (message.includes('execution reverted')) {
      const match = message.match(/execution reverted:?\s*(.+?)(?:\n|$)/i);
      if (match?.[1]) return match[1].trim();
    }

    return fallbackReason;
  }
}
