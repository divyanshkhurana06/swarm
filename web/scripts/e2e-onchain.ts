/**
 * End-to-end smoke test against the real deployed contracts on Monad.
 *
 * The Foundry suite runs against a locally emulated P256 precompile
 * (`forge test --odyssey`). This runs the same flow against the actual chain,
 * so it proves Monad's precompile at 0x0100 behaves the way the docs say --
 * before sixty people find out for us.
 *
 * Signatures come from contracts/script/webauthn.js, the same generator the
 * Foundry tests use, so this exercises real P256 assertions.
 *
 *   npx tsx scripts/e2e-onchain.ts
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  http,
  formatUnits,
  keccak256,
  toBytes,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, TASK_POOL, TASK_ID, taskPoolAbi } from "../lib/contracts";
import {
  labelChallenge as localLabelChallenge,
  withdrawChallenge as localWithdrawChallenge,
  workerIdOf as localWorkerId,
} from "../lib/passkey";

const SIGNER = join(process.cwd(), "..", "contracts", "script", "webauthn.js");

/** Stands in for a real passkey credential id in this headless test. */
const CRED = keccak256(toBytes("e2e-credential-id"));

const publicClient = createPublicClient({ chain, transport: http() });
const account = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex);
const wallet = createWalletClient({ account, chain, transport: http() });

function pubkey() {
  const out = execFileSync("node", [SIGNER, "pubkey"]).toString() as Hex;
  const [x, y] = decodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }],
    out
  );
  return { x, y };
}

function assertion(challenge: Hex) {
  const out = execFileSync("node", [SIGNER, "sign", challenge]).toString() as Hex;
  const [authenticatorData, clientDataJSON, challengeIndex, r, s] =
    decodeAbiParameters(
      [
        { type: "bytes" },
        { type: "bytes" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      out
    );
  return { authenticatorData, clientDataJSON, challengeIndex, r, s };
}

async function send(functionName: string, args: readonly unknown[]) {
  const hash = await wallet.writeContract({
    address: TASK_POOL,
    abi: taskPoolAbi,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    functionName: functionName as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: args as any,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return { hash, gasUsed: receipt.gasUsed };
}

const read = (functionName: string, args: readonly unknown[] = []) =>
  publicClient.readContract({
    address: TASK_POOL,
    abi: taskPoolAbi,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    functionName: functionName as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: args as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as Promise<any>;

/**
 * Posts a dedicated FirstCome task for this run.
 *
 * Reusing the seeded task is fragile: it is majority-scored, so a lone worker
 * is never paid and any "answer until the balance clears" loop runs forever.
 */
async function postOwnTask(): Promise<bigint> {
  const spec = JSON.stringify({
    title: "e2e passkey run",
    question: "Flag it?",
    kind: "text",
    answers: { "0": "Fine", "1": "Flag" },
    items: Array.from({ length: 20 }, (_, id) => ({ id, text: `item ${id}` })),
  });
  const reward = 5_000n;
  const amount = reward * 20n;

  const signature = await account.signTypedData({
    domain: {
      name: "Swarm",
      version: "1",
      chainId: chain.id,
      verifyingContract: TASK_POOL,
    },
    types: {
      PostTask: [
        { name: "spec", type: "string" },
        { name: "rewardPerLabel", type: "uint96" },
        { name: "amount", type: "uint128" },
        { name: "items", type: "uint32" },
        { name: "mode", type: "uint8" },
        { name: "quorum", type: "uint8" },
      ],
    },
    primaryType: "PostTask",
    message: { spec, rewardPerLabel: reward, amount, items: 20, mode: 0, quorum: 1 },
  });

  const id = (await read("taskCount")) as bigint;
  await send("postTaskSponsored", [
    spec,
    reward,
    amount,
    20,
    0,
    1,
    account.address,
    signature,
  ]);
  return id;
}

async function main() {
  console.log(`chain    ${chain.name} (${chain.id})`);
  console.log(`TaskPool ${TASK_POOL}`);
  console.log(`relayer  ${account.address}\n`);

  const TASK = await postOwnTask();
  console.log(`task     #${TASK} (FirstCome, so answers pay immediately)`);

  const pk = pubkey();
  const workerId = (await read("idOf", [pk])) as Hex;
  console.log(`worker   ${workerId}`);

  // The browser computes challenges locally rather than paying a round trip
  // per swipe. If that TypeScript encoding drifts from Solidity's by even one
  // byte, every signature is rejected -- so diff them against the real chain.
  {
    const onChainId = (await read("idOf", [pk])) as Hex;
    if (localWorkerId(pk) !== onChainId) {
      throw new Error(`workerId mismatch: ${localWorkerId(pk)} vs ${onChainId}`);
    }

    const onChainLabel = (await read("labelChallenge", [TASK, 7n, 1])) as Hex;
    if (localLabelChallenge(TASK, 7n, 1) !== onChainLabel) {
      throw new Error(
        `labelChallenge mismatch: ${localLabelChallenge(TASK, 7n, 1)} vs ${onChainLabel}`
      );
    }

    const nonce = (await read("nonces", [workerId])) as bigint;
    const onChainWithdraw = (await read("withdrawChallenge", [
      workerId,
      account.address,
    ])) as Hex;
    if (localWithdrawChallenge(account.address, nonce) !== onChainWithdraw) {
      throw new Error("withdrawChallenge mismatch");
    }

    console.log("challenge encoding matches Solidity (label/withdraw)");
  }

  // 1. Register the passkey (proves possession of the private key).
  if (await read("isRegistered", [workerId])) {
    console.log("register skipped — already registered");
  } else {
    const { hash, gasUsed } = await send("registerWorker", [pk, CRED]);
    console.log(`register ok    gas ${gasUsed}  ${hash}`);
  }

  // The whole point of recording the credential hash: a worker who clears
  // their browser must still be able to find the money they earned.
  const recovered = (await read("workerOf", [CRED])) as Hex;
  if (recovered !== workerId) {
    throw new Error(`identity recovery broken: ${recovered} != ${workerId}`);
  }
  console.log("identity recoverable from credential id alone");

  // 2. Submit a label. This is the hot path: one passkey signature, one
  //    on-chain payment, in a single transaction.
  const before = (await read("earned", [workerId])) as bigint;

  // Pick an item this worker has not answered yet, so reruns work.
  let itemId = 0n;
  while (await read("hasLabeled", [TASK, workerId, itemId])) itemId++;

  const answer = 1;
  const challenge = (await read("labelChallenge", [
    TASK,
    itemId,
    answer,
  ])) as Hex;
  const { hash, gasUsed } = await send("submitLabel", [
    TASK,
    itemId,
    answer,
    workerId,
    assertion(challenge),
  ]);

  const after = (await read("earned", [workerId])) as bigint;
  console.log(`label ok       gas ${gasUsed}  item ${itemId}  ${hash}`);
  console.log(`paid           ${formatUnits(after - before, 6)} DUSD`);

  // 3. Confirm a bad signature is actually rejected on the real chain, not
  //    just in the local emulator. A precompile that silently returns "valid"
  //    would look identical to a working one until someone attacked it.
  const wrong = execFileSync("node", [SIGNER, "sign-wrong", challenge]).toString() as Hex;
  const [aD, cD, cI, r, s] = decodeAbiParameters(
    [
      { type: "bytes" },
      { type: "bytes" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    wrong
  );
  let nextItem = itemId + 1n;
  while (await read("hasLabeled", [TASK, workerId, nextItem])) nextItem++;

  try {
    await publicClient.simulateContract({
      address: TASK_POOL,
      abi: taskPoolAbi,
      functionName: "submitLabel",
      args: [
        TASK,
        nextItem,
        1,
        workerId,
        { authenticatorData: aD, clientDataJSON: cD, challengeIndex: cI, r, s },
      ],
      account,
    });
    console.error("\nFAIL — a signature over the wrong challenge was ACCEPTED");
    process.exit(1);
  } catch {
    console.log("bad signature rejected on-chain — precompile behaves correctly");
  }

  // 4. Cash out. Earnings live in the contract's ledger keyed by public key,
  //    not "in" the passkey -- this proves a passkey signature can move them
  //    to an arbitrary address the worker names at withdrawal time.
  //
  //    Answer until the balance clears MIN_WITHDRAWAL; sweeping a few cents
  //    costs more gas than it moves, so the contract refuses below the floor.
  const minimum = (await read("MIN_WITHDRAWAL")) as bigint;
  let nextFree = itemId + 1n;
  let guard = 0;
  while (((await read("balanceOf", [workerId])) as bigint) < minimum) {
    if (++guard > 30) {
      throw new Error(
        "balance never reached the minimum — is this task paying on submit?"
      );
    }
    while (await read("hasLabeled", [TASK, workerId, nextFree])) nextFree++;
    const c = (await read("labelChallenge", [TASK, nextFree, 1])) as Hex;
    await send("submitLabel", [TASK, nextFree, 1, workerId, assertion(c)]);
    nextFree++;
  }
  console.log(`topped up past the ${formatUnits(minimum, 6)} minimum`);

  const claimable = (await read("balanceOf", [workerId])) as bigint;
  if (claimable > 0n) {
    const dest = "0x000000000000000000000000000000000000dEaD" as const;
    const usd = (await read("token")) as Hex | undefined;

    const wc = (await read("withdrawChallenge", [workerId, dest])) as Hex;
    const { hash: wHash, gasUsed: wGas } = await send("withdraw", [
      workerId,
      dest,
      assertion(wc),
    ]);

    const left = (await read("balanceOf", [workerId])) as bigint;
    if (left !== 0n) throw new Error(`withdraw left ${left} behind`);

    console.log(
      `withdraw ok    gas ${wGas}  ${formatUnits(claimable, 6)} DUSD -> ${dest}  ${wHash}`
    );
    if (usd) console.log(`               (token ${usd})`);

    // A stablecoin payout is invisible until the token is imported, so a
    // receipt NFT lands at the same address. Its artwork is generated
    // on-chain, so nothing has to stay hosted for it to keep rendering.
    const receiptsAddr = (await read("receipts")) as Hex;
    const nftAbi = [
      { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
      { name: "tokenURI", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "string" }] },
      { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    ] as const;

    const held = await publicClient.readContract({ address: receiptsAddr, abi: nftAbi, functionName: "balanceOf", args: [dest] });
    const supply = await publicClient.readContract({ address: receiptsAddr, abi: nftAbi, functionName: "totalSupply" });
    const uri = await publicClient.readContract({ address: receiptsAddr, abi: nftAbi, functionName: "tokenURI", args: [supply] });

    if (held === 0n) throw new Error("no receipt NFT was minted");
    if (!uri.startsWith("data:application/json;base64,")) {
      throw new Error(`tokenURI is not self-contained: ${uri.slice(0, 40)}`);
    }
    const meta = JSON.parse(atob(uri.slice("data:application/json;base64,".length)));
    if (!String(meta.image).startsWith("data:image/svg+xml;base64,")) {
      throw new Error("receipt artwork is not on-chain");
    }
    console.log(`receipt NFT    #${supply} -> ${dest}, "${meta.name}", art rendered on-chain`);
    console.log(`               contract ${receiptsAddr}`);
  }

  const [labels, paid, workers] = await Promise.all([
    read("totalLabels"),
    read("totalPaid"),
    read("workerCount"),
  ]);
  console.log(
    `\ntotals: ${labels} answers · ${formatUnits(paid as bigint, 6)} DUSD paid · ${workers} workers`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
