export const BALANCER_VAULT_ABI = [
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "name": "poolId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "name": "poolAddress",
        "type": "address"
      },
      {
        "indexed": false,
        "name": "specialization",
        "type": "uint8"
      }
    ],
    "name": "PoolRegistered",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "name": "poolId",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "name": "tokens",
        "type": "address[]"
      },
      {
        "indexed": false,
        "name": "assetManagers",
        "type": "address[]"
      }
    ],
    "name": "TokensRegistered",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "name": "poolId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "name": "liquidityProvider",
        "type": "address"
      },
      {
        "indexed": false,
        "name": "tokens",
        "type": "address[]"
      },
      {
        "indexed": false,
        "name": "amounts",
        "type": "int256[]"
      },
      {
        "indexed": false,
        "name": "paidProtocolSwapFeeAmounts",
        "type": "uint256[]"
      }
    ],
    "name": "PoolBalanceChanged",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "name": "poolId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "name": "tokenIn",
        "type": "address"
      },
      {
        "indexed": true,
        "name": "tokenOut",
        "type": "address"
      },
      {
        "indexed": false,
        "name": "amountIn",
        "type": "uint256"
      },
      {
        "indexed": false,
        "name": "amountOut",
        "type": "uint256"
      }
    ],
    "name": "Swap",
    "type": "event"
  },
  {
    "type": "function",
    "name": "swap",
    "inputs": [
      {
        "name": "singleSwap",
        "type": "tuple",
        "components": [
          {
            "name": "poolId",
            "type": "bytes32"
          },
          {
            "name": "kind",
            "type": "uint8"
          },
          {
            "name": "assetIn",
            "type": "address"
          },
          {
            "name": "assetOut",
            "type": "address"
          },
          {
            "name": "amount",
            "type": "uint256"
          },
          {
            "name": "userData",
            "type": "bytes"
          }
        ]
      },
      {
        "name": "funds",
        "type": "tuple",
        "components": [
          {
            "name": "sender",
            "type": "address"
          },
          {
            "name": "fromInternalBalance",
            "type": "bool"
          },
          {
            "name": "recipient",
            "type": "address"
          },
          {
            "name": "toInternalBalance",
            "type": "bool"
          }
        ]
      },
      {
        "name": "limit",
        "type": "uint256"
      },
      {
        "name": "deadline",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "amountCalculated",
        "type": "uint256"
      }
    ],
    "stateMutability": "payable"
  }
] as const;
