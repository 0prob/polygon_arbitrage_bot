
/**
 * src/execution/index.js — Execution module barrel export
 */

// Addresses and constants
export {
  BALANCER_VAULT,
  UNISWAP_V3_ROUTER,
  QUICKSWAP_V2_ROUTER,
  SUSHISWAP_ROUTER,
  PROTOCOL_ROUTERS,
  ROUTER_REQUIRED_PROTOCOLS,
  DIRECT_SWAP_PROTOCOLS,
  CURVE_STABLE_PROTOCOLS,
  CURVE_CRYPTO_PROTOCOLS,
  BALANCER_PROTOCOLS,
  WOOFI_PROTOCOLS,
  WOOFI_ROUTER_V2,
  WOOFI_WOOPP_V2,
} from "./addresses.ts";

// ABI fragments
export {
  ERC20_TRANSFER_ABI,
  ERC20_APPROVE_ABI,
  V2_PAIR_SWAP_ABI,
  V3_EXACT_INPUT_SINGLE_ABI,
  EXECUTOR_ABI,
  EXECUTOR_PRE_APPROVE_ABI,
  EXECUTOR_APPROVE_IF_NEEDED_ABI,
  CURVE_EXCHANGE_INT128_ABI,
  CURVE_EXCHANGE_UINT256_ABI,
  BALANCER_VAULT_SWAP_ABI,
  WOOFI_ROUTER_SWAP_ABI,
} from "./abi_fragments.ts";

// Calldata encoding
export {
  encodeV2Hop,
  encodeV3Hop,
  encodeCurveHop,
  encodeBalancerHop,
  encodeWoofiHop,
  encodeRoute,
  computeRouteHash,
  buildFlashParams,
  encodeExecuteArb,
} from "./calldata.ts";

// Gas estimation
export {
  fetchGasPrice,
  fetchEIP1559Fees,
  estimateGas,
  recommendGasParams,
  quickGasCheck,
} from "./gas.ts";

// Nonce management
export { NonceManager } from "./nonce_manager.ts";

// Transaction building
export { buildArbTx, buildTransferTx } from "./build_tx.ts";

// Private mempool submission
export {
  signTransaction,
  sendPrivateTx,
  sendBundleAlchemy,
} from "./private_tx.ts";

// Transaction sending (dry-run + private mempool)
export { sendTx } from "./send_tx.ts";
