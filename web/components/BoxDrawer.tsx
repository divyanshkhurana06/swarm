"use client";

import { useRef, useState } from "react";
import { boxFromDrag, type Box } from "@/lib/images";

/**
 * Draw boxes around the things.
 *
 * Several boxes per image, because a street scene holds more than one car and
 * one box would force the worker to pick a favourite while the requester pays
 * for a complete answer.
 *
 * Coordinates are basis points of the image rather than pixels, so a box drawn
 * with a thumb lands in the same place on the requester's monitor. Pointer
 * events cover finger, stylus and mouse with one handler -- the difference
 * between working on the phones in the room and only on a laptop.
 */
export function BoxDrawer({
  src,
  boxes,
  onChange,
  disabled,
}: {
  src: string;
  boxes: Box[];
  onChange: (boxes: Box[]) => void;
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

  return (
    <div className="space-y-2">
      <div
        ref={ref}
        onPointerDown={(e) => {
          if (disabled || failed) return;
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
          // A tap is not a box; anything tiny is a stray touch, not an answer.
          if (final.w > 200 && final.h > 200) onChange([...boxes, final]);
        }}
        className={`relative touch-none select-none overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 ${
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
          alt="Draw a box around each target"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={`h-72 w-full object-contain transition-opacity ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
        />

        {boxes.map((b, i) => (
          <div
            key={i}
            className="absolute border-2 border-emerald-400 bg-emerald-400/15"
            style={{
              left: `${b.x / 100}%`,
              top: `${b.y / 100}%`,
              width: `${b.w / 100}%`,
              height: `${b.h / 100}%`,
            }}
          >
            <button
              onPointerDown={(e) => {
                // Don't let removing a box start a new one underneath.
                e.stopPropagation();
                onChange(boxes.filter((_, j) => j !== i));
              }}
              className="absolute -right-2 -top-2 grid h-5 w-5 place-items-center rounded-full bg-zinc-900 text-xs text-zinc-300 ring-1 ring-emerald-400/60"
            >
              ×
            </button>
          </div>
        ))}

        {live && live.w > 0 && (
          <div
            className="pointer-events-none absolute border-2 border-dashed border-emerald-300 bg-emerald-300/10"
            style={{
              left: `${live.x / 100}%`,
              top: `${live.y / 100}%`,
              width: `${live.w / 100}%`,
              height: `${live.h / 100}%`,
            }}
          />
        )}
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-600">
          {boxes.length === 0
            ? "Drag a box around each one you find"
            : `${boxes.length} box${boxes.length > 1 ? "es" : ""} · drag to add another`}
        </span>
        {boxes.length > 0 && (
          <button
            onClick={() => onChange([])}
            className="text-zinc-500 underline underline-offset-4"
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}
