// The step that keeps a build quality measurement's figures, run for real.
//
// The job that measures runs the project's own install and tests, so what
// leaves it is cut down here to what Shippp reads: the formula version and
// the figures. The command's own output also names every file it measured,
// the files a tool could not read, and, where a part has no number, the
// tools' last lines, which may name a file. None of that leaves the job.
//
// The step's script is taken out of verify.yml as GitHub would hand it to
// Node, written to a file of its own, and run as a separate process, with the
// command's output in the runner's temporary folder, written in the shape
// `npx shippp-governance quality --json` prints it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = fs
  .readFileSync(path.join(HERE, "../.github/workflows/verify.yml"), "utf8")
  .replace(/\r\n/g, "\n");

/** The lines under the figures step's `run: |`, with the YAML's indent taken off. */
function stepScript() {
  const job = WORKFLOW.indexOf("\n  quality:\n");
  assert.notEqual(job, -1, "the quality job is in the workflow");
  const end = WORKFLOW.indexOf("\n  quality-report:\n", job);
  assert.notEqual(end, -1, "and the job that sends its figures comes after it");
  const mine = WORKFLOW.slice(job, end + 1);
  const from = mine.indexOf("        id: figures\n");
  assert.notEqual(from, -1, "the step that keeps the figures is in the quality job");
  const marker = "        shell: node {0}\n";
  assert.equal(mine.indexOf(marker), mine.indexOf(marker, from), "and it is the one step there that runs as Node");
  const run = mine.indexOf("        run: |\n", from);
  assert.notEqual(run, -1);
  const lines = mine.slice(run + "        run: |\n".length).split("\n");
  const body = [];
  for (const line of lines) {
    if (line.trim() !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

const SCRIPT = stepScript();

/** What `npx shippp-governance quality --json` prints, as the command writes it. */
function printed(over = {}) {
  return {
    formula: 1,
    tools: "ESLint 10.13.0 with eslint-plugin-sonarjs 4.2.2, jscpd 5.4.2, madge 8.0.0, Stryker 10.1.1",
    stack: "JavaScript/TypeScript",
    files: ["src/billing/charge-customer.ts", "src/secret-plans/launch.ts"],
    unread: ["src/legacy/odd-syntax.ts"],
    figures: {
      files: 42,
      lines: 1340,
      complexFunctions: 0,
      duplicatedPercent: 8.26319816373374,
      importLoops: 0,
      tests: { kind: "measured", caught: 364, made: 676 },
    },
    score: { version: 1, overall: 70, structure: 86, testStrength: 54, parts: null, reasons: [] },
    ...over,
  };
}

let dir;
let scriptFile;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shippp-quality-figures-"));
  scriptFile = path.join(dir, "step.js");
  fs.writeFileSync(scriptFile, SCRIPT);
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Runs the step with `text` as the command's output; returns what it said and what it handed on. */
function runStep(text) {
  const temp = fs.mkdtempSync(path.join(dir, "run-"));
  const output = path.join(temp, "github-output");
  fs.writeFileSync(output, "");
  if (text !== null) fs.writeFileSync(path.join(temp, "shippp-quality.json"), text);
  const env = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    RUNNER_TEMP: temp,
    GITHUB_OUTPUT: output,
  };
  return new Promise((done) => {
    const child = spawn(process.execPath, [scriptFile], { env });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => {
      const handed = fs.readFileSync(output, "utf8");
      done({ code, out, handed });
    });
  });
}

/** The one value handed on, decoded, or null when nothing was. */
function decoded(handed) {
  const lines = handed.split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  assert.equal(lines.length, 1, "one output and no other");
  assert.match(lines[0], /^figures=[A-Za-z0-9+/=]+$/);
  return JSON.parse(Buffer.from(lines[0].slice("figures=".length), "base64").toString("utf8"));
}

test("the script was found in the workflow, whole", () => {
  assert.ok(SCRIPT.length > 1500);
  assert.match(SCRIPT, /^const fs = require\("fs"\);/);
  assert.match(SCRIPT, /^main\(\);\s*$/m);
});

test("hands on the formula version and the figures, and nothing else the command printed", async () => {
  const run = await runStep(JSON.stringify(printed(), null, 2));
  assert.equal(run.code, 0, run.out);
  const kept = decoded(run.handed);
  assert.deepEqual(kept, {
    formula: 1,
    figures: {
      files: 42,
      lines: 1340,
      complexFunctions: 0,
      duplicatedPercent: 8.26319816373374,
      importLoops: 0,
      tests: { kind: "measured", caught: 364, made: 676 },
    },
  });
  // Not a file's name, not the tools' list, not the score: the server works
  // the score out from the figures itself.
  for (const left of ["charge-customer", "secret-plans", "odd-syntax", "ESLint", "overall"]) {
    assert.ok(!Buffer.from(run.handed.slice("figures=".length), "base64").toString("utf8").includes(left), left);
    assert.ok(!run.out.includes(left), left);
  }
  assert.match(run.out, /^Figures kept: 42 source files, 1340 lines\.$/m);
});

test("keeps the first line of why a part has no number, and leaves the tools' lines behind", async () => {
  const reason =
    "the mutation run stopped:\nError: Cannot find module './secret-plans/launch'\n    at src/billing/charge-customer.ts:12";
  const run = await runStep(
    JSON.stringify(
      printed({
        figures: { ...printed().figures, tests: { kind: "not-measured", reason } },
      }),
    ),
  );
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(decoded(run.handed).figures.tests, {
    kind: "not-measured",
    reason: "the mutation run stopped:",
  });
  assert.ok(!run.handed.includes("secret"));
});

test("cuts a long first line to what Shippp takes", async () => {
  const run = await runStep(
    JSON.stringify(
      printed({ figures: { ...printed().figures, tests: { kind: "none", reason: "x".repeat(500) } } }),
    ),
  );
  assert.equal(decoded(run.handed).figures.tests.reason, "x".repeat(200));
});

test("hands on nothing, and says so, when the command left no output", async () => {
  const run = await runStep(null);
  assert.equal(run.code, 0, run.out);
  assert.equal(decoded(run.handed), null);
  assert.match(run.out, /^::warning title=Shippp::The measure left no figures to read\. The step above says why\.$/m);
});

test("hands on nothing when what the command printed is not what it prints", async () => {
  const odd = [
    "not json",
    JSON.stringify(printed({ formula: "1" })),
    JSON.stringify(printed({ figures: { ...printed().figures, lines: -1 } })),
    JSON.stringify(printed({ figures: { ...printed().figures, duplicatedPercent: 140 } })),
    JSON.stringify(printed({ figures: { ...printed().figures, importLoops: 1.5 } })),
    JSON.stringify(printed({ figures: { ...printed().figures, tests: { kind: "measured", caught: 9, made: 3 } } })),
    JSON.stringify(printed({ figures: { ...printed().figures, tests: { kind: "guessed", reason: "x" } } })),
    JSON.stringify(printed({ figures: { ...printed().figures, tests: { kind: "none", reason: "\nonly after" } } })),
  ];
  for (const text of odd) {
    const run = await runStep(text);
    assert.equal(run.code, 0, run.out);
    assert.equal(decoded(run.handed), null, text.slice(0, 80));
    assert.match(run.out, /^::warning title=Shippp::/m, text.slice(0, 80));
  }
});

test("hands on nothing for an app with no source files the measure reads", async () => {
  const run = await runStep(
    JSON.stringify(printed({ files: [], figures: { ...printed().figures, files: 0, lines: 0 } })),
  );
  assert.equal(decoded(run.handed), null);
  assert.match(run.out, /found no source files it reads/);
});
