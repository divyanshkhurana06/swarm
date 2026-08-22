"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { formatUnits, type Hex } from "viem";
import { DUSD_DECIMALS, TASK_POOL } from "@/lib/contracts";
import {
  Mode,
  loadResults,
  loadSurveyResponses,
  loadTask,
  type Task,
} from "@/lib/tasks";
import { Badge, Shell } from "@/components/ui";

/**
 * The dataset.
 *
 * This is what the requester actually bought. For labelling tasks that is the
 * crowd's answer per item plus how much of the crowd agreed -- agreement being
 * the honest quality signal, since a 50/50 split means the item was ambiguous
 * rather than that the workers were careless. For surveys it is the responses
 * themselves.
 *
 * Read from contract state rather than reconstructed from events: the public
 * RPC caps eth_getLogs at 100 blocks, which makes event-scraping a dataset
 * unreliable exactly when the dataset gets big enough to matter.
 */

type Row = Awaited<ReturnType<typeof loadResults>>[number];
type Response = Awaited<ReturnType<typeof loadSurveyResponses>>[number];

export default function Results({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const taskId = Number(id);

  const [task, setTask] = useState<Task | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [responses, setResponses] = useState<Response[] | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    loadTask(taskId).then((t) => {
      if (!t) {
        setNotFound(true);
        return;
      }
      setTask(t);
      if (t.mode === Mode.Survey) {
        loadSurveyResponses(t).then(setResponses).catch(() => setResponses([]));
      } else {
        loadResults(t).then(setRows).catch(() => setRows([]));
      }
    });
  }, [taskId]);

  const download = (kind: "json" | "csv") => {
    if (!task) return;

    let content: string;

    if (task.mode === Mode.Survey) {
      if (!responses) return;
      content =
        kind === "json"
          ? JSON.stringify(
              {
                task: task.spec.title,
                contract: TASK_POOL,
                taskId,
                questions: task.spec.items.map((q) => q.text),
                responses: responses.map((r) => ({
                  worker: r.workerId,
                  answers: task.spec.items.map((q, i) => ({
                    question: q.text,
                    answer: r.answers[i] ?? "",
                  })),
                })),
              },
              null,
              2
            )
          : [
              ["worker", ...task.spec.items.map((q) => JSON.stringify(q.text))].join(","),
              ...responses.map((r) =>
                [r.workerId, ...task.spec.items.map((_, i) => JSON.stringify(r.answers[i] ?? ""))].join(",")
              ),
            ].join("\n");
    } else {
      if (!rows) return;
      content =
        kind === "json"
          ? JSON.stringify(
              {
                task: task.spec.title,
                question: task.spec.question,
                answers: task.spec.answers,
                scoring: "first-come bounty",
                contract: TASK_POOL,
                taskId,
                items: rows.map((r) => ({
                  id: r.id,
                  content: r.text,
                  label: r.label === null ? null : task.spec.answers[String(r.label)],
                  votes: {
                    [task.spec.answers["0"]]: r.no,
                    [task.spec.answers["1"]]: r.yes,
                  },
                  agreement: Number(r.agreement.toFixed(2)),
                })),
              },
              null,
              2
            )
          : [
              "id,content,label,votes_a,votes_b,agreement",
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
    }

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

  if (notFound) {
    return (
      <Shell wide>
        <Link href="/" className="text-sm text-zinc-500">
          ← Back
        </Link>
        <p className="text-zinc-400">No task #{taskId} on this contract.</p>
      </Shell>
    );
  }

  if (!task) {
    return (
      <Shell wide>
        <div className="text-zinc-600">Loading task {taskId}…</div>
      </Shell>
    );
  }

  const isSurvey = task.mode === Mode.Survey;
  const ready = isSurvey ? responses !== null : rows !== null;

  return (
    <Shell wide>
      <div className="flex items-center justify-between">
        <Link href="/" className="text-sm text-zinc-500">
          ← Back
        </Link>
        <span className="font-mono text-xs text-zinc-600">task #{taskId}</span>
      </div>

      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {task.spec.title}
          </h1>
          {task.mode === Mode.Survey ? (
            <Badge tone="sky">survey</Badge>
          ) : (
            <Badge tone="emerald">bounty · first come</Badge>
          )}
        </div>
        <p className="mt-1 text-zinc-500">{task.spec.question}</p>
      </div>

      <Summary task={task} rows={rows} responses={responses} />

      <div className="flex gap-3">
        <button
          onClick={() => download("json")}
          disabled={!ready}
          className="flex-1 rounded-xl bg-emerald-500 py-3 font-semibold text-zinc-950 disabled:opacity-40"
        >
          Download JSON
        </button>
        <button
          onClick={() => download("csv")}
          disabled={!ready}
          className="flex-1 rounded-xl border border-zinc-700 py-3 font-medium disabled:opacity-40"
        >
          Download CSV
        </button>
      </div>

      <p className="text-xs leading-relaxed text-zinc-600">
        {formatUnits(task.paidOut, DUSD_DECIMALS)} DUSD paid out across{" "}
        {task.answers} answers.{" "}
        {task.mode === Mode.Survey
          ? "Each response was paid for only once every question was answered."
          : "Each image was a bounty — paid to the first worker to answer it."}
      </p>

      {isSurvey ? (
        <SurveyResponses task={task} responses={responses} />
      ) : (
        <LabelRows task={task} rows={rows} />
      )}
    </Shell>
  );
}

function Summary({
  task,
  rows,
  responses,
}: {
  task: Task;
  rows: Row[] | null;
  responses: Response[] | null;
}) {
  if (task.mode === Mode.Survey) {
    return (
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Questions" value={String(task.itemCount)} />
        <Stat label="Responses" value={String(responses?.length ?? 0)} accent />
        <Stat
          label="Escrow left"
          value={`$${formatUnits(task.funded - task.paidOut, DUSD_DECIMALS)}`}
        />
      </div>
    );
  }

  const answered = rows?.filter((r) => r.total > 0).length ?? 0;
  const contested = rows?.filter((r) => r.total > 1 && r.agreement < 1).length ?? 0;

  return (
    <div className="grid grid-cols-3 gap-3">
      <Stat label="Items" value={String(task.itemCount)} />
      <Stat label="Answered" value={String(answered)} accent />
      <Stat label="Contested" value={String(contested)} />
    </div>
  );
}

function LabelRows({ task, rows }: { task: Task; rows: Row[] | null }) {
  if (rows === null) {
    return (
      <div className="rounded-2xl border border-zinc-800 p-6 text-zinc-600">
        Reading results…
      </div>
    );
  }

  const isImage = task.spec.kind === "bbox";

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-800">
      {rows.map((r) => (
        <div
          key={r.id}
          className="flex items-start gap-4 border-b border-zinc-800/60 p-4 last:border-0"
        >
          {isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={r.text}
              alt=""
              className="h-16 w-24 shrink-0 rounded-lg bg-zinc-950 object-cover"
            />
          ) : null}
          <div className="min-w-0 flex-1">
            {!isImage && (
              <p className="text-sm leading-relaxed text-zinc-300">{r.text}</p>
            )}
            <p className={`text-xs text-zinc-600 ${isImage ? "" : "mt-1"}`}>
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
      ))}
    </div>
  );
}

function SurveyResponses({
  task,
  responses,
}: {
  task: Task;
  responses: Response[] | null;
}) {
  if (responses === null) {
    return (
      <div className="rounded-2xl border border-zinc-800 p-6 text-zinc-600">
        Reading responses…
      </div>
    );
  }

  if (responses.length === 0) {
    return (
      <div className="rounded-2xl border border-zinc-800 p-6 text-zinc-500">
        No completed responses yet. Partial answers aren&apos;t shown — or paid
        for — until someone finishes the whole thing.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {responses.map((r, i) => (
        <div
          key={r.workerId}
          className="overflow-hidden rounded-2xl border border-zinc-800"
        >
          <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/40 px-4 py-2">
            <span className="text-sm font-medium">Response {i + 1}</span>
            <span className="font-mono text-xs text-zinc-600">
              {(r.workerId as Hex).slice(0, 10)}…
            </span>
          </div>
          {task.spec.items.map((q, qi) => (
            <div key={q.id} className="border-b border-zinc-800/60 p-4 last:border-0">
              <p className="text-xs text-zinc-500">{q.text}</p>
              <p className="mt-1.5 leading-relaxed text-zinc-200">
                {r.answers[qi] || <span className="text-zinc-600">—</span>}
              </p>
            </div>
          ))}
        </div>
      ))}
    </div>
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
      <div className="truncate text-xs uppercase tracking-widest text-zinc-500">
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
