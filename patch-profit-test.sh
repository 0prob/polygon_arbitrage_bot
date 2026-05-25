sed -i 's/500_000_000_000n; \/\/ 5e11/500_000_000_000_000_000_000_000_000_000n; \/\/ 5e29/' src/core/assessment/profit.test.ts
sed -i 's/maticWeiToTokens(1n, 10n)/maticWeiToTokens(1n, 10_000_000_000_000_000_000n)/' src/core/assessment/profit.test.ts
sed -i 's/maticWeiToTokens(100n, 10n)/maticWeiToTokens(100n, 10_000_000_000_000_000_000n)/' src/core/assessment/profit.test.ts
sed -i 's/tokenToMaticRate: 500_000_000_000n, \/\/ 0.5 MATIC\/USDC/tokenToMaticRate: 500_000_000_000_000_000_000_000_000_000n, \/\/ 5e29/' src/core/assessment/profit.test.ts
sed -i 's/tokenToMaticRate: 1_000_000n, \/\/ 1 token = 1e-6 MATIC/tokenToMaticRate: 1_000_000_000_000_000_000_000_000n, \/\/ 1e24/' src/core/assessment/profit.test.ts
sed -i 's/tokenToMaticRate: 100_000_000_000_000_000_000n, \/\/ 1 unit = 100 MATIC/tokenToMaticRate: 100_000_000_000_000_000_000_000_000_000_000_000_000n, \/\/ 1e38/' src/core/assessment/profit.test.ts
bash patch-profit-test.sh
