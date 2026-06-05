import { createPublicClient, http } from 'viem';
import { polygon } from 'viem/chains';

const rpcUrl = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
const client = createPublicClient({ chain: polygon, transport: http(rpcUrl) });

async function main() {
  const poolQuickswap = '0xa7ff0a0fe10a0cf1c0dd6c1f87a877a6b44773c4'; // QuickSwap V3 WMATIC/USDC 0.05%

  const slot0Abi = { inputs: [], name: 'slot0', outputs: [
    { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
    { name: 'observationIndex', type: 'uint16' }, { name: 'observationCardinality', type: 'uint16' },
    { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'feeProtocol', type: 'uint8' },
    { name: 'unlocked', type: 'bool' }], stateMutability: 'view', type: 'function' };
  const liquidityAbi = { inputs: [], name: 'liquidity', outputs: [{ name: '', type: 'uint128' }], stateMutability: 'view', type: 'function' };

  const [slot0, liquidity] = await Promise.all([
    client.readContract({ address: poolQuickswap, abi: [slot0Abi], functionName: 'slot0' }),
    client.readContract({ address: poolQuickswap, abi: [liquidityAbi], functionName: 'liquidity' }),
  ]);

  console.log('QuickSwap V3 WMATIC/USDC 0.05%');
  console.log('sqrtPriceX96:', slot0[0].toString());
  console.log('tick:', slot0[1]);
  console.log('liquidity:', liquidity.toString());

  // capacity = liquidity / 1e12
  const capacity = liquidity / 1000000000000n;
  console.log('capacity:', capacity.toString());
  const low = capacity / 5000n;
  const high = capacity / 10n;
  const floor = high / 100n;
  const finalLow = low > floor ? low : floor;
  console.log('low:', low.toString(), 'floor:', floor.toString(), 'finalLow:', finalLow.toString());
  console.log('high:', high.toString());
}

main().catch(e => console.error(e));
