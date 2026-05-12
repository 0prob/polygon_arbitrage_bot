import {
  decodedBodyString,
  FULLY_SUPPORTED_CAPABILITIES,
  type DecodedEvent,
  type ProtocolDefinition,
} from "./factories.ts";

const DVM_FACTORY = "0x79887f65f83bdf15Bcc8736b5e5BcDB48fb8fE13";
const DPP_FACTORY = "0xd24153244066F0afA9415563bFC7Ba248bfB7a51";
const DSP_FACTORY = "0x43C49f8DD240e1545F147211Ec9f917376Ac1e87";

function createDodoV2Protocol({
  name,
  address,
  eventName,
  poolType,
}: {
  name: string;
  address: string;
  eventName: "NewDVM" | "NewDPP" | "NewDSP";
  poolType: "DVM" | "DPP" | "DSP";
}): ProtocolDefinition {
  const poolArgName = poolType.toLowerCase();
  return {
    name,
    address,
    startBlock: 0,
    capabilities: FULLY_SUPPORTED_CAPABILITIES,
    signature: `event ${eventName}(address baseToken, address quoteToken, address creator, address ${poolArgName})`,
    decode(decoded: DecodedEvent) {
      const baseToken = decodedBodyString(decoded, 0);
      const quoteToken = decodedBodyString(decoded, 1);
      return {
        pool_address: decodedBodyString(decoded, 3),
        tokens: [
          baseToken,
          quoteToken,
        ],
        metadata: {
          factory: address,
          poolType,
          baseToken,
          quoteToken,
          creator: decodedBodyString(decoded, 2),
        },
      };
    },
  };
}

export const DODO_DVM = createDodoV2Protocol({
  name: "DODO V2 DVM",
  address: DVM_FACTORY,
  eventName: "NewDVM",
  poolType: "DVM",
});

export const DODO_DPP = createDodoV2Protocol({
  name: "DODO V2 DPP",
  address: DPP_FACTORY,
  eventName: "NewDPP",
  poolType: "DPP",
});

export const DODO_DSP = createDodoV2Protocol({
  name: "DODO V2 DSP",
  address: DSP_FACTORY,
  eventName: "NewDSP",
  poolType: "DSP",
});
