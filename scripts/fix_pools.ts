import fs from 'fs';

const pools = JSON.parse(fs.readFileSync('scripts/pools.json', 'utf8'));
const fixedPools = pools.map((p: any) => {
  if (p.tokens && p.tokens.length === 2) {
    const t0 = p.tokens[0].toLowerCase();
    const t1 = p.tokens[1].toLowerCase();
    if (t0 > t1) {
      console.log(`Swapping tokens for ${p.address}: ${p.symbols}`);
      return {
        ...p,
        tokens: [t1, t0],
        symbols: p.symbols.split(' ')[0].split('/').reverse().join('/') + ' ' + (p.symbols.split(' ')[1] || '')
      };
    }
  }
  return p;
});

fs.writeFileSync('scripts/pools.json', JSON.stringify(fixedPools, null, 2));
console.log('Fixed pools.json');
