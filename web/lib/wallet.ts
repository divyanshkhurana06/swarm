/**
 * Embedded-wallet signing.
 *
 * The worker signs EIP-712 typed data with the wallet Privy created for them
 * at Google sign-in. Typed data rather than a raw hash so the wallet can show
 * what is actually being authorised, and so the contract can bind the
 * signature to this chain and this deployment.
 *
 * They still hold no MON, so the relayer submits and pays gas. The contract
 * recovers the worker's address from the signature, which is what stops the
 * relayer from being able to forge anything.
 */

import type { Hex } from "viem";
import { TASK_POOL, chain } from "./contracts";

/** Matches EIP712.domainSeparator("Swarm", "1") in the contract. */
const domain = {
  name: "Swarm",
  version: "1",
  chainId: chain.id,
  verifyingContract: TASK_POOL,
} as const;

const types = {
  PostTask: [
    { name: "spec", type: "string" },
    { name: "rewardPerLabel", type: "uint96" },
    { name: "amount", type: "uint128" },
    { name: "items", type: "uint32" },
  ],
  Label: [
    { name: "taskId", type: "uint256" },
    { name: "itemId", type: "uint256" },
    { name: "answer", type: "uint8" },
  ],
  Withdraw: [
    { name: "to", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** The minimum surface we need from a Privy wallet. */
export type SigningWallet = {
  address: string;
  getEthereumProvider: () => Promise<{
    request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  }>;
};

async function signTypedData(
  wallet: SigningWallet,
  primaryType: "Label" | "Withdraw" | "PostTask",
  message: Record<string, string>
): Promise<Hex> {
  const provider = await wallet.getEthereumProvider();

  const payload = JSON.stringify({
    domain,
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      [primaryType]: types[primaryType],
    },
    primaryType,
    message,
  });

  // eth_signTypedData_v4 takes the address first and the payload as a string.
  const signature = (await provider.request({
    method: "eth_signTypedData_v4",
    params: [wallet.address, payload],
  })) as Hex;

  return signature;
}

export function signLabel(
  wallet: SigningWallet,
  taskId: bigint,
  itemId: bigint,
  answer: number
): Promise<Hex> {
  return signTypedData(wallet, "Label", {
    taskId: taskId.toString(),
    itemId: itemId.toString(),
    answer: answer.toString(),
  });
}

export function signPostTask(
  wallet: SigningWallet,
  spec: string,
  rewardPerLabel: bigint,
  amount: bigint,
  items: number
): Promise<Hex> {
  return signTypedData(wallet, "PostTask", {
    spec,
    rewardPerLabel: rewardPerLabel.toString(),
    amount: amount.toString(),
    items: items.toString(),
  });
}

export function signWithdraw(
  wallet: SigningWallet,
  to: Hex,
  nonce: bigint
): Promise<Hex> {
  return signTypedData(wallet, "Withdraw", {
    to,
    nonce: nonce.toString(),
  });
}
