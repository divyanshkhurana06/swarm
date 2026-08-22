"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { formatUnits, type Hex } from "viem";
import { DUSD_DECIMALS, explorerTx } from "@/lib/contracts";
import { signPostTask, type SigningWallet } from "@/lib/wallet";
import { publicClient } from "@/lib/tasks";

/**
 * Requester side.
 *
 * Paste the things you need labelled, set what an answer is worth, sign once.
 * The task and every item go on-chain, so it is visible to workers with no
 * backend in between -- and the requester needs neither gas nor tokens to
 * post, for the same reason workers need neither to earn.
 */

const CONFIGURED = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);

export default function Page() {
  if (!CONFIGURED) {
    return (
      <Shell>
        <p className="text-zinc-400">
          Set <code className="text-zinc-200">NEXT_PUBLIC_PRIVY_APP_ID</code> to
          post tasks.
        </p>
      </Shell>
    );
  }
  return <PostTask />;
}

function PostTask() {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
  const address = wallet?.address as Hex | undefined;

  const [title, setTitle] = useState("Support ticket triage");
  const [question, setQuestion] = useState("Is this ticket urgent?");
  const [labelNo, setLabelNo] = useState("Not urgent");
  const [labelYes, setLabelYes] = useState("Urgent");
  const [raw, setRaw] = useState(
    "The site is down for all our users right now.\nHow do I change my avatar?\nBilling charged me twice this month.\nLove the new dark mode, thanks!\nI can't log in and my demo is in ten minutes."
  );
  const [rewardCents, setRewardCents] = useState("0.5");

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ hash: Hex; taskId?: number } | null>(null);

  const items = useMemo(
    () =>
      raw
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean)
        .map((text, id) => ({ id, text })),
    [raw]
  );

  // Reward is entered in cents because "0.005 DUSD" means nothing to a
  // requester deciding what a judgement is worth.
  const rewardUnits = useMemo(() => {
    const cents = Number(rewardCents);
    if (!Number.isFinite(cents) || cents <= 0) return 0n;
    return BigInt(Math.round(cents * 10_000)); // 1 cent = 10,000 units at 6dp
  }, [rewardCents]);

  const answersWanted = 3; // a small crowd per item, so disagreement shows up
  const funding = rewardUnits * BigInt(items.length * answersWanted);

  const post = useCallback(async () => {
    if (!wallet || !address) return;
    if (items.length === 0) {
      setError("Add at least one thing to label");
      return;
    }
    if (rewardUnits === 0n) {
      setError("Set a reward above zero");
      return;
    }

    setError(null);
    setBusy(true);
    try {
      const spec = JSON.stringify({
        title,
        question,
        answers: { "0": labelNo, "1": labelYes },
        items,
      });

      setStatus("Sign the task…");
      const signature = await signPostTask(
        wallet as unknown as SigningWallet,
        spec,
        rewardUnits,
        funding,
        items.length
      );

      setStatus("Posting on Monad…");
      const res = await fetch("/api/relay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "postTask",
          spec,
          rewardPerLabel: rewardUnits.toString(),
          amount: funding.toString(),
          items: items.length,
          requester: address,
          signature,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Posting failed");

      setStatus("Confirming…");
      await publicClient.waitForTransactionReceipt({ hash: json.hash });
      setDone({ hash: json.hash });
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [wallet, address, items, rewardUnits, funding, title, question, labelNo, labelYes]);

  if (!ready) {
    return (
      <Shell>
        <div className="text-zinc-600">Loading…</div>
      </Shell>
    );
  }

  if (!authenticated) {
    return (
      <Shell>
        <h1 className="text-3xl font-semibold tracking-tight">Post a task</h1>
        <p className="text-zinc-400">
          Get anything labelled by a live crowd, paid per answer. Sign in and
          post — you need no gas and no tokens.
        </p>
        <button
          onClick={login}
          className="rounded-2xl bg-emerald-500 py-4 text-lg font-semibold text-zinc-950"
        >
          Continue with Google
        </button>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell>
        <div className="flex flex-col gap-4 text-center">
          <div className="text-5xl">✓</div>
          <h1 className="text-2xl font-semibold">Your task is live</h1>
          <p className="text-zinc-400">
            It&apos;s on-chain and visible to every worker right now.
          </p>
          <Link
            href="/"
            className="rounded-2xl bg-emerald-500 py-4 font-semibold text-zinc-950"
          >
            See it in the worker app
          </Link>
          <a
            href={explorerTx(done.hash)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs text-emerald-500"
          >
            View on explorer ↗
          </a>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Post a task</h1>
        <Link href="/" className="text-sm text-zinc-500">
          Worker view →
        </Link>
      </div>

      <Field label="What is this batch?">
        <Input value={title} onChange={setTitle} />
      </Field>

      <Field label="What should workers decide?">
        <Input value={question} onChange={setQuestion} />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Answer A">
          <Input value={labelNo} onChange={setLabelNo} />
        </Field>
        <Field label="Answer B">
          <Input value={labelYes} onChange={setLabelYes} />
        </Field>
      </div>

      <Field label={`Items to label — one per line (${items.length})`}>
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={7}
          className="w-full resize-y rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm leading-relaxed outline-none focus:border-zinc-600"
        />
      </Field>

      <Field label="Pay per answer (cents)">
        <Input value={rewardCents} onChange={setRewardCents} mono />
      </Field>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm">
        <Row label="Items" value={String(items.length)} />
        <Row label="Answers wanted each" value={String(answersWanted)} />
        <Row
          label="Total budget"
          value={`$${formatUnits(funding, DUSD_DECIMALS)}`}
          accent
        />
        <p className="mt-2 text-xs leading-relaxed text-zinc-600">
          Several people answer each item independently. Where they disagree,
          the item was ambiguous — that shows up in your results rather than
          being hidden.
        </p>
      </div>

      <button
        onClick={post}
        disabled={busy}
        className="rounded-2xl bg-emerald-500 py-5 text-lg font-semibold text-zinc-950 active:scale-[0.98] transition disabled:opacity-40"
      >
        {busy ? (status ?? "Working…") : "Post it"}
      </button>

      {error && (
        <div className="rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col gap-5 p-6">
      {children}
    </main>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs uppercase tracking-widest text-zinc-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function Input({
  value,
  onChange,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 outline-none focus:border-zinc-600 ${
        mono ? "font-mono" : ""
      }`}
    />
  );
}

function Row({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-zinc-500">{label}</span>
      <span className={accent ? "font-semibold text-emerald-400" : "text-zinc-200"}>
        {value}
      </span>
    </div>
  );
}
