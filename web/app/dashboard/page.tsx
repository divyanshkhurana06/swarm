"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { createPublicClient, http, formatUnits, type Hex } from "viem";
import {
  chain,
  TASK_POOL,
  TASK_ID,
  taskPoolAbi,
  DUSD_DECIMALS,
} from "@/lib/contracts";

/**
 * The projector wall.
 *
 * Everything here is read straight from chain logs -- nothing is simulated,
 * buffered or replayed. When the room starts tapping, this is the room's
 * activity arriving as it is mined.
 */

const publicClient = createPublicClient({ chain, transport: http() });

type Payout = {
  key: string;
  workerId: Hex;
  reward: bigint;
  itemId: bigint;
  answer: number;
};

export default function Dashboard() {
  const [labels, setLabels] = useState(0n);
  const [paid, setPaid] = useState(0n);
  const [workers, setWorkers] = useState(0n);
  const [remaining, setRemaining] = useState(0n);
  const [feed, setFeed] = useState<Payout[]>([]);
  const [qr, setQr] = useState<string | null>(null);
  const [rate, setRate] = useState(0);

  const history = useRef<{ t: number; n: bigint }[]>([]);

  useEffect(() => {
    QRCode.toDataURL(window.location.origin, {
      margin: 1,
      width: 512,
      color: { dark: "#09090b", light: "#ffffff" },
    }).then(setQr);
  }, []);

  // Counters.
  useEffect(() => {
    const read = async () => {
      try {
        const [l, p, w, r] = await Promise.all([
          publicClient.readContract({
            address: TASK_POOL, abi: taskPoolAbi, functionName: "totalLabels",
          }),
          publicClient.readContract({
            address: TASK_POOL, abi: taskPoolAbi, functionName: "totalPaid",
          }),
          publicClient.readContract({
            address: TASK_POOL, abi: taskPoolAbi, functionName: "workerCount",
          }),
          publicClient.readContract({
            address: TASK_POOL, abi: taskPoolAbi, functionName: "remaining", args: [TASK_ID],
          }),
        ]);
        setLabels(l); setPaid(p); setWorkers(w); setRemaining(r);

        // Rolling answers-per-minute over the last 30 seconds.
        const now = Date.now();
        history.current = [...history.current, { t: now, n: l }].filter(
          (s) => now - s.t < 30_000
        );
        const first = history.current[0];
        const span = (now - first.t) / 1000;
        if (span > 3) setRate(Number(l - first.n) / (span / 60));
      } catch (e) {
        // The projector must never show a stack trace, but swallowing this
        // silently once cost us real debugging time -- log it.
        console.error("dashboard read failed:", e);
      }
    };

    read();
    const t = setInterval(read, 1500);
    return () => clearInterval(t);
  }, []);

  // Live payout feed.
  useEffect(() => {
    const unwatch = publicClient.watchContractEvent({
      address: TASK_POOL,
      abi: taskPoolAbi,
      eventName: "LabelSubmitted",
      pollingInterval: 800,
      onLogs: (logs) => {
        const next = logs.map((log, i) => ({
          key: `${log.transactionHash}-${log.logIndex ?? i}`,
          workerId: log.args.workerId as Hex,
          reward: log.args.reward as bigint,
          itemId: log.args.itemId as bigint,
          answer: Number(log.args.answer),
        }));
        setFeed((f) => [...next.reverse(), ...f].slice(0, 24));
      },
    });
    return () => unwatch();
  }, []);

  const money = (v: bigint) =>
    `$${Number(formatUnits(v, DUSD_DECIMALS)).toFixed(3)}`;

  return (
    <main className="min-h-dvh p-10 flex flex-col gap-10">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-6xl font-semibold tracking-tight">Swarm</h1>
          <p className="mt-2 text-xl text-zinc-500">
            Every row is a human paid on {chain.name}, in real time
          </p>
        </div>
        {qr && (
          <div className="text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt="Scan to start earning" className="w-40 rounded-xl" />
            <p className="mt-2 text-sm text-zinc-500">Scan to join</p>
          </div>
        )}
      </header>

      {/* Two columns until there is genuinely room for four -- venue
          projectors are frequently 1280x720, not 1920x1080. */}
      <section className="grid grid-cols-2 xl:grid-cols-4 gap-5">
        <Stat label="Answers on chain" value={labels.toString()} accent />
        <Stat label="Paid out" value={money(paid)} accent />
        <Stat label="Workers" value={workers.toString()} />
        <Stat label="Answers / min" value={rate.toFixed(0)} />
      </section>

      <section className="flex-1 min-h-0 flex flex-col rounded-3xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-x-4 border-b border-zinc-800 px-6 py-3 text-sm uppercase tracking-widest text-zinc-500">
          <span>Live payouts</span>
          <span className="tabular-nums">Pool remaining {money(remaining)}</span>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          {feed.length === 0 ? (
            <div className="flex h-full items-center justify-center text-2xl text-zinc-700">
              Waiting for the room…
            </div>
          ) : (
            feed.map((p) => (
              <div
                key={p.key}
                className="animate-slide-in flex items-center justify-between gap-4 border-b border-zinc-800/60 px-6 py-3.5 font-mono text-base xl:text-lg"
              >
                <span className="text-zinc-500 shrink-0">
                  {p.workerId.slice(0, 10)}…
                </span>
                <span className="truncate text-zinc-600">
                  item {p.itemId.toString()} → {p.answer === 1 ? "flag" : "fine"}
                </span>
                <span className="shrink-0 font-semibold text-emerald-400">
                  +{money(p.reward)}
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      <footer className="flex flex-wrap justify-between gap-x-6 gap-y-1 font-mono text-xs xl:text-sm text-zinc-600">
        <span className="truncate">TaskPool {TASK_POOL}</span>
        <span className="shrink-0">
          chain {chain.id} · P256 verified on-chain at 0x0100
        </span>
      </footer>
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
    <div className="min-w-0 rounded-3xl border border-zinc-800 bg-zinc-900/40 p-6">
      <div className="truncate text-xs xl:text-sm uppercase tracking-widest text-zinc-500">
        {label}
      </div>
      <div
        className={`mt-2 truncate text-4xl xl:text-6xl font-semibold tabular-nums ${
          accent ? "text-emerald-400" : "text-zinc-100"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
