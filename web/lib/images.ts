/**
 * Getting an uploaded photo small enough to live on-chain.
 *
 * There is no backend and no storage service, so an uploaded image has to go
 * into the task spec itself. That means the file has to shrink from a few
 * megabytes to a few kilobytes: downscaled hard and re-encoded as JPEG.
 *
 * The result is unmistakably lossy. That is the correct trade for "is there a
 * car in this" -- it is not the correct trade for medical imaging, and a real
 * deployment would put the original behind a URL and keep only the pointer
 * on-chain.
 */

/** Longest edge, in pixels, of a stored image. */
const MAX_EDGE = 320;

/** JPEG quality. Below ~0.5 boxes get hard to place accurately. */
const QUALITY = 0.5;

/** Refuse anything that would blow up the post transaction. */
export const MAX_BYTES_PER_IMAGE = 14_000;

/**
 * Roughly what it costs to put bytes into contract storage.
 *
 * One SSTORE per 32-byte word, plus calldata. Worth showing a requester
 * before they sign: at ~1.4 MON for a single 21KB photo, on-chain image
 * storage is a demo affordance, not an architecture.
 */
export function estimateGas(bytes: number): number {
  const words = Math.ceil(bytes / 32);
  return words * 20_000 + bytes * 16 + 200_000;
}

export type PreparedImage = {
  dataUri: string;
  bytes: number;
  name: string;
};

export async function prepareImage(file: File): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file);

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  let quality = QUALITY;
  let dataUri = canvas.toDataURL("image/jpeg", quality);

  // Step the quality down rather than silently posting something enormous.
  while (dataUri.length > MAX_BYTES_PER_IMAGE && quality > 0.25) {
    quality -= 0.1;
    dataUri = canvas.toDataURL("image/jpeg", quality);
  }

  return { dataUri, bytes: dataUri.length, name: file.name };
}

// --- bounding boxes --------------------------------------------------------

/** A box in basis points of the image, so it survives any display size. */
export type Box = { x: number; y: number; w: number; h: number };

export function packBox(box: Box | null): bigint {
  if (!box || box.w <= 0 || box.h <= 0) return 0n;

  const clamp = (v: number) => BigInt(Math.max(0, Math.min(10_000, Math.round(v))));
  return (
    (clamp(box.x) << 48n) | (clamp(box.y) << 32n) | (clamp(box.w) << 16n) | clamp(box.h)
  );
}

export function unpackBox(packed: bigint): Box | null {
  if (packed === 0n) return null;
  return {
    x: Number((packed >> 48n) & 0xffffn),
    y: Number((packed >> 32n) & 0xffffn),
    w: Number((packed >> 16n) & 0xffffn),
    h: Number(packed & 0xffffn),
  };
}

/** Normalises a drag into a box, whichever direction it was drawn. */
export function boxFromDrag(
  start: { x: number; y: number },
  end: { x: number; y: number }
): Box {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    w: Math.abs(end.x - start.x),
    h: Math.abs(end.y - start.y),
  };
}
