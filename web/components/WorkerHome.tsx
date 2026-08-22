"use client";

import Link from "next/link";
import { formatUnits } from "viem";
import { DUSD_DECIMALS } from "@/lib/contracts";
import { Mode, type Task } from "@/lib/tasks";

/**
 * The worker's home.
 *
 * Two categories, because there are two kinds of work. The counts are of
 * *open* tasks -- a category showing "3 available" that turns out to be
 * exhausted is worse than showing zero, since the worker has already decided
 * to spend the next ten minutes earning before they find out.
 */

const money = (v: bigint) => `$${formatUnits(v, DUSD_DECIMALS)}`;

export type Category = "bbox" | "survey";

export function categoryOf(task: Task): Category {
  return task.mode === Mode.Survey ? "survey" : "bbox";
}

/** Only tasks that can actually be worked on right now. */
export function isOpen(task: Task): boolean {
  return task.open && task.funded - task.paidOut >= task.rewardPerLabel;
}

export function IdentityCard({
  address,
  email,
  balance,
  nfts,
  available,
  streak,
}: {
  address: string;
  email?: string;
  balance: bigint;
  nfts: number;
  available: number;
  streak: number;
}) {
  return (
    <div className="rounded-3xl bg-gradient-to-br from-zinc-900 to-zinc-900/40 p-5 ring-1 ring-zinc-800">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
            Annotator
          </div>
          <div className="truncate font-mono text-sm text-zinc-200">
            {address.slice(0, 6)}…{address.slice(-4)}
          </div>
          {email && (
            <div className="truncate text-xs text-zinc-600">{email}</div>
          )}
        </div>

        <Link
          href="/withdraw"
          className="flex shrink-0 items-center gap-2 rounded-full bg-emerald-500/15 px-4 py-2 ring-1 ring-emerald-500/30"
        >
          <span className="text-lg font-semibold tabular-nums text-emerald-400">
            {money(balance)}
          </span>
        </Link>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2.5">
        <Tile label="Available" value={String(available)} />
        <Tile label="Streak" value={streak > 0 ? `🔥 ${streak}` : "—"} />
        <Tile label="Receipts" value={String(nfts)} />
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-zinc-950/60 px-3 py-2.5 ring-1 ring-zinc-800/80">
      <div className="text-[10px] uppercase tracking-widest text-zinc-500">
        {label}
      </div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums text-zinc-100">
        {value}
      </div>
    </div>
  );
}

const CATEGORIES: {
  key: Category;
  title: string;
  blurb: string;
  icon: string;
  accent: string;
}[] = [
  {
    key: "bbox",
    title: "Image bounties",
    blurb: "Box the target. First to answer takes it.",
    icon: "🖼",
    accent: "from-sky-500/20 to-sky-500/5 ring-sky-500/25",
  },
  {
    key: "survey",
    title: "Surveys",
    blurb: "Answer in your own words. Paid on completion.",
    icon: "💬",
    accent: "from-amber-500/20 to-amber-500/5 ring-amber-500/25",
  },
];

export function CategoryPicker({
  tasks,
  onPick,
}: {
  tasks: Task[];
  onPick: (c: Category) => void;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Select a category</h2>

      {CATEGORIES.map((c) => {
        const open = tasks.filter((t) => categoryOf(t) === c.key && isOpen(t));
        const best = open.reduce<bigint>(
          (m, t) => (t.rewardPerLabel > m ? t.rewardPerLabel : m),
          0n
        );

        return (
          <button
            key={c.key}
            onClick={() => onPick(c.key)}
            disabled={open.length === 0}
            className={`w-full rounded-2xl bg-gradient-to-br p-4 text-left ring-1 transition active:scale-[0.99] disabled:opacity-40 ${c.accent}`}
          >
            <div className="flex items-center gap-4">
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-zinc-950/60 text-2xl">
                {c.icon}
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{c.title}</div>
                <div className="truncate text-sm text-zinc-400">{c.blurb}</div>
                <div className="mt-1 text-xs text-zinc-500">
                  {open.length === 0
                    ? "nothing open right now"
                    : `${open.length} open · up to ${money(best)} each`}
                </div>
              </div>
              <span className="shrink-0 text-xl text-zinc-500">→</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A bounty appearing while the worker is looking at the screen.
 *
 * Only shown for tasks that arrive after the page loaded -- announcing the
 * ones that were already there would be noise, and the whole point is that
 * something is happening right now.
 */
export function BountyAlert({
  task,
  onTake,
  onDismiss,
}: {
  task: Task;
  onTake: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="animate-slide-in fixed inset-x-4 bottom-4 z-50 mx-auto max-w-md rounded-2xl border border-emerald-500/40 bg-zinc-900 p-4 shadow-2xl">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-500/15 text-lg">
          ⚡
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-widest text-emerald-400">
            New bounty
          </div>
          <div className="truncate font-medium">{task.spec.title}</div>
          <div className="text-xs text-zinc-500">
            {task.itemCount}{" "}
            {task.mode === Mode.Survey ? "questions" : "images"} ·{" "}
            {money(task.rewardPerLabel)} each
          </div>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          onClick={onTake}
          className="flex-1 rounded-xl bg-emerald-500 py-2.5 text-sm font-semibold text-zinc-950"
        >
          Take it
        </button>
        <button
          onClick={onDismiss}
          className="rounded-xl border border-zinc-700 px-4 py-2.5 text-sm text-zinc-400"
        >
          Later
        </button>
      </div>
    </div>
  );
}

export function TaskRow({ task, onPick }: { task: Task; onPick: () => void }) {
  const left = task.funded - task.paidOut;
  return (
    <button
      onClick={onPick}
      disabled={!isOpen(task)}
      className="w-full rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 text-left transition hover:border-zinc-700 active:scale-[0.99] disabled:opacity-40"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate font-medium">{task.spec.title}</span>
        <span className="shrink-0 font-mono text-sm text-emerald-400">
          {money(task.rewardPerLabel)}
        </span>
      </div>
      <p className="mt-1 truncate text-sm text-zinc-500">{task.spec.question}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-600">
        <span>
          {task.itemCount}{" "}
          {task.mode === Mode.Survey ? "questions" : "images"}
        </span>
        <span>·</span>
        <span>{task.answers} done</span>
        <span>·</span>
        <span>{money(left)} left in the pot</span>
      </div>
    </button>
  );
}
