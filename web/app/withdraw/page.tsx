"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { decodeEventLog, formatUnits, isAddress, type Hex } from "viem";
import {
  TASK_POOL,
  taskPoolAbi,
  DUSD_DECIMALS,
  explorerTx,
} from "@/lib/contracts";
import { signWithdraw, type SigningWallet } from "@/lib/wallet";
import { publicClient, workerIdOfAddress } from "@/lib/tasks";
import { Shell, WalletBar } from "@/components/ui";

/**
 * Cash out.
 *
 * Earnings accrue to a ledger in the contract and settle in one transfer.
 * They are deliberately not pushed on every answer: an ERC-20 transfer costs
 * more gas than a half-cent payment moves, so paying out per answer would
 * spend more on delivery than the worker earns.
 *
 * The destination defaults to the worker's own wallet. Privy already created
 * one at sign-in, so asking them to type an address would be asking them to
 * look up something we already know. Sending elsewhere stays possible -- an
 * exchange, a friend -- just not the default.
 */
export default function Page() {
  if (!process.env.NEXT_PUBLIC_PRIVY_APP_ID) {
    return (
      <Shell>
        <p className="text-zinc-400">Sign-in isn&apos;t configured.</p>
      </Shell>
    );
  }
  return <Withdraw />;
}

function Withdraw() {
  const { authenticated } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
  const address = wallet?.address as Hex | undefined;
  const workerId = address ? workerIdOfAddress(address) : undefined;

  const [balance, setBalance] = useState<bigint>(0n);
  const [nonce, setNonce] = useState<bigint>(0n);
  const [minimum, setMinimum] = useState<bigint>(50_000n);
  const [elsewhere, setElsewhere] = useState(false);
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [done, setDone] = useState<{
    hash: Hex;
    amount: bigint;
    to: string;
    receiptId?: bigint;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetched ahead of the tap on purpose: signing can be tied to a user
  // gesture, and an await before the prompt is enough to lose it.
  useEffect(() => {
    if (!workerId) return;
    const sync = () =>
      Promise.all([
        publicClient.readContract({
          address: TASK_POOL,
          abi: taskPoolAbi,
          functionName: "balanceOf",
          args: [workerId],
        }),
        publicClient.readContract({
          address: TASK_POOL,
          abi: taskPoolAbi,
          functionName: "nonces",
          args: [workerId],
        }),
        publicClient.readContract({
          address: TASK_POOL,
          abi: taskPoolAbi,
          functionName: "MIN_WITHDRAWAL",
        }),
      ])
        .then(([bal, n, min]) => {
          setBalance(bal as bigint);
          setNonce(n as bigint);
          setMinimum(min as bigint);
        })
        .catch((e) => console.error("withdraw read failed:", e));

    sync();
    const t = setInterval(sync, 5000);
    return () => clearInterval(t);
  }, [workerId]);

  const withdraw = useCallback(
    async (destination: string) => {
      if (!wallet || !address) return;
      if (!isAddress(destination)) {
        setError("That doesn't look like a valid address");
        return;
      }
      if (balance < minimum) {
        setError(
          `Minimum cash-out is $${formatUnits(minimum, DUSD_DECIMALS)} — answer a few more.`
        );
        return;
      }

      setError(null);
      setBusy(true);
      try {
        setStatus("Approve in your wallet…");
        const signature = await signWithdraw(
          wallet as unknown as SigningWallet,
          destination as Hex,
          nonce
        );

        setStatus("Sending…");
        const res = await fetch("/api/relay", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "withdrawFor",
            worker: address,
            to: destination,
            signature,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Withdrawal failed");

        setStatus("Confirming on Monad…");
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: json.hash,
        });

        let receiptId: bigint | undefined;
        for (const log of receipt.logs) {
          try {
            const parsed = decodeEventLog({
              abi: taskPoolAbi,
              data: log.data,
              topics: log.topics,
            });
            if (parsed.eventName === "Withdrawn") {
              receiptId = (parsed.args as { receiptId: bigint }).receiptId;
            }
          } catch {
            // Other contracts' logs land here too; ignore what we can't parse.
          }
        }

        setDone({ hash: json.hash, amount: balance, to: destination, receiptId });
        setBalance(0n);
        setStatus(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [wallet, address, balance, minimum, nonce]
  );

  const money = (v: bigint) => `$${formatUnits(v, DUSD_DECIMALS)}`;
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const ready = balance >= minimum;

  if (!authenticated || !address) {
    return (
      <Shell>
        <Link href="/" className="text-sm text-zinc-500">
          ← Back
        </Link>
        <p className="text-zinc-400">
          Not signed in. Head back and answer a few questions first.
        </p>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell>
        <div className="flex-1 flex flex-col justify-center gap-4 text-center">
          <div className="text-5xl">✓</div>
          <h1 className="text-2xl font-semibold">{money(done.amount)} sent</h1>
          <p className="text-zinc-400">
            {done.to.toLowerCase() === address.toLowerCase()
              ? "It's in your wallet."
              : `Sent to ${short(done.to)}`}
          </p>
          {done.receiptId !== undefined && (
            <p className="text-sm text-zinc-500">
              Receipt NFT{" "}
              <span className="font-mono text-zinc-300">
                #{done.receiptId.toString()}
              </span>{" "}
              minted to the same address.
            </p>
          )}
          <a
            href={explorerTx(done.hash)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs text-emerald-500"
          >
            View on explorer ↗
          </a>
          <Link href="/" className="mt-2 text-sm text-zinc-500">
            ← Back to earning
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <WalletBar address={address} />
      <Link href="/" className="text-sm text-zinc-500">
        ← Back to earning
      </Link>

      <div className="flex-1 flex flex-col justify-center gap-8">
        <div>
          <div className="text-xs uppercase tracking-widest text-zinc-500">
            Ready to withdraw
          </div>
          <div className="mt-1 text-5xl font-semibold tabular-nums text-emerald-400">
            {money(balance)}
          </div>
          {!ready && (
            <p className="mt-2 text-sm leading-relaxed text-zinc-500">
              Minimum is {money(minimum)}. Moving a few cents costs more in gas
              than it&apos;s worth, so it&apos;s held until it isn&apos;t.
            </p>
          )}
        </div>

        <div className="space-y-3">
          <button
            onClick={() => withdraw(address)}
            disabled={busy || !ready}
            className="w-full rounded-2xl bg-emerald-500 py-5 text-lg font-semibold text-zinc-950 active:scale-[0.98] transition disabled:opacity-40"
          >
            {busy
              ? (status ?? "Working…")
              : ready
                ? "Deposit to my wallet"
                : `Minimum is ${money(minimum)}`}
          </button>

          <p className="text-center font-mono text-xs text-zinc-600">
            {short(address)} · your wallet
          </p>

          {!elsewhere ? (
            <button
              onClick={() => setElsewhere(true)}
              className="w-full text-center text-sm text-zinc-500 underline underline-offset-4"
            >
              Send somewhere else instead
            </button>
          ) : (
            <div className="space-y-2 pt-2">
              <input
                value={other}
                onChange={(e) => setOther(e.target.value)}
                placeholder="0x…"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 font-mono text-sm outline-none focus:border-zinc-600"
              />
              <button
                onClick={() => withdraw(other.trim())}
                disabled={busy || !ready}
                className="w-full rounded-xl border border-zinc-700 py-3 font-medium disabled:opacity-40"
              >
                Send there
              </button>
              <p className="text-xs leading-relaxed text-zinc-600">
                An exchange deposit address, a friend&apos;s wallet — anywhere.
              </p>
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}
      </div>
    </Shell>
  );
}

