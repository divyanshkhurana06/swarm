"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { formatUnits, type Hex } from "viem";
import { DUSD_DECIMALS, explorerTx } from "@/lib/contracts";
import { signPostTask, type SigningWallet } from "@/lib/wallet";
import { publicClient, tasksBy, type Task } from "@/lib/tasks";
import { extractPdfText, looksLikeQuestion, splitIntoQuestions } from "@/lib/survey";
import { prepareImage, estimateGas, MAX_BYTES_PER_IMAGE } from "@/lib/images";
import { Shell, Field, Input, WalletBar } from "@/components/ui";

/**
 * Requester side.
 *
 * Two kinds of work, two ways of deciding who gets paid:
 *
 *   Bounty   upload photos, workers box the target, first to answer takes it
 *   Survey   long-form answers, paid only when the whole response is finished
 */

type Kind = "bbox" | "survey";

const KINDS: {
  key: Kind;
  mode: number;
  title: string;
  blurb: string;
  placeholder: string;
  defaultQuorum: number;
  defaultCents: string;
  hints: { title: string; question: string };
}[] = [
  {
    key: "bbox",
    mode: 0,
    title: "Image bounty",
    blurb:
      "Upload photos; workers draw a box around the thing you're after. First to answer takes the bounty.",
    placeholder:
      "Or paste image URLs, one per line:\nhttps://images.example.com/street-1.jpg",
    defaultQuorum: 1,
    // A box takes longer than a tap and can only be claimed once, so it is
    // priced as a bounty rather than piecework.
    defaultCents: "5",
    hints: {
      title: "Dashcam frames",
      question: "Draw a box around any car",
    },
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
    // Written answers take a minute of real thought.
    defaultCents: "15",
    hints: {
      title: "Customer research",
      question: "Answer in your own words",
    },
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

  const [kind, setKind] = useState<Kind>("bbox");
  const kindInfo = KINDS.find((k) => k.key === kind)!;

  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [raw, setRaw] = useState("");
  const [rewardCents, setRewardCents] = useState("5");
  const [quorum, setQuorum] = useState(1);

  const [extracting, setExtracting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ hash: Hex } | null>(null);
  const [mine, setMine] = useState<Task[] | null>(null);
  const [uploaded, setUploaded] = useState<{ dataUri: string; name: string }[]>(
    []
  );
  const fileRef = useRef<HTMLInputElement>(null);

  // A requester who cannot find the answers they paid for has bought nothing.
  useEffect(() => {
    if (!address) return;
    tasksBy(address).then(setMine).catch(() => setMine([]));
  }, [address, done]);

  const items = useMemo(() => {
    if (kind === "survey") return splitIntoQuestions(raw);

    // Uploaded photos first, then any pasted URLs.
    const urls = raw
      .split("\n")
      .map((t) => t.trim())
      .filter((t) => t.startsWith("http"));

    return [...uploaded.map((u) => u.dataUri), ...urls].map((text, id) => ({
      id,
      text,
    }));
  }, [raw, kind, uploaded]);

  /** Roughly what the task spec will cost to store. */
  const specBytes = useMemo(
    () => items.reduce((n, i) => n + i.text.length, 0),
    [items]
  );

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

  // Switching type changes what the fields mean, not what is in them. The
  // requester's own words survive; only the pricing defaults move.
  const switchKind = (next: Kind) => {
    const info = KINDS.find((k) => k.key === next)!;
    setKind(next);
    setQuorum(info.defaultQuorum);
    setRewardCents(info.defaultCents);
  };

  const onImages = async (files: File[]) => {
    setError(null);
    setExtracting(true);
    try {
      const prepared: { dataUri: string; name: string }[] = [];
      for (const f of files) {
        const img = await prepareImage(f);
        if (img.bytes > MAX_BYTES_PER_IMAGE) {
          setError(
            `${f.name} is still ${Math.round(img.bytes / 1000)}KB after shrinking — try a simpler photo.`
          );
          continue;
        }
        prepared.push({ dataUri: img.dataUri, name: img.name });
      }
      setUploaded((p) => [...p, ...prepared]);
    } catch (e) {
      setError(
        `Could not read that image: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setExtracting(false);
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
    if (!title.trim() || !question.trim()) {
      setError("Give the batch a name and tell workers what to decide");
      return;
    }

    setError(null);
    setBusy(true);
    try {
      const spec = JSON.stringify({
        title,
        question,
        kind,
        answers: { "0": "Nothing here", "1": "Found it" },
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

      {mine && mine.length > 0 && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="text-xs uppercase tracking-widest text-zinc-500">
            Your tasks
          </div>
          <div className="mt-2 space-y-1.5">
            {mine.map((t) => (
              <Link
                key={t.id}
                href={`/results/${t.id}`}
                className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-800/60"
              >
                <span className="min-w-0 flex-1 truncate text-zinc-300">
                  {t.spec.title}
                </span>
                <span className="shrink-0 text-xs text-zinc-500">
                  {t.answers} answered
                </span>
                <span className="shrink-0 text-xs text-emerald-500">
                  results →
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

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
        <Input value={title} onChange={setTitle} placeholder={kindInfo.hints.title} />
      </Field>

      <Field
        label={kind === "survey" ? "Instruction to workers" : "What should workers decide?"}
      >
        <Input
          value={question}
          onChange={setQuestion}
          placeholder={kindInfo.hints.question}
        />
      </Field>


      {kind === "bbox" && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => fileRef.current?.click()}
              disabled={extracting}
              className="rounded-xl border border-zinc-700 px-4 py-2.5 text-sm font-medium disabled:opacity-40"
            >
              {extracting ? "Shrinking…" : "Upload JPG / PNG"}
            </button>
            <span className="text-xs text-zinc-600">
              Stored on-chain, so they&apos;re downscaled hard
            </span>
          </div>
          {uploaded.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {uploaded.map((u, i) => (
                <div key={i} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={u.dataUri}
                    alt={u.name}
                    className="h-16 w-16 rounded-lg border border-zinc-800 object-cover"
                  />
                  <button
                    onClick={() =>
                      setUploaded((p) => p.filter((_, j) => j !== i))
                    }
                    className="absolute -right-1.5 -top-1.5 h-5 w-5 rounded-full bg-zinc-800 text-xs text-zinc-300"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) onImages(files);
              e.target.value = "";
            }}
          />
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
          kind === "bbox"
            ? `Image URLs — one per line (${items.length})`
            : kind === "survey"
              ? `Questions — one per line (${items.length})`
              : `Items to label — one per line (${items.length})`
        }
      >
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder={kindInfo.placeholder}
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
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm">
        <Row
          label={kind === "survey" ? "Questions" : "Images"}
          value={String(items.length)}
        />
        {kind === "bbox" && specBytes > 0 && (
          <>
            <Row label="Stored on-chain" value={`${Math.round(specBytes / 1000)} KB`} />
            <Row
              label="Gas to post"
              value={`~${(estimateGas(specBytes) * 102e-9).toFixed(2)} MON`}
            />
          </>
        )}
        <Row
          label="Escrowed now"
          value={`$${formatUnits(funding, DUSD_DECIMALS)}`}
          accent
        />
        <p className="mt-2 text-xs leading-relaxed text-zinc-500">
          <strong className="text-zinc-400">On testnet the escrow is minted
          for you</strong>, so you can post without holding tokens. On mainnet
          the identical call pulls real USDC from your balance via{" "}
          <code className="text-zinc-400">transferFrom</code> — nothing else
          about the contract changes.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-zinc-600">
          {kind === "bbox" &&
            "Each image is a bounty: the first worker to box it takes the reward and the image closes. \"Nothing here\" is a real answer and is paid too, because not paying it would teach workers to invent boxes."}
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
