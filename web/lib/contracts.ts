import { defineChain, parseAbi } from "viem";

/** https://docs.monad.xyz/developer-essentials/testnets */
export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
  blockExplorers: {
    default: { name: "MonadVision", url: "https://testnet.monadvision.com" },
  },
  contracts: {
    // Canonical Multicall3. viem will not batch reads unless the chain
    // declares it, and without batching the task list fires ~30 requests at
    // once and gets rate limited.
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" as const },
  },
  testnet: true,
});

/** https://docs.monad.xyz/developer-essentials/network-information */
export const monadMainnet = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } },
  blockExplorers: {
    default: { name: "MonadVision", url: "https://monadvision.com" },
  },
  contracts: {
    // Canonical Multicall3. viem will not batch reads unless the chain
    // declares it, and without batching the task list fires ~30 requests at
    // once and gets rate limited.
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" as const },
  },
});

export const chain =
  process.env.NEXT_PUBLIC_CHAIN === "mainnet" ? monadMainnet : monadTestnet;

export const TASK_POOL = process.env.NEXT_PUBLIC_TASK_POOL as `0x${string}`;
export const DEMO_USD = process.env.NEXT_PUBLIC_DEMO_USD as `0x${string}`;
export const TASK_ID = BigInt(process.env.NEXT_PUBLIC_TASK_ID ?? "0");

/** Reward per label, in DUSD's 6 decimals. Read from chain at runtime. */
export const DUSD_DECIMALS = 6;

export const taskPoolAbi = parseAbi([
  "struct WebAuthnSignature { bytes authenticatorData; bytes clientDataJSON; uint256 challengeIndex; uint256 r; uint256 s; }",
  "struct PubKey { uint256 x; uint256 y; }",
  "struct Task { address requester; uint96 rewardPerLabel; uint128 funded; uint128 paidOut; uint64 labelCount; bool open; uint8 mode; uint8 quorum; }",

  "function registerWorker(PubKey pk, bytes32 credentialHash) returns (bytes32)",
  "function submitLabel(uint256 taskId, uint256 itemId, uint8 answer, bytes32 workerId, WebAuthnSignature sig)",
  "function withdraw(bytes32 workerId, address to, WebAuthnSignature sig) returns (uint256)",

  // Embedded-wallet (Google sign-in) path. Same ledger, secp256k1 instead of P256.
  "function submitLabelFor(uint256 taskId, uint256 itemId, uint8 answer, address worker, bytes signature)",
  "function submitBoxFor(uint256 taskId, uint256 itemId, uint64 box, address worker, bytes signature)",
  "function boxDigest(uint256 taskId, uint256 itemId, uint64 box) view returns (bytes32)",
  "function boxOf(uint256, uint256, bytes32) view returns (uint64)",
  "function boxes(uint256 taskId, bytes32[] workerIds) view returns (uint64[])",
  "function withdrawFor(address worker, address to, bytes signature) returns (uint256)",
  "function idOfAddress(address worker) pure returns (bytes32)",

  // Requester side. Task specs live on-chain, so a worker needs no backend.
  "function postTaskSponsored(string spec, uint96 rewardPerLabel, uint128 amount, uint32 items, uint8 mode, uint8 quorum, address requester, bytes signature) returns (uint256)",
  "function postDigest(string spec, uint96 rewardPerLabel, uint128 amount, uint32 items, uint8 mode, uint8 quorum) view returns (bytes32)",
  "function submitSurveyFor(uint256 taskId, uint256 itemId, string answer, address worker, bytes signature)",
  "function surveyDigest(uint256 taskId, uint256 itemId, string answer) view returns (bytes32)",
  "function surveyResponse(uint256 taskId, bytes32 workerId) view returns (string[])",
  "function respondents(uint256 taskId) view returns (bytes32[])",
  "function respondentCount(uint256 taskId) view returns (uint256)",
  "function answeredCount(uint256, bytes32) view returns (uint32)",
  "function surveyPaid(uint256, bytes32) view returns (bool)",
  "function resolved(uint256, uint256) view returns (bool)",
  "function voteOf(uint256, uint256, bytes32) view returns (uint8)",
  "function taskSpec(uint256) view returns (string)",
  "function itemCount(uint256) view returns (uint32)",
  "function tally(uint256, uint256, uint8) view returns (uint32)",
  "function results(uint256 taskId) view returns (uint32[] zeros, uint32[] ones)",
  "function labelDigest(uint256 taskId, uint256 itemId, uint8 answer) view returns (bytes32)",
  "function withdrawDigest(address worker, address to) view returns (bytes32)",

  "function isRegistered(bytes32) view returns (bool)",
  "function earned(bytes32) view returns (uint256)",
  "function balanceOf(bytes32) view returns (uint256)",
  "function nonces(bytes32) view returns (uint256)",
  "function hasLabeled(uint256, bytes32, uint256) view returns (bool)",
  "function totalLabels() view returns (uint256)",
  "function totalPaid() view returns (uint256)",
  "function workerCount() view returns (uint256)",
  "function taskCount() view returns (uint256)",
  "function tasks(uint256) view returns (Task)",
  "function remaining(uint256) view returns (uint256)",
  "function idOf(PubKey pk) pure returns (bytes32)",
  "function token() view returns (address)",
  "function receipts() view returns (address)",
  "function MIN_WITHDRAWAL() view returns (uint256)",
  "function answersBy(bytes32) view returns (uint64)",

  // The client computes these locally to avoid a round trip per swipe; they
  // are exposed so the encoding can be diffed against Solidity in tests.
  "function workerOf(bytes32 credentialHash) view returns (bytes32)",
  "function labelChallenge(uint256 taskId, uint256 itemId, uint8 answer) view returns (bytes32)",
  "function withdrawChallenge(bytes32 workerId, address to) view returns (bytes32)",

  "event LabelSubmitted(uint256 indexed taskId, bytes32 indexed workerId, uint256 itemId, uint8 answer, uint256 reward, uint256 totalLabels)",
  "event WorkerRegistered(bytes32 indexed workerId, uint256 x, uint256 y)",
  "event Withdrawn(bytes32 indexed workerId, address indexed to, uint256 amount, uint256 receiptId)",
  "event ItemResolved(uint256 indexed taskId, uint256 indexed itemId, uint8 majority, uint256 paidWorkers)",
  "event Paid(uint256 indexed taskId, bytes32 indexed workerId, uint256 amount)",
  "event SurveyCompleted(uint256 indexed taskId, bytes32 indexed workerId, uint256 amount)",
]);

export const explorerTx = (hash: string) =>
  `${chain.blockExplorers.default.url}/tx/${hash}`;
