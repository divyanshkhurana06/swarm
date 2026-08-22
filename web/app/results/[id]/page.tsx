"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { formatUnits } from "viem";
import { DUSD_DECIMALS } from "@/lib/contracts";
import { loadResults, loadTask, type Task } from "@/lib/tasks";

/**
 * The dataset.
 *
 * This is what a requester actually bought: every item, the crowd's answer,
 * and how much of the crowd agreed. Agreement is the honest quality signal --
 * a 50/50 split means the item was ambiguous, not that the workers were
 * careless, and hiding that behind a single label would be lying about the
 * data.
 *
 * Read straight from contract state rather than reconstructed from events,
 * because the public RPC caps eth_getLogs at 100 blocks.
 */

type Row = Awaited<ReturnType<typeof loadResults>>[number];

export default function Results({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const taskId = Number(id);

  const [task, setTask] = useState<Task | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    loadTask(taskId).then((t) => {
      setTask(t);
      if (t) loadResults(t).then(setRows);
    });
  }, [taskId]);

  const download = (kind: "json" | "csv") => {
    if (!task || !rows) return;

    const content =
      kind === "json"
        ? JSON.stringify(
            {
              task: task.spec.title,
              question: task.spec.question,
              answers: task.spec.answers,
              contract: process.env.NEXT_PUBLIC_TASK_POOL,
              taskId,
              items: rows.map((r) => ({
                id: r.id,
                text: r.text,
                label: r.label === null ? null : task.spec.answers[String(r.label)],
                votes: { [task.spec.answers["0"]]: r.no, [task.spec.answers["1"]]: r.yes },
                agreement: Number(r.agreement.toFixed(2)),
              })),
            },
            null,
            2
          )
        : [
            "id,text,label,votes_a,votes_b,agreement",
            ...rows.map((r) =>
              [
                r.id,
                JSON.stringify(r.text),
                r.label === null ? "" : task.spec.answers[String(r.label)],
                r.no,
                r.yes,
                r.agreement.toFixed(2),
              ].join(",")
            ),
          ].join("\n");

    const blob = new Blob([content], {
      type: kind === "json" ? "application/json" : "text/csv",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `swarm-task-${taskId}.${kind}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!task) {
    return (
      <Shell>
        <div className="text-zinc-600">Loading task {taskId}…</div>
      </Shell>
    );
  }

  const answered = rows?.filter((r) => r.total > 0).length ?? 0;
  const contested = rows?.filter((r) => r.total > 1 && r.agreement < 1).length ?? 0;

  return (
    <Shell>
      <div className="flex items-center justify-between">
        <Link href="/" className="text-sm text-zinc-500">
          ← Back
        </Link>
        <span className="font-mono text-xs text-zinc-600">task #{taskId}</span>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {task.spec.title}
        </h1>
        <p className="mt-1 text-zinc-500">{task.spec.question}</p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Items" value={String(task.itemCount)} />
        <Stat label="Answered" value={String(answered)} accent />
        <Stat label="Contested" value={String(contested)} />
      </div>

      <div className="flex gap-3">
        <button
          onClick={() => download("json")}
          disabled={!rows}
          className="flex-1 rounded-xl bg-emerald-500 py-3 font-semibold text-zinc-950 disabled:opacity-40"
        >
          Download JSON
        </button>
        <button
          onClick={() => download("csv")}
          disabled={!rows}
          className="flex-1 rounded-xl border border-zinc-700 py-3 font-medium disabled:opacity-40"
        >
          Download CSV
        </button>
      </div>

      <p className="text-xs leading-relaxed text-zinc-600">
        Paid out so far: {formatUnits(task.paidOut, DUSD_DECIMALS)} DUSD across{" "}
        {task.answers} answers. Every row below was signed by a worker and
        verified on-chain before it was paid for.
      </p>

      <div className="overflow-hidden rounded-2xl border border-zinc-800">
        {rows === null ? (
          <div className="p-6 text-zinc-600">Reading results…</div>
        ) : (
          rows.map((r) => (
            <div
              key={r.id}
              className="flex items-start gap-4 border-b border-zinc-800/60 p-4 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-relaxed text-zinc-300">{r.text}</p>
                <p className="mt-1 text-xs text-zinc-600">
                  {r.total === 0
                    ? "no answers yet"
                    : `${r.total} answer${r.total > 1 ? "s" : ""} · ${Math.round(
                        r.agreement * 100
                      )}% agreed`}
                </p>
              </div>
              <span
                className={`shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium ${
                  r.label === null
                    ? "bg-zinc-800 text-zinc-500"
                    : r.agreement < 0.7
                      ? "bg-amber-500/15 text-amber-400"
                      : "bg-emerald-500/15 text-emerald-400"
                }`}
              >
                {r.label === null ? "—" : task.spec.answers[String(r.label)]}
              </span>
            </div>
          ))
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-5 p-6">
      {children}
    </main>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="text-xs uppercase tracking-widest text-zinc-500">
        {label}
      </div>
      <div
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          accent ? "text-emerald-400" : "text-zinc-100"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
