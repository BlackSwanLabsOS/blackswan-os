import { ethers } from "ethers";
import { provider, usdcContract } from "./chain.js";

/**
 * Ensure `owner` has approved `spender` for at least `amount` USDC.
 * Polls fresh on-chain allowance after approve — public Base Sepolia RPC
 * can return stale reads immediately after `tx.wait()`.
 */
export async function ensureAllowance(
  owner: string,
  spender: string,
  amount: bigint
): Promise<void> {
  if (amount <= 0n) return;

  const readAllowance = async (): Promise<bigint> => {
    // Bypass ethers JsonRpcProvider response cache.
    const raw = await provider.send("eth_call", [
      {
        to: await usdcContract.getAddress(),
        data: usdcContract.interface.encodeFunctionData("allowance", [
          owner,
          spender,
        ]),
      },
      "latest",
    ]);
    return BigInt(raw);
  };

  let current = await readAllowance();
  if (current >= amount) return;

  // Some USDC builds dislike non-zero → different non-zero approve.
  if (current > 0n) {
    const zeroTx = await usdcContract.approve(spender, 0n);
    await zeroTx.wait();
  }

  const approveTx = await usdcContract.approve(spender, ethers.MaxUint256);
  await approveTx.wait();

  for (let i = 0; i < 10; i++) {
    current = await readAllowance();
    if (current >= amount) return;
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(
    `USDC allowance still insufficient after approve ` +
      `(have ${current.toString()}, need ${amount.toString()})`
  );
}
