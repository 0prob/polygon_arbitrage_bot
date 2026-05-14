import { createCurveListedFactoryProtocol } from "./factories.ts";

const FACTORY_ADDRESS = "0xC1b393EfEF38140662b91441C6710Aa704973228";

export default createCurveListedFactoryProtocol({
  name: "Curve Tricrypto NG",
  address: FACTORY_ADDRESS,
  slotCount: 3,
  metadataForPool: () => ({
    factory: FACTORY_ADDRESS,
    variant: "tricrypto-ng",
  }),
});
