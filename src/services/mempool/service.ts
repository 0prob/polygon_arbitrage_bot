import type { Logger } from "../../infra/observability/logger.ts";
import type { SignalHandler, MempoolSignal, LargeSwapSignal } from "./signals.ts";
import { decodeSwapCalldata, SELECTORS } from "./decoder.ts";
import type { PendingStateOverlay } from "../../core/types/overlay.ts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface MempoolServiceOptions {
  coalesceTtlMs: number;
  largeSwapThresholdWei: bigint;
  dataDir?: string;
}

export const DEFAULT_MEMPOOL_OPTIONS: MempoolServiceOptions = {
  coalesceTtlMs: 100,
  largeSwapThresholdWei: 10n ** 18n, // 1 MATIC equivalent
};

export class MempoolService {
  private handlers: SignalHandler[] = [];
  private knownPools = new Set<string>();
  private lastEmitByPool = new Map<string, number>();
  private unknownSelectors = new Map<
    string,
    {
      selector: string;
      count: number;
      sampleTx: string;
      sampleTo: string;
      firstSeen: string;
      lastSeen: string;
    }
  >();
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private logger: Logger,
    private options: MempoolServiceOptions = DEFAULT_MEMPOOL_OPTIONS,
    private overlay?: PendingStateOverlay,
  ) {}

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  setKnownPools(pools: string[]): void {
    this.knownPools = new Set(pools.map((p) => p.toLowerCase()));
    this.logger.debug({ count: this.knownPools.size }, "MempoolService known pools updated");
  }

  async start(): Promise<void> {
    this.logger.info({}, "MempoolService started");
    this.loadUnknownSelectors();
  }

  stop(): void {
    this.logger.info({}, "MempoolService stopped");
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.writeUnknownSelectors();
  }

  private getUnknownSelectorsFilePath(): string {
    const dataDir = this.options.dataDir ?? "data";
    return join(dataDir, "unknown-selectors.json");
  }

  private loadUnknownSelectors(): void {
    const filePath = this.getUnknownSelectorsFilePath();
    if (!existsSync(filePath)) return;

    try {
      const raw = readFileSync(filePath, "utf8");
      const data = JSON.parse(raw);
      for (const [key, val] of Object.entries(data)) {
        this.unknownSelectors.set(key, val as any);
      }
      this.logger.info({ count: this.unknownSelectors.size }, "Loaded unknown selectors from file");
    } catch (err) {
      this.logger.warn({ err, filePath }, "Failed to load unknown selectors file");
    }
  }

  private saveUnknownSelectors(): void {
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.writeUnknownSelectors();
    }, 5000);
  }

  private writeUnknownSelectors(): void {
    const filePath = this.getUnknownSelectorsFilePath();
    try {
      const data = Object.fromEntries(this.unknownSelectors.entries());
      writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      this.logger.warn({ err, filePath }, "Failed to write unknown selectors file");
    }
  }

  private emit(signal: MempoolSignal): void {
    for (const h of this.handlers) h(signal);
  }

  private readonly MAX_EMIT_CACHE = 5000;

  /** Process a pending transaction from the mempool with coalescing. */
  processPendingTx(tx: { hash: string; to: string | null; input: string; value: string }): void {
    if (!tx.to || !tx.input) {
      this.logger.debug({ hash: tx.hash }, "mempool: ignored tx (no to/input)");
      return;
    }

    const traceId = "tx-" + tx.hash.slice(2, 8);
    const selector = tx.input.slice(0, 10).toLowerCase();

    // Noise filter for common non-swap selectors (checked BEFORE decoder).
    // These are not DEX swaps even if they interact with known pools.
    const IGNORED_SELECTORS = new Set([
      "0xe2ce6ca3", // claimDAORewards(uint256)
      "0xc7fff719", // updateOffer(address,uint256,uint256,uint256)
      "0xda5fe746", // signData(string,string,string)
      "0x88316456", // mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))
      "0x1df7814d", // claimAvailableBalance()
      "0x5c23bdf5", // resolve(bytes32)
      "0xf77a694a", // createAuction(uint256,uint256,string,uint256,uint256)
      "0x7357f5d2", // run(uint256,uint256)
      "0x2e17de78", // unstake(uint256)
      "0x31ac9920", // setMinFee(uint256)
      "0x00184bad", // commitStateRoot(bytes32,bytes32)
      "0x4782f779", // withdrawETH(address,uint256)
      "0x034de708", // claimMLMRewards(uint256)
      "0x7dc438a4", // setPriceForArbitrum((uint32,(uint128,uint64,uint32),(uint64,uint32)))
      "0x3161b7f6", // setPrice((uint32,(uint128,uint64,uint32))[])
      "0x410aa000", // setRewardsMerkleRoot(bytes32)
      "0x504e0fd4", // multicall((address,uint256,bytes,bool,uint256)[])
      "0xdd69becd", // claimStakeRewards(uint256)
      "0x8d6cc56d", // updatePrice(uint256)
      "0x290bb021", // aggregateStrict((address,bool,bytes,uint256)[])
      "0x925489a8", // claimMany(uint256[])
      "0x29aa1cd9", // betFor((address,(uint256,uint256,uint8,uint64[],uint128[],uint128,uint8,bytes)[],uint8,address,bytes,bytes,bytes)[])
      "0x4a6cc677", // batchBurn(address[],uint256[])
      "0x42842e0e", // safeTransferFrom(address,address,uint256)
      "0x00000003", // rz_16jun22_88961909()
      "0xad5425c6", // deposit(bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,bytes32,uint32,uint32,uint32,bytes)
      "0x91c41f15", // createMarket(bytes32,uint32,uint32,uint256,bytes)
      "0x68c7450f", // registerToken(uint256,uint256,bytes32)
      "0x632a9a52", // vote()
      "0x557a056a", // deposit2(uint256,address,uint256,address)
      "0xeb7e2de0", // transferToDestination(bytes32,address,address,uint256,bytes32)
      "0x0894edf1", // commitVerification(bytes,bytes32)
      "0x0bce9aaa", // updateLeverage(uint32,uint24)
      "0xa415bcad", // borrow(address,uint256,uint256,uint16,address)
      "0x437b9116", // tryMulticall(bytes[])
      "0xb2c536d1", // sendBatch(address[],uint256)
      "0x0000000b", // setPreSigns_weQh((address,address,address,uint256,uint256,uint256,uint256,bytes)[],bool)
      "0x617ba037", // supply(address,uint256,address,uint16)
      "0x6f174630", // settlePromise(uint256,uint256,bytes32,bytes)
      "0x48d9f01e", // settlePromise(address,uint256,uint256,bytes32,bytes)
      "0xf953cec7", // receiveMessage(bytes)
      "0x98b1e06a", // deposit(bytes)
      "0x84a3bb6b", // onChainGM(address)
      "0xd8aed145", // repay(uint256,uint256)
      "0xec0ab6a7", // batchCall(uint256,address[],bytes[])
      "0xe2ece38f", // bridgeWithdraw(address,uint256)
      "0x0ecbcdab", // borrow(uint256,uint256)
      "0xadc9772e", // stake(address,uint256)
      "0xc6e67267", // tokenizeNca(string[],(string,string,string,string,string[],string[],string,string,string,string)[],string[])
      "0x2213bc0b", // exec(address,address,uint256,address,bytes)
      "0xf0fc6bca", // claimDividend()
      "0x374f435d", // multicall((address,bytes,uint256,bool,bytes32)[])
      "0xd7098154", // claimPrize(uint256)
      "0x2c7bddf4", // loserSweepETH_11435948882()
      "0x0c89a0df", // transferTokens(address)
      "0xe2019cc9", // batchBurnForBuybackForWalletPair((address,address,uint256,uint256,bytes4)[],bytes[],uint256[],uint256)
      "0xf242432a", // safeTransferFrom(address,address,uint256,uint256,bytes)
      "0x4047fc1f", // requestEntropy(string)
      "0xb6b55f25", // deposit(uint256)
      "0xcef6d209", // redeemDelegations(bytes[],bytes32[],bytes[])
      "0x00000005", // fiverFiver_gwnqirj()
      "0xeeb9635c", // mintTokens()
      "0x9b2f2764", // updatePortfolio(string[],uint256[])
      "0xd2b490db", // batchSendNativeAndTokens(address[],address[],uint256[],uint256[])
      "0x42966c68", // burn(uint256)
      "0xd505accf", // permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
      "0x5a3b74b9", // setUserUseReserveAsCollateral(address,bool)
      "0x51b22c9d", // withdraw(uint256,address,uint256,uint8,bytes32,bytes32,uint256)
      "0x95435ac9", // ILoveGambling(bytes17,bytes27,bytes27,bytes13,bytes25,bytes24,bytes18,string)
      "0x11289565", // report(address,bytes,bytes,bytes[])
      "0xdeff4b24", // fillRelay((bytes32,bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,uint256,uint32,uint32,bytes),uint256,bytes32)
      "0x46bd28d4", // receiveSeasonalTokens(address,address,uint256)
      "0x6a2366fc", // CRPStaking__InvalidTimeUnit()
      "0x143ba4f3", // distributeRewards(address[],uint256[])
      "0x18712c21", // setMerkleRoot(uint256,bytes32)
      "0x8cc7104f", // unwrap(address,address,uint256)
      "0x72ce4275", // splitPosition(address,bytes32,bytes32,uint256[],uint256)
      "0x0248f237", // withdrawTurbine(uint256)
      "0xcccbb34c", // batchTransferWithAuthorization(address[],address[],uint256[],uint256[],uint256[],bytes32[],uint8[],bytes32[],bytes32[],uint256)
      "0x4e71d92d", // claim()
      "0x7299095e", // tryEarn(((uint256,address,address,uint256)[],uint256,uint256,uint256,uint256))
      "0x4b268241", // withdrawAsset(address,address,uint256,address,uint256,bytes32,bytes,bytes32[],bytes[],bool)
      "0x1f7f570a", // addWalletPair(address,address)
      "0xe8017952", // depositErc20(address,address,uint256,bytes32)
      "0xdd46508f", // modifyLiquidities(bytes,uint256)
      "0x52a8088f", // claimPartial(uint256)
      "0x8d241526", // setMultipleValues(string[],uint256[])
      "0x67830ac9", // burnTokenBatch(bytes32[])
      "0xcd6e13f7", // multicall((address,bool,uint256,bytes)[],address,address,bytes)
      "0x9ddba085", // proxy(address,address,uint256,bytes)
      "0xb1a18eab", // DispenseProduct(uint256,uint256,address)
      "0x40c10f19", // mint(address,uint256)
      "0xbeabacc8", // transfer(address,address,uint256)
      "0x4458a14c", // redeem(address,uint256,bool)
      "0x95a89b88", // batchMintWithPermitForWalletPair(address,uint256[],string[],uint256,uint256,(uint256,uint8,bytes32,bytes32),uint256)
      "0x34ee9791", // proxy((uint8,address,uint256,bytes)[])
      "0xcb3e9b84", // join(uint8)
      "0x379607f5", // claim(uint256)
      "0xac756684", // tunePrice(address,uint256,uint256,uint256)
      "0x4a502f39", // postStateList(address[],uint128[],uint64[],uint64[],uint256)
      "0x6abb1721", // fulfillRandomWords((uint256[2],uint256[2],uint256,uint256,uint256,address,uint256[2],uint256[2],uint256)[],(uint64,uint256,uint32,uint32,address,bytes)[])
      "0xd3fc9864", // mint(address,uint256,string)
      "0x2ec0ff6c", // collectFee(address,uint256)
      "0xa790fe47", // settleNodeInterest(address[])
      "0x15ed0249", // withdrawPromotion(uint256)
      "0x791ac947", // swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)
      "0x1e83409a", // claim(address)
      "0xe75cf6e5", // matchOrdersAndPrepareCombinatorial((uint256,address,address,uint256,uint256,uint256,uint8,uint8,uint256,bytes32,bytes32,bytes),(uint256,address,address,uint256,uint256,uint256,uint8,uint8,uint256,bytes32,bytes32,bytes)[],uint256[],uint256[],(uint256,uint256,uint256),uint256[])
      "0xdd4ed837", // makeCalls((address,bytes,uint256)[])
      "0x9e7212ad", // mergePositions(address,bytes32,bytes32,uint256[],uint256)
      "0x8df82800", // settle(uint256)
      "0xb8b4f908", // proposePrice(address,bytes32,uint256,bytes,int256)
      "0x69e29b59", // collectReward(uint32)
      "0x87517c45", // approve(address,address,uint160,uint48)
      "0x62355638", // wrap(address,address,uint256)
      "0x789f93f6", // transferERC721(address,address,address,uint256)
      "0xac9650d8", // multicall(bytes[])
      "0x00000008", // ____MEV_X____Ga543()
      "0x9ebea88c", // unstake(uint256,bool)
      "0xd808d889", // aggregate((address,address,address,address,uint256,uint256,uint256,string,bytes),(address,bytes))
      "0x90113282", // move(string,string,string,uint256,uint256,address)
      "0x00000000", // fulfillBasicOrder_efficient_6GL6yc((address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,(uint256,address)[],bytes))
      "0x49c36c07", // initiateApeBreedingByOwner6538289081()
      "0x82ad56cb", // aggregate3((address,bool,bytes)[])
      "0x91e5209d", // mintAndDistribute(uint256)
      "0x71ea9205", // postState(address,uint128,uint64,uint64)
      "0x3eaf5d9f", // tick()
      "0xd39bd016", // callWithSyncFeeConcurrentERC2771((uint256,address,bytes,address,bytes32,uint256),address,bytes,bool,bytes32)
      "0x02b8ff01", // claim(bytes32,uint256,address,uint256,uint256,bytes)
      "0xd0dbc833", // mintForUser(address,uint256)
      "0x6057361d", // store(uint256)
      "0xb1dc65a4", // transmit(bytes32[3],bytes,bytes32[],bytes32[],bytes32)
      "0xd0295134", // tuneParameters(address,uint256,uint256,uint256,uint256,uint256)
      "0xdbeccb23", // redeemPositions(bytes32,uint256[])
      "0x0f75e81f", // issue(bytes32)
      "0x1fad948c", // handleOps((address,uint256,bytes,bytes,uint256,uint256,uint256,uint256,uint256,bytes,bytes)[],address)
      "0x7ad4b0a4", // setAttribute(address,bytes32,bytes,uint256)
      "0x23b872dd", // transferFrom(address,address,uint256)
      "0x77835641", // deploy(address[],bytes32[])
      "0x765e827f", // handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)
      "0x405cec67", // relayCall(address,address,bytes,uint256,uint256,uint256,uint256,bytes,bytes)
      "0x0a2b8f36", // permit2TransferAndMulticall(address,((address,uint256)[],uint256,uint256),(address,bool,uint256,bytes)[],address,address,bytes,bytes)
      "0x236e5f14", // execV3(bytes)
      "0x8ec3dbb9", // gatewayBurn(bytes,bytes)
      "0x51ba162c", // disperseTokenSimple(address,address[],uint256[])
      "0x6fadcf72", // forward(address,bytes)
      "0x0dcd7a6c", // sendMultiSigToken(address,uint256,address,uint256,uint256,bytes)
      "0x5b63685e", // merge(bytes31,uint256)
      "0xaffb2c84", // claimDonation(uint256)
      "0x72a66b69", // claimEverything()
      "0x2e1a7d4d", // withdraw(uint256)
      "0xe3ee160e", // transferWithAuthorization (USDC)
      "0xd286f3cf", // claimInterest
      "0xa9059cbb", // transfer(address,uint256)
      "0x095ea7b3", // approve(address,uint256)
      "0x3c2b4399", // POLYMARKET_CTF matchOrders
      "0x3829cab1", // CLAIM_INTEREST
      "0x6a761202", // GNOSIS_SAFE execTransaction
      "0x46a73fb1", // SILENCE
      "0xa694fc3a", // STAKE
      "0x5638f1f3", // REDEEM_SILENCE
      "0xd9f0f7f5", // UNSTAKE_PRINCIPAL
      "0x0a3c4405", // POLYMARKET_DEPOSIT
    ]);
    if (IGNORED_SELECTORS.has(selector)) return;

    // Record unknown selector if not in SELECTORS map
    if (SELECTORS[selector] === undefined) {
      const now = new Date().toISOString();
      const existing = this.unknownSelectors.get(selector);
      if (existing) {
        existing.count++;
        existing.lastSeen = now;
      } else {
        this.unknownSelectors.set(selector, {
          selector,
          count: 1,
          sampleTx: tx.hash,
          sampleTo: tx.to,
          firstSeen: now,
          lastSeen: now,
        });
      }
      this.saveUnknownSelectors();
    }

    // Selectors that route through a vault/router (not pool-direct calls)
    const ROUTER_SELECTORS = new Set(["0x52bbbe29", "0x5c11d795"]);

    // Log incoming transaction
    this.logger.debug({ hash: tx.hash, to: tx.to, selector }, "mempool: processing tx");

    if (tx.input.startsWith("0xc9c65396") || tx.input.startsWith("0xa1671295")) {
      this.emit({
        type: "new_pool_pending",
        data: { traceId, txHash: tx.hash, factoryAddress: tx.to as `0x${string}` },
      });
    }

    // Dynamic Pool Learning: unknown to but known direct-pool selector — tentatively learn the target before decoding.
    // This ensures that decodeSwapCalldata succeeds for the current transaction rather than just future ones.
    const isDirectPoolSelector = SELECTORS[selector] !== undefined && !ROUTER_SELECTORS.has(selector);
    if (isDirectPoolSelector && tx.to && !this.knownPools.has(tx.to.toLowerCase())) {
      this.logger.debug({ pool: tx.to.toLowerCase(), selector }, "mempool: dynamically learned new pool");
      this.knownPools.add(tx.to.toLowerCase());
    }

    const decoded = decodeSwapCalldata(tx.to as `0x${string}`, tx.input, this.knownPools);
    if (!decoded) {
      this.logger.debug({ hash: tx.hash, selector }, "mempool: ignored tx (no decoded swap)");
      return;
    }

    // Dynamic Pool Learning: after successful decode, ensure the resolved pool is known
    if (!this.knownPools.has(decoded.poolAddress.toLowerCase())) {
      this.logger.debug({ pool: decoded.poolAddress, selector }, "mempool: dynamically learned decoded pool");
      this.knownPools.add(decoded.poolAddress.toLowerCase());
    }

    if (this.overlay) {
      if (decoded.protocol.startsWith("UNISWAP_V2")) {
        this.logger.debug({ pool: decoded.poolAddress, amount: decoded.amountIn.toString() }, "mempool: updating V2 overlay");
        const amount = decoded.amountIn;
        if (decoded.zeroForOne) {
          this.overlay.update(decoded.poolAddress, { reserve0: amount });
        } else {
          this.overlay.update(decoded.poolAddress, { reserve1: amount });
        }
      } else if (decoded.protocol.startsWith("UNISWAP_V3") && decoded.zeroForOne !== undefined) {
        // V3 overlay: mark state dirty for the dry runner by setting a sentinel.
        // The exact sqrtPriceX96 projection requires running the swap math, which
        // is deferred to the dry runner. Setting { pendingV3: true } triggers a
        // fresh RPC read for this pool before the dry run.
        this.logger.debug({ pool: decoded.poolAddress }, "mempool: marking V3 pool dirty for overlay");
        this.overlay.update(decoded.poolAddress, { pendingV3: true });
      }
    }

    const isIndirect = decoded.poolAddress.toLowerCase() !== (tx.to || "").toLowerCase();
    const effectiveSize = isIndirect ? this.options.largeSwapThresholdWei : decoded.amountIn;
    if (!isIndirect && effectiveSize < this.options.largeSwapThresholdWei) {
      this.logger.debug(
        {
          pool: decoded.poolAddress,
          amount: decoded.amountIn.toString(),
          thresh: this.options.largeSwapThresholdWei.toString(),
          hash: tx.hash,
        },
        "mempool: decoded swap below threshold",
      );
      return;
    }

    const poolKey = decoded.poolAddress.toLowerCase();
    const now = Date.now();
    const lastEmit = this.lastEmitByPool.get(poolKey);
    if (lastEmit != null && now - lastEmit < this.options.coalesceTtlMs) return;

    // Delete first to ensure it's moved to the end of the Map's insertion order (LRU behavior)
    this.lastEmitByPool.delete(poolKey);
    this.lastEmitByPool.set(poolKey, now);

    if (this.lastEmitByPool.size > this.MAX_EMIT_CACHE) {
      const oldest = this.lastEmitByPool.entries().next();
      if (oldest.value) {
        this.lastEmitByPool.delete(oldest.value[0]);
      }
    }

    this.logger.info(
      { pool: decoded.poolAddress, protocol: decoded.protocol, amount: decoded.amountIn.toString(), hash: tx.hash.slice(0, 10) + "..." },
      "mempool: emitting large_swap signal",
    );
    const signal: LargeSwapSignal = {
      traceId,
      txHash: tx.hash,
      poolAddress: decoded.poolAddress,
      tokenIn: decoded.tokenIn,
      tokenOut: decoded.tokenOut,
      estimatedSwapSize: effectiveSize,
      zeroForOne: decoded.zeroForOne,
    };
    this.emit({ type: "large_swap", data: signal });
  }
}
