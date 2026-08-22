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
  "struct Task { address requester; uint96 rewardPerLabel; uint128 funded; uint128 paidOut; uint64 labelCount; bool open; }",

  "function registerWorker(PubKey pk, bytes32 credentialHash, WebAuthnSignature sig) returns (bytes32)",
  "function submitLabel(uint256 taskId, uint256 itemId, uint8 answer, bytes32 workerId, WebAuthnSignature sig)",
  "function withdraw(bytes32 workerId, address to, WebAuthnSignature sig)",

  "function isRegistered(bytes32) view returns (bool)",
  "function earned(bytes32) view returns (uint256)",
  "function balanceOf(bytes32) view returns (uint256)",
  "function nonces(bytes32) view returns (uint256)",
  "function hasLabeled(uint256, bytes32, uint256) view returns (bool)",
  "function totalLabels() view returns (uint256)",
  "function totalPaid() view returns (uint256)",
  "function workerCount() view returns (uint256)",
  "function tasks(uint256) view returns (Task)",
  "function remaining(uint256) view returns (uint256)",
  "function idOf(PubKey pk) pure returns (bytes32)",
  "function token() view returns (address)",

  // The client computes these locally to avoid a round trip per swipe; they
  // are exposed so the encoding can be diffed against Solidity in tests.
  "function registerChallenge(PubKey pk, bytes32 credentialHash) view returns (bytes32)",
  "function workerOf(bytes32 credentialHash) view returns (bytes32)",
  "function labelChallenge(uint256 taskId, uint256 itemId, uint8 answer) view returns (bytes32)",
  "function withdrawChallenge(bytes32 workerId, address to) view returns (bytes32)",

  "event LabelSubmitted(uint256 indexed taskId, bytes32 indexed workerId, uint256 itemId, uint8 answer, uint256 reward, uint256 totalLabels)",
  "event WorkerRegistered(bytes32 indexed workerId, uint256 x, uint256 y)",
  "event Withdrawn(bytes32 indexed workerId, address indexed to, uint256 amount)",
]);

export const explorerTx = (hash: string) =>
  `${chain.blockExplorers.default.url}/tx/${hash}`;
