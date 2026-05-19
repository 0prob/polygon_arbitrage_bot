# Cross-Chain Atomic Arbitrage: Polygon ↔ Katana via ERC-7683 Intents

**Date:** 2026-05-19
**Status:** Design

## Overview

Add cross-chain atomic arbitrage between Polygon PoS (chain 137) and Katana (chain 747474). The bot detects price discrepancies across the two chains for the same asset pairs and executes arb via a capital-efficient flash-swap-on-Katana model using the ERC-7683 cross-chain intents standard with exclusive filler protection.

The existing Polygon-only arb logic remains completely untouched — this is a separate module toggled via env vars.

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ Polygon (137)                          Katana (747474)                │
│                                                                        │
│ CrossChainIntentOrigin.sol              KatanaExecutor.sol            │
│   ┌─────────────────────────┐           ┌─────────────────────────┐   │
│   │ executeArbOrder()       │           │ executeArb()            │   │
│   │   • Pull escrow from    │           │   • Flash-swap from     │   │
│   │     solver wallet       │           │     Sushi V2/V3 pool    │   │
│   │   • Lock in vault       │           │   • Execute arb hops    │   │
│   │   • Emit OrderCreated   │◄────Order►│     (inside callback)   │   │
│   │   • Return orderId      │           │   • Repay flash-swap    │   │
│   │                         │           │   • Emit FillExecuted   │   │
│   │ claimOrder(orderId)     │           └─────────────────────────┘   │
│   │   • Verify AggLayer     │                                          │
│   │     proof (filler addr) │           Sushi V2 Factory:              │
│   │   • Release escrow      │           0x72d111b4d6f31b38919a...     │
│   │                         │           Sushi V3 Factory:              │
│   └─────────────────────────┘           0x203e8740894c8955cb8...     │
│                                                                        │
│                     Off-chain (Solver Bot)                             │
│   ┌─────────────────────────────────────────────────────────────────┐ │
│   │ 1. CrossChainScanner: compute profitable routes                │ │
│   │ 2. Tx 1: call CrossChainIntentOrigin.executeArbOrder()        │ │
│   │    (solver deposits escrow, order goes live)                   │ │
│   │ 3. Tx 2: call KatanaExecutor.executeArb()                     │ │
│   │    (flash-swap from Sushi pool, arb inside callback)           │ │
│   │ 4. Wait for AggLayer proof finalization                       │ │
│   │ 5. Tx 3: call CrossChainIntentOrigin.claimOrder()             │ │
│   └─────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

## Capital Flow

The escrow on Polygon is a small commitment amount (e.g., 10 WETH). The actual arb capital comes from a flash-swap on Katana via SushiSwap V2/V3 pools.

**Flow:**

1. **Polygon (Tx 1):** Solver deposits 10 WETH into `CrossChainIntentOrigin` escrow. Order is created with `exclusiveFiller = solver's Katana address`.

2. **Katana (Tx 2):** Solver calls `KatanaExecutor.executeArb()` which:
   - Flash-swaps 98 WETH from a Sushi V2/V3 pool (borrows capital without collateral)
   - Inside the callback, executes arb hops across Sushi V2/V3 pools
   - Result: 101 WETH (3 WETH profit)
   - Repays flash-swap (98 WETH + fee)
   - Keeps 3 WETH profit on Katana
   - Emits `FillExecuted(orderId)`

3. **Settlement:** AggLayer asynchronously passes the state root containing the Fill event back to Polygon.

4. **Polygon (Tx 3):** Solver calls `claimOrder(orderId, proof)` on `CrossChainIntentOrigin`:
   - Verifies AggLayer proof references the Fill event by the correct `exclusiveFiller`
   - Releases 10 WETH escrow back to solver's Polygon wallet

**Solver net:**
- Polygon: Deposited 10 WETH → got 10 WETH back (net 0)
- Katana: Flash-swapped 98 → arb'd to 101 → repaid 98 + fee → kept ~3 WETH
- Total profit: ~3 WETH per cycle
- Capital at risk: ~10 WETH (the escrow + gas on both chains)

## 1. Polygon Contract: CrossChainIntentOrigin.sol

New contract, no relation to existing ArbExecutor. UUPS upgradeable.

### State

```solidity
struct Escrow {
    address token;              // Escrowed token (WETH or USDC)
    uint256 amount;             // Escrowed amount
    address solver;             // Solver wallet (will receive back)
    address exclusiveFiller;    // Katana address that must fill the order
    uint256 deadline;           // Block timestamp for expiry
    bool claimed;               // Whether escrow has been released
}

mapping(bytes32 => Escrow) public vaults;
address public immutable bridge;       // AggLayer bridge contract
address public immutable katanaExecutorAddr; // Known Katana executor (for proof verification)
uint256 public claimDelay;             // Blocks to wait after Fill before claiming
address public fallbackAddr;           // For expired orders
```

### Functions

**`executeArbOrder(address escrowToken, uint256 escrowAmount, bytes calldata orderData) external returns (bytes32 orderId)`**
- Pull `escrowAmount` of `escrowToken` from `msg.sender` via `transferFrom` (solver must pre-approve)
- Generate `orderId = keccak256(abi.encode(escrowToken, escrowAmount, msg.sender, block.timestamp))`
- Store in `vaults[orderId]`
- Emit `OrderCreated(orderId, orderData)`
- Revert if `CROSS_CHAIN_ARB_ENABLED` env var is false

**`claimOrder(bytes32 orderId, bytes calldata proof) external`**
- Validate `vaults[orderId]` exists and not claimed
- Verify AggLayer proof references Fill event on Katana by `exclusiveFiller` address
- `require(msg.sender == vaults[orderId].solver)`
- Mark claimed, transfer `vaults[orderId].amount` of `vaults[orderId].token` to `msg.sender`
- Emit `OrderClaimed(orderId)`

**`withdrawUnclaimed(bytes32 orderId) external`**
- Only after `vaults[orderId].deadline` passes
- Transfer escrow to `fallbackAddr`
- Emit `OrderExpired(orderId)`

### Security

- claimOrder must verify the AggLayer proof payload includes the `exclusiveFiller` address from the order — not just that any Fill event exists
- Reentrancy guard on all state-mutating functions
- Ownable with pause functionality

## 2. Katana Contract: KatanaExecutor.sol

New contract deployed on Katana (chain 747474). UUPS upgradeable. Executes arb via SushiSwap V2/V3 flash-swaps.

### State

```solidity
address public authorizedSolver;   // Bot's Katana wallet (only this can call executeArb)
address public immutable sushiV2Factory;  // 0x72d111b4d6f31b38919ae39779f570b747d6acd9
address public immutable sushiV3Factory;  // 0x203e8740894c8955cB8950759876d7E7E45E04c1
bytes32 public immutable sushiV2InitHash; // 0xe18a34eb... (standard)
bytes32 public immutable sushiV3InitHash; // 0xe040f12c7cee3904b78f24f8fc395629c2e69525c2815da7a659f7483e378ecb
```

### Functions

**`executeArb(address flashPool, uint8 flashProtocol, uint256 flashAmount, SwapStep[] calldata swapPath, address profitToken, uint256 minProfitOut, bytes32 orderId) external`**
- Only callable by `authorizedSolver`
- `flashProtocol`: 2 for V2, 3 for V3
- `flashPool`: the SushiSwap V2 pair or V3 pool to flash-swap from
- `swapPath`: array of swap steps (pool, tokenIn, tokenOut, protocol)
- `profitToken`: token to consolidate profit into (vbWETH, vbUSDC, AUSD)
- `minProfitOut`: minimum acceptable output

**V2 flash-swap initiation:**
```solidity
// Borrow flashAmount of tokenOut from a V2 pair
uint256 amount0Out = zeroForOne ? 0 : flashAmount;
uint256 amount1Out = zeroForOne ? flashAmount : 0;
IUniswapV2Pair(flashPool).swap(amount0Out, amount1Out, address(this), callbackData);
```

**V3 flash-swap initiation:**
```solidity
// Borrow via V3 swap callback
IPool(flashPool).swap(recipient, zeroForOne, int256(flashAmount), sqrtPriceLimitX96, callbackData);
```

**Callbacks:**

**`uniswapV2Call(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external`**
- Only callable by a Sushi V2 pair (deterministic address verification)
- Decode `swapPath` from `data`
- Execute arb hops:
  - For V2 hops: `transfer(tokenIn, pair, amountIn) → pair.swap(amount0Out, amount1Out, to, "")`
  - For V3 hops: `pool.swap(recipient, zeroForOne, amountSpecified, priceLimit, callbackData)`
- Compute profit accounting for vbToken exchange rates
- Repay flash-swap: `transfer(flashToken, msg.sender, flashAmount + fee)`

**`uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external`**
- Verify caller is a legitimate Sushi V3 pool via deterministic `computeAddress(deployer, tokenA, tokenB, fee)` using init hash
- Same arb execution pattern as V2 callback
- Repay flash-swap

### vbToken Handling

When computing `receivedAmount - flashAmount`, use the Vault Bridge view functions:
```solidity
// Get the underlying value of a vbToken
uint256 underlying = IVaultBridge(token).previewWithdraw(balance);
// Or get exchange rate
uint256 rate = IVaultBridge(token).exchangeRate();
```

This ensures the profit calculation correctly accounts for the yield-bearing nature of vbTokens used in Katana pools.

## 3. ERC-7683 Order Structure

### OrderData (within ERC-7683 payload)

```solidity
struct OrderData {
    address exclusiveFiller;        // Solver's Katana wallet address
    uint32 excludabilityDeadline;   // Timestamp until which only the filler can fill
    bytes katanaExecutionPayload;   // ABI-encoded call to KatanaExecutor.executeArb()
    address expectedOutputToken;    // Profit token on Katana (vbWETH/vbUSDC/AUSD)
    uint256 expectedMinOutput;      // Minimum acceptable output
}
```

### Resolved Order (solver-facing representation)

The resolver contract translates the order payload into:
- **Steps**: Call to KatanaExecutor.executeArb() on chain 747474
- **Variables**: exclusiveFiller as PaymentRecipient
- **Payments**: escrowed tokens released to solver after Fill proof
- **Assumptions**: AggLayer liveness, Katana chain finality

## 4. Off-chain Solver Bot

```
src/
├── services/
│   ├── crosschain/
│   │   ├── scanner.ts        // CrossChainScanner — price monitoring
│   │   ├── solver.ts         // SolverBot — tx submission + event monitoring
│   │   ├── order.ts          // ERC-7683 order construction
│   │   └── types.ts          // Cross-chain types
│   └── execution/
│       └── crosschain_calldata.ts  // Katana arb calldata encoding
```

### CrossChainScanner

- Reads SushiSwap V2/V3 pool states from Polygon HyperIndex DB
- Reads SushiSwap V2/V3 pool states from Katana RPC (via `katanaRpcUrl` from env)
- Computes price discrepancies for the golden asset set (WETH, USDC, WBTC, USDT)
- Estimates profitability: expected arb profit vs flash-swap fee vs gas costs
- Generates `SwapStep[]` arrays for `KatanaExecutor.executeArb()`
- Pushes profitable routes to the solver queue

### SolverBot

1. **Compute route**: CrossChainScanner finds profitable cross-chain price difference
2. **Polygon Tx**: Call `CrossChainIntentOrigin.executeArbOrder()`:
   - Solver's Polygon wallet pre-approves escrow token
   - Submit tx with escrow amount
   - Wait for `OrderCreated` event (confirm on-chain)
3. **Katana Tx**: Call `KatanaExecutor.executeArb()`:
   - Uses solver's Katana wallet (authorized solver)
   - Flash-swap from Sushi pool
   - Arb hops inside callback
   - Wait for `FillExecuted` event
4. **Settlement**: Wait for AggLayer proof finalization:
   - Monitor for the state root containing the Fill event
   - Can use the AggLayer bridge contract's `claimMessage()` to prove the event
5. **Polygon Claim**: Call `CrossChainIntentOrigin.claimOrder(orderId, proof)`:
   - Release escrowed tokens back to solver's Polygon wallet

### .env Toggles

```
CROSS_CHAIN_ARB_ENABLED=true          # Master toggle (default: false)
KATANA_EXECUTOR_ENABLED=true          # Katana contract toggle (default: false)
POLYGON_ESCROW_TOKEN=0x7ceb23fd...   # WETH on Polygon
ESCROW_AMOUNT=10                      # 10 WETH
KATANA_RPC_URL=https://rpc.katana.network
KATANA_EXECUTOR_ADDRESS=0x...        # Deployed KatanaExecutor address
ORIGIN_SETTLER_ADDRESS=0x...         # Deployed CrossChainIntentOrigin address
EXCLUSIVE_FILLER_ADDRESS=0x...        # Solver's Katana wallet
KATANA_SOLVER_PRIVATE_KEY=0x...       # Solver's Katana wallet key
POLYGON_SOLVER_PRIVATE_KEY=0x...      # Solver's Polygon wallet key
```

## 5. HyperIndex Multi-chain Config

Add Katana chain to `hyperindex/config.yaml`:

```yaml
chains:
  - id: 137
    # ... existing Polygon config ...
  - id: 747474
    start_block: 0
    contracts:
      - name: SushiV2Factory
        address: "0x72d111b4d6f31b38919ae39779f570b747d6acd9"
        abi_file_path: abis/uniswap_v2_factory.json
        handler: src/handlers_mjs/handlers_katana/v2_factory.js
        events:
          - event: PairCreated
      - name: KatanaV2Pool
        abi_file_path: abis/uniswap_v2_pool.json
        handler: src/handlers_mjs/handlers_katana/v2_pool.js
        events:
          - event: Sync
      - name: SushiV3Factory
        address: "0x203e8740894c8955cB8950759876d7E7E45E04c1"
        abi_file_path: abis/uniswap_v3_factory.json
        handler: src/handlers_mjs/handlers_katana/v3_factory.js
        events:
          - event: PoolCreated
      - name: KatanaV3Pool
        abi_file_path: abis/uniswap_v3_pool.json
        handler: src/handlers_mjs/handlers_katana/v3_pool.js
        events:
          - event: Swap
```

The Katana HyperIndex pipeline indexes SushiSwap pool states into the same SQLite database (different chain namespace). The CrossChainScanner reads both Polygon and Katana pool states from the same DB.

## 6. Files to Create

### Smart Contracts
- `sol/src/CrossChainIntentOrigin.sol` — Polygon escrow/claim contract (UUPS)
- `sol/src/KatanaExecutor.sol` — Katana flash-swap arb executor (UUPS)
- `sol/src/interfaces/IAggLayerBridge.sol` — AggLayer proof verification interface
- `sol/src/interfaces/IVaultBridge.sol` — Katana vbToken exchange rate interface

### HyperIndex
- `hyperindex/src/handlers_mjs/handlers_katana/v2_factory.js` — Katana V2 factory handler
- `hyperindex/src/handlers_mjs/handlers_katana/v2_pool.js` — Katana V2 pool handler
- `hyperindex/src/handlers_mjs/handlers_katana/v3_factory.js` — Katana V3 factory handler
- `hyperindex/src/handlers_mjs/handlers_katana/v3_pool.js` — Katana V3 pool handler

### Bot Services
- `src/services/crosschain/scanner.ts` — Cross-chain price scanner
- `src/services/crosschain/solver.ts` — Solver bot (tx submission, event monitoring)
- `src/services/crosschain/order.ts` — ERC-7683 order construction
- `src/services/crosschain/types.ts` — Types and interfaces
- `src/services/execution/crosschain_calldata.ts` — Katana arb calldata encoding
- `src/infra/db/katana_reader.ts` — Katana HyperIndex DB reader
- `src/config/crosschain_schema.ts` — Cross-chain config schema

### Config
- Update `hyperindex/config.yaml` — Add Katana chain + contracts
- Update `.env.example` — Add cross-chain env vars

## 7. Files to Modify

- `src/orchestrator/pass_loop.ts` — Add cross-chain scanner trigger (only if `CROSS_CHAIN_ARB_ENABLED`)
- `src/orchestrator/boot.ts` — Initialize cross-chain services (conditionally)
- `src/core/types/protocol.ts` — Add Katana protocol keys (if needed for shared types)
- `src/core/types/common.ts` — Add cross-chain address constants

## 8. Toggle Architecture

Both the Polygon contract and the Katana contract check their respective env var toggles before executing:

```
CrossChainIntentOrigin.executeArbOrder():
  if (!config.crossChainArbEnabled) revert("Cross-chain arb disabled")

KatanaExecutor.executeArb():
  if (!config.katanaExecutorEnabled) revert("Katana executor disabled")

CrossChainScanner:
  if (!config.crossChainArbEnabled) return  // Skip scanning

SolverBot:
  if (!config.crossChainArbEnabled) return  // Skip processing
```

## 9. Testing

### Unit Tests
- CrossChainIntentOrigin: escrow, claim, expiry, reentrancy
- KatanaExecutor: V2 flash-swap callback, V3 flash-swap callback, mixed hops
- CrossChainScanner: price computation, route generation
- SolverBot: event parsing, tx construction

### Integration Tests
- Deploy both contracts to testnet (Bokuto for Katana, Amoy for Polygon)
- Execute end-to-end arb with small amounts
- Verify AggLayer proof verification in claimOrder
- Verify exclusiveFiller protection (attempt a fill from wrong address → revert)

### Gas Benchmarks
- CrossChainIntentOrigin.executeArbOrder()
- CrossChainIntentOrigin.claimOrder()
- KatanaExecutor.executeArb() (with various swap path lengths)

## 10. Security Considerations

1. **ExclusiveFiller protection**: The `exclusiveFiller` field in `OrderData` is the only thing preventing MEV bots from stealing the order. It must be enforced at both the contract and proof-verification level.

2. **AggLayer proof verification**: `claimOrder` must verify the proof payload references the correct filler address, not just any Fill event. The proof contains the entire event log — verify the `exclusiveFiller` address matches.

3. **vbToken exchange rate manipulation**: The flash-swap repayment math must use the correct vbToken exchange rate at execution time. If the exchange rate changes between the swap and the repayment computation, use the `previewWithdraw()` or `exchangeRate()` at execution time (not cached).

4. **Reentrancy**: Both contracts use reentrancy guards on all state-mutating functions.

5. **Escrow expiry**: The `withdrawUnclaimed` function with a timeout protects against stuck funds if the solver fails to claim.

6. **Deterministic pool verification**: KatanaExecutor uses `computeAddress` with the correct init hash to verify pool callers, not a whitelist — this is gas-efficient and prevents spoofing.

## 11. Implementation Order

1. Write and deploy CrossChainIntentOrigin.sol to Polygon
2. Write and deploy KatanaExecutor.sol to Katana
3. Add Katana chain to HyperIndex config.yaml
4. Write Katana HyperIndex handlers (V2 + V3 factory, V2 + V3 pool)
5. Build CrossChainScanner (price reading + route computation)
6. Build SolverBot (tx submission, event monitoring, claiming)
7. Build calldata encoder for Katana arb
8. Wire pass loop trigger (conditionally, behind toggle)
9. Deploy both contracts to testnet
10. End-to-end test on Amoy + Bokuto with small amounts
11. Deploy to mainnet (Polygon + Katana)
12. Monitor and tune
