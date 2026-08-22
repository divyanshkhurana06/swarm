"use client";

import { useState } from "react";
import { chain } from "@/lib/contracts";

export function Shell({
  children,
  wide,
}: {
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <main
      className={`mx-auto flex min-h-dvh w-full flex-col gap-5 p-6 ${
        wide ? "max-w-lg" : "max-w-md"
      }`}
    >
      {children}
    </main>
  );
}

/**
 * The wallet, always visible.
 *
 * A worker who cannot see their own address has no way to check that the money
 * arrived, and "trust us, it's there" is exactly the thing this is supposed to
 * replace. One tap copies it; one tap opens it on the explorer.
 */
export function WalletBar({
  address,
  email,
}: {
  address: string;
  email?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard is blocked in some embedded browsers; the address is still
      // on screen to read.
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-widest text-zinc-500">
          Your wallet
        </div>
        <button
          onClick={copy}
          className="block truncate font-mono text-xs text-zinc-300"
          title={address}
        >
          {copied ? "copied" : `${address.slice(0, 10)}…${address.slice(-6)}`}
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {email && (
          <span className="hidden max-w-[9rem] truncate text-xs text-zinc-600 sm:block">
            {email}
          </span>
        )}
        <a
          href={`${chain.blockExplorers.default.url}/address/${address}`}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400"
        >
          View ↗
        </a>
      </div>
    </div>
  );
}

export function Field({
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

export function Input({
  value,
  onChange,
  mono,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 outline-none focus:border-zinc-600 ${
        mono ? "font-mono text-sm" : ""
      }`}
    />
  );
}

export function Badge({
  children,
  tone = "zinc",
}: {
  children: React.ReactNode;
  tone?: "zinc" | "emerald" | "amber" | "sky";
}) {
  const tones = {
    zinc: "bg-zinc-800 text-zinc-400",
    emerald: "bg-emerald-500/15 text-emerald-400",
    amber: "bg-amber-500/15 text-amber-400",
    sky: "bg-sky-500/15 text-sky-400",
  };
  return (
    <span
      className={`shrink-0 whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
