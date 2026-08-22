"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { formatUnits, type Hex } from "viem";
import {
  chain,
  TASK_POOL,
  taskPoolAbi,
  DUSD_DECIMALS,
  explorerTx,
} from "@/lib/contracts";
import { signLabel, type SigningWallet } from "@/lib/wallet";
import {
  loadTasks,
  publicClient,
  unansweredItems,
  workerIdOfAddress,
  type Item,
  type Task,
} from "@/lib/tasks";

type Paid = { hash: Hex; reward: bigint };

const CONFIGURED = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);
const money = (v: bigint) => `$${formatUnits(v, DUSD_DECIMALS)}`;

export default function Page() {
  // usePrivy throws outside its provider, and the provider needs an app id.
  // Branch before any hook runs so a missing env var degrades to a message
  // rather than a white screen.
  if (!CONFIGURED) {
    return (
      <Shell>
        <div className="flex-1 flex flex-col justify-center gap-3">
          <h1 className="text-2xl font-semibold">Sign-in isn&apos;t configured</h1>
          <p className="text-zinc-400">
            Set <code className="text-zinc-200">NEXT_PUBLIC_PRIVY_APP_ID</code>.
            The{" "}
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

  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [queue, setQueue] = useState<Item[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [earned, setEarned] = useState<bigint>(0n);
  const [streak, setStreak] = useState(0);
  const [feed, setFeed] = useState<Paid[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = useRef(0);

  const wallet = useMemo(
    () => wallets.find((w) => w.walletClientType === "privy") ?? wallets[0],
    [wallets]
  );
  const address = wallet?.address as Hex | undefined;
  const workerId = address ? workerIdOfAddress(address) : undefined;

  useEffect(() => {
    loadTasks()
      .then(setTasks)
      .catch((e) => {
        console.error("loadTasks failed:", e);
        setError(
          `Could not load tasks: ${e instanceof Error ? e.message.split("\n")[0] : e}`
        );
      });
  }, []);

  // Only offer items this worker hasn't answered: the contract allows one
  // answer per worker per item, so replaying a task from the top after a
  // reload would revert.
  useEffect(() => {
    if (!task || !workerId) return;
    let cancelled = false;
    setQueue(null);
    unansweredItems(task, workerId).then((items) => {
      if (cancelled) return;
      setQueue(items);
      setCursor(0);
    });
    return () => {
      cancelled = true;
    };
  }, [task, workerId]);

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
          if (pending.current === 0) setEarned(v as bigint);
        })
        .catch(() => {});
    sync();
    const t = setInterval(sync, 4000);
    return () => clearInterval(t);
  }, [workerId]);

  const answer = useCallback(
    async (value: number) => {
      if (!wallet || !address || !task || !queue || busy) return;
      const item = queue[cursor];
      if (!item) return;

      setError(null);
      setBusy(true);
      pending.current += 1;
      const reward = task.rewardPerLabel;

      try {
        const signature = await signLabel(
          wallet as unknown as SigningWallet,
          BigInt(task.id),
          BigInt(item.id),
          value
        );

        setCursor((c) => c + 1);
        setEarned((e) => e + reward);
        setStreak((s) => s + 1);

        const res = await fetch("/api/relay", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "labelFor",
            taskId: String(task.id),
            itemId: String(item.id),
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
        if (!/AlreadyLabeled/i.test(message)) setError(message);
      } finally {
        pending.current -= 1;
        setBusy(false);
      }
    },
    [wallet, address, task, queue, cursor, busy]
  );

  if (!ready) {
    return (
      <Shell>
        <div className="flex-1 flex items-center justify-center text-zinc-600">
          Loading…
        </div>
      </Shell>
    );
  }

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
          <Link href="/post" className="text-center text-sm text-zinc-500">
            Need something labelled? Post a task →
          </Link>
        </div>
      </Shell>
    );
  }

  if (!address) {
    return (
      <Shell>
        <div className="flex-1 flex items-center justify-center text-zinc-500">
          Creating your wallet…
        </div>
      </Shell>
    );
  }

  // --- task picker --------------------------------------------------------

  if (!task) {
    return (
      <Shell>
        <Header earned={earned} email={user?.google?.email} address={address} />

        <div>
          <h2 className="text-lg font-semibold">Open tasks</h2>
          <p className="text-sm text-zinc-500">
            Posted by requesters, stored on-chain.
          </p>
        </div>

        {tasks === null ? (
          <div className="text-zinc-600">Reading tasks from Monad…</div>
        ) : tasks.length === 0 ? (
          <div className="text-zinc-500">
            Nothing posted yet.{" "}
            <Link href="/post" className="text-emerald-500 underline">
              Post the first one
            </Link>
            .
          </div>
        ) : (
          <div className="space-y-2.5">
            {tasks.map((t) => {
              const left = t.funded - t.paidOut;
              return (
                <button
                  key={t.id}
                  onClick={() => setTask(t)}
                  disabled={!t.open || left < t.rewardPerLabel}
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 text-left active:scale-[0.99] transition disabled:opacity-40"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">{t.spec.title}</span>
                    <span className="shrink-0 font-mono text-sm text-emerald-400">
                      {money(t.rewardPerLabel)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-zinc-500">{t.spec.question}</p>
                  <div className="mt-2 flex gap-3 text-xs text-zinc-600">
                    <span>{t.itemCount} items</span>
                    <span>{t.answers} answered</span>
                    <span>{money(left)} left</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <Link href="/post" className="text-center text-sm text-zinc-500">
          Post your own task →
        </Link>
        <Footer />
      </Shell>
    );
  }

  // --- labelling ----------------------------------------------------------

  const item = queue?.[cursor];
  const total = queue?.length ?? 0;
  const progress = total === 0 ? 0 : (cursor / total) * 100;

  return (
    <Shell>
      <Header earned={earned} email={user?.google?.email} address={address} />

      <div className="flex items-center justify-between">
        <button
          onClick={() => setTask(null)}
          className="text-sm text-zinc-500"
        >
          ← All tasks
        </button>
        <Link
          href={`/results/${task.id}`}
          className="text-sm text-zinc-500 underline underline-offset-4"
        >
          Results
        </Link>
      </div>

      {total > 0 && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-900">
          <div
            className="h-full bg-emerald-500 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {item ? (
        <div className="flex-1 flex flex-col justify-center gap-6">
          <div>
            <div className="flex items-baseline justify-between">
              <p className="text-sm text-zinc-500">{task.spec.question}</p>
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
              {task.spec.answers["0"]}
            </button>
            <button
              onClick={() => answer(1)}
              disabled={busy}
              className="rounded-2xl bg-amber-500 py-6 text-lg font-semibold text-zinc-950 active:scale-[0.97] transition disabled:opacity-40"
            >
              {task.spec.answers["1"]}
            </button>
          </div>

          <p className="text-center text-xs text-zinc-600">
            {busy ? "Signing…" : `${total - cursor} left · ${money(task.rewardPerLabel)} each`}
          </p>
        </div>
      ) : queue === null ? (
        <div className="flex-1 flex items-center justify-center text-zinc-600">
          Checking what you&apos;ve already answered…
        </div>
      ) : (
        <div className="flex-1 flex flex-col justify-center text-center gap-3">
          <div className="text-2xl font-semibold">Batch done.</div>
          <p className="text-zinc-400">
            You&apos;ve earned {money(earned)} in total, already on-chain.
          </p>
          <button
            onClick={() => setTask(null)}
            className="mt-2 rounded-2xl border border-zinc-700 py-4 font-medium"
          >
            Find another task
          </button>
          {earned > 0n && (
            <Link
              href="/withdraw"
              className="rounded-2xl bg-emerald-500 py-4 text-lg font-semibold text-zinc-950"
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

function Header({
  earned,
  email,
  address,
}: {
  earned: bigint;
  email?: string;
  address: string;
}) {
  return (
    <header className="flex items-start justify-between">
      <div>
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          Earned
        </div>
        <div className="text-3xl font-semibold tabular-nums text-emerald-400">
          {money(earned)}
        </div>
        <div className="mt-0.5 text-xs text-zinc-600">
          {email ?? `${address.slice(0, 10)}…`}
        </div>
      </div>
      {earned > 0n && (
        <Link
          href="/withdraw"
          className="rounded-xl border border-emerald-700/50 px-3 py-1.5 text-sm text-emerald-400"
        >
          Cash out
        </Link>
      )}
    </header>
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
