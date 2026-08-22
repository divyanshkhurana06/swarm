"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createPublicClient, http, formatUnits, type Hex } from "viem";
import {
  chain,
  TASK_POOL,
  TASK_ID,
  taskPoolAbi,
  DUSD_DECIMALS,
  explorerTx,
} from "@/lib/contracts";
import {
  clearIdentity,
  createIdentity,
  credentialHashOf,
  isSupported,
  labelChallenge,
  loadIdentity,
  saveIdentity,
  serializeSignature,
  sign,
  signInWithPasskey,
  type Identity,
} from "@/lib/passkey";

type Item = { id: number; text: string };
type Manifest = {
  title: string;
  question: string;
  answers: Record<string, string>;
  items: Item[];
};

type Receipt = { hash: Hex; reward: bigint; at: number };

const publicClient = createPublicClient({ chain, transport: http() });

export default function Worker() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  /**
   * Items this worker has not answered yet.
   *
   * The contract allows one answer per worker per item, so walking the
   * manifest from index 0 on every page load meant a reload re-submitted an
   * answered item and reverted with AlreadyLabeled. What has been answered
   * lives on-chain, so ask the chain rather than trusting a counter in memory.
   */
  const [queue, setQueue] = useState<Item[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [reward, setReward] = useState<bigint>(0n);
  const [earned, setEarned] = useState<bigint>(0n);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Answers are optimistic: we credit the balance the moment the relayer
  // accepts the transaction, and reconcile against the chain in the background.
  const pending = useRef(0);

  useEffect(() => {
    // localStorage is a cache, not the source of truth. A stored identity can
    // be stale -- pointing at a worker that does not exist on the contract we
    // are currently talking to. Trusting it blindly renders a working screen
    // where every answer reverts with NotRegistered, which looks to the user
    // like their money vanished. Verify before trusting.
    const stored = loadIdentity();
    if (stored) {
      publicClient
        .readContract({
          address: TASK_POOL,
          abi: taskPoolAbi,
          functionName: "isRegistered",
          args: [stored.workerId],
        })
        .then((registered) => {
          if (registered) {
            setIdentity(stored);
          } else {
            // Their passkey may still be recoverable via "I've been here
            // before"; drop only the stale cache entry.
            clearIdentity();
            setIdentity(null);
          }
        })
        // A network hiccup shouldn't lock someone out of work they can do.
        .catch(() => setIdentity(stored));
    }

    fetch("/manifest/moderation.json")
      .then((r) => r.json())
      .then(setManifest)
      .catch(() => setError("Could not load the task manifest"));

    publicClient
      .readContract({
        address: TASK_POOL,
        abi: taskPoolAbi,
        functionName: "tasks",
        args: [TASK_ID],
      })
      .then((t) => setReward(BigInt(t.rewardPerLabel)))
      .catch(() => {});
  }, []);

  // Build the work queue from what this worker has NOT already answered.
  useEffect(() => {
    if (!identity || !manifest) return;
    let cancelled = false;

    Promise.all(
      manifest.items.map((item) =>
        publicClient
          .readContract({
            address: TASK_POOL,
            abi: taskPoolAbi,
            functionName: "hasLabeled",
            args: [TASK_ID, identity.workerId, BigInt(item.id)],
          })
          .then((done) => (done ? null : item))
          // If the check itself fails, offer the item; a duplicate submission
          // is rejected on-chain anyway and we handle that below.
          .catch(() => item)
      )
    ).then((results) => {
      if (cancelled) return;
      setQueue(results.filter((i): i is Item => i !== null));
      setCursor(0);
    });

    return () => {
      cancelled = true;
    };
  }, [identity, manifest]);

  // Reconcile the optimistic balance with what the contract actually says.
  useEffect(() => {
    if (!identity) return;
    const sync = () =>
      publicClient
        .readContract({
          address: TASK_POOL,
          abi: taskPoolAbi,
          functionName: "earned",
          args: [identity.workerId],
        })
        .then((onChain) => {
          // Never move the number backwards while answers are still in flight.
          if (pending.current === 0) setEarned(onChain);
        })
        .catch(() => {});

    sync();
    const t = setInterval(sync, 4000);
    return () => clearInterval(t);
  }, [identity]);

  const start = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      setStatus("Creating your passkey…");
      const id = await createIdentity();
      const credentialHash = credentialHashOf(id.credentialId);

      setStatus("Registering on Monad…");
      const res = await fetch("/api/relay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "register",
          x: id.pubkey!.x.toString(),
          y: id.pubkey!.y.toString(),
          credentialHash,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Registration failed");

      // Labels are rejected until registration is mined, so wait this once.
      setStatus("Confirming…");
      await publicClient.waitForTransactionReceipt({ hash: json.hash });

      setIdentity(id);
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * Recover an existing worker identity from the passkey itself.
   *
   * Storing the identity only in localStorage meant a cleared cache, a
   * different browser, or a second tap on "Start earning" silently created a
   * new worker and orphaned the balance. The chain is the source of truth.
   */
  const signIn = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      setStatus("Confirm with Face ID…");
      const { credentialId, credentialHash } = await signInWithPasskey();

      setStatus("Finding your account…");
      const workerId = await publicClient.readContract({
        address: TASK_POOL,
        abi: taskPoolAbi,
        functionName: "workerOf",
        args: [credentialHash],
      });

      if (
        workerId ===
        "0x0000000000000000000000000000000000000000000000000000000000000000"
      ) {
        // Almost always means the chosen passkey belongs to an earlier
        // deployment. Name the credential so the failure is diagnosable
        // rather than mysterious.
        throw new Error(
          `That passkey (${credentialHash.slice(0, 10)}…) has no account on ` +
            `contract ${TASK_POOL.slice(0, 6)}…${TASK_POOL.slice(-4)}. ` +
            `It's probably from an older version — tap "Start earning" to make a new one.`
        );
      }

      const restored = { credentialId, workerId };
      saveIdentity(restored);
      setIdentity(restored);
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const answer = useCallback(
    async (value: number) => {
      if (!identity || !queue || busy) return;
      const item = queue[cursor];
      if (!item) return;

      setError(null);
      setBusy(true);
      pending.current += 1;

      try {
        const sig = await sign(
          labelChallenge(TASK_ID, BigInt(item.id), value),
          identity.credentialId
        );

        // Advance immediately -- the next card should be up before the
        // transaction lands, or this feels slower than the chain is.
        setCursor((c) => c + 1);
        setEarned((e) => e + reward);

        const res = await fetch("/api/relay", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "label",
            taskId: TASK_ID.toString(),
            itemId: item.id.toString(),
            answer: value,
            workerId: identity.workerId,
            sig: serializeSignature(sig),
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Submission failed");

        setReceipts((r) =>
          [{ hash: json.hash as Hex, reward, at: Date.now() }, ...r].slice(0, 6)
        );
      } catch (e) {
        setEarned((v) => (v >= reward ? v - reward : 0n));
        const message = e instanceof Error ? e.message : String(e);
        // One answer per worker per item. If this item was already answered
        // (a stale queue, a double tap), just move on -- it is not an error
        // the worker can do anything about.
        if (!/AlreadyLabeled/i.test(message)) {
          setError(message);
        }
      } finally {
        pending.current -= 1;
        setBusy(false);
      }
    },
    [identity, queue, cursor, reward, busy]
  );

  const money = (v: bigint) => `$${formatUnits(v, DUSD_DECIMALS)}`;

  if (!isSupported() && typeof window !== "undefined") {
    return (
      <Shell>
        <p className="text-zinc-400">
          This browser has no passkey support. Open it on a phone with Face ID or
          a fingerprint reader.
        </p>
      </Shell>
    );
  }

  // --- onboarding ---------------------------------------------------------

  if (!identity) {
    return (
      <Shell>
        <div className="flex-1 flex flex-col justify-center gap-8">
          <div>
            <h1 className="text-4xl font-semibold tracking-tight">Swarm</h1>
            <p className="mt-3 text-lg text-zinc-400 leading-snug">
              Do a few seconds of work. Get paid instantly, on-chain.
            </p>
          </div>

          <ul className="space-y-2.5 text-zinc-400">
            {[
              "No wallet. No signup. No seed phrase.",
              "One Face ID tap and you're earning.",
              "Every answer is paid the moment you give it.",
            ].map((line) => (
              <li key={line} className="flex gap-3">
                <span className="text-emerald-400">—</span>
                {line}
              </li>
            ))}
          </ul>

          <div className="space-y-3">
            <button
              onClick={start}
              disabled={busy}
              className="w-full rounded-2xl bg-emerald-500 py-5 text-lg font-semibold text-zinc-950 active:scale-[0.98] transition disabled:opacity-50"
            >
              {busy ? (status ?? "Working…") : "Start earning"}
            </button>

            <button
              onClick={signIn}
              disabled={busy}
              className="w-full rounded-2xl border border-zinc-800 py-4 text-zinc-400 active:scale-[0.98] transition disabled:opacity-50"
            >
              I&apos;ve been here before
            </button>
          </div>

          {error && <ErrorBox message={error} />}
        </div>
        <Footer />
      </Shell>
    );
  }

  // --- working ------------------------------------------------------------

  const item = queue?.[cursor];

  return (
    <Shell>
      <header className="flex items-baseline justify-between">
        <div>
          <div className="text-xs uppercase tracking-widest text-zinc-500">
            Earned
          </div>
          <div className="text-3xl font-semibold tabular-nums text-emerald-400">
            {money(earned)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-widest text-zinc-500">
            Per answer
          </div>
          <div className="text-lg tabular-nums text-zinc-300">{money(reward)}</div>
          {earned > 0n && (
            <Link
              href="/withdraw"
              className="mt-1 inline-block text-sm text-emerald-500 underline underline-offset-4"
            >
              Cash out
            </Link>
          )}
        </div>
      </header>

      {item ? (
        <div className="flex-1 flex flex-col justify-center gap-6">
          <div>
            <p className="text-sm text-zinc-500">{manifest?.question}</p>
            <div
              key={item.id}
              className="animate-pop mt-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-6 text-lg leading-relaxed"
            >
              {item.text}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => answer(0)}
              disabled={busy}
              className="rounded-2xl border border-zinc-700 bg-zinc-900 py-6 text-lg font-medium active:scale-[0.97] transition disabled:opacity-40"
            >
              {manifest?.answers["0"]}
            </button>
            <button
              onClick={() => answer(1)}
              disabled={busy}
              className="rounded-2xl bg-amber-500 py-6 text-lg font-semibold text-zinc-950 active:scale-[0.97] transition disabled:opacity-40"
            >
              {manifest?.answers["1"]}
            </button>
          </div>

          <p className="text-center text-xs text-zinc-600">
            {busy ? "Confirm with Face ID…" : `${queue!.length - cursor} left`}
          </p>
        </div>
      ) : queue === null ? (
        <div className="flex-1 flex items-center justify-center text-zinc-600">
          Finding what you haven&apos;t answered yet…
        </div>
      ) : (
        <div className="flex-1 flex flex-col justify-center text-center gap-3">
          <div className="text-2xl font-semibold">That&apos;s the batch.</div>
          <p className="text-zinc-400">
            You earned {money(earned)}. It&apos;s already on-chain — withdraw it to
            any address whenever you like.
          </p>
          {earned > 0n && (
            <Link
              href="/withdraw"
              className="mt-2 rounded-2xl bg-emerald-500 py-4 text-lg font-semibold text-zinc-950"
            >
              Cash out {money(earned)}
            </Link>
          )}
        </div>
      )}

      {error && <ErrorBox message={error} />}

      {receipts.length > 0 && (
        <div className="mt-4 space-y-1.5">
          {receipts.map((r) => (
            <a
              key={r.hash}
              href={explorerTx(r.hash)}
              target="_blank"
              rel="noreferrer"
              className="animate-slide-in flex items-center justify-between rounded-lg bg-zinc-900/60 px-3 py-2 font-mono text-xs text-zinc-500"
            >
              <span className="text-emerald-500">+{money(r.reward)}</span>
              <span>{r.hash.slice(0, 10)}…</span>
            </a>
          ))}
        </div>
      )}

      <Footer />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 p-6">
      {children}
    </main>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
      {message}
    </div>
  );
}

function Footer() {
  return (
    <footer className="pt-2 text-center text-xs text-zinc-700">
      Paid in DUSD on {chain.name} · every answer verified by your passkey on-chain
    </footer>
  );
}
