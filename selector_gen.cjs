const { keccak256, toHex, stringToBytes } = require("viem");
const sig = "swap((address,address,uint24,int24,address),bool,int128,uint160,bytes)";
const hash = keccak256(stringToBytes(sig));
console.log(hash.slice(0, 10));
