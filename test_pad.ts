const addr = "0x8ef2f93b3c99050fdbd926d30e537997faf32ee";
const padded = "0x" + addr.slice(2).padStart(40, "0");
console.log(padded, padded.length);
