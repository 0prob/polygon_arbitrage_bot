import type { Logger } from "../../infra/observability/logger.ts";
import type { SignalHandler, MempoolSignal, LargeSwapSignal } from "./signals.ts";
import { decodeSwapCalldata, SELECTORS } from "./decoder.ts";
import { join } from "node:path";
import type { PendingStateOverlay } from "../../core/types/overlay.ts";

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
    await this.loadUnknownSelectors();
  }

  async stop(): Promise<void> {
    this.logger.info({}, "MempoolService stopped");
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    await this.writeUnknownSelectors();
  }

  private getUnknownSelectorsFilePath(): string {
    const dataDir = this.options.dataDir ?? "data";
    return join(dataDir, "unknown-selectors.json");
  }

  private async loadUnknownSelectors(): Promise<void> {
    const filePath = this.getUnknownSelectorsFilePath();
    const { readFile } = await import("node:fs/promises");
    try {
      const raw = await readFile(filePath, "utf8");
      const data = JSON.parse(raw);
      for (const [key, val] of Object.entries(data)) {
        this.unknownSelectors.set(key, val as any);
      }
      this.logger.info({ count: this.unknownSelectors.size }, "Loaded unknown selectors from file");
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        this.logger.warn({ err, filePath }, "Failed to load unknown selectors file");
      }
    }
  }

  private saveUnknownSelectors(): void {
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      void this.writeUnknownSelectors();
    }, 5000);
  }

  private async writeUnknownSelectors(): Promise<void> {
    const filePath = this.getUnknownSelectorsFilePath();
    try {
      const data = Object.fromEntries(this.unknownSelectors.entries());
      const { writeFile } = await import("node:fs/promises");
      await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
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
      "0x45b1341b", // anchorLog(string,bytes32)
      "0x63c2a510", // claimMiningReward(address)
      "0x14cd6cd7", // depositInventory(uint256,uint256)
      "0x97e2334d", // countSearchedSaro(string)
      "0x6a263e21", // _transferWithTxnFee(address,address,uint256)
      "0xe74b981b", // setFeeRecipient(address)
      "0xcd808d94", // lockWallet(address)
      "0x33289a46", // withdrawDeposit(uint256)
      "0x4bd1c9f1", // mint((address,uint256,uint256,uint256,uint8,bytes32,bytes32))
      "0x04203b62", // batchIncreasePower(address[],uint256[],uint8)
      "0x44d616f7", // setCommunityLeader(uint256,address)
      "0x737b84cd", // delegatedTradingAction(address,bytes)
      "0xa4cb15ce", // createProxy(address,uint256,address,uint256,uint256,(uint8,bytes32,bytes32))
      "0x940b1428", // cancelConditions(uint256[])
      "0xc52c1593", // batchTransfer(uint256[],address[])
      "0xa4446174", // createWithDurationsLL(address,address,(address,address,uint128,bool,bool,(uint40,uint40),(uint128,uint128),uint40,string)[])
      "0xed53ddb9", // postBySig(string,address,uint256,uint8,bytes32,bytes32)
      "0x44602eb8", // registerBatch(bytes32[],string[],bytes32[])
      "0xd46eb119", // wrap()
      "0xf45346dc", // deposit(address,uint256,address)
      "0x62e73470", // batchCall((bytes)[])
      "0xe00af4a7", // sweepERC20(address)
      "0x2386c47d", // claimROI(uint256)
      "0xad11485d", // addLogByDate(uint32,bytes32)
      "0xc3490263", // claim(uint256,uint256)
      "0x8e4a2b8d", // mintWithDepositPool(address,uint256[],address[])
      "0x6a25fac7", // setOracleDrone(uint256,address)
      "0x4352fa9f", // setPrices(address[],uint256[])
      "0xc4d252f5", // cancel(bytes32)
      "0x01681a62", // sweep(address)
      "0x39f47693", // unwrap(address,uint256)
      "0x9fe72c4b", // lock((bytes32,address,uint8,uint256,uint256,uint16,uint16,bool,uint256,uint256),bytes)
      "0xb8236926", // investV2((uint256,address,uint256,bytes,bytes[],bytes[],bytes[],(bytes,bytes,uint256,uint256,int24,int24,uint256,uint256)[],(uint256,uint8,bytes32,bytes32),(uint256,uint8,bytes32,bytes32)),address)
      "0xa71870e5", // startMission(uint16,uint256,uint8,uint256[])
      "0xe3310e2b", // burnForShipment(uint256,address)
      "0x0d84165b", // transferComputingPower(address,uint256)
      "0xa17a7094", // delistNFT(address,uint256)
      "0x39cf685b", // updateVRFConfig(address,bytes32,uint256)
      "0x4000aea0", // transferAndCall(address,uint256,bytes)
      "0x7341c10c", // addConsumer(uint64,address)
      "0xa21a23e4", // createSubscription()
      "0x127c88bd", // depositNFT(address,uint256,uint256,bool)
      "0x27fd95c9", // batchMint(address[],uint256[],string[])
      "0x79be55f7", // enterProtocolByOwner(address)
      "0xebd4b81c", // initYieldToken(address,uint240)
      "0x4e4f7429", // addTransaction(uint256,address,address,uint256,uint256)
      "0xb3b9aa48", // editLock(uint256,uint256,uint256)
      "0xa138da9a", // swapAndDeposit(address,uint256,uint256,bytes,address)
      "0xde6c6d36", // mintForAddressMultiple(address[],uint256[])
      "0x7e56b7b0", // startBridgeTokensViaEco((bytes32,string,string,address,address,address,uint256,uint256,bool,bool),(bytes,address,uint64,bytes,bytes32,address))
      "0xfd279430", // mevShieldTx()
      "0x474cf53d", // depositETH(address,address,uint16)
      "0xbc4f2d6d", // rebase(uint256)
      "0x8129fc1c", // initialize()
      "0x322bba21", // createOrder((address,address,uint256,uint256,bytes32,uint256,uint32,bool,int64))
      "0x0b66f3f5", // multisendToken(address,address[],uint256[])
      "0xb7a16251", // updateDataFeedsValuesPartial(bytes32[])
      "0xa2b0e857", // mint(address,string,string,string,string,uint256,uint256,uint256,uint256)
      "0x995846bd", // stake(address,uint256,bool)
      "0x88be5e4f", // setPairDepthBands(uint256[],(uint256,uint256,uint256,uint256)[])
      "0xad8733ca", // multisend(address,address[],uint256[])
      "0x9cc1a283", // mint((address,address,int24,int24,uint256,uint256,uint256,uint256,address,uint256))
      "0xad3b1b47", // withdrawFees(address,uint256)
      "0x5f784ebe", // BatchTxnforToken(address[],uint256[])
      "0xd79261fd", // setPairCustomMaxLeverages(uint256[],uint256[])
      "0xcdb319fe", // syncAllProjectsFromManagerTVL()
      "0x88d695b2", // batchTransfer(address[],uint256[])
      "0x5ce308a7", // addEntry(string,string)
      "0x68573107", // batchMint(address[],uint256[])
      "0x2cdf0b95", // sendFrom(address,uint16,bytes32,uint256,uint256,(address,address,bytes))
      "0xcddc1bc1", // rejectOffer(address,uint256,address)
      "0x6198e339", // unlock(uint256)
      "0xca628c78", // withdrawToken()
      "0x94bf804d", // mint(uint256,address)
      "0x50bb4e7f", // mintWithTokenURI(address,uint256,string)
      "0x57a37ff4", // extractMission(bytes32)
      "0x4d31be1a", // listNFT(address,uint256,uint256,uint8,address)
      "0xcfbf153b", // createMonster(address,uint256,uint256)
      "0xfc99303d", // batchUploadFor(address,(address,address,uint256,uint256,bytes32,bytes32,uint64)[])
      "0xc813e051", // batchTreasuryTransferFor(address,(address,uint256)[])
      "0x0430b0b5", // registerWithPermitFor(address,address,bytes32,uint256,uint256,uint256,uint8,bytes32,bytes32)
      "0x40968794", // sendBatchSolanaUnlock((uint64,bytes,uint256,bytes,uint256,uint256,bytes,uint256,bytes,bytes,bytes,bytes,bytes,bytes)[],bytes32,uint256,uint64,uint64)
      "0x30be6955", // createToken((string,string),(uint16,uint16,address,uint128,uint128[],uint128[]))
      "0x62523d3a", // registerReferrer()
      "0xb669027a", // bulkSafeMint(address[])
      "0x0191a434", // join(uint256,bool,uint256)
      "0xd7a08473", // callDiamondWithEIP2612Signature(address,uint256,uint256,uint8,bytes32,bytes32,bytes)
      "0xcaacf34d", // depositV2(address,uint256,uint256)
      "0xbdbfa3de", // cancelLoan(uint256)
      "0xad884f69", // joinNetwork(address)
      "0xa8d55211", // mintToCaller(address,string)
      "0x0000000c", // gumXZCZ()
      "0x48511d03", // matchOrdersWithFees(uint256,uint256[],(uint256,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint8,uint8,bytes),(uint256,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint8,uint8,bytes)[],uint256,uint256[])
      "0xf3621e43", // claimRewards(address,address,uint256)
      "0x5e83ed8d", // safeStake(uint256,uint256,uint256,uint256)
      "0x7e734c5a", // createClone(string,string,bytes32)
      "0xdbbdf083", // register(uint256,address)
      "0xf14ddffc", // createAccount(address,bytes32)
      "0x8981d256", // batchSpendFor(address,(address,uint256,uint256,bytes32,bytes32,uint64)[])
      "0xa3443faa", // swapAndStartBridgeTokensViaRelayDepository((bytes32,string,string,address,address,address,uint256,uint256,bool,bool),(address,address,address,address,uint256,bytes,bool)[],(bytes32,address))
      "0xbfc54822", // bet(uint256,uint256,uint256)
      "0xa53410dd", // addIdentityToStorage(address,address,uint16)
      "0xdb00cbe4", // fulfillOracleCondition(bytes32)
      "0xf8419ac3", // inspect(uint256[],uint256[])
      "0xe4725ba1", // accept(bytes32)
      "0x7cd44734", // compose302(address,address,bytes32,uint16,bytes,bytes,uint256)
      "0x23663007", // gaslessTransfer(address,address,uint256,uint256,uint256,bytes32,bytes)
      "0x93b38ebc", // batchCustodialSpendFor(address,(address,address,uint256,uint256,bytes32,bytes32,uint64)[])
      "0x617c5ffe", // settleRedemption((address,uint256,uint256,uint256,uint8,uint256,uint256),bytes,(address,uint256,uint256,uint256,uint8,uint256,uint256),bytes,bytes32,uint256,uint256,uint256)
      "0x8ceab900", // request(bytes32,address)
      "0xfd636975", // addWeight(address,uint256)
      "0xb97138de", // oracleFundEscrow(bytes32,uint256,uint256)
      "0xbb4c9f0b", // multiSend(address[],uint256[])
      "0xbaca0004", // recycle(address)
      "0x2e0a13ff", // nodeWithdrawByAddress()
      "0x9281aa0b", // setWhitelisted(address,bool)
      "0x87201b41", // fulfillAvailableAdvancedOrders(((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),uint120,uint120,bytes,bytes)[],(uint256,uint8,uint256,uint256,bytes32[])[],(uint256,uint256)[][],(uint256,uint256)[][],bytes32,address,uint256)
      "0x911f456b", // multiConfigure((uint256,string,string,address,(uint80,uint48,uint48,uint16,uint16,bool),string,(bytes32,string[],string),address,bytes32,address[],address[],address[],address[],address[],(uint80,uint16,uint48,uint48,uint8,uint32,uint16,bool)[],address[],address[],(uint80,uint24,uint40,uint40,uint40,uint16,uint16)[],address[]))
      "0xcac7130c", // pay((uint256,uint256,uint256,uint256,uint256,uint256,address,address,address,address,address,address,uint8,uint8,bool,bytes,bytes))
      "0xbc157ac1", // deposit(uint256,address,uint256)
      "0xdc29f1de", // topUp()
      "0x96eab961", // triggerAutoProcess()
      "0x8ed955b9", // harvestAll()
      "0xee73faa7", // setReinvestAndAutoupgrade(bool,bool)
      "0xf9c028ec", // transferToken(address,address,uint256,bytes)
      "0xf0b7b915", // connectPool(address,bytes)
      "0x34f839eb", // gdaMint()
      "0x40208aa0", // joinBoard()
      "0x1f7fdffa", // mintBatch(address,uint256[],uint256[],bytes)
      "0x573ade81", // repay(address,uint256,uint256,address)
      "0xab115fd8", // directRelease(uint256,bytes32,bytes32,address,address)
      "0xf9edea44", // withdrawTierIncome(uint256)
      "0xd0cc7fae", // unstake(uint64,uint256)
      "0x5c19a95c", // delegate(address)
      "0x2999e0ac", // sendHierarchicalMove(string,string,string[],string,uint256,uint256,address)
      "0xa70806f7", // followUser(address)
      "0x6b13fcb1", // batchTransfer((address,address,address,uint256)[])
      "0x130a8182", // saveHash(string,string)
      "0xa8652f78", // fillPrice(uint256)
      "0x5607410d", // batchMintWithDeadline(address,uint256[],string[],uint256,uint256)
      "0x85e07421", // makeGreenBox(uint256,uint256)
      "0xf2d12b12", // matchAdvancedOrders(((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),uint120,uint120,bytes,bytes)[],(uint256,uint8,uint256,uint256,bytes32[])[],((uint256,uint256)[],(uint256,uint256)[])[],address)
      "0x6a24297f", // previousIglooStorage()
      "0xc89acc86", // send(address,bytes)
      "0x12ff148d", // resetDODOPrivatePool(address,uint256[],uint256[],uint8,uint256,uint256,uint256)
      "0xdca67d7b", // gatherErc20(address)
      "0x9386ce2b", // withdraw(address,uint256,uint256,uint8,bytes32,bytes32)
      "0xbd7047c4", // claimDividends(uint256)
      "0x6a24294f", // encryptedEncodedKeyEvent(uint,address,bytes32)
      "0x4924154a", // emitRewards(string,address[])
      "0x6b7747b3", // individualMint(address,uint256)
      "0xc002c4d6", // getTicket()
      "0xa065adcf", // redeemPositions(bytes32,bytes32,uint256[])
      "0x46f0a4ed", // split(address[],uint256[],uint256)
      "0xec8acddf", // withdrawWithData(address,uint256,uint256,(address,uint256,bytes)[],bytes)
      "0xf1dc3cc9", // remove_liquidity_one_coin(uint256,uint256,uint256)
      "0x27fec59a", // multicall(address[],bytes[],uint256,bytes)
      "0x4b61cd6f", // mintSigned(address,address,address,uint256,(uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool),uint256,bytes)
      "0x31fb67c2", // withdraw(string)
      "0x31f27b07", // sendReward(uint256,address)
      "0xbce38bd7", // tryAggregate(bool,(address,bytes)[])
      "0x84eaa00f", // withdrawAirdrop(address,uint256,uint256)
      "0x6ea5d58f", // quoteUpdate((uint16,bytes32)[])
      "0xcf82e2c6", // payWithNativeToken(address,uint256,uint256)
      "0xeca81d42", // safeMint(address,string,string)
      "0x807e8b4b", // requestPayout(uint256,uint8)
      "0x22b34d68", // updateTransferFee(uint256,bool)
      "0x3f965e56", // drip(address[],(address,uint256,uint256)[])
      "0xfd50e7ab", // sweepErc20(address,address,uint256)
      "0x714280b3", // topupToken(address,uint256)
      "0x09c56431", // execWithSig(bytes32,address,bytes,uint256,uint256,bytes32,bytes32)
      "0x236e06fa", // batchReveal((uint256,string)[])
      "0x59974e38", // distributeRewards(uint256)
      "0x1c8ec642", // depositToPolymarket(address,address,uint256)
      "0x2568a51a", // distribute(address,uint256,address[],uint256[])
      "0x1b7ab660", // deployContract(bytes32,bytes,string,string,string)
      "0x2f5e4b9a", // withdrawalFrom(address,uint256)
      "0x517a55a3", // remove_liquidity_one_coin(uint256,int128,uint256,bool)
      "0x53c06c38", // createMarket(uint256)
      "0x9d2a770b", // anchorBatch(bytes32,uint256,uint256)
      "0x7bbaf1ea", // performUpkeep(uint256,bytes)
      "0xca27a197", // withdrawalWithPermit(uint256,address,uint256,uint256,uint8,uint8,bytes32,bytes32)
      "0x9ec68f0f", // multiSend(address,address[],uint256[])
      "0xe8b87649", // serviceRequest(string,uint256,uint256)
      "0xc8b168a8", // batchTransactionsEnhanced(uint256[],address[],bytes[])
      "0x5cf8113b", // startBridgeTokensViaNEARIntents((bytes32,string,string,address,address,address,uint256,uint256,bool,bool),(bytes32,address,bytes32,uint256,uint256,address,bytes))
      "0xc36d308a", // mintEP(uint256)
      "0x2d52de18", // cancelCharge(uint256)
      "0x251eb094", // withdrawProfits(address[])
      "0xc6878519", // completeTransfer(bytes)
      "0xad8bc26b", // batchDistribute(address[],uint256[])
      "0xda7c2563", // unlock(address,address,uint256,bytes32,uint256)
      "0x7249fbb6", // refund(bytes32)
      "0x79c76e1a", // flush(address)
      "0xbb721aab", // issueCertificate(address,string)
      "0xb621b032", // startBridgeTokensViaMayan((bytes32,string,string,address,address,address,uint256,uint256,bool,bool),(bytes32,address,bytes))
      "0x044a40c3", // shield(((bytes32,(uint8,address,uint256),uint120),(bytes32[3],bytes32))[])
      "0x4c267eb5", // commitRoot(uint256,bytes32,uint16)
      "0xb45b1c1f", // appendWinnersToSatelliteFinal(uint256,uint256[])
      "0xb1a34e0d", // addClaim(uint256,uint256,address,bytes,bytes,string)
      "0xd6c95d20", // initialize(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)
      "0x39bb39eb", // transfer(address,uint256,uint16,bytes32,bytes32,bytes,(uint256,address,bytes,bytes),(uint16,address))
      "0xc2bf7aef", // withdrawal(address,uint256,bool)
      "0x454a03e0", // registerIdentity(address,address,uint16)
      "0x5f2992fe", // depositNFT(address,address,uint256[])
      "0x8ff3928c", // reset(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256)
      "0xd9eba439", // registerListAndSetBaseURI(uint256,string,(address,address,uint256,uint64,uint64,uint64,uint64,uint32,uint64,bytes32,bool),string)
      "0xa8a97304", // createMerchant(bytes32,address,address,address)
      "0xfebe7fe2", // setMarkAsPaid(uint256)
      "0x3b91efb9", // anchorCertificate(string,string,string,string,uint256,bytes32,string)
      "0xe60f0c05", // matchOrders((uint256,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint8,uint8,bytes),(uint256,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint8,uint8,bytes)[],uint256,uint256[])
      "0x9e7934db", // distributeEther(address[],uint256[])
      "0xd286e909", // distributeToken(address[],address[],uint256[])
      "0xc3f44c0a", // relayMetaTx(uint8,bytes32,bytes32,address,bytes,address)
      "0x2f4350c2", // redeemAll()
      "0xc3ef0114", // splitPayment((address,uint256,string,address,address,address,uint256,uint256,uint256))
      "0x28c70ea0", // claimRewards(address,bytes[])
      "0x8dbdbe6d", // deposit(uint256,uint256,address)
      "0x96fd1c42", // flush(address,uint256)
      "0x4004008d", // _mockApplyDifficulty(uint256)
      "0x4a85d788", // postBatch(bytes32[])
      "0x7d7c2a1c", // rebalance()
      "0x261449d7", // updateCertificateInBatchStatus(bytes32,uint8)
      "0xfc5f1003", // startBridgeTokensViaGasZip((bytes32,string,string,address,address,address,uint256,uint256,bool,bool),(bytes32,uint256))
      "0xa42ad923", // addWithSignature(address,uint256,address,bytes)
      "0xb68fb020", // cancelOrder(uint256,bytes32)
      "0xf14faf6f", // donate(uint256)
      "0x9db5dbe4", // transferERC20(address,address,uint256)
      "0xa085acc4", // bulkMintSLDWithRecords(address[],string[],string[],string[][],string[][])
      "0x1239ec8c", // batchTransfer(address,address[],uint256[])
      "0x71ee95c0", // claim(address[],address[],uint256[],bytes32[][])
      "0xe932ad19", // mint(uint256,address,string,string)
      "0x06d0739f", // updateListing(address,uint256,uint256,address,uint256)
      "0x2468d6f4", // setWhiteListUser(address,address,bool)
      "0x1688f0b9", // createProxyWithNonce(address,bytes,uint256)
      "0xa309fa75", // transfer(address,address,uint256,uint256,bytes32,bytes)
      "0x59029b73", // releasePrincipal(address,uint256)
      "0xfd9f1e10", // cancel((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256)[])
      "0xbf29e2cd", // reinvestHalf()
      "0x793c1946", // resume(address)
      "0xb9303701", // createSaltedOrder((address,uint256,bytes,uint256,uint256,bytes,address,bytes,bytes,bytes,bytes),uint64,bytes,uint32,bytes,bytes)
      "0xbbe5bd00", // initiateArbitrage(address,uint256,bytes)
      "0x2f622e6b", // withdrawNative(address)
      "0x83f8b7e2", // claimDailyReward()
      "0x731133e9", // mint(address,uint256,uint256,bytes)
      "0xe7acab24", // fulfillAdvancedOrder(((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),uint120,uint120,bytes,bytes),(uint256,uint8,uint256,uint256,bytes32[])[],bytes32,address)
      "0x02ee864d", // addLinkedWithSignature(bytes32,address,uint256,address,bytes)
      "0xbcdec0ae", // transferHelper(address,uint256)
      "0x3001bfba", // distributeDogau(uint256)
      "0x5ae401dc", // multicall(uint256,bytes[])
      "0xf3fef3a3", // withdraw(address,uint256)
      "0x39509351", // increaseAllowance(address,uint256)
      "0x64a8cce9", // acceptOrder(uint256,string)
      "0x6c83a890", // aggregate3Value((address,address,bool,uint256,bytes)[],uint256,uint256,uint256)
      "0xad3280ef", // WithdrawReward(address)
      "0x9eedeb1e", // registerToken(uint256,uint256,bytes32,bytes32)
      "0xa115e8dd", // respondToEvent(bytes32,uint8)
      "0x2dad97d4", // repayWithATokens(address,uint256,uint256)
      "0x84eb85d5", // addMiner(string,address,address,uint256)
      "0x29e0e160", // acceptOffer(address,uint256,address,uint256)
      "0x8d1247ba", // burn(address,uint256,bytes32,bytes)
      "0x5db7a328", // supply(address,uint256,uint256,address)
      "0x9470b0bd", // withdrawFrom(address,uint256)
      "0xf55b792e", // setMerchantMaxPerTx(address,uint256)
      "0xe3693bf0", // withdrawItems(bytes,bytes32,bytes32,uint256,uint256,uint256[],uint256[],uint256[],uint256[])
      "0x252f7b01", // validateTransactionProofV1(uint16,address,uint256,bytes32,bytes32,bytes)
      "0x2e686259", // setMerchantCustomRate(address,uint16)
      "0xae0b51df", // claim(uint256,uint256,bytes32[])
      "0xeaac2925", // lock(address,uint256,address,uint256)
      "0xce53edcb", // performMissionActions(bytes32,(uint8,uint8,uint8,uint8)[])
      "0xcd279c7c", // safeMint(address,uint256,string)
      "0x1481e50f", // revealMission(bytes32)
      "0xe203611f", // convert(uint256[],((uint256,uint256),(uint256[2],uint256[2]),(uint256,uint256)),uint32,uint96,uint96,bytes)
      "0x555029a6", // invoke(bytes32[],bytes[])
      "0x2cbda9fe", // redeemPackWithRewards(uint32)
      "0x2f2ff15d", // grantRole(bytes32,address)
      "0x310ec4a7", // setAllowance(address,uint256)
      "0x2929abe6", // distribute(address[],uint256[])
      "0x02998cf3", // listNFT(uint256,uint256,address)
      "0x328debb0", // resolveBattle(bytes32)
      "0x68fc0f7e", // rescue(address,address,uint256,address)
      "0x9d152ee9", // postPriceList(address[],uint128[],uint256)
      "0x68a78781", // setFeeConfig(uint32,uint64,uint64,uint24,uint24,uint24,uint24)
      "0x303e9092", // redeemCollection(bytes,uint256,uint128,uint256[],address)
      "0xcceb1bea", // depositToFarm(uint256,uint256[],uint256[],uint256[],uint256[],uint256[],uint256[])
      "0x7a6eb345", // claimRewardExt(address,address,uint256,uint256,uint256,(uint8,bytes32,bytes32))
      "0x119abf67", // unlockSingle(bytes)
      "0x6a24245a", // LockTheContract(bool)
      "0xdb006a75", // redeem(uint256)
      "0xa3f81f89", // withdrawFromIncomeWallet()
      "0x8e5e6a28", // updateImageURI(uint256,string)
      "0x24058ad3", // increasePositionSize(uint32,uint120,uint24,uint64,uint16)
      "0xcf10c969", // registerIdentity(address,uint256,uint256,address,bytes)
      "0xb842f3b6", // rewardWithdraw(uint256)
      "0x63998a8d", // initiateRepay(address,uint256,address,uint8,uint8,bytes)
      "0xd92af1b7", // setNickname(uint256,string)
      "0x36ce736b", // closeTradeMarket(uint32,uint64)
      "0x5a90a113", // schaubbSweep(address[],bytes[])
      "0x991f255f", // aggregate(address[],bytes[],uint256[],address)
      "0xc4b6ecd3", // createSignal(string,uint8,uint256,uint256,uint256,uint256)
      "0x219f5d17", // increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))
      "0x69321fc5", // buySettle(((address,address,address,address,uint256,uint256,uint256,uint256,uint8,uint256,uint256,bytes,bytes,(bytes4,uint256,address,int8,bytes)),bytes,(bytes4,bytes),bytes),bytes,address,bytes)
      "0xb88a802f", // claimReward()
      "0x2d67c0c5", // claimByIndex(uint256)
      "0x36627978", // repairTokenWear(uint256,uint256,uint256)
      "0xd508e623", // deployNewInstance(bytes32)
      "0x321acd0c", // payWithToken(address,uint256,uint256)
      "0x5c833bfd", // redeem(address,uint256,address)
      "0x2d67b5ea", // unlockCompressedBatch(bytes,bytes,uint16[])
      "0xf9bc8d32", // prepareCondition(bytes32)
      "0xd85064c2", // relayOperation(uint256,address,bytes,bytes)
      "0x32389b71", // bulkTransfer(((uint8,address,uint256,uint256)[],address,bool)[],bytes32)
      "0x3c29ede8", // depositToken((string,(string,string,string)),uint256,((string,string),(string,uint256),(string,string,string),bytes,bool)[],(uint256,bytes,string))
      "0xeca2a317", // performFulfilment(uint256,bytes[],address,uint256,(address,uint256,bytes),(((uint256,uint256,uint256,uint256,address,address,address,address,uint32,address,uint256,address,uint256,uint256),address,uint256,bytes32,bytes,uint256,bytes,address),address,uint256,bytes,uint256),bytes)
      "0x6704363c", // update(uint64)
      "0x34fcf437", // setRate(uint256)
      "0xd1b68611", // reduceStakeTo(address,uint256)
      "0x0e5c011e", // harvest(address)
      "0x400400b2", // platformSafeTransfer(address,address,uint256)
      "0x36c78516", // transferFrom(address,address,uint160,address)
      "0x1d6ee8eb", // claimUsdc()
      "0xd09c0117", // delegatedSafeSignedTransferFrom(address,address,uint256,bytes)
      "0x5b5a646e", // sendBatchEvmUnlock(bytes32[],address,uint256)
      "0x70485155", // sendCredits(uint32,(uint16,(uint32,uint64,uint64)[])[])
      "0x228c0b0f", // accountRewards(uint256[],((uint256,uint256),(uint256[2],uint256[2]),(uint256,uint256)),uint32,uint96,bytes)
      "0x2bb55dee", // kill((address,address,address),int24,int24,uint128,bool,address)
      "0x1793876b", // transferVoucher(string,uint256,(string,string),((string,string),(string,uint256),(string,string,string),bytes,bool)[],(uint256,bytes,string))
      "0xe282dcdd", // messageIn(uint256,uint256,bytes32,bytes)
      "0xf3570e3b", // mintBrla(address,uint256)
      "0x39125215", // sendMultiSig(address,uint256,bytes,uint256,uint256,bytes)
      "0x28533a6d", // setRange(address,uint128,uint128)
      "0x94c7f5b5", // place((address,address,address),int24,bool,uint128)
      "0x50635394", // claimBonus()
      "0x5a9c9eb8", // mintMultiple(address[],uint256[],string[])
      "0x3659cfe6", // upgradeTo(address)
      "0xf279e6a1", // Withdraw(address,uint256,uint256)
      "0x535aec20", // batchProcessActions(bytes[])
      "0xdace42a2", // cleanupExpiredOffers(address,uint256)
      "0x6c31c4c6", // back(address,uint256,bool)
      "0x199aecdf", // stakeWithDAI(uint256)
      "0xf446092d", // claimSession(uint256)
      "0x155622a4", // emergencyWithdraw(uint8)
      "0xa68b068b", // adminWithdrawAll(address)
      "0x69328dec", // withdraw(address,uint256,address)
      "0x40040029", // testMintDiscount_NotActive()
      "0xe2034caa", // notarize(string,string)
      "0x979a77a8", // transact(uint256[2],uint256[2][2],uint256[2],(uint16,uint16,uint16),(uint256,address[],uint256[],int256[],bool[],int256[],uint256[][],uint256[][],bytes[][],(address,uint256,uint256),uint256,(uint256,uint256,uint256,uint256),uint256,uint256,uint16,address,address,uint256,bytes,(uint256,uint256,int256[],bool,(int256[],address[],uint256[])[]),(address,address,bytes,bytes),(uint8,bytes32,bytes32,uint256,uint256,address),address))
      "0x53043490", // ownerTransferFrom(address,address,uint256)
      "0x5eabd9c7", // deposit((uint16,uint16,uint256,uint256,uint256),bytes32,bytes32,uint256)
      "0x058a56ac", // cancelOffer(address,uint256)
      "0xe2bbb158", // deposit(uint256,uint256)
      "0x5872278a", // deposit(uint256,uint256,uint256,uint256,uint256,uint256)
      "0x8e0250ee", // depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)
      "0x4515cef3", // add_liquidity(uint256[3],uint256)
      "0x69380ce5", // withdrawProfit(address,uint256,bytes32,bytes)
      "0xa64dfa75", // multiConfigure(address,(uint256[],uint256[],string,string,(uint80,uint80,uint40,uint40,bool,address,uint24,uint24,uint16,uint16,uint16)[],uint256[],string,(bytes32,string[],string),(address,uint16)[],bytes32,address[],address[],address[],address[],address[],address[],address,uint96,address,uint256[],uint256[]))
      "0xc73a2d60", // disperseToken(address,address[],uint256[])
      "0x1ba0e812", // receiveMessages(address[],bytes[],address)
      "0xd64b4516", // createHangHoaToken(string,string,uint256)
      "0x3a9d666f", // arbitraryCallsWithTokenCheck(address[],bytes[],address,uint256)
      "0x59d3ce47", // Activate()
      "0x39c79e0c", // close(bytes32)
      "0x50df638b", // deposit(bytes,address,uint128)
      "0xde37c45b", // safe(uint256,uint256,uint256,address,bool)
      "0x0962ef79", // claimRewards(uint256)
      "0x5efd6f04", // addTP(bytes32)
      "0x347d6a22", // sendHierarchicalMove(string,string,string[],string)
      "0x475b6d9e", // nativeDrop((uint32,bytes32,uint64),uint32,address,(address,uint256)[],uint256)
      "0x8215ae57", // claimPower()
      "0x3ce33bff", // bridge(string,address,uint256,bytes)
      "0x5eb512e7", // deployVault(address)
      "0x19aa70e7", // claimDivs()
      "0x4451d89f", // claimToken()
      "0xdccedc74", // fulfillOrder(bytes,bytes,address,bytes)
      "0xeacabe14", // mintNFT(address,string)
      "0x06799dee", // create(bytes32,uint256,address,address,address,uint256)
      "0xf207564e", // register(uint256)
      "0x303a785d", // refundByOwnerOrAdmin(bytes32,uint8,bytes,bytes)
      "0x83b71871", // registerRelayServer(uint256,uint256,string)
      "0x4f7fb332", // claimMerkleBatch(uint256[],uint256[],bytes32[][])
      "0x79cc6790", // burnFrom(address,uint256)
      "0x94d008ef", // mint(address,uint256,bytes)
      "0xd0e30db0", // deposit()
      "0xf3ea8325", // ping(bytes32,bytes32,uint256,uint256)
      "0x966f197c", // transferBatch(address[],uint256[],address[],uint256[],uint256[])
      "0x64f5e9e7", // callExtension(bytes)
      "0x00000004", // matchTokenOrderByAdmin_MYmNxE()
      "0x2b28b34e", // setFares(uint32,uint80,uint80)
      "0xd605e5d4", // claimReward(address,uint256,uint256,uint256,bytes)
      "0x252dba42", // aggregate((address,bytes)[])
      "0x00000020", // unlock_98ABD3()
      "0x4641257d", // harvest()
      "0xb0d0f4b8", // record(bytes32,string)
      "0x7c1a5cb6", // setDolzPrice(uint256)
      "0xb3e49ea2", // multipleSwapExactTokensForTokensSupportingFeeOnTransferTokens(address,address,uint256,uint256,address[],address,uint256)
      "0xcf6cbb3d", // flushTokens(address,uint256)
      "0x847c5c64", // processWithdrawal(address,address,uint256,uint256,address,uint64,uint64,bytes,int256,bytes32[])
      "0xe83f967b", // sendTokens(address,address[],uint256[])
      "0xb9de6a93", // enterProtocol(address,address,uint256)
      "0x2e378115", // fillV3Relay((address,address,address,address,address,uint256,uint256,uint256,uint32,uint32,uint32,bytes),uint256)
      "0x29b0db8b", // fillTxV2(bytes32,bytes32,address,bytes32,uint256,uint256,uint256,uint256,bytes)
      "0x7365870b", // bet(uint256)
      "0x86b8865c", // listNFT(address,uint256,uint256,address,uint256)
      "0xea732637", // burnProof(bytes4,bytes,bytes,bytes4,uint256,bytes,uint256,bytes,uint256[],uint256[])
      "0x7564ac38", // claimUSDT()
      "0x2eb2c2d6", // safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)
      "0x65da41b9", // addHeaders(bytes,bytes)
      "0xba2b582c", // certify(address,string,(string,bytes32,string))
      "0xd4f9886d", // _checkAndExpireListing(address,uint256)
      "0x90322513", // contribute(address,uint128,address)
      "0x3ce95eb0", // mintDefaultVariant(uint256,uint8,uint256)
      "0x3820c31b", // removeVideo(uint256)
      "0x5fafabae", // creditAlbum(address,uint256)
      "0x4953c782", // claimReward(address,address)
      "0xbaa2abde", // removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)
      "0xb760faf9", // depositTo(address)
      "0x2e7ba6ef", // claim(uint256,address,uint256,bytes32[])
      "0xe4269fc4", // forwardERC20(address,uint256,(uint256,uint256,uint8,bytes32,bytes32),address,bytes)
      "0x005213f1", // water(address,uint256)
      "0x0d391ddd", // confirmRelease(uint256,string)
      "0x69b2a833", // swapBaseToQuote(address,uint256,uint256)
      "0x95ace4b3", // claim(bytes32,uint256,uint256,bytes)
      "0x1f3177ba", // arbitraryCalls(address[],bytes[])
      "0x542eb745", // stakeFlexible(uint256)
      "0x6a242071", // getMyROCKET_LAUNCH()
      "0x2fd515c7", // open(uint256,uint128,uint128)
      "0x546dc63e", // stakeLP(uint256,uint8)
      "0x7ca7faa3", // redeemLocked(uint256)
      "0xaec96b09", // settleClose(address,uint256,uint256)
      "0x049878f3", // join(uint256)
      "0x51b1f799", // userWithdrawBatch((uint256,address,uint256,uint256,address,bool)[],uint256[])
      "0x2e311d37", // initiateClose((address,address,uint256,uint256,uint256),bytes,(uint256,uint256,uint256,uint256,bytes))
      "0x920ec42f", // joinChannel((string,string,address,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,string,bytes))
      "0xe1fcde8e", // startViaRubic(address[],uint256[],bytes)
      "0x58181a80", // fundAndRunMulticall(address,uint256,(uint8,address,uint256,bytes,bytes)[])
      "0x7cc0c848", // movePosition((uint160,uint160),(int24,int24,uint128),(bool,(uint8,address,address,uint256,uint256,bytes)),(int24,int24,uint160,uint160,uint256,uint256,uint256,uint256,bool),bytes)
      "0xc358547e", // fulfillOrder((uint64,bytes,uint256,bytes,uint256,uint256,bytes,uint256,bytes,bytes,bytes,bytes,bytes,bytes),uint256,bytes32,bytes,address)
      "0x57ecfd28", // receiveMessage(bytes,bytes)
      "0xd5bade07", // postPrice(address,uint128)
      "0x21c16ce3", // batchMintTokens((uint64,address,uint32,string,uint32)[],bytes32)
      "0x5668b02e", // stakeWithPermit(uint256,uint256,uint256,uint8,bytes32,bytes32)
      "0xb9e1aa03", // deposit(address,bytes32)
      "0x102c1519", // deployNFTCollection((address,address,uint256,uint256,uint256,string,string,string,bool,bool,string),(address,address,uint256),bytes,bytes32)
      "0x6d0d6a7e", // pushDataReport((bytes32,bytes32,(uint16,uint16,uint64),uint64,bytes),bytes)
      "0x90890809", // Deposit(address,uint256,uint256)
      "0xfe3f7de9", // dissolveTEU(address,address,uint256)
      "0x368ddfe7", // reportNav(uint256)
      "0x7263e87d", // stargateV2Bridge((address,uint32,uint16,bytes32,uint256,address,uint256,bytes,bytes,bytes),(address,address,uint256,uint256,uint256,address,uint256,uint16,string))
      "0x7117f3fa", // createWallet(address[],bytes32)
      "0xdbc7d8fd", // claim(uint8,uint256)
      "0x174dea71", // aggregate3Value((address,bool,uint256,bytes)[])
      "0x146163dc", // pixOut(uint256,address,address)
      "0xb6f9de95", // swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)
      "0x6c694114", // uplevel(uint256)
      "0xf8e93ef9", // mint(uint256[])
      "0x1749e1e3", // multicall((address,uint256,bytes)[])
      "0xc53e4e8d", // claimTokens(uint256,uint256,uint256,uint256[],bytes)
      "0x0fd6ff49", // heartbeat(string)
      "0xb57b083c", // reissueWithMetadata(string,string[],uint256)
      "0x82ecf2f6", // create(uint32,bytes32,bytes)
      "0x8a4068dd", // transfer()
      "0x8b59492e", // web3kit((address,bytes,uint256)[])
      "0x0193b9fc", // callDiamondWithPermit2(bytes,((address,uint256),uint256,uint256),bytes)
      "0x55a569d7", // create(string,string,uint8,address[],uint256[])
      "0x7acb7757", // stake(uint256,address)
      "0x0cdcb535", // setLevel(uint256,uint8)
      "0x0ddd588d", // vdkasjhfs(address,address,uint256,uint256,address[],uint256,bool,bool)
      "0xa9aeaaf1", // createMarketItem(address,address,uint256)
      "0xfdaf2075", // call(uint256,address,uint256,address,bytes,bytes)
      "0x8f821438", // addMatchedLiquidity(uint256,uint256,uint256)
      "0xbe6d055a", // proxy(address,bytes)
      "0xdac36d87", // claimPgcAndHold(address,address,bool)
      "0x015f7fef", // claim_bonus()
      "0xa3ed9cd0", // deposit(address,address,uint256,uint256,address)
      "0x161d0770", // withdrawPayout(address,uint256)
      "0x7b0472f0", // stake(uint256,uint256)
      "0x6a627842", // mint(address)
      "0xd11711a2", // participate()
      "0xd80c6c1b", // sweep(bytes32,address,address[])
      "0x569a5aa3", // register(address[],bytes)
      "0x23b70d76", // createOrder(uint256,uint256,address)
      "0xc49298ac", // reportPayouts(bytes32,uint256[])
      "0x0ef52d0c", // createCollateralContract(string,address)
      "0xce2e62ff", // yeetExactTokensForTokens1107459129()
      "0x31c43a7e", // recordFill(address,bytes32,uint256,uint256,uint256,bytes32)
      "0x00000001", // multicallN2M_001Taw5z(uint256,bytes[])
      "0x625d41e2", // mint(address,uint32,string)
      "0x85d014ba", // notarize(uint256,string)
      "0xa10df729", // rollVariant(uint256,uint256,uint256,uint256,bytes32,bytes)
      "0x3b126fc5", // claimClaimables(address)
      "0xe8e33700", // addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)
      "0xe98a702a", // burnNFT(uint256[],uint256[])
      "0x01e33667", // withdrawToken(address,address,uint256)
      "0x74fa4121", // handleOps(bytes,uint256,uint256)
      "0xb0652ee6", // acrossBridge((address,address,address,address,uint32,uint32,address,uint256,uint256,uint32,bytes),(address,address,uint256,uint256,uint256,address,uint256,uint16,string))
      "0x452ae331", // attack(address,uint256,uint256)
      "0x0d58b1db", // transferFrom((address,address,uint160,address)[])
      "0x173457ef", // startBridgeTokensViaPolymerCCTP((bytes32,string,string,address,address,address,uint256,uint256,bool,bool),(uint256,uint256,bytes32,bytes32,uint32))
      "0x3a26ccc2", // recordLog(string,string,string,string)
      "0x24c244eb", // liquidateAsset(address,address[],uint256[])
      "0xa2119377", // createToken(string,address)
      "0x59cd73f8", // onboardBusQueue(address,uint32,uint256[],((uint256,uint256),(uint256[2],uint256[2]),(uint256,uint256)))
      "0x0c1577f6", // redeemTokenForPurposesAsAdmin(address,uint256,uint256,uint256[],address,string)
      "0x3c7a22cc", // settleLiquidation(address,uint256,uint256)
      "0x2831fff3", // postPrice(int256,uint256)
      "0xe2f72829", // setInviter(address)
      "0x13d79a0b", // settle(address[],uint256[],(uint256,uint256,address,uint256,uint256,uint32,bytes32,uint256,uint256,uint256,bytes)[],(address,uint256,bytes)[][3])
      "0xa638f2e2", // stake(uint256,uint256,uint256)
      "0x1e9a87ce", // mintWithRarity(address,uint256,uint8)
      "0x3fd7beff", // createCollateralContract(string[],address[],bytes32[])
      "0x932b1719", // liquidate(address,uint256,(uint256,uint256,uint256,uint256,bytes))
      "0x7b939232", // depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)
      "0x6c6060c9", // pBatchMintSelectedIds(uint256[],address[],address)
      "0x99ce07c4", // unstake((address,string,uint256,uint256,uint256,uint256),bytes)
      "0x2810e1d6", // resolve()
      "0x4420e486", // register(address)
      "0x03c2924d", // resolveClaim(uint256,uint256)
      "0xe2de2a03", // redeemWithFee(bytes,bytes,bytes,(uint8,bytes32,uint64,uint64,uint64,bytes32,bytes32))
      "0xd26b644a", // batchUpdatePositions(bytes)
      "0x514fcac7", // cancelOrder(uint256)
      "0x31931955", // addRecord(bytes32,bytes32)
      "0xa7c4ba5e", // finalizeMarket(uint256,uint256,address,uint256)
      "0x00000002", // wipeBlockchain_EkJWPe()
      "0x51cff8d9", // withdraw(address)
      "0xdbd89df3", // endMarket(uint256,uint256)
      "0x84d61c97", // receiveRequestV2Signed(bytes,address,bytes)
      "0x0d51f0b7", // createAccount(address,uint256,address[],uint8)
      "0x94adbda7", // unstakeForUser(address,uint256,uint256)
      "0xae28b68c", // safeTransfer(address,uint256,uint256,bytes)
      "0x6b3ec416", // cross((address,address,address,address,address,uint256,uint256,uint256,string,bytes,bytes))
      "0x29a48682", // safeMint(address,(uint256,uint256,address,address,string,uint16,address,uint256,bool,uint16,address),(uint256,address,bytes32[],bytes32[]))
      "0xacc697e5", // createOrder(uint256,uint256,uint256,string,address)
      "0x013054c2", // redeemToken(uint256)
      "0xf1603698", // main(uint256[],((uint256,uint256),(uint256[2],uint256[2]),(uint256,uint256)),uint32,uint96,bytes)
      "0xca93d6c3", // notarize(bytes32,string,address,string)
      "0x71458ee2", // relayCall(address,address,bytes,uint256,bytes)
      "0x48fc01d4", // resolveConditions((uint256,uint128[],uint64)[])
      "0xeda04d81", // invest_stable_coin(address)
      "0xc98bdecc", // createDidV2((string,address,(uint16,string)[]))
      "0x4cd08d03", // register(string,string,string)
      "0x19535a54", // fulfillOrder(uint256,bytes,(uint8,bytes32,bytes32,uint16,bytes32,bytes32,uint64,uint64,uint64,uint64,uint64,uint8,uint8,bytes32),(uint16,bytes32,uint8,bytes32),(bytes32,bytes32,bool),(uint256,uint256,uint8,bytes32,bytes32))
      "0x39255d5b", // callAgreement(address,bytes,bytes)
      "0xffb2c479", // process(uint256)
      "0x4319e825", // checkIn(uint256,uint32,bytes)
      "0x14d287a4", // purchaseSlot(uint256,uint256)
      "0x2700bbaf", // depositWithId(address,uint256,uint256)
      "0xd1058e59", // claimAll()
      "0x711bc67b", // depositWithAuthorization(address,((uint256,address),(address,bytes32,uint256,address,bytes32,uint256,bytes32,uint32,uint32,uint32,bytes),uint256,address,uint256),uint256,uint256,bytes)
      "0x3dc28cf1", // send(address,address,uint256,uint256)
      "0x78af6c4d", // registerDocument(bytes32,string,string)
      "0xde9f7395", // updatePricePerShare(uint256)
      "0xcdd1b25d", // relay(bytes,bytes[],address[],uint256[])
      "0xc9a69562", // makeFlashLoan(address[],uint256[],bytes)
      "0xff70b936", // dispatch(bytes[])
      "0xf9a9d0a7", // issueTEU(address,string,string,address)
      "0x8a11990f", // purchasePackage(uint256,uint256)
      "0x9ea7685a", // registerReferrer(address)
      "0x3ccfd60b", // withdraw()
      "0xe8e3e87b", // withdrawPayouts(address,uint256[])
      "0x70af9a84", // fillPrice(uint256,uint256)
      "0x933139e7", // withdrawMany(address[],address[],uint256[])
      "0xf2881e21", // transfer(address,uint256,address,uint256,uint256)
      "0xc7c7f5b3", // send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address)
      "0x08691d30", // transferToRegisteredWallet(address,uint256,address)
      "0x28f89146", // withdrawDynamic(address,string,uint256,uint256)
      "0x0bb97fbc", // withdrawStatic(address,string,uint256,uint256)
      "0x7af10029", // batchWithdraw(uint64[],bytes32[],(uint64,address,address,uint256,(address,uint256)[])[])
      "0x372500ab", // claimRewards()
      "0xe4a9b20e", // performExtraction(uint256,(address,uint256,bytes),bytes)
      "0xc8f8c6c5", // transferTruther(address,uint256,address)
      "0xff9abefc", // bulkMintTLD(address[],string[])
      "0x7b703a13", // claimLegacyD9AndSweep(uint256[])
      "0x6b942f7c", // resolveQuestion(bytes32)
      "0xb293f97f", // transfer(uint256,uint16,bytes32,bytes32,bool,bytes)
      "0xff75ffaa", // mintTNGD(uint256)
      "0xa5977fbb", // send(address,address,uint256,uint64,uint64,uint32)
      "0x47900508", // claim(uint32,bytes32,uint64,bytes)
      "0x3d0ebf48", // createBattle(address,address)
      "0x0d734324", // execV4(bytes)
      "0xd9caed12", // withdraw(address,address,uint256)
      "0x441a3e70", // withdraw(uint256,uint256)
      "0xea9eebf7", // voteWithSignature(address,uint256,uint8,uint256,uint8,bytes32,bytes32)
      "0xd1eb08be", // rejectBets((uint256,uint256[])[])
      "0x7c8b0744", // purchaseToken(address,uint256,address,uint8)
      "0xed73606a", // makeOffer(address,uint256,uint256,address,uint256)
      "0x4e43e495", // submitCheckpoint(bytes,uint256[3][])
      "0xf5537ede", // transferToken(address,address,uint256)
      "0xdd752e55", // stake(uint8,uint256)
      "0x3e476053", // moveFunds(address,uint256)
      "0x6e553f65", // deposit(uint256,address)
      "0xa11b1198", // metaRoute((bytes,bytes,address[],address,address,uint256,bool,address,bytes))
      "0x0779afe6", // send(address,address,uint256)
      "0x7fb7c1df", // createSmartWallet(bytes32,address)
      "0xf497df75", // fillOrderArgs((uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),bytes32,bytes32,uint256,uint256,bytes)
      "0x56214ed4", // stakeEFI(uint8)
      "0xb88d4fde", // safeTransferFrom(address,address,uint256,bytes)
      "0x63185c42", // mint(address,address,address)
      "0x815af908", // acceptTerms()
      "0x20265830", // liquidateAsset(string[],address[][])
      "0xf9e4bab4", // transferAndMulticall(address[],uint256[],(address,bool,uint256,bytes)[],address,address,bytes)
      "0x89a86ad3", // open(address,uint256,uint256)
      "0xbe6002c2", // exec(address,bytes)
      "0x03c1cb97", // leverageDeposit((address,address,address,uint256,uint256,uint256,uint256),bytes,bytes,(address,address,uint256,uint256),(uint256,uint256,uint256,uint256,bytes))
      "0x3ef13367", // flushTokens(address)
      "0x13b2f75c", // createForwarder(address,address,bytes32)
      "0x205c2878", // withdrawTo(address,uint256)
      "0xe63d38ed", // disperseEther(address[],uint256[])
      "0xe47dd571", // withdrawProfit(uint256,uint256,bytes)
      "0xe84d2014", // stake(uint8,uint256,uint256,address)
      "0x2b67b570", // permit(address,((address,uint160,uint48,uint48),address,uint256),bytes)
      "0xa22cb465", // setApprovalForAll(address,bool)
      "0x348011ae", // publishStatements(string[],string[],uint256[],address[],uint256[])
      "0x64350ffd", // claimFor(address,uint256,uint256,bytes32[],uint8,bytes32,bytes32)
      "0xd00ba30b", // KingOfBsc(int8,bytes8,bytes8,bytes5,bytes16,int128,bytes32,bytes14)
      "0x9c66c25d", // withdrawV2(address,address,uint256)
      "0xd77a2748", // mining(uint256,address,uint256)
      "0x791e6629", // brlaToUsd(address,uint256,uint256,uint256,address,address,address)
      "0x272ca482", // batchMint(address,uint256[],string[],uint256)
      "0x5f3bd1c8", // snwap(address,uint256,address,address,uint256,address,bytes)
      "0xdeb36e32", // startVesting()
      "0xedcc1c1e", // invest(uint256,uint256,uint256,bytes)
      "0xb4e9bf88", // rebalance(address,int24,int24,int24,int24,address,uint256[4],uint256[4])
      "0x7c26640c", // golemTransferDirectPacked(bytes32[])
      "0x73845cfa", // setLocked(address,uint256)
      "0xa1291f7f", // ownerTransfer(address,address,uint256)
      "0xea87152b", // register(string,uint256)
      "0x8d3ccf9f", // bridge(bytes32,uint32,bytes32,uint256)
      "0x466cecb5", // settleAndTransfer(address,bytes32,int256,uint256,address,bool)
      "0xa1884d2c", // createProxy(address,uint256,address,(uint8,bytes32,bytes32))
      "0x8c3e5945", // fulfillWithERC20(address,uint256,address,address,bytes,address,(bytes,(uint8,bytes32,bytes32,uint16,bytes32,bytes32,uint64,uint64,uint64,uint64,uint64,uint8,uint8,bytes32),(uint16,bytes32,uint8,bytes32),(bytes32,bytes32,bool)),bytes32,(uint256,uint256,uint8,bytes32,bytes32))
      "0x968763a0", // registerWithReferrer(address)
      "0x6143a1ff", // bet(uint256,bool,uint256,uint256,address)
      "0x47e7ef24", // deposit(address,uint256)
      "0x7c39d130", // process(bytes,bytes)
      "0x2da03409", // flushForwarderTokens(address,address)
      "0xfb90b320", // createForwarder(address,bytes32)
      "0xf7f30834", // transfer(uint256,(uint8,address,address,uint256,uint256)[])
      "0xa1305b17", // relayCall(address,address,bytes,uint256,bytes,uint256,address,bytes)
      "0xc0722f37", // withdrawls(address[],uint256[])
      "0x585ab12c", // registionExit(address)
      "0x5f377433", // depositTokenWithNote(address,uint256,string)
      "0xd204c45e", // safeMint(address,string)
      "0x2eb375ea", // claimInterest(uint256)
      "0xead41243", // prepareQuestion(bytes32,bytes,bytes32)
      "0xde5e0b9a", // commit(bytes32[2],bytes,bytes32[],bytes32[],bytes32)
      "0xf3c91c83", // closeMarket(bytes32,uint32)
      "0xfad99f98", // claimCommission()
      "0x81c23eca", // claim_ex(uint256,bytes)
      "0xd9e7c316", // withdraw(uint128,address,address,uint128,bytes)
      "0x185d1646", // initialize(bytes,address,uint256,uint256,uint256)
      "0x28ffe6c8", // join(address)
      "0xddc63262", // harvest(uint256)
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
    if (!this.knownPools.has(decoded.poolAddress)) {
      this.logger.debug({ pool: decoded.poolAddress, selector }, "mempool: dynamically learned decoded pool");
      this.knownPools.add(decoded.poolAddress);
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
