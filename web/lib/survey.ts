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

/** Extracts text from a PDF entirely in the browser. */
export async function extractPdfText(file: File): Promise<string> {
  // Loaded on demand: pdf.js is large and most requesters paste text instead.
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.mjs",
    import.meta.url
  ).toString();

  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages: string[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Items carry their own spacing; join on spaces and tidy up after.
    pages.push(
      content.items
        .map((it) => ("str" in it ? it.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
    );
  }

  return pages.join("\n");
}

/**
 * Splits a document into questions.
 *
 * Tries the structures real surveys actually use, in order of how confident
 * we can be about them: explicit question marks, then numbered or bulleted
 * lines, then plain lines. Anything too short to be a question is dropped.
 */
export function splitIntoQuestions(text: string): Question[] {
  const cleaned = text.replace(/\r/g, "").trim();
  if (!cleaned) return [];

  let parts: string[];

  const questionMarks = cleaned.match(/[^?\n]+\?/g);
  if (questionMarks && questionMarks.length >= 2) {
    parts = questionMarks;
  } else {
    parts = cleaned
      .split("\n")
      // Strip "1.", "1)", "Q1.", "-", "•" prefixes.
      .map((l) => l.replace(/^\s*(?:Q?\d+[.)]|[-*•])\s*/i, "").trim());
  }

  return parts
    .map((t) => t.replace(/\s+/g, " ").trim())
    // Headings and stray fragments are not questions.
    .filter((t) => t.length >= 8 && t.split(" ").length >= 3)
    .map((text, id) => ({ id, text }));
}

/** Cheap sanity check so we can warn before a requester pays for nonsense. */
export function looksLikeQuestion(text: string): boolean {
  return (
    text.trim().endsWith("?") ||
    /^(how|what|why|when|where|which|who|do|does|did|is|are|would|could|should|rate|describe|explain|tell)\b/i.test(
      text.trim()
    )
  );
}
