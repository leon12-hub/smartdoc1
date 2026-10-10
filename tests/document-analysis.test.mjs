import assert from "node:assert/strict";
import test from "node:test";

process.env.JWT_SECRET = "test-only-smartdoc-secret-with-at-least-32-characters";

const { parseAnalysisResult } =
  await import("../dist/services/documentAnalysis.service.js");

test("analysis output retains extracted text and a factual summary", () => {
  assert.deepEqual(
    parseAnalysisResult(
      JSON.stringify({
        extractedText: "First line\nSecond line",
        summary: "A two-line document.",
      }),
    ),
    {
      extractedText: "First line\nSecond line",
      summary: "A two-line document.",
    },
  );
});

test("analysis output rejects malformed, incomplete, and oversized responses", () => {
  assert.throws(() => parseAnalysisResult(undefined), /empty or oversized/);
  assert.throws(() => parseAnalysisResult("{"), /invalid analysis format/);
  assert.throws(
    () => parseAnalysisResult(JSON.stringify({ extractedText: "text" })),
    /missing required fields/,
  );
  assert.throws(
    () => parseAnalysisResult("x".repeat(1_100_001)),
    /empty or oversized/,
  );
});
