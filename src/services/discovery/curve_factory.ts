import type { Address } from "../../core/types/common.ts";

export interface CurvePoolInfo {
  poolAddress: Address;
  lpToken: Address;
  coins: Address[];
}

export type CurveFactoryFetcher = (factoryAddress: Address) => Promise<CurvePoolInfo[]>;
