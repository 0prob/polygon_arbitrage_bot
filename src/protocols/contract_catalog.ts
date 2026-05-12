export type AbiExpectation = {
  type: "event" | "function";
  name: string;
  inputs: string[];
  indexed?: boolean[];
};

export type ContractCatalogEntry = {
  protocol: string;
  label: string;
  address: string;
  role: "factory" | "router" | "vault" | "registry" | "pool" | "oracle" | "helper";
  integration: "active" | "catalog_only";
  expectations: AbiExpectation[];
};

export const POLYGON_CHAIN_ID = "137";

export const UNISWAP_V2_PAIR_CREATED_EXPECTATION: AbiExpectation = {
  type: "event",
  name: "PairCreated",
  inputs: ["address", "address", "address", "uint256"],
  indexed: [true, true, false, false],
};

export const CONTRACT_CATALOG: ContractCatalogEntry[] = [
  {
    protocol: "QUICKSWAP_V2",
    label: "QuickSwap V2 Factory",
    address: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32",
    role: "factory",
    integration: "active",
    expectations: [
      UNISWAP_V2_PAIR_CREATED_EXPECTATION,
    ],
  },
  {
    protocol: "SUSHISWAP_V2",
    label: "SushiSwap Factory",
    address: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
    role: "factory",
    integration: "active",
    expectations: [
      UNISWAP_V2_PAIR_CREATED_EXPECTATION,
    ],
  },
  {
    protocol: "DFYN_V2",
    label: "DFYN Network Swap V2 Factory",
    address: "0xE7Fb3e833eFE5F9c441105EB65Ef8b261266423B",
    role: "factory",
    integration: "active",
    expectations: [
      UNISWAP_V2_PAIR_CREATED_EXPECTATION,
    ],
  },
  {
    protocol: "COMETHSWAP_V2",
    label: "ComethSwap V2 Factory",
    address: "0x800b052609c355cA8103E06F022aA30647eAd60a",
    role: "factory",
    integration: "active",
    expectations: [
      UNISWAP_V2_PAIR_CREATED_EXPECTATION,
    ],
  },
  {
    protocol: "APESWAP_V2",
    label: "ApeSwap V2 Factory",
    address: "0xCf083Be4164828f00cAE704EC15a36D711491284",
    role: "factory",
    integration: "active",
    expectations: [
      UNISWAP_V2_PAIR_CREATED_EXPECTATION,
    ],
  },
  {
    protocol: "MESHSWAP_V2",
    label: "Meshswap V2 Factory",
    address: "0x9F3044f7F9FC8bC9eD615d54845b4577B833282d",
    role: "factory",
    integration: "active",
    expectations: [
      UNISWAP_V2_PAIR_CREATED_EXPECTATION,
    ],
  },
  {
    protocol: "JETSWAP_V2",
    label: "JetSwap V2 Factory",
    address: "0x668ad0ed2622C62E24f0d5ab6B6Ac1b9D2cD4AC7",
    role: "factory",
    integration: "active",
    expectations: [
      UNISWAP_V2_PAIR_CREATED_EXPECTATION,
    ],
  },
  {
    protocol: "UNISWAP_V3",
    label: "Uniswap V3 Factory",
    address: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    role: "factory",
    integration: "active",
    expectations: [
      {
        type: "event",
        name: "PoolCreated",
        inputs: ["address", "address", "uint24", "int24", "address"],
        indexed: [true, true, true, false, false],
      },
    ],
  },
  {
    protocol: "QUICKSWAP_V3",
    label: "QuickSwap V3 Algebra Factory",
    address: "0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28",
    role: "factory",
    integration: "active",
    expectations: [
      {
        type: "event",
        name: "Pool",
        inputs: ["address", "address", "address"],
        indexed: [true, true, false],
      },
    ],
  },
  {
    protocol: "SUSHISWAP_V3",
    label: "SushiSwap V3 Factory",
    address: "0x917933899c6a5F8E37F31E19f92CdBFF7e8FF0e2",
    role: "factory",
    integration: "active",
    expectations: [
      {
        type: "event",
        name: "PoolCreated",
        inputs: ["address", "address", "uint24", "int24", "address"],
        indexed: [true, true, true, false, false],
      },
    ],
  },
  {
    protocol: "KYBERSWAP_ELASTIC",
    label: "KyberSwap Elastic Factory",
    address: "0x5F1dddbf348aC2fbe22a163e30F99F9ECE3DD50a",
    role: "factory",
    integration: "active",
    expectations: [
      {
        type: "event",
        name: "PoolCreated",
        inputs: ["address", "address", "uint24", "int24", "address"],
        indexed: [true, true, true, false, false],
      },
    ],
  },
  {
    protocol: "BALANCER_V2",
    label: "Balancer V2 Vault",
    address: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
    role: "vault",
    integration: "active",
    expectations: [
      {
        type: "event",
        name: "PoolRegistered",
        inputs: ["bytes32", "address", "uint8"],
        indexed: [true, true, false],
      },
      {
        type: "function",
        name: "getPoolTokens",
        inputs: ["bytes32"],
      },
      {
        type: "function",
        name: "swap",
        inputs: ["tuple", "tuple", "uint256", "uint256"],
      },
    ],
  },
  {
    protocol: "CURVE_MAIN_REGISTRY",
    label: "Curve Main Registry",
    address: "0x094d12e5b541784701FD8d65F11fc0598FBC6332",
    role: "registry",
    integration: "active",
    expectations: [
      {
        type: "event",
        name: "PoolAdded",
        inputs: ["address", "bytes"],
        indexed: [true, false],
      },
      {
        type: "function",
        name: "get_coins",
        inputs: ["address"],
      },
    ],
  },
  {
    protocol: "CURVE_STABLE_FACTORY",
    label: "Curve StableSwap Factory",
    address: "0x722272D36ef0Da72FF51c5A65Db7b870E2e8D4ee",
    role: "factory",
    integration: "active",
    expectations: [
      {
        type: "event",
        name: "PlainPoolDeployed",
        inputs: ["address[4]", "uint256", "uint256", "address"],
        indexed: [false, false, false, false],
      },
      {
        type: "event",
        name: "MetaPoolDeployed",
        inputs: ["address", "address", "uint256", "uint256", "address"],
        indexed: [false, false, false, false, false],
      },
    ],
  },
  {
    protocol: "CURVE_CRYPTO_FACTORY",
    label: "Curve Crypto Factory",
    address: "0xE5De15A9C9bBedb4F5EC13B131E61245f2983A69",
    role: "factory",
    integration: "active",
    expectations: [
      {
        type: "event",
        name: "CryptoPoolDeployed",
        inputs: ["address", "address[2]", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "address"],
        indexed: [false, false, false, false, false, false, false, false, false, false, false, false, false],
      },
    ],
  },
  {
    protocol: "CURVE_STABLESWAP_NG",
    label: "Curve StableSwap NG Factory",
    address: "0x1764ee18e8B3ccA4787249Ceb249356192594585",
    role: "factory",
    integration: "active",
    expectations: [
      { type: "function", name: "pool_count", inputs: [] },
      { type: "function", name: "pool_list", inputs: ["uint256"] },
      { type: "function", name: "get_coins", inputs: ["address"] },
    ],
  },
  {
    protocol: "CURVE_TRICRYPTO_NG",
    label: "Curve Tricrypto NG Factory",
    address: "0xC1b393EfEF38140662b91441C6710Aa704973228",
    role: "factory",
    integration: "active",
    expectations: [
      { type: "function", name: "pool_count", inputs: [] },
      { type: "function", name: "pool_list", inputs: ["uint256"] },
      { type: "function", name: "get_coins", inputs: ["address"] },
    ],
  },
  {
    protocol: "DODO_ZOO",
    label: "DODOZoo",
    address: "0x357c5E9cfA8B834EDcef7C7aAbD8F9Db09119d11",
    role: "factory",
    integration: "catalog_only",
    expectations: [
      {
        type: "event",
        name: "DODOBirth",
        inputs: ["address", "address", "address"],
        indexed: [false, false, false],
      },
      { type: "function", name: "getDODO", inputs: ["address", "address"] },
      { type: "function", name: "getDODOs", inputs: [] },
    ],
  },
  {
    protocol: "DODO_DVM",
    label: "DODO DVMFactory",
    address: "0x79887f65f83bdf15Bcc8736b5e5BcDB48fb8fE13",
    role: "factory",
    integration: "active",
    expectations: [
      {
        type: "event",
        name: "NewDVM",
        inputs: ["address", "address", "address", "address"],
        indexed: [false, false, false, false],
      },
      { type: "function", name: "getDODOPool", inputs: ["address", "address"] },
    ],
  },
  {
    protocol: "DODO_DPP",
    label: "DODO DPPFactory",
    address: "0xd24153244066F0afA9415563bFC7Ba248bfB7a51",
    role: "factory",
    integration: "active",
    expectations: [
      {
        type: "event",
        name: "NewDPP",
        inputs: ["address", "address", "address", "address"],
        indexed: [false, false, false, false],
      },
      { type: "function", name: "getDODOPool", inputs: ["address", "address"] },
    ],
  },
  {
    protocol: "DODO_DSP",
    label: "DODO DSPFactory",
    address: "0x43C49f8DD240e1545F147211Ec9f917376Ac1e87",
    role: "factory",
    integration: "active",
    expectations: [
      {
        type: "event",
        name: "NewDSP",
        inputs: ["address", "address", "address", "address"],
        indexed: [false, false, false, false],
      },
      { type: "function", name: "getDODOPool", inputs: ["address", "address"] },
    ],
  },
  {
    protocol: "WOOFI",
    label: "WOOFi WooRouterV2",
    address: "0x4c4AF8DBc524681930a27b2F1Af5bcC8062E6fB7",
    role: "router",
    integration: "active",
    expectations: [
      { type: "function", name: "querySwap", inputs: ["address", "address", "uint256"] },
      { type: "function", name: "swap", inputs: ["address", "address", "uint256", "uint256", "address", "address"] },
      {
        type: "event",
        name: "WooRouterSwap",
        inputs: ["uint8", "address", "address", "uint256", "uint256", "address", "address", "address"],
        indexed: [false, true, true, false, false, false, true, false],
      },
    ],
  },
  {
    protocol: "WOOFI",
    label: "WOOFi CrosswapRouterV5",
    address: "0xB84aEfEF2DDDE628d5c7F1fba320dE63e3f4757c",
    role: "router",
    integration: "catalog_only",
    expectations: [],
  },
  {
    protocol: "WOOFI",
    label: "WOOFi WooPPv2 Proxy",
    address: "0x5520385bFcf07Ec87C4c53A7d8d65595Dff69FA4",
    role: "pool",
    integration: "active",
    expectations: [
      { type: "function", name: "quoteToken", inputs: [] },
      { type: "function", name: "poolSize", inputs: ["address"] },
      { type: "function", name: "tryQuery", inputs: ["address", "address", "uint256"] },
      { type: "function", name: "query", inputs: ["address", "address", "uint256"] },
      { type: "function", name: "swap", inputs: ["address", "address", "uint256", "uint256", "address", "address"] },
      {
        type: "event",
        name: "WooSwap",
        inputs: ["address", "address", "uint256", "uint256", "address", "address", "address", "uint256", "uint256"],
        indexed: [true, true, false, false, false, true, false, false, false],
      },
    ],
  },
  {
    protocol: "WOOFI",
    label: "WOOFi WooracleV2.2",
    address: "0x2A8Ede62D0717C8C92b88639ecf603FDF31A8428",
    role: "oracle",
    integration: "active",
    expectations: [
      { type: "function", name: "state", inputs: ["address"] },
      { type: "function", name: "decimals", inputs: ["address"] },
      { type: "function", name: "quoteToken", inputs: [] },
    ],
  },
  {
    protocol: "WOOFI",
    label: "WOOFi IntegrationHelper",
    address: "0x7Ba560eB735AbDCf9a3a5692272652A0cc81850d",
    role: "helper",
    integration: "catalog_only",
    expectations: [],
  },
];
