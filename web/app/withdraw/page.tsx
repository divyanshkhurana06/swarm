"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  createPublicClient,
  decodeEventLog,
  formatUnits,
  http,
  isAddress,
  type Hex,
} from "viem";
import {
  chain,
  TASK_POOL,
  taskPoolAbi,
  DUSD_DECIMALS,
  explorerTx,
} from "@/lib/contracts";
import {
  loadIdentity,
  serializeSignature,
  sign,
  withdrawChallenge,
  type Identity,
} from "@/lib/passkey";

/**
 * Cash out.
 *
 * The passkey holds no money -- it cannot. Earnings live in TaskPool's ledger,
 * keyed by the passkey's public key. This screen signs a withdrawal naming a
 * destination, and the contract pays out to whatever address the worker picks.
 *
 * That address is chosen here, at cash-out time, which is the whole reason a
 * worker never needed a wallet to start earning in the first place.
 */

const publicClient = createPublicClient({ chain, transport: http() });

export default function Withdraw() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [balance, setBalance] = useState<bigint>(0n);
  const [nonce, setNonce] = useState<bigint>(0n);
  const [minimum, setMinimum] = useState<bigint>(50_000n);
  const [receiptId, setReceiptId] = useState<bigint | null>(null);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [done, setDone] = useState<{ hash: Hex; amount: bigint } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIdentity(loadIdentity());
  }, []);

  useEffect(() => {
    if (!identity) return;
    // The nonce is fetched here rather than inside the click handler on
    // purpose: iOS consumes the user gesture across an await, so any network
    // round trip before navigator.credentials.get() makes Face ID fail with
    // NotAllowedError. Everything the signature needs must be ready before
    // the user taps.
    const sync = () =>
      Promise.all([
        publicClient.readContract({
          address: TASK_POOL,
          abi: taskPoolAbi,
          functionName: "balanceOf",
          args: [identity.workerId],
        }),
        publicClient.readContract({
          address: TASK_POOL,
          abi: taskPoolAbi,
          functionName: "nonces",
          args: [identity.workerId],
        }),
        publicClient.readContract({
          address: TASK_POOL,
          abi: taskPoolAbi,
          functionName: "MIN_WITHDRAWAL",
        }),
      ])
        .then(([bal, n, min]) => {
          setBalance(bal);
          setNonce(n);
          setMinimum(min);
        })
        .catch((e) => console.error("withdraw screen read failed:", e));

    sync();
    const t = setInterval(sync, 5000);
    return () => clearInterval(t);
  }, [identity]);

  const withdraw = useCallback(async () => {
    if (!identity) return;
    const destination = to.trim();

    if (!isAddress(destination)) {
      setError("That doesn't look like a valid address (should start 0x, 42 chars)");
      return;
    }

    if (balance < minimum) {
      setError(
        `Minimum cash-out is $${formatUnits(minimum, DUSD_DECIMALS)}. ` +
          `Answer a few more to get there.`
      );
      return;
    }

    setError(null);
    setBusy(true);
    try {
      // Face ID first, with no await before it -- see the note on the nonce
      // fetch above. The nonce is part of the challenge, so a withdrawal
      // signature cannot be replayed to drain the balance twice.
      setStatus("Confirm with Face ID…");
      const sig = await sign(
        withdrawChallenge(destination as Hex, nonce),
        identity.credentialId
      );

      setStatus("Sending…");
      const res = await fetch("/api/relay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "withdraw",
          workerId: identity.workerId,
          to: destination,
          sig: serializeSignature(sig),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Withdrawal failed");

      setStatus("Confirming on Monad…");
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: json.hash,
      });

      // Pull the receipt NFT id out of the Withdrawn event so we can link to it.
      for (const log of receipt.logs) {
        try {
          const parsed = decodeEventLog({
            abi: taskPoolAbi,
            data: log.data,
            topics: log.topics,
          });
          if (parsed.eventName === "Withdrawn") {
            setReceiptId((parsed.args as { receiptId: bigint }).receiptId);
          }
        } catch {
          // Other contracts' logs are in here too; ignore what we can't parse.
        }
      }

      setDone({ hash: json.hash, amount: balance });
      setBalance(0n);
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [identity, to, balance]);

  const money = (v: bigint) => `$${formatUnits(v, DUSD_DECIMALS)}`;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 p-6">
      <Link href="/" className="text-sm text-zinc-500">
        ← Back to earning
      </Link>

      {!identity ? (
        <p className="text-zinc-400">
          No passkey on this device yet. Head back and answer a few questions
          first.
        </p>
      ) : done ? (
        <div className="flex-1 flex flex-col justify-center gap-4 text-center">
          <div className="text-5xl">✓</div>
          <h1 className="text-2xl font-semibold">Sent</h1>
          <p className="text-zinc-400">
            {money(done.amount)} is on its way to
            <br />
            <span className="font-mono text-sm text-zinc-300">{to}</span>
          </p>
          {receiptId !== null && (
            <p className="text-sm text-zinc-400">
              Receipt NFT{" "}
              <span className="font-mono text-zinc-200">#{receiptId.toString()}</span>{" "}
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
        </div>
      ) : (
        <div className="flex-1 flex flex-col justify-center gap-8">
          <div>
            <div className="text-xs uppercase tracking-widest text-zinc-500">
              Ready to withdraw
            </div>
            <div className="mt-1 text-5xl font-semibold tabular-nums text-emerald-400">
              {money(balance)}
            </div>
          </div>

          <div className="space-y-3">
            <label
              htmlFor="destination"
              className="block text-sm text-zinc-400"
            >
              Send it where?
            </label>
            <input
              id="destination"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="0x…"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-4 font-mono text-sm outline-none focus:border-zinc-600"
            />
            <p className="text-xs leading-relaxed text-zinc-600">
              Any address works — a wallet, an exchange deposit address, a
              friend&apos;s. You never needed one to earn; you only need one to
              cash out. You&apos;ll also get a receipt NFT at the same address,
              which shows up in a wallet without importing anything.
            </p>
          </div>

          <button
            onClick={withdraw}
            disabled={busy || balance < minimum}
            className="w-full rounded-2xl bg-emerald-500 py-5 text-lg font-semibold text-zinc-950 active:scale-[0.98] transition disabled:opacity-40"
          >
            {busy
              ? (status ?? "Working…")
              : balance < minimum
                ? `Minimum is ${money(minimum)}`
                : `Withdraw ${money(balance)}`}
          </button>

          {error && (
            <div className="rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}
        </div>
      )}
    </main>
  );
}
