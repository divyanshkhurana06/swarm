"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { formatUnits, type Hex } from "viem";
import { chain, TASK_POOL, taskPoolAbi, DUSD_DECIMALS, explorerTx } from "@/lib/contracts";
import { signLabel, signSurveyAnswer, type SigningWallet } from "@/lib/wallet";
import {
  Mode,
  loadTasks,
  publicClient,
  surveyProgress,
  unansweredItems,
  workerIdOfAddress,
  type Item,
  type Task,
} from "@/lib/tasks";
import { Badge, Shell, WalletBar } from "@/components/ui";

type Paid = { hash: Hex; reward: bigint };

const CONFIGURED = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);
const money = (v: bigint) => `$${formatUnits(v, DUSD_DECIMALS)}`;

export default function Page() {
  // usePrivy throws outside its provider, and the provider needs an app id.
  // Branch before any hook runs so a missing env var degrades to a message.
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
  const [pendingVotes, setPendingVotes] = useState(0);
  const [text, setText] = useState("");
  const [feed, setFeed] = useState<Paid[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inFlight = useRef(0);

  const wallet = useMemo(
    () => wallets.find((w) => w.walletClientType === "privy") ?? wallets[0],
    [wallets]
  );
  const address = wallet?.address as Hex | undefined;
  const workerId = address ? workerIdOfAddress(address) : undefined;

  const refreshTasks = useCallback(() => {
    loadTasks()
      .then(setTasks)
      .catch((e) => {
        console.error("loadTasks failed:", e);
        setError(`Could not load tasks: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      });
  }, []);

  useEffect(refreshTasks, [refreshTasks]);

  // Only offer what this worker hasn't answered. One answer per worker per
  // item, so replaying from the top after a reload would revert.
  useEffect(() => {
    if (!task || !workerId) return;
    let cancelled = false;
    setQueue(null);
    setText("");
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
          if (inFlight.current === 0) setEarned(v as bigint);
        })
        .catch(() => {});
    sync();
    const t = setInterval(sync, 4000);
    return () => clearInterval(t);
  }, [workerId]);

  const advance = (reward: bigint, hash: Hex, credited: boolean) => {
    setCursor((c) => c + 1);
    setText("");
    if (credited) setEarned((e) => e + reward);
    setFeed((f) => [{ hash, reward }, ...f].slice(0, 5));
  };

  const submit = useCallback(
    async (value: number | string) => {
      if (!wallet || !address || !task || !queue || busy) return;
      const item = queue[cursor];
      if (!item) return;

      setError(null);
      setBusy(true);
      inFlight.current += 1;
      const reward = task.rewardPerLabel;
      const isSurvey = task.mode === Mode.Survey;

      try {
        let body: Record<string, unknown>;

        if (isSurvey) {
          const answer = String(value).trim();
          if (!answer) throw new Error("Write an answer first");
          const signature = await signSurveyAnswer(
            wallet as unknown as SigningWallet,
            BigInt(task.id),
            BigInt(item.id),
            answer
          );
          body = {
            action: "surveyFor",
            taskId: String(task.id),
            itemId: String(item.id),
            answer,
            worker: address,
            signature,
          };
        } else {
          const signature = await signLabel(
            wallet as unknown as SigningWallet,
            BigInt(task.id),
            BigInt(item.id),
            Number(value)
          );
          body = {
            action: "labelFor",
            taskId: String(task.id),
            itemId: String(item.id),
            answer: Number(value),
            worker: address,
            signature,
          };
        }

        // Majority holds the money until the crowd agrees, and a survey pays
        // only on completion -- so don't pretend either has paid yet.
        const paysNow = task.mode === Mode.FirstCome;
        if (task.mode === Mode.Majority) setPendingVotes((p) => p + 1);

        const res = await fetch("/api/relay", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Submission failed");

        advance(reward, json.hash as Hex, paysNow);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (/AlreadyLabeled/i.test(message)) {
          setCursor((c) => c + 1);
          setText("");
        } else if (/ItemFull/i.test(message)) {
          setError("Someone else just took that one — moving on.");
          setCursor((c) => c + 1);
          setText("");
        } else {
          setError(message);
        }
      } finally {
        inFlight.current -= 1;
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
              "Every answer is paid on-chain, to you.",
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
        <WalletBar address={address} email={user?.google?.email} />
        <Earnings earned={earned} />

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
              const dry = left < t.rewardPerLabel;
              return (
                <button
                  key={t.id}
                  onClick={() => setTask(t)}
                  disabled={!t.open || dry}
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 text-left transition hover:border-zinc-700 active:scale-[0.99] disabled:opacity-40"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">{t.spec.title}</span>
                    <span className="shrink-0 font-mono text-sm text-emerald-400">
                      {money(t.rewardPerLabel)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-zinc-500">{t.spec.question}</p>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <ModeBadge task={t} />
                    <span className="text-xs text-zinc-600">
                      {t.itemCount} {t.mode === Mode.Survey ? "questions" : "items"}
                    </span>
                    <span className="text-xs text-zinc-600">·</span>
                    <span className="text-xs text-zinc-600">{money(left)} left</span>
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

  // --- working ------------------------------------------------------------

  const item = queue?.[cursor];
  const total = queue?.length ?? 0;
  const isSurvey = task.mode === Mode.Survey;
  const isImage = task.spec.kind === "image";

  return (
    <Shell>
      <WalletBar address={address} email={user?.google?.email} />

      <div className="flex items-center justify-between">
        <button onClick={() => setTask(null)} className="text-sm text-zinc-500">
          ← All tasks
        </button>
        <div className="flex items-center gap-3">
          <ModeBadge task={task} />
          <Link
            href={`/results/${task.id}`}
            className="text-sm text-zinc-500 underline underline-offset-4"
          >
            Results
          </Link>
        </div>
      </div>

      <Earnings earned={earned} pendingVotes={pendingVotes} />

      {total > 0 && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-900">
          <div
            className="h-full bg-emerald-500 transition-all duration-300"
            style={{ width: `${(cursor / total) * 100}%` }}
          />
        </div>
      )}

      {item ? (
        <div className="flex-1 flex flex-col justify-center gap-5">
          <p className="text-sm text-zinc-500">{task.spec.question}</p>

          {isImage ? (
            <div
              key={item.id}
              className="animate-pop overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.text}
                alt="Item to label"
                className="h-64 w-full bg-zinc-950 object-contain"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.opacity = "0.2";
                }}
              />
            </div>
          ) : (
            <div
              key={item.id}
              className="animate-pop rounded-2xl border border-zinc-800 bg-zinc-900 p-6 text-lg leading-relaxed"
            >
              {item.text}
            </div>
          )}

          {isSurvey ? (
            <div className="space-y-3">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={5}
                placeholder="Your answer…"
                className="w-full resize-y rounded-2xl border border-zinc-800 bg-zinc-900 px-4 py-3 leading-relaxed outline-none focus:border-zinc-600"
              />
              <button
                onClick={() => submit(text)}
                disabled={busy || !text.trim()}
                className="w-full rounded-2xl bg-emerald-500 py-4 text-lg font-semibold text-zinc-950 disabled:opacity-40"
              >
                {busy ? "Signing…" : cursor + 1 === total ? "Finish and get paid" : "Next question"}
              </button>
              <p className="text-center text-xs text-zinc-600">
                Question {cursor + 1} of {total} · paid when all are answered
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => submit(0)}
                  disabled={busy}
                  className="rounded-2xl border border-zinc-700 bg-zinc-900 py-6 text-lg font-medium active:scale-[0.97] transition disabled:opacity-40"
                >
                  {task.spec.answers["0"]}
                </button>
                <button
                  onClick={() => submit(1)}
                  disabled={busy}
                  className="rounded-2xl bg-amber-500 py-6 text-lg font-semibold text-zinc-950 active:scale-[0.97] transition disabled:opacity-40"
                >
                  {task.spec.answers["1"]}
                </button>
              </div>
              <p className="text-center text-xs text-zinc-600">
                {busy
                  ? "Signing…"
                  : `${total - cursor} left · ${money(task.rewardPerLabel)} each`}
              </p>
            </>
          )}
        </div>
      ) : queue === null ? (
        <div className="flex-1 flex items-center justify-center text-zinc-600">
          Checking what you&apos;ve already answered…
        </div>
      ) : (
        <Finished
          task={task}
          workerId={workerId!}
          earned={earned}
          onBack={() => {
            setTask(null);
            refreshTasks();
          }}
        />
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
              <span className="text-emerald-500">
                {task.mode === Mode.FirstCome ? `+${money(p.reward)}` : "submitted"}
              </span>
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

function Earnings({
  earned,
  pendingVotes,
}: {
  earned: bigint;
  pendingVotes?: number;
}) {
  return (
    <div className="flex items-end justify-between">
      <div>
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          Earned
        </div>
        <div className="text-3xl font-semibold tabular-nums text-emerald-400">
          {money(earned)}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {!!pendingVotes && (
          <span className="text-xs text-amber-400">
            {pendingVotes} awaiting the vote
          </span>
        )}
        {earned > 0n && (
          <Link
            href="/withdraw"
            className="rounded-xl border border-emerald-700/50 px-3 py-1.5 text-sm text-emerald-400"
          >
            Cash out
          </Link>
        )}
      </div>
    </div>
  );
}

function Finished({
  task,
  workerId,
  earned,
  onBack,
}: {
  task: Task;
  workerId: Hex;
  earned: bigint;
  onBack: () => void;
}) {
  const [survey, setSurvey] = useState<{ answered: number; paid: boolean } | null>(
    null
  );

  useEffect(() => {
    if (task.mode !== Mode.Survey) return;
    surveyProgress(task, workerId).then(setSurvey).catch(() => {});
  }, [task, workerId]);

  return (
    <div className="flex-1 flex flex-col justify-center text-center gap-3">
      <div className="text-2xl font-semibold">
        {task.mode === Mode.Survey && survey?.paid
          ? "Survey complete."
          : "Nothing left here."}
      </div>

      <p className="text-zinc-400">
        {task.mode === Mode.Majority
          ? "Your answers are in. Each one pays as soon as enough people have answered that item and the majority is settled."
          : task.mode === Mode.Survey
            ? survey?.paid
              ? "You were paid for the whole response."
              : "You've answered everything available on this one."
            : `You've earned ${money(earned)} in total, already on-chain.`}
      </p>

      <button
        onClick={onBack}
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
  );
}

function ModeBadge({ task }: { task: Task }) {
  if (task.mode === Mode.Majority) {
    return <Badge tone="amber">majority of {task.quorum}</Badge>;
  }
  if (task.mode === Mode.Survey) return <Badge tone="sky">survey</Badge>;
  return <Badge tone="emerald">first come</Badge>;
}

function Footer() {
  return (
    <footer className="text-center text-xs text-zinc-700">
      Paid in DUSD on {chain.name} · every answer signed by you, verified on-chain
    </footer>
  );
}
