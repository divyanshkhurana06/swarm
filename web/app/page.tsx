"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { formatUnits, type Hex } from "viem";
import { chain, TASK_POOL, taskPoolAbi, DUSD_DECIMALS, explorerTx } from "@/lib/contracts";
import { signBox, signLabel, signSurveyAnswer, type SigningWallet } from "@/lib/wallet";
import { packBox, type Box } from "@/lib/images";
import { BoxDrawer } from "@/components/BoxDrawer";
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
import { Badge, MoneyPop, Shell, WalletBar } from "@/components/ui";
import {
  BountyAlert,
  CategoryPicker,
  IdentityCard,
  TaskRow,
  categoryOf,
  isOpen,
  type Category,
} from "@/components/WorkerHome";
import { walletBalances } from "@/lib/tasks";

type Pop = { id: number; label: string };

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
  const [category, setCategory] = useState<Category | null>(null);
  const [held, setHeld] = useState<{ dusd: bigint; nfts: number }>({
    dusd: 0n,
    nfts: 0,
  });
  const [streak, setStreak] = useState(0);
  const [alert, setAlert] = useState<Task | null>(null);
  const seen = useRef<Set<number> | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [queue, setQueue] = useState<Item[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [earned, setEarned] = useState<bigint>(0n);
  const [text, setText] = useState("");
  const [box, setBox] = useState<Box | null>(null);
  const [pops, setPops] = useState<Pop[]>([]);
  const [bump, setBump] = useState(0);
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

  useEffect(() => {
    refreshTasks();
    const t = setInterval(refreshTasks, 12_000);
    return () => clearInterval(t);
  }, [refreshTasks]);

  // Announce only tasks that appear after this screen loaded. Announcing the
  // ones already there would be noise; the point is that it just happened.
  useEffect(() => {
    if (!tasks) return;
    if (seen.current === null) {
      seen.current = new Set(tasks.map((t) => t.id));
      return;
    }
    const fresh = tasks.find((t) => !seen.current!.has(t.id) && isOpen(t));
    tasks.forEach((t) => seen.current!.add(t.id));
    if (fresh) setAlert(fresh);
  }, [tasks]);

  useEffect(() => {
    if (!address) return;
    const sync = () => walletBalances(address).then(setHeld).catch(() => {});
    sync();
    const t = setInterval(sync, 6000);
    return () => clearInterval(t);
  }, [address]);

  // Only offer what this worker hasn't answered. One answer per worker per
  // item, so replaying from the top after a reload would revert.
  useEffect(() => {
    if (!task || !workerId) return;
    let cancelled = false;
    setQueue(null);
    setText("");
    setBox(null);
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

  const popId = useRef(0);

  /** Shows the payment, then cleans itself up once the animation is done. */
  const showPop = (label: string) => {
    const id = ++popId.current;
    setPops((p) => [...p, { id, label }]);
    setTimeout(() => setPops((p) => p.filter((x) => x.id !== id)), 1200);
  };

  const advance = (reward: bigint, credited: boolean) => {
    setCursor((c) => c + 1);
    setText("");
    setBox(null);
    setStreak((v) => v + 1);

    if (credited) {
      setEarned((e) => e + reward);
      setBump((b) => b + 1);
      showPop(`+${money(reward)}`);
    }
  };

  const submit = useCallback(
    async (value: number | string | Box | null) => {
      if (!wallet || !address || !task || !queue || busy) return;
      const item = queue[cursor];
      if (!item) return;

      setError(null);
      setBusy(true);
      inFlight.current += 1;
      const reward = task.rewardPerLabel;
      const isSurvey = task.mode === Mode.Survey;
      const isBox = task.spec.kind === "bbox";

      try {
        let body: Record<string, unknown>;

        if (isBox) {
          const packed = packBox(value as Box | null);
          const signature = await signBox(
            wallet as unknown as SigningWallet,
            BigInt(task.id),
            BigInt(item.id),
            packed
          );
          body = {
            action: "boxFor",
            taskId: String(task.id),
            itemId: String(item.id),
            box: packed.toString(),
            worker: address,
            signature,
          };
        } else if (isSurvey) {
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

        // A survey pays on completion, so don't claim money has landed yet.
        const paysNow = task.mode === Mode.FirstCome;

        const res = await fetch("/api/relay", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Submission failed");

        advance(reward, paysNow);
        // A survey is only paid once every question is answered, so showing an
        // amount here would be a lie the contract contradicts a minute later.
        if (!paysNow) showPop("saved");
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
    const open = (tasks ?? []).filter(isOpen);
    const inCategory = category
      ? open.filter((t) => categoryOf(t) === category)
      : [];

    return (
      <Shell>
        <IdentityCard
          address={address}
          email={user?.google?.email}
          balance={earned}
          nfts={held.nfts}
          available={open.length}
          streak={streak}
        />

        {tasks === null ? (
          <div className="text-zinc-600">Reading tasks from Monad…</div>
        ) : category === null ? (
          <>
            <CategoryPicker tasks={open} onPick={setCategory} />
            {open.length === 0 && (
              <p className="text-sm text-zinc-500">
                Nothing open right now.{" "}
                <Link href="/post" className="text-emerald-500 underline">
                  Post a task
                </Link>{" "}
                and it&apos;ll appear here instantly.
              </p>
            )}
          </>
        ) : (
          <>
            <button
              onClick={() => setCategory(null)}
              className="self-start text-sm text-zinc-500"
            >
              ← Categories
            </button>
            <h2 className="text-lg font-semibold">
              {category === "bbox" ? "Image bounties" : "Surveys"}
            </h2>
            <div className="space-y-2.5">
              {inCategory.map((t) => (
                <TaskRow key={t.id} task={t} onPick={() => setTask(t)} />
              ))}
            </div>
          </>
        )}

        <Link href="/post" className="text-center text-sm text-zinc-500">
          Need something labelled? Post a task →
        </Link>

        {alert && (
          <BountyAlert
            task={alert}
            onTake={() => {
              setTask(alert);
              setAlert(null);
            }}
            onDismiss={() => setAlert(null)}
          />
        )}
        <Footer />
      </Shell>
    );
  }

  // --- working ------------------------------------------------------------

  const item = queue?.[cursor];
  const total = queue?.length ?? 0;
  const isSurvey = task.mode === Mode.Survey;
  const isBox = task.spec.kind === "bbox";
  const isImage = task.spec.kind === "image" || isBox;
  const upcoming = isImage ? (queue ?? []).slice(cursor + 1, cursor + 4) : [];

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

      <Earnings earned={earned} bump={bump} />

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

          {isBox ? (
            <BoxDrawer
              key={item.id}
              src={item.text}
              box={box}
              onChange={setBox}
              disabled={busy}
            />
          ) : isImage ? (
            <ImageCard key={item.id} src={item.text} />
          ) : (
            <div
              key={item.id}
              className="animate-pop rounded-2xl border border-zinc-800 bg-zinc-900 p-6 text-lg leading-relaxed"
            >
              {item.text}
            </div>
          )}

          <MoneyPop pops={pops} />

          {/* Fetch the next few so tapping through doesn't stall on the
              network -- an image task lives or dies on how fast it feels. */}
          <div className="hidden">
            {upcoming.map((u) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={u.id} src={u.text} alt="" />
            ))}
          </div>

          {isBox ? (
            <div className="space-y-3">
              <button
                onClick={() => submit(box)}
                disabled={busy || !box}
                className="w-full rounded-2xl bg-emerald-500 py-4 text-lg font-semibold text-zinc-950 disabled:opacity-40"
              >
                {busy ? "Signing…" : box ? "Claim bounty" : "Draw a box first"}
              </button>
              <button
                onClick={() => submit(null)}
                disabled={busy}
                className="w-full rounded-xl border border-zinc-700 py-3 text-sm text-zinc-400 disabled:opacity-40"
              >
                Nothing here
              </button>
              <p className="text-center text-xs text-zinc-600">
                {total - cursor} left · {money(task.rewardPerLabel)} each · first
                to answer takes it
              </p>
            </div>
          ) : isSurvey ? (
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

/**
 * An image to label.
 *
 * Holds its own loading and failure state: a broken URL has to be visibly
 * broken, because a worker cannot honestly answer "is there a car in this"
 * about an image that never loaded.
 */
function ImageCard({ src }: { src: string }) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");

  return (
    <div className="animate-pop relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
      {state === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-600">
          Loading image…
        </div>
      )}
      {state === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center">
          <span className="text-sm text-amber-400">This image didn&apos;t load</span>
          <span className="text-xs text-zinc-600">
            Skip it rather than guessing
          </span>
        </div>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="Item to label"
        className={`h-72 w-full object-contain transition-opacity duration-200 ${
          state === "ok" ? "opacity-100" : "opacity-0"
        }`}
        onLoad={() => setState("ok")}
        onError={() => setState("error")}
      />
    </div>
  );
}

function Earnings({ earned, bump }: { earned: bigint; bump?: number }) {
  return (
    <div className="flex items-end justify-between">
      <div>
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          Earned
        </div>
        <div
          key={bump}
          className={`text-3xl font-semibold tabular-nums text-emerald-400 ${
            bump ? "animate-bump" : ""
          }`}
        >
          {money(earned)}
        </div>
      </div>
      <div className="flex items-center gap-3">
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
        {task.mode === Mode.Survey
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
  if (task.mode === Mode.Survey) return <Badge tone="sky">survey</Badge>;
  return <Badge tone="emerald">bounty · first come</Badge>;
}

function Footer() {
  return (
    <footer className="text-center text-xs text-zinc-700">
      Paid in DUSD on {chain.name} · every answer signed by you, verified on-chain
    </footer>
  );
}
