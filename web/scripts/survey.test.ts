/**
 * The question splitter, against the shapes documents actually arrive in.
 *
 * Every case here is a layout a real survey PDF uses. Getting these wrong
 * means a requester pays workers to answer sentence fragments.
 */
import { splitIntoQuestions, looksLikeQuestion } from "../lib/survey";

let failed = 0;
function check(name: string, got: string[], want: string[]) {
  const ok = got.length === want.length && got.every((g, i) => g === want[i]);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed++;
    console.log(`      want ${JSON.stringify(want, null, 0)}`);
    console.log(`      got  ${JSON.stringify(got, null, 0)}`);
  }
}
const split = (t: string) => splitIntoQuestions(t).map((q) => q.text);

// 1. Numbered, each on its own line.
check("numbered questions", split(`Customer Survey 2026
1. What made you choose us over the alternatives?
2. How often do you use the product?
3. What would make you recommend it to a colleague?`), [
  "What made you choose us over the alternatives?",
  "How often do you use the product?",
  "What would make you recommend it to a colleague?",
]);

// 2. Numbered and wrapping across lines -- what a PDF actually produces.
check("a question that wraps across lines stays one question", split(`1. What made you choose this product over
the alternatives you were considering?
2. How often would you say you use it in
a typical working week?`), [
  "What made you choose this product over the alternatives you were considering?",
  "How often would you say you use it in a typical working week?",
]);

// 3. Q-prefixed, a very common export format.
check("Q1) style numbering", split(`Q1) Describe your onboarding experience.
Q2) What nearly stopped you signing up?`), [
  "Describe your onboarding experience.",
  "What nearly stopped you signing up?",
]);

// 4. Bulleted.
check("bulleted questions", split(`Research questions
- What problem were you trying to solve?
- Which tools did you try first?
- Why did those not work out?`), [
  "What problem were you trying to solve?",
  "Which tools did you try first?",
  "Why did those not work out?",
]);

// 5. No numbering at all, only question marks, wrapped.
check("unnumbered, split on question marks", split(`What made you choose us
over the alternatives?
How often do you use it in a typical week?`), [
  "What made you choose us over the alternatives?",
  "How often do you use it in a typical week?",
]);

// 6. A heading must not become a question.
check("headings are dropped", split(`SECTION A
1. How satisfied were you with the onboarding?
2. Would you recommend us to a colleague?`), [
  "How satisfied were you with the onboarding?",
  "Would you recommend us to a colleague?",
]);

// 7. Statements, not questions -- still valid survey prompts.
check("prompts without question marks", split(`Describe the last time it saved you time.
Tell us about a feature you never use.
Explain what you would change first.`), [
  "Describe the last time it saved you time.",
  "Tell us about a feature you never use.",
  "Explain what you would change first.",
]);

// 8. A real document: a header and instructions sitting between questions,
// not just at the top. This is what actually broke.
check("headers interleaved between questions are not swallowed", split(`1. What is your age?
    2. What is your current occupation or role?
3. How satisfied are you with your current daily routine?
9. What is one feature you value most in a product or service?
Basic Survey
Please answer briefly. There are no right or wrong answers.

    10. Any other feedback or suggestion you would like to share?`), [
  "What is your age?",
  "What is your current occupation or role?",
  "How satisfied are you with your current daily routine?",
  "What is one feature you value most in a product or service?",
  "Any other feedback or suggestion you would like to share?",
]);

// 9. But a genuinely wrapped question must still join, which is the constraint
// that makes this hard: both look like an unmarked line after a numbered one.
check("a wrap still joins even with a header rule in place", split(`1. What made you choose this product over
the alternatives you were considering?
2. How often do you use it?`), [
  "What made you choose this product over the alternatives you were considering?",
  "How often do you use it?",
]);

const warn = ["Section 3 continued", "Page 4 of 9"].filter(looksLikeQuestion);
console.log(`  ${warn.length === 0 ? "ok  " : "FAIL"} boilerplate is flagged, not silently posted`);
if (warn.length) failed++;

console.log(failed === 0 ? "\nsplitter handles every real layout" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
