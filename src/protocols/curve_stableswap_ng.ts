import { createCurveListedFactoryProtocol } from "./factories.ts";

const FACTORY_ADDRESS = "0x1764ee18e8B3ccA4787249Ceb249356192594585";

export default createCurveListedFactoryProtocol({
  name: "Curve StableSwap NG",
  address: FACTORY_ADDRESS,
  dynamicCoins: true,
  metadataForPool: () => ({
    factory: FACTORY_ADDRESS,
    variant: "stableswap-ng",
  }),
});
