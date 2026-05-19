import { describe, it, expect, vi } from "vitest";
import { fetchCurvePools } from "./curve_discovery";
import { type PublicClient, getContract } from "viem";

vi.mock("viem", async () => {
  const actual = await vi.importActual("viem");
  return {
    ...actual,
    getContract: vi.fn(),
  };
});

describe("fetchCurvePools", () => {
  it("should fetch pools correctly", async () => {
    const mockClient = {} as PublicClient;
    const factoryAddress = "0x1234567890123456789012345678901234567890" as `0x${string}`;

    const mockFactory = {
      read: {
        pool_count: vi.fn().mockResolvedValue(1n),
        pool_list: vi.fn().mockResolvedValue("0xPoolAddress"),
        get_coins: vi.fn().mockResolvedValue(["0xCoin1", "0xCoin2", "0x0000000000000000000000000000000000000000"]),
      },
    };

    vi.mocked(getContract).mockReturnValue(mockFactory as any);

    const pools = await fetchCurvePools(mockClient, factoryAddress);

    expect(pools).toHaveLength(1);
    expect(pools[0].poolAddress).toBe("0xPoolAddress");
    expect(pools[0].coins).toEqual(["0xCoin1", "0xCoin2"]);
  });
});
