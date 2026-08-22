"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { createPublicClient, http, formatUnits, type Hex } from "viem";
import {
  chain,
  TASK_POOL,
  TASK_ID,
  taskPoolAbi,
  DUSD_DECIMALS,
  explorerTx,
} from "@/lib/contracts";
import { signLabel, type SigningWallet } from "@/lib/wallet";

type Item = { id: number; text: string };
type Manifest = {
  title: string;
  question: string;
  answers: Record<string, string>;
  items: Item[];
};

type Paid = { hash: Hex; reward: bigint };

const publicClient = createPublicClient({ chain, transport: http() });
const CONFIGURED = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);

export default function Page() {
  // usePrivy throws outside PrivyProvider, and the provider needs an app id.
  // Branch before any hook runs so a missing env var degrades to a readable
  // message instead of a white screen.
  if (!CONFIGURED) {
    return (
      <Shell>
        <div className="flex-1 flex flex-col justify-center gap-3">
          <h1 className="text-2xl font-semibold">Sign-in isn&apos;t configured</h1>
          <p className="text-zinc-400">
            Set <code className="text-zinc-200">NEXT_PUBLIC_PRIVY_APP_ID</code> and
            reload. The{" "}
            <Link href="/dashboard" className="text-emerald-500 underline">
              dashboard
            </Link>{" "}
            works without it.
          </p>
        </div>
      </Shell>
    );
  }
  return <Worker />;
}

function Worker() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useWallets();

  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [queue, setQueue] = useState<Item[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [reward, setReward] = useState<bigint>(0n);
  const [earned, setEarned] = useState<bigint>(0n);
  const [streak, setStreak] = useState(0);
  const [feed, setFeed] = useState<Paid[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = useRef(0);

  // Privy creates the embedded wallet on login; it may appear a beat later.
  const wallet = useMemo(
    () => wallets.find((w) => w.walletClientType === "privy") ?? wallets[0],
    [wallets]
  );
  const address = wallet?.address as Hex | undefined;

  const workerId = useMemo(
    () =>
      address
        ? (`0x${"0".repeat(24)}${address.slice(2)}`.toLowerCase() as Hex)
        : undefined,
    [address]
  );

  useEffect(() => {
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

  // Only offer items this worker hasn't answered. The contract allows one
  // answer per worker per item, so replaying the manifest from the top after a
  // reload would revert with AlreadyLabeled.
  useEffect(() => {
    if (!workerId || !manifest) return;
    let cancelled = false;

    Promise.all(
      manifest.items.map((item) =>
        publicClient
          .readContract({
            address: TASK_POOL,
            abi: taskPoolAbi,
            functionName: "hasLabeled",
            args: [TASK_ID, workerId, BigInt(item.id)],
          })
          .then((done) => (done ? null : item))
          .catch(() => item)
      )
    ).then((r) => {
      if (cancelled) return;
      setQueue(r.filter((i): i is Item => i !== null));
      setCursor(0);
    });

    return () => {
      cancelled = true;
    };
  }, [workerId, manifest]);

  useEffect(() => {
    if (!workerId) return;
    const sync = () =>
      publicClient
        .readContract({
          address: TASK_POOL,
          abi: taskPoolAbi,
          functionName: "earned",
          args: [workerId],
        })
        .then((v) => {
          if (pending.current === 0) setEarned(v);
        })
        .catch(() => {});
    sync();
    const t = setInterval(sync, 4000);
    return () => clearInterval(t);
  }, [workerId]);

  const answer = useCallback(
    async (value: number) => {
      if (!wallet || !address || !queue || busy) return;
      const item = queue[cursor];
      if (!item) return;

      setError(null);
      setBusy(true);
      pending.current += 1;

      try {
        const signature = await signLabel(
          wallet as unknown as SigningWallet,
          TASK_ID,
          BigInt(item.id),
          value
        );

        // Move on immediately; the next card should be up before the
        // transaction lands or this feels slower than the chain is.
        setCursor((c) => c + 1);
        setEarned((e) => e + reward);
        setStreak((s) => s + 1);

        const res = await fetch("/api/relay", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "labelFor",
            taskId: TASK_ID.toString(),
            itemId: item.id.toString(),
            answer: value,
            worker: address,
            signature,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Submission failed");

        setFeed((f) => [{ hash: json.hash as Hex, reward }, ...f].slice(0, 5));
      } catch (e) {
        setEarned((v) => (v >= reward ? v - reward : 0n));
        setStreak(0);
        const message = e instanceof Error ? e.message : String(e);
        // A duplicate is nothing the worker can act on -- just move past it.
        if (!/AlreadyLabeled/i.test(message)) setError(message);
      } finally {
        pending.current -= 1;
        setBusy(false);
      }
    },
    [wallet, address, queue, cursor, reward, busy]
  );

  const money = (v: bigint) => `$${formatUnits(v, DUSD_DECIMALS)}`;

  if (!ready) {
    return (
      <Shell>
        <div className="flex-1 flex items-center justify-center text-zinc-600">
          Loading…
        </div>
      </Shell>
    );
  }

  // --- signed out ---------------------------------------------------------

  if (!authenticated) {
    return (
      <Shell>
        <div className="flex-1 flex flex-col justify-center gap-8">
          <div>
            <h1 className="text-4xl font-semibold tracking-tight">Swarm</h1>
            <p className="mt-3 text-lg text-zinc-400 leading-snug">
              Label data for a few seconds. Get paid instantly, on-chain.
            </p>
          </div>

          <ul className="space-y-2.5 text-zinc-400">
            {[
              "Sign in with Google — that's the whole signup.",
              "A wallet is created for you. No seed phrase, ever.",
              "Every answer is paid the moment you give it.",
            ].map((line) => (
              <li key={line} className="flex gap-3">
                <span className="text-emerald-400">—</span>
                {line}
              </li>
            ))}
          </ul>

          <button
            onClick={login}
            className="w-full rounded-2xl bg-emerald-500 py-5 text-lg font-semibold text-zinc-950 active:scale-[0.98] transition"
          >
            Continue with Google
          </button>
        </div>
        <Footer />
      </Shell>
    );
  }

  // --- signed in, wallet still being created ------------------------------

  if (!address) {
    return (
      <Shell>
        <div className="flex-1 flex items-center justify-center text-center text-zinc-500">
          Creating your wallet…
        </div>
      </Shell>
    );
  }

  const item = queue?.[cursor];
  const done = queue ? queue.length - (queue.length - cursor) : 0;
  const total = queue?.length ?? 0;

  return (
    <Shell>
      <header className="flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-widest text-zinc-500">
            Earned
          </div>
          <div className="text-3xl font-semibold tabular-nums text-emerald-400">
            {money(earned)}
          </div>
          <div className="mt-0.5 text-xs text-zinc-600">
            {user?.google?.email ?? address.slice(0, 10)}
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

      {total > 0 && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-900">
          <div
            className="h-full bg-emerald-500 transition-all duration-300"
            style={{ width: `${(done / total) * 100}%` }}
          />
        </div>
      )}

      {item ? (
        <div className="flex-1 flex flex-col justify-center gap-6">
          <div>
            <div className="flex items-baseline justify-between">
              <p className="text-sm text-zinc-500">{manifest?.question}</p>
              {streak >= 3 && (
                <span className="text-xs font-medium text-amber-400">
                  {streak} in a row
                </span>
              )}
            </div>
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
            {busy ? "Signing…" : `${total - cursor} left`}
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
            You earned {money(earned)}, already on-chain.
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

      {error && (
        <div className="rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {feed.length > 0 && (
        <div className="space-y-1.5">
          {feed.map((p) => (
            <a
              key={p.hash}
              href={explorerTx(p.hash)}
              target="_blank"
              rel="noreferrer"
              className="animate-slide-in flex items-center justify-between rounded-lg bg-zinc-900/60 px-3 py-2 font-mono text-xs text-zinc-500"
            >
              <span className="text-emerald-500">+{money(p.reward)}</span>
              <span>{p.hash.slice(0, 10)}…</span>
            </a>
          ))}
        </div>
      )}

      <button
        onClick={logout}
        className="text-center text-xs text-zinc-700 underline underline-offset-4"
      >
        Sign out
      </button>
      <Footer />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 p-6">
      {children}
    </main>
  );
}

function Footer() {
  return (
    <footer className="text-center text-xs text-zinc-700">
      Paid in DUSD on {chain.name} · every answer signed by you, verified on-chain
    </footer>
  );
}
