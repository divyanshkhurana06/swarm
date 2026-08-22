/**
 * All three task modes, end to end, against the deployed contracts.
 *
 * The Foundry suite proves the logic against a local EVM. This proves the
 * whole stack agrees on the real chain: the EIP-712 encoding the browser
 * produces, the relayer's calldata, and the contract's accounting. A mismatch
 * in any one of them fails here rather than in front of a room.
 *
 *   npx tsx scripts/e2e-modes.ts
 */

import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  keccak256,
  toBytes,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { chain, TASK_POOL, taskPoolAbi } from "../lib/contracts";

const publicClient = createPublicClient({ chain, transport: http() });
const relayer = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex);
const relay = createWalletClient({ account: relayer, chain, transport: http() });

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
    { name: "mode", type: "uint8" },
    { name: "quorum", type: "uint8" },
  ],
  Label: [
    { name: "taskId", type: "uint256" },
    { name: "itemId", type: "uint256" },
    { name: "answer", type: "uint8" },
  ],
  SurveyAnswer: [
    { name: "taskId", type: "uint256" },
    { name: "itemId", type: "uint256" },
    { name: "answerHash", type: "bytes32" },
  ],
} as const;

const read = <T,>(fn: string, args: readonly unknown[] = []) =>
  publicClient.readContract({
    address: TASK_POOL,
    abi: taskPoolAbi,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    functionName: fn as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: args as any,
  }) as Promise<T>;

async function send(fn: string, args: readonly unknown[]) {
  const hash = await relay.writeContract({
    address: TASK_POOL,
    abi: taskPoolAbi,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    functionName: fn as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: args as any,
  });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${fn} reverted`);
  return hash;
}

/** A throwaway worker, exactly like one Privy would mint at sign-in. */
function newWorker() {
  return privateKeyToAccount(generatePrivateKey());
}

const idOf = (a: string) =>
  `0x${"0".repeat(24)}${a.slice(2)}`.toLowerCase() as Hex;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function post(spec: object, reward: bigint, items: number, mode: number, quorum: number) {
  const requester = newWorker();
  const specJson = JSON.stringify(spec);
  const amount = reward * BigInt(items * quorum);

  const signature = await requester.signTypedData({
    domain,
    types: { PostTask: types.PostTask },
    primaryType: "PostTask",
    message: {
      spec: specJson,
      rewardPerLabel: reward,
      amount,
      items,
      mode,
      quorum,
    },
  });

  const before = await read<bigint>("taskCount");
  await send("postTaskSponsored", [
    specJson,
    reward,
    amount,
    items,
    mode,
    quorum,
    requester.address,
    signature,
  ]);
  return { taskId: before, requester };
}

async function label(taskId: bigint, itemId: bigint, answer: number, w: ReturnType<typeof newWorker>) {
  const signature = await w.signTypedData({
    domain,
    types: { Label: types.Label },
    primaryType: "Label",
    message: { taskId, itemId, answer },
  });
  await send("submitLabelFor", [taskId, itemId, answer, w.address, signature]);
}

async function survey(taskId: bigint, itemId: bigint, answer: string, w: ReturnType<typeof newWorker>) {
  const signature = await w.signTypedData({
    domain,
    types: { SurveyAnswer: types.SurveyAnswer },
    primaryType: "SurveyAnswer",
    message: { taskId, itemId, answerHash: keccak256(toBytes(answer)) },
  });
  await send("submitSurveyFor", [taskId, itemId, answer, w.address, signature]);
}

const REWARD = 5_000n;

async function main() {
  console.log(`chain    ${chain.name} (${chain.id})`);
  console.log(`TaskPool ${TASK_POOL}\n`);

  // --- majority: text labelling ----------------------------------------
  console.log("Majority (text labelling)");
  {
    const spec = {
      title: "e2e text",
      question: "Urgent?",
      kind: "text",
      answers: { "0": "No", "1": "Yes" },
      items: [{ id: 0, text: "The site is down" }],
    };
    const { taskId } = await post(spec, REWARD, 1, 1, 3);
    const [a, b, c] = [newWorker(), newWorker(), newWorker()];

    await label(taskId, 0n, 1, a);
    await label(taskId, 0n, 1, b);
    check(
      "nothing paid before quorum",
      (await read<bigint>("earned", [idOf(a.address)])) === 0n
    );

    await label(taskId, 0n, 0, c); // the dissenter

    check("item resolved at quorum", await read<boolean>("resolved", [taskId, 0n]));
    check(
      "majority paid",
      (await read<bigint>("earned", [idOf(a.address)])) === REWARD &&
        (await read<bigint>("earned", [idOf(b.address)])) === REWARD
    );
    check(
      "minority paid nothing",
      (await read<bigint>("earned", [idOf(c.address)])) === 0n
    );
  }

  // --- first come: image labelling --------------------------------------
  console.log("\nFirstCome (image labelling)");
  {
    const spec = {
      title: "e2e images",
      question: "Car?",
      kind: "image",
      answers: { "0": "No car", "1": "Car" },
      items: [{ id: 0, text: "https://example.com/a.jpg" }],
    };
    const { taskId } = await post(spec, REWARD, 1, 0, 1);
    const a = newWorker();
    const b = newWorker();

    await label(taskId, 0n, 1, a);
    check(
      "paid immediately",
      (await read<bigint>("earned", [idOf(a.address)])) === REWARD
    );

    let full = false;
    try {
      await label(taskId, 0n, 1, b);
    } catch {
      full = true;
    }
    check("second worker is turned away once the item is full", full);
  }

  // --- survey ------------------------------------------------------------
  console.log("\nSurvey");
  {
    const spec = {
      title: "e2e survey",
      question: "Answer in your own words",
      kind: "survey",
      answers: { "0": "", "1": "" },
      items: [
        { id: 0, text: "Why did you choose us?" },
        { id: 1, text: "How often do you use it?" },
      ],
    };
    const { taskId } = await post(spec, REWARD, 2, 2, 1);
    const a = newWorker();

    await survey(taskId, 0n, "It was cheaper than the alternatives.", a);
    check(
      "half a survey pays nothing",
      (await read<bigint>("earned", [idOf(a.address)])) === 0n
    );

    await survey(taskId, 1n, "Two or three times a week.", a);
    check(
      "completed survey pays for every question",
      (await read<bigint>("earned", [idOf(a.address)])) === REWARD * 2n,
      formatUnits(await read<bigint>("earned", [idOf(a.address)]), 6) + " DUSD"
    );

    const answers = await read<string[]>("surveyResponse", [taskId, idOf(a.address)]);
    check(
      "requester can read the response back",
      answers[0] === "It was cheaper than the alternatives." &&
        answers[1] === "Two or three times a week."
    );
  }

  console.log(
    `\n${failures === 0 ? "all modes behave correctly on-chain" : `${failures} FAILED`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
