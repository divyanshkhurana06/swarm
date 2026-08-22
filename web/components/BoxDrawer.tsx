"use client";

import { useRef, useState } from "react";
import { boxFromDrag, type Box } from "@/lib/images";

/**
 * Draw a box around the thing.
 *
 * Coordinates are kept in basis points of the image rather than pixels, so a
 * box drawn with a thumb on a phone lands in the same place when the requester
 * opens it on a monitor.
 *
 * Pointer events rather than mouse or touch events: the same handler then
 * covers finger, stylus and mouse, which is the difference between this
 * working on the phones in the room and only on a laptop.
 */
export function BoxDrawer({
  src,
  box,
  onChange,
  disabled,
}: {
  src: string;
  box: Box | null;
  onChange: (box: Box | null) => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [live, setLive] = useState<Box | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  const toBp = (e: React.PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * 10_000,
      y: ((e.clientY - rect.top) / rect.height) * 10_000,
    };
  };

  const shown = live ?? box;

  return (
    <div className="space-y-2">
      <div
        ref={ref}
        onPointerDown={(e) => {
          if (disabled || failed) return;
          // Capture so a drag that leaves the image still finishes cleanly.
          (e.target as Element).setPointerCapture?.(e.pointerId);
          const p = toBp(e);
          setDrag(p);
          setLive({ x: p.x, y: p.y, w: 0, h: 0 });
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          setLive(boxFromDrag(drag, toBp(e)));
        }}
        onPointerUp={(e) => {
          if (!drag) return;
          const final = boxFromDrag(drag, toBp(e));
          setDrag(null);
          setLive(null);
          // A tap is not a box; treat anything tiny as a miss.
          onChange(final.w > 200 && final.h > 200 ? final : null);
        }}
        className={`relative touch-none overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 select-none ${
          disabled ? "" : "cursor-crosshair"
        }`}
      >
        {!loaded && !failed && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-600">
            Loading image…
          </div>
        )}
        {failed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center">
            <span className="text-sm text-amber-400">
              This image didn&apos;t load
            </span>
            <span className="text-xs text-zinc-600">
              Mark it as nothing found rather than guessing
            </span>
          </div>
        )}

        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt="Draw a box around the target"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={`h-72 w-full object-contain transition-opacity ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
        />

        {shown && shown.w > 0 && (
          <div
            className="pointer-events-none absolute border-2 border-emerald-400 bg-emerald-400/15"
            style={{
              left: `${shown.x / 100}%`,
              top: `${shown.y / 100}%`,
              width: `${shown.w / 100}%`,
              height: `${shown.h / 100}%`,
            }}
          />
        )}
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-600">
          {shown ? "Drag again to redraw" : "Drag a box around it"}
        </span>
        {box && (
          <button
            onClick={() => onChange(null)}
            className="text-zinc-500 underline underline-offset-4"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
