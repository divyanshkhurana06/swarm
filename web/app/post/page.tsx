"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { formatUnits, type Hex } from "viem";
import { DUSD_DECIMALS, explorerTx } from "@/lib/contracts";
import { signPostTask, type SigningWallet } from "@/lib/wallet";
import { publicClient } from "@/lib/tasks";
import { extractPdfText, looksLikeQuestion, splitIntoQuestions } from "@/lib/survey";
import { Shell, Field, Input, WalletBar } from "@/components/ui";

/**
 * Requester side.
 *
 * Three kinds of work, three ways of deciding who gets paid, because they are
 * genuinely different problems:
 *
 *   Images   objective, fast, first come first served
 *   Text     judgement calls, scored by majority so guessing does not pay
 *   Survey   long-form, paid only when the whole response is finished
 */

type Kind = "image" | "text" | "survey";

const KINDS: {
  key: Kind;
  mode: number;
  title: string;
  blurb: string;
  placeholder: string;
  defaultQuorum: number;
}[] = [
  {
    key: "image",
    mode: 0,
    title: "Image labelling",
    blurb: "Objective and quick. First to answer is paid, no waiting.",
    placeholder:
      "https://images.example.com/street-1.jpg\nhttps://images.example.com/street-2.jpg",
    defaultQuorum: 1,
  },
  {
    key: "text",
    mode: 1,
    title: "Text labelling",
    blurb:
      "Judgement calls. Several people answer and only those who agree with the majority are paid.",
    placeholder:
      "The site is down for all our users right now.\nHow do I change my avatar?\nBilling charged me twice this month.",
    defaultQuorum: 3,
  },
  {
    key: "survey",
    mode: 2,
    title: "Survey",
    blurb:
      "Long-form answers. Upload a PDF or paste your questions. Paid only on a completed response.",
    placeholder:
      "What made you choose us over the alternatives?\nHow often do you use the product?\nWhat would make you recommend it to a colleague?",
    defaultQuorum: 1,
  },
];

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

  const [kind, setKind] = useState<Kind>("text");
  const kindInfo = KINDS.find((k) => k.key === kind)!;

  const [title, setTitle] = useState("Support ticket triage");
  const [question, setQuestion] = useState("Is this ticket urgent?");
  const [labelNo, setLabelNo] = useState("Not urgent");
  const [labelYes, setLabelYes] = useState("Urgent");
  const [raw, setRaw] = useState(KINDS[1].placeholder);
  const [rewardCents, setRewardCents] = useState("0.5");
  const [quorum, setQuorum] = useState(3);

  const [extracting, setExtracting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ hash: Hex } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => {
    if (kind === "survey") return splitIntoQuestions(raw);
    return raw
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((text, id) => ({ id, text }));
  }, [raw, kind]);

  // Entered in cents: "0.005 DUSD" means nothing to someone deciding what a
  // judgement is worth.
  const rewardUnits = useMemo(() => {
    const cents = Number(rewardCents);
    if (!Number.isFinite(cents) || cents <= 0) return 0n;
    return BigInt(Math.round(cents * 10_000));
  }, [rewardCents]);

  // Escrow has to cover the worst case: every item answered `quorum` times.
  // Surveys pay per completed response, which is the same arithmetic.
  const funding = rewardUnits * BigInt(items.length * quorum);

  const switchKind = (next: Kind) => {
    const info = KINDS.find((k) => k.key === next)!;
    setKind(next);
    setQuorum(info.defaultQuorum);
    setRaw(info.placeholder);
    if (next === "image") {
      setTitle("Street scenes");
      setQuestion("Is there a car in this image?");
      setLabelNo("No car");
      setLabelYes("Car");
    } else if (next === "text") {
      setTitle("Support ticket triage");
      setQuestion("Is this ticket urgent?");
      setLabelNo("Not urgent");
      setLabelYes("Urgent");
    } else {
      setTitle("Customer research");
      setQuestion("Answer in your own words");
    }
  };

  const onFile = async (file: File) => {
    setError(null);
    setExtracting(true);
    try {
      const text = file.name.toLowerCase().endsWith(".pdf")
        ? await extractPdfText(file)
        : await file.text();
      const found = splitIntoQuestions(text);
      if (found.length === 0) {
        setError("Couldn't find questions in that file — paste them instead.");
      } else {
        setRaw(found.map((q) => q.text).join("\n"));
      }
    } catch (e) {
      setError(
        `Could not read that file: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setExtracting(false);
    }
  };

  const post = useCallback(async () => {
    if (!wallet || !address) return;
    if (items.length === 0) {
      setError("Add at least one item");
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
        kind,
        answers: { "0": labelNo, "1": labelYes },
        items,
      });

      setStatus("Sign the task…");
      const signature = await signPostTask(
        wallet as unknown as SigningWallet,
        spec,
        rewardUnits,
        funding,
        items.length,
        kindInfo.mode,
        quorum
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
          mode: kindInfo.mode,
          quorum,
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
  }, [
    wallet,
    address,
    items,
    rewardUnits,
    funding,
    title,
    question,
    labelNo,
    labelYes,
    kind,
    kindInfo,
    quorum,
  ]);

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
          Get anything labelled by a live crowd, paid per answer. You need no gas
          and no tokens to post.
        </p>
        <button
          onClick={login}
          className="rounded-2xl bg-emerald-500 py-4 text-lg font-semibold text-zinc-950"
        >
          Continue with Google
        </button>
        <Link href="/" className="text-center text-sm text-zinc-500">
          I want to earn instead →
        </Link>
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

  const badQuestions =
    kind === "survey" ? items.filter((i) => !looksLikeQuestion(i.text)).length : 0;

  return (
    <Shell wide>
      {address && <WalletBar address={address} />}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Post a task</h1>
        <Link href="/" className="text-sm text-zinc-500">
          Worker view →
        </Link>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {KINDS.map((k) => (
          <button
            key={k.key}
            onClick={() => switchKind(k.key)}
            className={`rounded-xl border px-3 py-3 text-sm font-medium transition ${
              kind === k.key
                ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-300"
                : "border-zinc-800 bg-zinc-900/60 text-zinc-400"
            }`}
          >
            {k.title}
          </button>
        ))}
      </div>
      <p className="-mt-2 text-xs leading-relaxed text-zinc-500">
        {kindInfo.blurb}
      </p>

      <Field label="What is this batch?">
        <Input value={title} onChange={setTitle} />
      </Field>

      <Field
        label={kind === "survey" ? "Instruction to workers" : "What should workers decide?"}
      >
        <Input value={question} onChange={setQuestion} />
      </Field>

      {kind !== "survey" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Answer A">
            <Input value={labelNo} onChange={setLabelNo} />
          </Field>
          <Field label="Answer B">
            <Input value={labelYes} onChange={setLabelYes} />
          </Field>
        </div>
      )}

      {kind === "survey" && (
        <div className="flex items-center gap-3">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={extracting}
            className="rounded-xl border border-zinc-700 px-4 py-2.5 text-sm font-medium disabled:opacity-40"
          >
            {extracting ? "Reading…" : "Upload PDF or text"}
          </button>
          <span className="text-xs text-zinc-600">
            We&apos;ll pull out the questions — check them before posting.
          </span>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.txt,.md"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
            }}
          />
        </div>
      )}

      <Field
        label={
          kind === "image"
            ? `Image URLs — one per line (${items.length})`
            : kind === "survey"
              ? `Questions — one per line (${items.length})`
              : `Items to label — one per line (${items.length})`
        }
      >
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={8}
          className="w-full resize-y rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 font-mono text-sm leading-relaxed outline-none focus:border-zinc-600"
        />
      </Field>

      {badQuestions > 0 && (
        <p className="-mt-2 text-xs text-amber-400">
          {badQuestions} line{badQuestions > 1 ? "s don't" : " doesn't"} read like
          a question. Worth a look before you pay for answers to it.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field
          label={kind === "survey" ? "Pay per question (cents)" : "Pay per answer (cents)"}
        >
          <Input value={rewardCents} onChange={setRewardCents} mono />
        </Field>
        {kind !== "survey" && (
          <Field label="Answers per item">
            <Input
              value={String(quorum)}
              onChange={(v) => setQuorum(Math.max(1, Math.min(9, Number(v) || 1)))}
              mono
            />
          </Field>
        )}
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm">
        <Row label={kind === "survey" ? "Questions" : "Items"} value={String(items.length)} />
        {kind !== "survey" && <Row label="Answers each" value={String(quorum)} />}
        <Row
          label="Escrowed now"
          value={`$${formatUnits(funding, DUSD_DECIMALS)}`}
          accent
        />
        <p className="mt-2 text-xs leading-relaxed text-zinc-600">
          {kind === "text" &&
            "Everyone answers independently. Only those who agree with the majority are paid, so a worker guessing loses money rather than earning it. Whatever the crowd doesn't earn comes back to you."}
          {kind === "image" &&
            "Paid the moment an answer arrives — the task is objective enough that waiting for a vote would only slow it down."}
          {kind === "survey" &&
            "A worker is paid for the whole response, once every question is answered. A half-filled form is worth nothing to you, so it earns nothing."}
        </p>
      </div>

      <button
        onClick={post}
        disabled={busy}
        className="rounded-2xl bg-emerald-500 py-5 text-lg font-semibold text-zinc-950 active:scale-[0.98] transition disabled:opacity-40"
      >
        {busy ? (status ?? "Working…") : `Post and escrow $${formatUnits(funding, DUSD_DECIMALS)}`}
      </button>

      {error && (
        <div className="rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
    </Shell>
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
