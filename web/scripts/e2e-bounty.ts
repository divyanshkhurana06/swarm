/** The bounty flow against the deployed contract: draw, claim, race, export. */
import {
  createPublicClient, createWalletClient, http, formatUnits, type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { chain, TASK_POOL, taskPoolAbi } from "../lib/contracts";
import { packBox, unpackBox } from "../lib/images";
import { encodePacked, keccak256 } from "viem";

const publicClient = createPublicClient({ chain, transport: http() });
const relayer = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex);
const relay = createWalletClient({ account: relayer, chain, transport: http() });
const domain = { name: "Swarm", version: "1", chainId: chain.id, verifyingContract: TASK_POOL } as const;

const read = <T,>(fn: string, args: readonly unknown[] = []) =>
  publicClient.readContract({ address: TASK_POOL, abi: taskPoolAbi, functionName: fn as never, args: args as never }) as Promise<T>;

async function send(fn: string, args: readonly unknown[]) {
  const hash = await relay.writeContract({ address: TASK_POOL, abi: taskPoolAbi, functionName: fn as never, args: args as never });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${fn} reverted`);
}

const idOf = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`.toLowerCase() as Hex;
let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) failures++;
};

async function main() {
  console.log(`TaskPool ${TASK_POOL}\n`);
  const requester = privateKeyToAccount(generatePrivateKey());
  const spec = JSON.stringify({
    title: "e2e bounty", question: "Box the car", kind: "bbox",
    answers: { "0": "Nothing here", "1": "Found it" },
    items: [{ id: 0, text: "https://example.com/a.jpg" }, { id: 1, text: "https://example.com/b.jpg" }],
  });
  const reward = 50_000n, amount = reward * 2n;
  const sig = await requester.signTypedData({
    domain,
    types: { PostTask: [
      { name: "spec", type: "string" }, { name: "rewardPerLabel", type: "uint96" },
      { name: "amount", type: "uint128" }, { name: "items", type: "uint32" },
      { name: "mode", type: "uint8" }, { name: "quorum", type: "uint8" },
    ] },
    primaryType: "PostTask",
    message: { spec, rewardPerLabel: reward, amount, items: 2, mode: 0, quorum: 1 },
  });
  const taskId = await read<bigint>("taskCount");
  await send("postTaskSponsored", [spec, reward, amount, 2, 0, 1, requester.address, sig]);
  console.log(`posted bounty #${taskId}\n`);

  const Box = [
    { name: "taskId", type: "uint256" }, { name: "itemId", type: "uint256" },
    { name: "boxesHash", type: "bytes32" },
  ] as const;
  const drawBy = async (w: ReturnType<typeof privateKeyToAccount>, item: bigint, packed: bigint[]) => {
    // abi.encodePacked pads array elements to 32 bytes -- see lib/wallet.ts.
    const boxesHash = keccak256(encodePacked(packed.map(() => "uint256"), packed));
    const s = await w.signTypedData({ domain, types: { Box }, primaryType: "Box", message: { taskId, itemId: item, boxesHash } });
    await send("submitBoxesFor", [taskId, item, packed, w.address, s]);
  };

  const alice = privateKeyToAccount(generatePrivateKey());
  const bob = privateKeyToAccount(generatePrivateKey());

  // A box drawn on a phone, in basis points of the image.
  // Three cars in one street scene.
  const drawn = [
    { x: 1200, y: 3400, w: 2500, h: 1800 },
    { x: 4000, y: 3000, w: 1500, h: 1200 },
    { x: 7000, y: 3600, w: 1800, h: 1400 },
  ];
  await drawBy(alice, 0n, drawn.map(packBox));

  const stored = await read<readonly bigint[]>("boxesOf", [taskId, 0n, idOf(alice.address)]);
  check("every box on the image is kept", stored.length === 3, `${stored.length} stored`);
  const back = unpackBox(stored[0]);
  check("the exact coordinates survive the round trip",
    back?.x === drawn[0].x && back?.y === drawn[0].y && back?.w === drawn[0].w && back?.h === drawn[0].h,
    JSON.stringify(back));
  check("claiming a bounty pays immediately",
    (await read<bigint>("earned", [idOf(alice.address)])) === reward,
    formatUnits(await read<bigint>("earned", [idOf(alice.address)]), 6) + " DUSD");

  let raced = false;
  try { await drawBy(bob, 0n, [packBox({ x: 1, y: 1, w: 900, h: 900 })]); } catch { raced = true; }
  check("first come, first served — the image is closed to everyone else", raced);

  // "Nothing here" is a real answer.
  await drawBy(bob, 1n, []);
  check("an honest 'nothing here' is paid too",
    (await read<bigint>("earned", [idOf(bob.address)])) === reward);
  check("and is recorded as nothing-found, not as a box",
    (await read<readonly bigint[]>("boxesOf", [taskId, 1n, idOf(bob.address)])).length === 0);

  // A receipt is minted when a worker *finishes* a task, so give Carol a
  // whole task of her own rather than half of Alice and Bob's.
  const carol = privateKeyToAccount(generatePrivateKey());
  const spec2 = JSON.stringify({
    title: "e2e receipt", question: "Box the car", kind: "bbox",
    answers: { "0": "Nothing here", "1": "Found it" },
    items: [{ id: 0, text: "https://example.com/c.jpg" }],
  });
  const sig2 = await requester.signTypedData({
    domain,
    types: { PostTask: [
      { name: "spec", type: "string" }, { name: "rewardPerLabel", type: "uint96" },
      { name: "amount", type: "uint128" }, { name: "items", type: "uint32" },
      { name: "mode", type: "uint8" }, { name: "quorum", type: "uint8" },
    ] },
    primaryType: "PostTask",
    message: { spec: spec2, rewardPerLabel: reward, amount: reward, items: 1, mode: 0, quorum: 1 },
  });
  const task2 = await read<bigint>("taskCount");
  await send("postTaskSponsored", [spec2, reward, reward, 1, 0, 1, requester.address, sig2]);

  {
    const packed = [packBox({ x: 10, y: 10, w: 500, h: 500 })];
    const boxesHash = keccak256(encodePacked(packed.map(() => "uint256"), packed));
    const sg = await carol.signTypedData({ domain, types: { Box }, primaryType: "Box", message: { taskId: task2, itemId: 0n, boxesHash } });
    await send("submitBoxesFor", [task2, 0n, packed, carol.address, sg]);
  }

  const receipts = await read<Hex>("receipts");
  const nftAbi = [
    { name: "receiptOf", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint128" }, { type: "uint64" }, { type: "uint64" }] },
    { name: "kindOf", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "string" }] },
    { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  ] as const;
  const supply = await publicClient.readContract({ address: receipts, abi: nftAbi, functionName: "totalSupply" });
  const [amt, ans] = await publicClient.readContract({ address: receipts, abi: nftAbi, functionName: "receiptOf", args: [supply] });
  const kind = await publicClient.readContract({ address: receipts, abi: nftAbi, functionName: "kindOf", args: [supply] });
  check("finishing a task mints a receipt for that task alone",
    amt === reward && ans === 1n, `${formatUnits(amt, 6)} DUSD for ${ans} answer(s)`);
  check("and says what kind of work it was", kind === "Image bounty", kind);

  const workers = await read<readonly Hex[]>("participants", [taskId]);
  check("both workers are enumerable for export", workers.length === 2);
  const flat = await read<readonly bigint[]>("boxes", [taskId, workers]);
  check("export returns a box per worker per item", flat.length === workers.length * 2);

  console.log(`\n${failures === 0 ? "the bounty flow works on-chain" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
