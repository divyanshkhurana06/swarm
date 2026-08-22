/** Posts one task of each kind so the marketplace isn't empty at demo time. */
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, TASK_POOL, taskPoolAbi } from "../lib/contracts";

const publicClient = createPublicClient({ chain, transport: http() });
const account = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex);
const relay = createWalletClient({ account, chain, transport: http() });

const domain = { name: "Swarm", version: "1", chainId: chain.id, verifyingContract: TASK_POOL } as const;
const PostTask = [
  { name: "spec", type: "string" }, { name: "rewardPerLabel", type: "uint96" },
  { name: "amount", type: "uint128" }, { name: "items", type: "uint32" },
  { name: "mode", type: "uint8" }, { name: "quorum", type: "uint8" },
] as const;

async function post(spec: object, reward: bigint, items: number, mode: number, quorum: number) {
  const specJson = JSON.stringify(spec);
  const amount = reward * BigInt(items * quorum);
  const signature = await account.signTypedData({
    domain, types: { PostTask }, primaryType: "PostTask",
    message: { spec: specJson, rewardPerLabel: reward, amount, items, mode, quorum },
  });
  const hash = await relay.writeContract({
    address: TASK_POOL, abi: taskPoolAbi, functionName: "postTaskSponsored",
    args: [specJson, reward, amount, items, mode, quorum, account.address, signature],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  posted "${(spec as {title:string}).title}" (${items} items, mode ${mode}, quorum ${quorum})`);
}

// Priced so the numbers mean something: a 10-image batch is worth 20 cents,
// a 3-question survey 45. At half a cent an answer nobody believes the pitch.
const CENT = 10_000n;
const IMAGE_RATE = 5n * CENT;   // 5c a box: slower than a tap, claimed once
const TEXT_RATE = 3n * CENT;    // 3c, and you carry the risk of the vote
const SURVEY_RATE = 15n * CENT; // 15c a written answer
const img = (id: number, text: string) => ({ id, text });

async function main() {
  await post({
    title: "Dashcam frames",
    question: "Draw a box around any car",
    kind: "bbox",
    answers: { "0": "Nothing here", "1": "Found it" },
    items: [
      img(0, "https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=700"),
      img(1, "https://images.unsplash.com/photo-1502877338535-766e1452684a?w=700"),
      img(2, "https://images.unsplash.com/photo-1493238792000-8113da705763?w=700"),
      img(3, "https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=700"),
      img(4, "https://images.unsplash.com/photo-1541899481282-d53bffe3c35d?w=700"),
      img(5, "https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=700"),
    ],
  }, IMAGE_RATE, 6, 0, 1);

  await post({
    title: "Storefront signs",
    question: "Draw a box around the shop sign",
    kind: "bbox",
    answers: { "0": "Nothing here", "1": "Found it" },
    items: [
      img(0, "https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=700"),
      img(1, "https://images.unsplash.com/photo-1534452203293-494d7ddbf7e0?w=700"),
      img(2, "https://images.unsplash.com/photo-1521737604893-d14cc237f11d?w=700"),
      img(3, "https://images.unsplash.com/photo-1528698827591-e19ccd7bc23d?w=700"),
    ],
  }, IMAGE_RATE, 4, 0, 1);

  await post({
    title: "Support ticket triage",
    question: "Is this ticket urgent?",
    kind: "text",
    answers: { "0": "Not urgent", "1": "Urgent" },
    items: [
      { id: 0, text: "The site is down for all our users right now." },
      { id: 1, text: "How do I change my avatar?" },
      { id: 2, text: "Billing charged me twice this month." },
      { id: 3, text: "Love the new dark mode, thanks!" },
      { id: 4, text: "I can't log in and my demo is in ten minutes." },
      { id: 5, text: "Is there a keyboard shortcut for search?" },
      { id: 6, text: "Production data looks corrupted after the migration." },
      { id: 7, text: "Could you add a dark theme to the mobile app?" },
    ],
  }, TEXT_RATE, 8, 0, 1);

  await post({
    title: "Customer research",
    question: "Answer in your own words — a sentence is fine",
    kind: "survey",
    answers: { "0": "", "1": "" },
    items: [
      { id: 0, text: "What made you choose this product over the alternatives?" },
      { id: 1, text: "How often do you use it in a typical week?" },
      { id: 2, text: "What would make you recommend it to a colleague?" },
    ],
  }, SURVEY_RATE, 3, 2, 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
