import { NextResponse } from "next/server";
import { createWalletClient, createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount, nonceManager } from "viem/accounts";
import { chain, TASK_POOL, taskPoolAbi } from "@/lib/contracts";

/**
 * Gas relayer.
 *
 * Workers have no MON and no wallet, so somebody has to pay gas. This route
 * holds a funded key and submits transactions on their behalf.
 *
 * This is safe because the *contract* verifies the worker's passkey signature.
 * The relayer is a postman: it cannot forge a label, redirect a payout, or
 * touch a worker's balance. The worst it can do is refuse to deliver -- and a
 * worker can always submit the same signed payload themselves.
 */

const RPC = process.env.RPC_URL || chain.rpcUrls.default.http[0];

// A single EOA submitting hundreds of concurrent transactions will collide on
// nonces unless they are handed out in order. viem's nonce manager serialises
// allocation in-process. Past a few hundred transactions per minute the right
// answer is a pool of relayer keys; one key is enough for a room.
const account = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex, {
  nonceManager,
});

const wallet = createWalletClient({ account, chain, transport: http(RPC) });
const publicClient = createPublicClient({ chain, transport: http(RPC) });

type SigPayload = {
  authenticatorData: Hex;
  clientDataJSON: Hex;
  challengeIndex: string;
  r: string;
  s: string;
};

function toSig(p: SigPayload) {
  return {
    authenticatorData: p.authenticatorData,
    clientDataJSON: p.clientDataJSON,
    challengeIndex: BigInt(p.challengeIndex),
    r: BigInt(p.r),
    s: BigInt(p.s),
  };
}

export async function POST(req: Request) {
  if (!process.env.RELAYER_PRIVATE_KEY) {
    return NextResponse.json({ error: "Relayer is not configured" }, { status: 500 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { action, sig } = body as { action?: string; sig?: SigPayload };
  if (!action) {
    return NextResponse.json({ error: "Missing action" }, { status: 400 });
  }
  // Registration is a single WebAuthn ceremony and carries no assertion;
  // everything else must be signed.
  if (action !== "register" && !sig) {
    return NextResponse.json({ error: "Missing sig" }, { status: 400 });
  }

  try {
    let hash: Hex;

    switch (action) {
      case "register": {
        const { x, y, credentialHash } = body as unknown as {
          x: string;
          y: string;
          credentialHash: Hex;
        };
        hash = await wallet.writeContract({
          address: TASK_POOL,
          abi: taskPoolAbi,
          functionName: "registerWorker",
          args: [{ x: BigInt(x), y: BigInt(y) }, credentialHash],
        });
        break;
      }

      case "label": {
        const { taskId, itemId, answer, workerId } = body as unknown as {
          taskId: string;
          itemId: string;
          answer: number;
          workerId: Hex;
        };
        hash = await wallet.writeContract({
          address: TASK_POOL,
          abi: taskPoolAbi,
          functionName: "submitLabel",
          args: [BigInt(taskId), BigInt(itemId), Number(answer), workerId, toSig(sig!)],
        });
        break;
      }

      case "withdraw": {
        const { workerId, to } = body as unknown as { workerId: Hex; to: Hex };
        hash = await wallet.writeContract({
          address: TASK_POOL,
          abi: taskPoolAbi,
          functionName: "withdraw",
          args: [workerId, to, toSig(sig!)],
        });
        break;
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }

    // Return as soon as it is accepted. Waiting for a receipt on every swipe
    // would make the UI feel slower than the chain actually is.
    return NextResponse.json({ hash });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`relay ${action} failed:`, message);
    return NextResponse.json({ error: message.split("\n")[0] }, { status: 500 });
  }
}

/** Health check: is the relayer funded enough to keep the demo alive? */
export async function GET() {
  if (!process.env.RELAYER_PRIVATE_KEY) {
    return NextResponse.json({ configured: false });
  }
  const balance = await publicClient.getBalance({ address: account.address });
  return NextResponse.json({
    configured: true,
    relayer: account.address,
    balanceWei: balance.toString(),
    balanceMon: Number(balance) / 1e18,
    chainId: chain.id,
  });
}
