/**
 * Turning a document into answerable questions.
 *
 * A requester has a survey as a PDF or a wall of pasted text, not as a tidy
 * array. This pulls the text out and splits it into questions, then hands the
 * result back for the requester to edit -- deliberately, because a heuristic
 * will sometimes be wrong and silently posting a mangled survey wastes both
 * the requester's money and the workers' time.
 */

export type Question = { id: number; text: string };

/**
 * Extracts text from a PDF, preserving line structure.
 *
 * pdf.js returns positioned fragments, not lines. Joining them all with
 * spaces -- which is the obvious thing to do -- destroys every line break and
 * leaves the splitter with a single wall of text and nothing to split on.
 * Fragments are grouped back into lines using the end-of-line flag where the
 * document provides it, and their baseline y-coordinate where it does not.
 */
export async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.mjs",
    import.meta.url
  ).toString();

  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const lines: string[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();

    let current = "";
    let lastY: number | null = null;

    for (const item of content.items) {
      if (!("str" in item)) continue;

      // transform[5] is the baseline y. A jump means a new line even when the
      // document never sets hasEOL.
      const y = item.transform?.[5] as number | undefined;
      const movedLine =
        lastY !== null && y !== undefined && Math.abs(y - lastY) > 2;

      if (movedLine && current.trim()) {
        lines.push(current.trim());
        current = "";
      }

      current += item.str;
      if (y !== undefined) lastY = y;

      if (item.hasEOL) {
        if (current.trim()) lines.push(current.trim());
        current = "";
      }
    }

    if (current.trim()) lines.push(current.trim());
  }

  return lines.join("\n");
}

/** Question numbering a real document actually uses. */
const NUMBERED = /^\s*(?:Q\s*)?(\d{1,2})\s*[.)\]:-]\s+/i;
const BULLET = /^\s*[-*•●▪]\s+/;

/**
 * Splits a document into questions.
 *
 * Works line by line and joins continuations, because a question that wraps
 * across two lines in the PDF is still one question -- treating each visual
 * line as an item is how you end up paying workers to answer sentence
 * fragments.
 */
export function splitIntoQuestions(text: string): Question[] {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  const numbered = lines.filter((l) => NUMBERED.test(l)).length;
  const bulleted = lines.filter((l) => BULLET.test(l)).length;

  const chunks: string[] = [];
  let buffer = "";

  const flush = () => {
    if (buffer.trim()) chunks.push(buffer.trim());
    buffer = "";
  };

  if (numbered >= 2 || bulleted >= 2) {
    // The document numbers its questions, so a marker starts a new one and
    // everything until the next marker belongs to it.
    for (const line of lines) {
      const isMarker = NUMBERED.test(line) || BULLET.test(line);
      if (isMarker) {
        flush();
        buffer = line.replace(NUMBERED, "").replace(BULLET, "");
      } else if (buffer) {
        buffer += " " + line;
      } else {
        // Preamble before the first question -- a title, a heading. Skip it.
      }
    }
    flush();
  } else if (text.includes("?")) {
    // No numbering, but question marks tell us where each one ends.
    for (const line of lines) {
      buffer = buffer ? `${buffer} ${line}` : line;
      if (line.includes("?")) flush();
    }
    flush();
  } else {
    // Nothing to go on: one question per line is the least surprising guess.
    for (const line of lines) chunks.push(line);
  }

  return chunks
    .map((t) => t.replace(/\s+/g, " ").trim())
    // Headings, page numbers and stray fragments are not questions.
    .filter((t) => t.length >= 8 && t.split(" ").length >= 3)
    .map((text, id) => ({ id, text }));
}

/** Cheap sanity check so we can warn before a requester pays for nonsense. */
export function looksLikeQuestion(text: string): boolean {
  return (
    text.trim().endsWith("?") ||
    /^(how|what|why|when|where|which|who|do|does|did|is|are|would|could|should|rate|describe|explain|tell|have|has|can|will|on a scale)\b/i.test(
      text.trim()
    )
  );
}
