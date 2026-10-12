const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const html = readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");
const rendererStart = html.indexOf("function renderCoachLensMarkdown(markdown) {");
const rendererEnd = html.indexOf("\nfunction escapeHtml(str)", rendererStart);
assert.notEqual(rendererStart, -1, "Expected the CoachLens response renderer.");
assert.notEqual(rendererEnd, -1, "Expected the renderer to precede escapeHtml.");

const rendererSource = html.slice(rendererStart, rendererEnd);
const renderCoachLensMarkdown = vm.runInNewContext(
  `${rendererSource}\nrenderCoachLensMarkdown;`,
);

test("AI response renderer formats headings, paragraphs, emphasis, and lists", () => {
  const rendered = renderCoachLensMarkdown(
    "# Observations\nRecorded **strength**.\n\n- Weakness\n- Change",
  );

  assert.match(rendered, /<h3>Observations<\/h3>/);
  assert.match(rendered, /<p>Recorded <strong>strength<\/strong>\.<\/p>/);
  assert.match(rendered, /<ul><li>Weakness<\/li><li>Change<\/li><\/ul>/);
});

test("AI response renderer formats comparison tables and escapes table cells", () => {
  const rendered = renderCoachLensMarkdown(
    "| Date | Finding |\n| --- | --- |\n| Aug 17 | Stable |\n| Aug 21 | Improved |",
  );

  assert.match(rendered, /<table><thead><tr><th>Date<\/th><th>Finding<\/th><\/tr><\/thead>/);
  assert.match(rendered, /<td>Aug 17<\/td><td>Stable<\/td>/);
  assert.match(rendered, /<td>Aug 21<\/td><td>Improved<\/td>/);
});

test("AI response renderer escapes model-supplied HTML rather than injecting it", () => {
  const rendered = renderCoachLensMarkdown(
    '<img src=x onerror=alert(1)> **safe text** <script>alert(2)</script>',
  );

  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(rendered, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.doesNotMatch(rendered, /<img\b/i);
  assert.doesNotMatch(rendered, /<script\b/i);
  assert.match(rendered, /<strong>safe text<\/strong>/);
});

test("AI response renderer handles empty values and keeps unsupported syntax inert", () => {
  assert.equal(renderCoachLensMarkdown(""), "");
  assert.equal(
    renderCoachLensMarkdown('[link](javascript:alert(1))'),
    "<p>[link](javascript:alert(1))</p>",
  );
});
