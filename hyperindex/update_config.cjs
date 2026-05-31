const fs = require('fs');
let yaml = fs.readFileSync('config.yaml', 'utf8');

// Global start block
yaml = yaml.replace(
  /start_block: \$\{POLYGON_START_BLOCK:-86500000\} # LIVE-DEBUG DEFAULT:/,
  'start_block: ${POLYGON_START_BLOCK:-5024576} # LIVE-DEBUG DEFAULT:'
);

// V2Factory
yaml = yaml.replace(
  /name: V2Factory\n\s+start_block: \$\{POLYGON_START_BLOCK:-86500000\} # \(live-debug safe; original ~5\.48M Quickswap in comment only\)/,
  'name: V2Factory\n        start_block: ${POLYGON_START_BLOCK:-5024576} # Quickswap V2 deployment'
);

// V3Factory
yaml = yaml.replace(
  /name: V3Factory\n\s+start_block: \$\{POLYGON_START_BLOCK:-86500000\} # \(live-debug safe; original ~22\.7M V3 in comment only\)/,
  'name: V3Factory\n        start_block: ${POLYGON_START_BLOCK:-22757547} # Uniswap V3 deployment'
);

// UniswapV2Pool
yaml = yaml.replace(
  /name: UniswapV2Pool\n\s+start_block: \$\{POLYGON_START_BLOCK:-86500000\}/,
  'name: UniswapV2Pool\n        start_block: ${POLYGON_START_BLOCK:-5024576}'
);

// UniswapV3Pool
yaml = yaml.replace(
  /name: UniswapV3Pool\n\s+start_block: \$\{POLYGON_START_BLOCK:-86500000\}/,
  'name: UniswapV3Pool\n        start_block: ${POLYGON_START_BLOCK:-22757547}'
);

// CurveRegistry
yaml = yaml.replace(
  /name: CurveRegistry\n\s+start_block: \$\{POLYGON_START_BLOCK:-86500000\}/,
  'name: CurveRegistry\n        start_block: ${POLYGON_START_BLOCK:-10000000}'
);

// CurvePool
yaml = yaml.replace(
  /name: CurvePool\n\s+start_block: \$\{POLYGON_START_BLOCK:-86500000\}/,
  'name: CurvePool\n        start_block: ${POLYGON_START_BLOCK:-10000000}'
);

// PoolManager
yaml = yaml.replace(
  /name: PoolManager\n\s+start_block: \$\{POLYGON_START_BLOCK:-86500000\} # Uniswap V4 deployment/,
  'name: PoolManager\n        start_block: ${POLYGON_START_BLOCK:-66980384} # Uniswap V4 deployment'
);

// BalancerVault
yaml = yaml.replace(
  /name: BalancerVault\n\s+start_block: \$\{POLYGON_START_BLOCK:-86500000\}/,
  'name: BalancerVault\n        start_block: ${POLYGON_START_BLOCK:-15832990}'
);

// DodoFactory
yaml = yaml.replace(
  /name: DodoFactory\n\s+start_block: \$\{POLYGON_START_BLOCK:-86500000\}/,
  'name: DodoFactory\n        start_block: ${POLYGON_START_BLOCK:-14722979}'
);

// DodoPool
yaml = yaml.replace(
  /name: DodoPool\n\s+# Point 1: Uses same start_block as factory. Point 3: addresses supplied exclusively via contractRegister in dodo_factory.ts\n\s+start_block: \$\{POLYGON_START_BLOCK:-86500000\}/,
  'name: DodoPool\n        # Point 1: Uses same start_block as factory. Point 3: addresses supplied exclusively via contractRegister in dodo_factory.ts\n        start_block: ${POLYGON_START_BLOCK:-14722979}'
);

fs.writeFileSync('config.yaml', yaml);
console.log('done');
