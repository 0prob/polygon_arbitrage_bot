export interface TokenTaxConfig {
  buyTaxMultiplier: number;
  sellTaxMultiplier: number;
}

export class TokenRegistry {
  private taxes: Map<string, TokenTaxConfig> = new Map();

  constructor(initialTaxes: Record<string, TokenTaxConfig> = {}) {
    for (const [address, config] of Object.entries(initialTaxes)) {
      this.taxes.set(address.toLowerCase(), config);
    }
  }

  /**
   * Adjusts the input amount based on the sell tax of the token being sent.
   * Sell tax means the pool receives less than what the user sent.
   */
  applySellTax(tokenAddress: string, amount: bigint): bigint {
    const config = this.taxes.get(tokenAddress.toLowerCase());
    if (!config || config.sellTaxMultiplier === 1.0) return amount;
    return BigInt(Math.floor(Number(amount) * config.sellTaxMultiplier));
  }

  /**
   * Adjusts the output amount based on the buy tax of the token being received.
   * Buy tax means the user receives less than what the pool sent.
   */
  applyBuyTax(tokenAddress: string, amount: bigint): bigint {
    const config = this.taxes.get(tokenAddress.toLowerCase());
    if (!config || config.buyTaxMultiplier === 1.0) return amount;
    return BigInt(Math.floor(Number(amount) * config.buyTaxMultiplier));
  }
}
