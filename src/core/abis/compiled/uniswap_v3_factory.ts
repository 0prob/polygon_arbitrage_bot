export const UNISWAP_V3_FACTORY_ABI = [
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "token0",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "token1",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "uint24",
        "name": "fee",
        "type": "uint24"
      },
      {
        "indexed": false,
        "internalType": "int24",
        "name": "tickSpacing",
        "type": "int24"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "pool",
        "type": "address"
      }
    ],
    "name": "PoolCreated",
    "type": "event"
  },
  {
    "type": "function",
    "name": "getPool",
    "inputs": [
      {
        "name": "tokenA",
        "type": "address"
      },
      {
        "name": "tokenB",
        "type": "address"
      },
      {
        "name": "fee",
        "type": "uint24"
      }
    ],
    "outputs": [
      {
        "name": "pool",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  }
] as const;
