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
const MAX_EDGE = 448;

/** JPEG quality. Below ~0.5 boxes get hard to place accurately. */
const QUALITY = 0.5;

/** Refuse anything that would blow up the post transaction. */
export const MAX_BYTES_PER_IMAGE = 22_000;

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

/**
 * Renders each page of a PDF to an image.
 *
 * A requester with a contact sheet or a scanned batch has one file, not
 * twenty JPEGs, and asking them to export the pages by hand is asking them
 * not to bother. Rendered at the same size limit as an upload, so a PDF page
 * costs the same to store as a photo.
 */
export async function pdfToImages(
  file: File,
  grid: { cols: number; rows: number } = { cols: 1, rows: 1 }
): Promise<PreparedImage[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.mjs",
    import.meta.url
  ).toString();

  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const out: PreparedImage[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    // Render each cell at roughly MAX_EDGE, not the whole page -- otherwise a
    // 3x3 sheet arrives with every cell a third of a usable size.
    const cells = Math.max(grid.cols, grid.rows);
    const viewport = page.getViewport({
      scale: Math.min(4, (MAX_EDGE * cells) / Math.max(base.width, base.height)),
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");

    await page.render({ canvas, canvasContext: ctx, viewport }).promise;

    // A page holding a sheet of photos is many jobs, not one. Cutting it up
    // here means each cell arrives at working resolution and earns its own
    // reward, instead of nineteen of them riding free on the twentieth.
    const tw = canvas.width / grid.cols;
    const th = canvas.height / grid.rows;

    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        const label =
          grid.cols * grid.rows === 1
            ? `${file.name} p${i}`
            : `${file.name} p${i} r${r + 1}c${c + 1}`;
        out.push(
          await encodeRegion(canvas, c * tw, r * th, tw, th, label)
        );
      }
    }
  }

  return out;
}

export type PreparedImage = {
  dataUri: string;
  bytes: number;
  name: string;
};

/** Draws a source region onto a canvas and encodes it within the byte budget. */
async function encodeRegion(
  source: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  name: string
): Promise<PreparedImage> {
  const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  let quality = QUALITY;
  let dataUri = canvas.toDataURL("image/jpeg", quality);
  while (dataUri.length > MAX_BYTES_PER_IMAGE && quality > 0.25) {
    quality -= 0.1;
    dataUri = canvas.toDataURL("image/jpeg", quality);
  }

  return { dataUri, bytes: dataUri.length, name };
}

/**
 * Slices a contact sheet into separate images.
 *
 * A page of twenty car photos is one file but twenty jobs. Stored whole it
 * would be downscaled to the point where no cell is boxable -- and it would
 * still be a single bounty, so nineteen of the photos would go unpaid. Cut
 * into tiles, each cell arrives at full working resolution and each is worth
 * its own reward.
 *
 * The requester chooses the grid, because only they know how the sheet is
 * laid out and guessing it wrong wastes their escrow.
 */
export async function sliceIntoTiles(
  file: File,
  cols: number,
  rows: number
): Promise<PreparedImage[]> {
  const bitmap = await createImageBitmap(file);
  const tw = bitmap.width / cols;
  const th = bitmap.height / rows;

  const tiles: PreparedImage[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push(
        await encodeRegion(
          bitmap,
          c * tw,
          r * th,
          tw,
          th,
          `${file.name} r${r + 1}c${c + 1}`
        )
      );
    }
  }

  bitmap.close();
  return tiles;
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file);
  const out = await encodeRegion(
    bitmap,
    0,
    0,
    bitmap.width,
    bitmap.height,
    file.name
  );
  bitmap.close();
  return out;
}

/** Native pixel size, so the form can warn about sheets before they are posted. */
export async function imageSize(file: File) {
  const bitmap = await createImageBitmap(file);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
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
