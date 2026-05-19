# Deploy Scripts & Envio Codegen

## Problem

1. Two new contracts (`KatanaExecutor` on Katana chain 747474, `CrossChainIntentOrigin` on Polygon chain 137) need deploy scripts
2. `envio codegen` fails for chain 747474 because no HyperSync endpoint is configured

## Solution

### 1. Envio Config: Add HyperSync for chain 747474

Add `hypersync_config.url: https://katana.hypersync.xyz` under chain 747474 in `hyperindex/config.yaml`.

### 2. Forge Deploy Scripts

Two new Foundry `.s.sol` scripts following the existing `ArbExecutor.s.sol` pattern:

**`KatanaExecutor.s.sol`** — deployed on Katana (747474)
- Constructor args from env: `SOLVER` (required), `SUSHI_V2_FACTORY`, `SUSHI_V3_FACTORY`
- Defaults for factories: known Katana addresses (`0x72d111b4d6f31b38919ae39779f570b747d6acd9`, `0x203e8740894c8955cB8950759876d7E7E45E04c1`)

**`CrossChainIntentOrigin.s.sol`** — deployed on Polygon (137)
- UUPS proxy + `initialize()` args from env: `BRIDGE` (AggLayer), `KATANA_EXECUTOR_ADDRESS`
- Ownable — owner set to `$OWNER`

### 3. Enhanced `sol/deploy` Bash Script

Takes a contract name argument (positional):

```
./deploy arb       → forge script script/ArbExecutor.s.sol (Polygon RPC)
./deploy katana    → forge script script/KatanaExecutor.s.sol (Katana RPC)
./deploy origin    → forge script script/CrossChainIntentOrigin.s.sol (Polygon RPC)
```

Env vars per target:

| Script | Required Env | Optional Env |
|---|---|---|
| `arb` | `RPC_URL`, `PRIVATE_KEY`, `OWNER` | `BALANCER_VAULT`, `UNISWAP_V3_FACTORY`, `SUSHISWAP_V3_FACTORY`, etc. |
| `katana` | `KATANA_RPC_URL`, `PRIVATE_KEY`, `SOLVER` | `SUSHI_V2_FACTORY`, `SUSHI_V3_FACTORY` |
| `origin` | `RPC_URL`, `PRIVATE_KEY`, `BRIDGE`, `KATANA_EXECUTOR_ADDRESS` | (none) |

### Deploy Order

1. `PRIVATE_KEY=<key> SOLVER=<solver> KATANA_RPC_URL=<rpc> ./deploy katana` → outputs KatanaExecutor address
2. `PRIVATE_KEY=<key> BRIDGE=<bridge> KATANA_EXECUTOR_ADDRESS=<addr> RPC_URL=<rpc> ./deploy origin` → deploys CrossChainIntentOrigin
