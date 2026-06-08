import type { Address } from "../../core/types/common.ts";

// DEX swap function selectors only.
// Non-swap selectors (Polymarket, ClaimInterest, Governance, etc.) are filtered
// before this map is consulted — see IGNORED_SELECTORS in service.ts.
export const SELECTORS: Record<string, string> = {
  "0x5d807adc": "OTHER", // trade(address,string,address,uint256,address,uint256,bool,bytes)
  "0x27ebdc85": "OTHER", // swapToUSDBW(uint256)
  "0x4cd480bd": "OTHER", // swapAndBridge(bytes32,uint256,bytes32,uint256,bytes32,uint256,uint8,uint256)
  "0xf479a080": "OTHER", // executeMetaTransactionSwap((address,bytes,uint256,address,bool,address,uint256,uint256,uint256),bytes)
  "0x75d2bf60": "OTHER", // executeDraw(uint256)
  "0x9be111d1": "OTHER", // swapAndExecute(((uint8,(uint256,uint256,uint256,address,address,uint8,address,bytes)),address,address,address,uint256,bytes,bytes32),(bytes4,bytes4,uint256,uint256,uint256,(address,address,uint256)[]),bytes)
  "0x8803dbee": "OTHER", // swapTokensForExactTokens(uint256,uint256,address[],address,uint256)
  "0x560f6dbb": "OTHER", // executeTrade((bytes4,uint256,(bytes4,uint256,uint256,address,uint256[],(address,address,uint256[],uint256,bytes4)[],bytes[],(address,address,uint256,uint256,uint256,bytes32),bytes),(bytes4,uint256,uint256,address,(address,address,uint256[],uint256,bytes4)[],bytes[],(address,address,uint256,uint256,uint256,bytes32),bytes),bytes,bytes),bytes)
  "0xb9ea2f4b": "OTHER", // swapExactInputMultihop(uint24,address,uint24,address,uint24,address)
  "0x49650044": "OTHER", // execute((uint8,bytes)[])
  "0x83d13e01": "OTHER", // execute(((address,uint256,uint8),(uint8,bytes)),(address,uint256),(uint8,(uint256,address),(uint256,address),address,address,bytes),(uint256,bytes),(uint256,bytes))
  "0x6e1537da": "OTHER", // swapAndBridge(bytes32,address,address,uint256,bytes,bytes,bytes,bytes)
  "0x4bbf3a7a": "OTHER", // swapToken(uint256)
  "0x37c6145a": "OTHER", // executeController((uint32,bytes))
  "0x3d3d7e90": "OTHER", // executeBatch2(address[],bytes[],address,address,uint256,uint256,bytes)
  "0x490c2f86": "OTHER", // execute((uint256,bool,uint256,bytes,uint256,uint256,uint256,uint256,uint256,uint64))
  "0xa6d0ad61": "OTHER", // execute((bytes,address,uint256)[])
  "0x3110c7b9": "OTHER", // swapAndStartBridgeTokensViaNEARIntents((bytes32,string,string,address,address,address,uint256,uint256,bool,bool),(address,address,address,address,uint256,bytes,bool)[],(bytes32,address,bytes32,uint256,uint256,address,bytes))
  "0x9d9892cd": "OTHER", // swap(uint256,uint256,uint256)
  "0xbb7914a3": "OTHER", // buySPOL(uint256)
  "0xd2384e41": "OTHER", // buyMatrixFromUser()
  "0x6c11bcd3": "OTHER", // sellTokens(uint256)
  "0x0640975d": "OTHER", // buy((uint256,uint256,address,address))
  "0x8627df46": "OTHER", // buyTickets(uint256,uint256)
  "0xd6febde8": "OTHER", // buy(uint256,uint256)
  "0x1a98b2e0": "OTHER", // executeWithToken(bytes32,string,string,bytes,string,uint256)
  "0x09c5eabe": "OTHER", // execute(bytes)
  "0xe4a974cc": "OTHER", // expressExecuteWithToken(bytes32,string,string,bytes,string,uint256)
  "0x5e94e28d": "OTHER", // swapExactAmountOutOnUniswapV3((address,address,uint256,uint256,uint256,bytes32,address,bytes),uint256,bytes)
  "0x264849e7": "OTHER", // simpleExecuteSwap(uint256)
  "0x0cd00a76": "OTHER", // executeOnce()
  "0x65cc2c19": "OTHER", // trade(string,uint256,string,uint256)
  "0x82225b83": "OTHER", // sellStep(uint256)
  "0x736eac0b": "OTHER", // swapTokensMultipleV3NativeToERC20(bytes32,string,string,address,uint256,(address,address,address,address,uint256,bytes,bool)[])
  "0x41f85ee8": "OTHER", // createSellOrderFor(address,address,uint256,uint256)
  "0x90411a32": "OTHER", // swap(address,(address,address,address,address,uint256,uint256,uint256,uint256,address,bytes),(uint256,uint256,uint256,bytes)[])
  "0x4c2e5f7b": "OTHER", // swapUSDForTokens(uint256)
  "0x18e3ab4d": "OTHER", // sellStep(uint256,uint256)
  "0x259f28fb": "OTHER", // swapEFIToPOL(uint256)
  "0xfa0ef397": "OTHER", // buyStepPublic(uint256,uint256)
  "0xedacb144": "OTHER", // swapTNGDForUSDT(uint256)
  "0xd96073cf": "OTHER", // swap(uint256,uint256)
  "0xbda031ba": "OTHER", // buyAutoURI(uint256,uint256,address)
  "0xfd3ad6d4": "OTHER", // executeMetaTxn((address,address,uint256),bytes[],bytes32,address,bytes)
  "0x5b95db40": "OTHER", // swapEFIToDAI(uint256)
  "0x7765b9f0": "OTHER", // buyStock((address,uint256,address,uint256,string,uint256,uint256,bytes))
  "0xd8ed1acc": "OTHER", // executeMetaTransaction(address,bytes,bytes)
  "0x164ac2a8": "OTHER", // executeArbitrage(address,uint256,(uint8,address,address,uint24,uint256)[])
  "0x01617fab": "OTHER", // swapWrap(uint256,uint256)
  "0x5bfcc4f8": "OTHER", // openTrade((address,uint32,uint16,uint24,bool,bool,uint8,uint8,uint120,uint64,uint64,uint64,bool,uint160,uint24),uint16,address)
  "0x4d6d5089": "OTHER", // swapV3(address,address,address,uint24,address,uint256,uint256,uint256)
  "0xf082b423": "OTHER", // buyNft(address,(address,uint256,uint256,uint256,string)[])
  "0xe6c806ff": "OTHER", // acrossSwapAndBridge((address,address,address,uint256,uint256,uint256,uint256,address,uint256,bool,uint16,string),(address,address,address,address,bool,uint256,bytes)[],(address,address,address,address,uint32,uint32,address,uint256,uint256,uint32,bytes))
  "0x6a2424b9": "OTHER", // swapSlash(uint,uint)
  "0xdf905caf": "OTHER", // execute((address,address,uint256,uint256,uint48,bytes,bytes))
  "0x2fa11647": "OTHER", // externalSwap(address,address,address,address,uint256,uint256,uint256,bytes,bytes,uint256)
  "0x0c53c51c": "OTHER", // executeMetaTransaction(address,bytes,bytes32,bytes32,uint8)
  "0x61461954": "OTHER", // execute()
  "0x9d83fd7f": "OTHER", // executeMulticallWithAgentAllowance(address,address[],uint256[],bytes[],uint8[],bytes,bytes)
  "0x53da6f01": "OTHER", // buyNFT(address,uint256,uint256)
  "0x46ec278a": "OTHER", // swapWithBackendSignature(bytes)
  "0x97514d90": "OTHER", // sellOrder(uint256)
  "0xba61557d": "OTHER", // executeWithSig(((address,uint256,bytes)[],bytes32),bytes)
  "0xfa74fd43": "OTHER", // swapAndForwardEth(uint256,address,bytes,address,uint256,address,bytes)
  "0x4d8160ba": "OTHER", // strictlySwapAndCall(address,uint256,bytes,address,bytes,address,uint256,address,address,bytes)
  "0x110560ad": "OTHER", // swapAndBridge(((uint256,address),(address,bytes32,uint256,address,bytes32,uint256,bytes32,uint32,uint32,uint32,bytes),address,address,uint8,uint256,uint256,bytes,bool,address,uint256))
  "0xc8173c44": "OTHER", // directExecuteSwap(uint256,bytes32,bytes32,address,address)
  "0x5a2c71cd": "OTHER", // executeBridge((address,address,uint256,bytes,bool,address,uint256))
  "0x6bcae0ff": "OTHER", // createSellOrder(string,string,uint256,uint256)
  "0xf3294c13": "OTHER", // Execute(address)
  "0x1a46e42a": "OTHER", // cancelSellOrder(uint256)
  "0x2090d831": "OTHER", // swapWithData(address,address,uint256,uint256,uint256,address,(address,uint256,bytes)[],bytes)
  "0x18cbafe5": "OTHER", // swapExactTokensForETH(uint256,uint256,address[],address,uint256)
  "0x7a9a1628": "OTHER", // execute((bool,bool,uint256,address,uint256,bytes)[],uint256,bytes)
  "0x780c82ab": "OTHER", // swapAndStartBridgeTokensViaPolymerCCTP((bytes32,string,string,address,address,address,uint256,uint256,bool,bool),(address,address,address,address,uint256,bytes,bool)[],(uint256,uint256,bytes32,bytes32,uint32))
  "0x945bcec9": "OTHER", // batchSwap(uint8,(bytes32,uint256,uint256,uint256,bytes)[],address[],(address,bool,address,bool),int256[],uint256)
  "0x12aa3caf": "OTHER", // swap(address,(address,address,address,address,uint256,uint256,uint256),bytes,bytes)
  "0x27bea2c6": "OTHER", // executeBatchAndSkipFailures((address,uint256,bytes)[])
  "0xa6f2ae3a": "OTHER", // buy()
  "0x4666fc80": "OTHER", // swapTokensSingleV3ERC20ToERC20(bytes32,string,string,address,uint256,(address,address,address,address,uint256,bytes,bool))
  "0xaf7060fd": "OTHER", // swapTokensSingleV3NativeToERC20(bytes32,string,string,address,uint256,(address,address,address,address,uint256,bytes,bool))
  "0xc04b8d59": "OTHER", // exactInput((bytes,address,uint256,uint256,uint256))
  "0x2554a14c": "OTHER", // wrapAndSwapV2((bytes4,bytes,bytes,bytes4,uint256,bytes,uint256),bytes,address[])
  "0x489f9902": "OTHER", // execute((bytes,bytes),(address,bytes)[],uint256)
  "0x99bbc6dc": "OTHER", // executeTransactionLUW((bytes32,address,uint256,bytes,bytes),bytes)
  "0x2c57e884": "OTHER", // swapTokensMultipleV3ERC20ToNative(bytes32,string,string,address,uint256,(address,address,address,address,uint256,bytes,bool)[])
  "0x47153f82": "OTHER", // execute((address,address,uint256,uint256,uint256,bytes),bytes)
  "0xc7a76969": "OTHER", // strictlySwapAndCallDln(address,uint256,bytes,(address,bytes,address,uint256,address),address,bytes,bytes32)
  "0x571d3dc7": "OTHER", // execute((address,uint256,bytes)[],bytes32)
  "0xaa27981d": "OTHER", // executeAllocate(address,(uint8,address,address,uint256,uint256)[],address,uint64,bytes,bytes,bytes)
  "0x2298207a": "OTHER", // simpleBuy((address,address,uint256,uint256,uint256,address[],bytes,uint256[],uint256[],address,address,uint256,bytes,uint256,bytes16))
  "0x8393dc7f": "OTHER", // BUY(uint256,uint256,uint32)
  "0xe6daaf9c": "OTHER", // execute((uint256,bool,uint256,uint256))
  "0x649932dd": "OTHER", // swapExactEPForFBX(uint256,uint256,uint256)
  "0x1794958f": "OTHER", // swapAndStartBridgeTokensViaAcrossV4((bytes32,string,string,address,address,address,uint256,uint256,bool,bool),(address,address,address,address,uint256,bytes,bool)[],(bytes32,bytes32,bytes32,bytes32,uint256,uint128,bytes32,uint32,uint32,uint32,bytes))
  "0xceb757d5": "OTHER", // swapExactTokensForTokens(uint256,uint256,address[],address[],address,uint256)
  "0x3bf30f85": "OTHER", // execute(address[],bytes)
  "0xb8815477": "OTHER", // unxswapToWithBaseRequest(uint256,address,(uint256,address,uint256,uint256,uint256),bytes32[])
  "0xf5dfac71": "OTHER", // xExecute(address,address,uint256,bytes)
  "0xb2dd7292": "OTHER", // buyPackageUnified(address,uint256)
  "0xb5604fa7": "OTHER", // swapExactOutputSingle(address,address,uint24,uint256,uint256,address,address,bool)
  "0xa6886da9": "OTHER", // directUniV3Swap((address,address,address,uint256,uint256,uint256,uint256,uint256,address,bool,address,bytes,bytes,bytes16))
  "0xe9b6fb0e": "OTHER", // authorizeAndExecute(bytes,bytes,(address,address,uint256),(address,address,uint256,bytes))
  "0x876a02f6": "OTHER", // swapExactAmountInOnUniswapV3((address,address,uint256,uint256,uint256,bytes32,address,bytes),uint256,bytes)
  "0x54e3f31b": "OTHER", // simpleSwap((address,address,uint256,uint256,uint256,address[],bytes,uint256[],uint256[],address,address,uint256,bytes,uint256,bytes16))
  "0x9a249c41": "OTHER", // defiSwap(address,(address,address,address,address,address,uint256,bytes,bytes))
  "0x30c48952": "OTHER", // swapAndStartBridgeTokensViaMayan((bytes32,string,string,address,address,address,uint256,uint256,bool,bool),(address,address,address,address,uint256,bytes,bool)[],(bytes32,address,bytes))
  "0xdad7ef1c": "OTHER", // SELL(uint256,uint256)
  "0x0c307f76": "OTHER", // dagSwapTo(uint256,address,(uint256,address,uint256,uint256,uint256),(address[],address[],uint256[],bytes[],uint256)[])
  "0xe32bbc9e": "OTHER", // execute((uint8,uint8,address,uint256,uint128,address,uint256,uint256,bytes,uint256,uint256,bytes,uint256,uint256,uint256,uint64,uint64,uint64,int24,int24,bool,uint256,uint256,bytes,bytes))
  "0x6234d42b": "OTHER", // executeTransaction(((address,uint256,bytes),(address,uint256,uint256,uint256,uint256,address),uint256),bytes,bool,address)
  "0x60d09476": "OTHER", // cctpSwapAndBridge((address,address,address,uint256,uint256,uint256,uint256,address,uint256,bool,uint16,string),(address,address,address,address,bool,uint256,bytes)[],(uint32,bytes32,uint256))
  "0x1fff991f": "OTHER", // execute((address,address,uint256),bytes[],bytes32)
  "0x415baf97": "OTHER", // buyWeek1(uint256,uint256,uint256)
  "0x46c67b6d": "OTHER", // megaSwap((address,uint256,uint256,uint256,address,(uint256,(address,uint256,(address,uint256,uint256,(uint256,address,uint256,bytes,uint256)[])[])[])[],address,uint256,bytes,uint256,bytes16))
  "0x606326ff": "OTHER", // swapAndStartBridgeTokensViaGasZip((bytes32,string,string,address,address,address,uint256,uint256,bool,bool),(address,address,address,address,uint256,bytes,bool)[],(bytes32,uint256))
  "0x9ddf93bb": "OTHER", // swap(address,string,string,uint256,uint256)
  "0x8afe7f85": "OTHER", // executeBestTradeMultiplePairs(address[],address[],uint256,address[],uint256[],uint256[],uint256[],uint256[],uint256[],uint256[],uint256,uint256,int256)
  "0xfcfbd33a": "OTHER", // executeWithValidator((address,uint256,bytes)[],address,bytes)
  "0x1725dc9b": "OTHER", // executeSwap((address,address,address,uint256,uint256,bytes,bool,address,uint256),(address,uint256,bytes)[])
  "0x83bd37f9": "OTHER", // swapCompact()
  "0x143ca9b0": "OTHER", // execute((address,uint256,bytes)[],uint256,bytes)
  "0xf3e6ea8a": "OTHER", // swap(address,uint256,uint256,address)
  "0x6a241f0a": "OTHER", // swapPari2Leva(address,uint256,uint256)
  "0xb80886ac": "OTHER", // executeContract(address,bytes,uint256)
  "0x6171d1c9": "OTHER", // execute((address,uint256,bytes)[],bytes)
  "0xbc651188": "OTHER", // exactInputSingle((address,address,address,uint256,uint256,uint256,uint160))
  "0xd85ca173": "OTHER", // swapExactAmountInOnBalancerV2((uint256,uint256,uint256,bytes32,uint256),uint256,bytes,bytes)
  "0xdb5c7e88": "OTHER", // execute(address,bytes32,bytes,uint256,uint256,bytes)
  "0x17567b42": "OTHER", // SwapExactTokenForETH(uint256,uint256,address,address,bytes,uint256)
  "0xcfb7b66d": "OTHER", // swapExactInputSingle(address,address,uint24,uint256,uint256,address,uint256)
  "0x2894adf9": "OTHER", // execute(address,address,uint256,bytes,bytes[],uint256)
  "0x627dd56a": "OTHER", // swap(bytes)
  "0xe21fd0e9": "OTHER", // swap((address,address,bytes,(address,address,address[],uint256[],address[],uint256[],address,uint256,uint256,uint256,bytes),bytes))
  "0xc3192f1f": "OTHER", // SwapExactETHForToken(uint256,uint256,address,address,bytes,uint256)
  "0x07ed2379": "OTHER", // swap(address,(address,address,address,address,uint256,uint256,uint256),bytes)
  "0xb9b5149b": "OTHER", // exactInputV3Swap((address,address,address,address,uint256,uint256,uint256,uint256,uint256[],bytes,string))
  "0x84124b2d": "OTHER", // FreeBetLiveTradeRequested(address,uint,bytes32)
  "0x2d9fb478": "OTHER", // execute(((address,bytes,uint256,bool)[],uint256,uint256),bytes)
  "0x94b918de": "OTHER", // swap(uint256)
  "0xf7b5c341": "OTHER", // deployAndExecute(address,address,string,((address,bytes,uint256,bool,uint16,address)[],uint256,uint256),bytes)
  "0x5f575529": "OTHER", // swap(string,address,uint256,bytes)
  "0xe45be251": "OTHER", // executeBatchAndEnsureBalance((address,bytes,uint256)[],bool)
  "0xcfc32570": "OTHER", // execute302((address,(uint32,bytes32,uint64),bytes32,bytes,bytes,uint256))
  "0x30dedc57": "OTHER", // swapAndForwardERC20(address,uint256,(uint256,uint256,uint8,bytes32,bytes32),address,bytes,address,uint256,address,bytes)
  "0x0dc4bdae": "OTHER", // exactInputV2Swap((address,address,uint256,uint256,uint256,uint256,address[],address[],bytes,string),uint256)
  "0xa94e78ef": "OTHER", // multiSwap((address,uint256,uint256,uint256,address,(address,uint256,(address,uint256,uint256,(uint256,address,uint256,bytes,uint256)[])[])[],address,uint256,bytes,uint256,bytes16))
  "0x5fd9ae2e": "OTHER", // swapTokensMultipleV3ERC20ToERC20(bytes32,string,string,address,uint256,(address,address,address,address,uint256,bytes,bool)[])
  "0xb0bbcd88": "OTHER", // swap(uint256,uint256,address[],address,uint256,bool)
  "0xb143044b": "OTHER", // execute((uint32,address,bytes,uint256,bytes)[])
  "0x414bf389": "OTHER", // exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
  "0xa618ec1a": "OTHER", // SwapV2()
  "0xd3e2885c": "OTHER", // SwapExactTokenForToken(uint256,uint256,address,address,address,bytes,uint256)
  "0x7ff36ab5": "OTHER", // swapExactETHForTokens(uint256,address[],address,uint256)
  "0xe4849b32": "OTHER", // sell(uint256)
  "0xe3ead59e": "OTHER", // swapExactAmountIn(address,(address,address,uint256,uint256,uint256,bytes32,address),uint256,bytes,bytes)
  "0x9871efa4": "OTHER", // unxswapByOrderId(uint256,uint256,uint256,bytes32[])
  "0x1679c792": "OTHER", // exactInputSingle((address,address,address,address,uint256,uint256,uint256,uint160))
  "0xdb3e2198": "OTHER", // exactOutputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
  "0x14d08fca": "OTHER", // onChainSwaps((address,address,address,uint256,uint256,uint256,uint256,address,uint256,bool,uint16,string),(address,address,address,address,bool,uint256,bytes)[],address)
  "0x34fcd5be": "OTHER", // executeBatch((address,uint256,bytes)[])
  "0xde2980fc": "OTHER", // execute3((bytes,address,bool)[],address,address)
  "0x24856bc3": "OTHER", // execute(bytes,bytes[])
  "0x2e931c2e": "OTHER", // SwapV4()
  "0xd96a094a": "OTHER", // buy(uint256)
  "0x023e8d84": "OTHER", // batchExecute((uint8,address,uint256,bytes)[])
  "0x1cff79cd": "OTHER", // execute(address,bytes)
  "0x785e8275": "OTHER", // swapViaKyberGuarded(bytes,(address,uint256)[],uint256,address,uint256)
  "0x9aefaff8": "OTHER", // execute(address,address,uint256,bytes)
  "0xb41ce860": "OTHER", // executeOnce(uint256,uint256)
  "0xfd66ae06": "OTHER", // SwapV3()
  "0xe9ae5c53": "OTHER", // execute(bytes32,bytes)
  "0x3f707e6b": "OTHER", // execute((address,uint256,bytes)[])
  "0x04e45aaf": "OTHER", // exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
  "0xf2c42696": "OTHER", // dagSwapByOrderId(uint256,(uint256,address,uint256,uint256,uint256),(address[],address[],uint256[],bytes[],uint256)[])
  "0x3593564c": "OTHER", // execute(bytes,bytes[],uint256)
  "0xc320682c": "OTHER", // executeTrade((bytes4,uint256,(bytes4,uint256,uint256,uint256,(address,address,uint256,uint256,uint256,bytes32),bytes),(bytes4,uint256,uint256,(address,address,uint256,uint256,bytes4),bytes),bytes,bytes),bytes)
  "0xb61d27f6": "OTHER", // execute(address,uint256,bytes)
  "0x38ed1739": "OTHER", // swapExactTokensForTokens(uint256,uint256,address[],address,uint256)
  "0x022c0d9f": "UNISWAP_V2", // swap(uint256,uint256,address,bytes)
  "0x128acb08": "UNISWAP_V3", // swap(address,bool,int256,uint160,bytes)
  "0x52bbbe29": "BALANCER_V2", // swap((bytes32,uint8,address,address,uint256,bytes),...,uint256)
  "0x3df02124": "CURVE_STABLE", // exchange(int128,int128,uint256,uint256)
  "0x5b41b908": "CURVE_CRYPTO", // exchange(uint256,uint256,uint256,uint256)
  "0x5c0c4997": "DODO_V2", // sellBase(address,uint256,uint256,bytes)
  "0x6b5a7b77": "DODO_V2", // sellQuote(address,uint256,uint256,bytes)
  "0x9ba7e8a9": "WOOFI", // swap(address,uint256,uint256,address,address)
  "0x3b358e1b": "KYBERSWAP_ELASTIC", // swap(address,address,uint256,bytes)
  "0x6c70970e": "UNISWAP_V4", // swap((address,address,uint24,int24,address),bool,int128,uint160,bytes)
  "0x01b7037c": "OTHER",
  "0xa00597a0": "OTHER",
  "0x5c11d795": "UNISWAP_V2_ROUTER", // swapExactTokensForTokensSupportingFeeOnTransferTokens
};

export interface DecodedSwap {
  protocol: string;
  poolAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  zeroForOne?: boolean;
}

/**
 * Decode a transaction's input data to identify a swap.
 * Returns null if the input doesn't match a known swap selector.
 */
export function decodeSwapCalldata(to: Address, input: string, knownPools: Set<string>): DecodedSwap | null {
  if (!input || input.length < 10) return null;
  const selector = input.slice(0, 10).toLowerCase();
  const protocol = SELECTORS[selector];
  if (!protocol) {
    console.debug(`mempool: ignored tx (unknown selector: ${selector})`);
    return null;
  }

  const lcTo = to.toLowerCase();
  let targetPool: string = lcTo;
  let isKnown = knownPools.has(lcTo);
  if (!isKnown) {
    const extracted = extractEncodedAddresses(input);
    const hit = extracted.find((a) => knownPools.has(a));
    if (hit) {
      isKnown = true;
      targetPool = hit;
    }
  }
  if (!isKnown) {
    console.debug(`mempool: ignored tx (unknown pool: ${lcTo})`);
    return null;
  }

  const poolAddress = targetPool as Address;
  const isDirect = lcTo === targetPool; // protocol-specific fixed-offset parses only valid for direct-to-pool calls

  // V2 swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data) -- direct to pair
  if (protocol === "UNISWAP_V2") {
    if (isDirect) {
      const amount0Out = BigInt("0x" + input.slice(10, 74));
      const amount1Out = BigInt("0x" + input.slice(74, 138));
      if (amount0Out > 0n) {
        return { protocol, poolAddress, tokenIn: "" as Address, tokenOut: "" as Address, amountIn: amount0Out, zeroForOne: false };
      }
      return { protocol, poolAddress, tokenIn: "" as Address, tokenOut: "" as Address, amountIn: amount1Out, zeroForOne: true };
    }
    // indirect V2: fallthrough to generic
  }

  if (protocol === "UNISWAP_V3" && isDirect) {
    // swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes data)
    let amountSpecified = 0n;
    if (input.length >= 10 + 192) {
      try {
        amountSpecified = BigInt("0x" + input.slice(10 + 128, 10 + 192));
      } catch {}
    }
    const size = amountSpecified < 0n ? -amountSpecified : amountSpecified;
    let zeroForOne: boolean | undefined;
    if (input.length >= 10 + 128) {
      try {
        const zfoWord = BigInt("0x" + input.slice(10 + 64, 10 + 128));
        zeroForOne = zfoWord !== 0n;
      } catch {}
    }
    return { protocol, poolAddress, tokenIn: "" as Address, tokenOut: "" as Address, amountIn: size || 1n, zeroForOne };
  }

  // Generic for BALANCER_V2, CURVE_*, DODO_V2, WOOFI, KYBERSWAP_ELASTIC, and indirect V2/V3.
  // Improved heuristic: The amount is likely to be a large value, but we need to avoid picking up
  // pool addresses or other large constants. Look for values in the calldata that
  // are likely to be amounts based on typical swap sizes.
  let amountIn = 0n;
  const dataHex = input.slice(10);
  for (let j = 0; j + 64 <= dataHex.length; j += 64) {
    const w = dataHex.slice(j, j + 64);
    try {
      const v = BigInt("0x" + w);
      // Heuristic: swap amounts are typically smaller than addresses (160 bits)
      // but large enough to be a meaningful swap (e.g., > 10^12 wei).
      if (v > 10n ** 12n && v < 1n << 160n) {
        // If we find multiple, we might want the most reasonable one.
        // For now, take the largest valid one as it's likely the amountSpecified.
        if (v > amountIn) {
          amountIn = v;
        }
      }
    } catch {}
  }
  if (amountIn === 0n) amountIn = 1n;
  return { protocol, poolAddress, tokenIn: "" as Address, tokenOut: "" as Address, amountIn };
}

/**
 * Extract all addresses from a transaction's input data.
 * Used for pool indexing — any address in the input might be a pool or token.
 */
export function extractEncodedAddresses(input: string): string[] {
  const addrs: string[] = [];
  if (!input || input.length < 42) return addrs;
  // EVM word-aligned address extraction:
  // The method selector is 4 bytes (8 hex characters) after "0x" (prefix).
  // So the first word starts at index 10.
  // Each subsequent word starts at 10 + k * 64.
  // Addresses are right-aligned (padded with 12 bytes = 24 hex characters on the left).
  // So they occupy the last 40 hex characters of the 64 hex character word.
  // This corresponds to range: [10 + k * 64 + 24, 10 + k * 64 + 64].
  for (let i = 10; i + 64 <= input.length; i += 64) {
    const chunk = "0x" + input.slice(i + 24, i + 64);
    if (chunk.length === 42) {
      addrs.push(chunk.toLowerCase());
    }
  }
  return addrs;
}
