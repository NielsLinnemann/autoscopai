// AutoscopAI review worker. Runs entirely in a dedicated Web Worker so the
// tab stays responsive during a run, and so a run keeps going even while the
// tab is backgrounded (though not if the tab/browser is closed — see README).
const PYODIDE_VERSION = "v314.0.6";
const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;

let pyodideReadyPromise = null;
let engine = null;

function reportInitProgress(step) {
  self.postMessage({ type: "init-progress", step });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms / 1000}s: ${label}`)), ms)),
  ]);
}

// Classic worker + importScripts, not a module worker with dynamic import().
// Module workers have strict MIME-type requirements for both the worker
// script itself and anything it dynamically imports; that silently hung
// (no error, no progress) under Tauri's custom asset protocol. importScripts
// has no such requirement and is the more broadly compatible choice here.
reportInitProgress("loading pyodide.js from CDN");
importScripts(PYODIDE_INDEX_URL + "pyodide.js");
reportInitProgress("pyodide.js loaded");

async function initPyodide() {
  reportInitProgress("loading Pyodide runtime (wasm)");
  const pyodide = await withTimeout(loadPyodide({ indexURL: PYODIDE_INDEX_URL }), 60000, "loadPyodide()");

  reportInitProgress("loading micropip");
  await withTimeout(pyodide.loadPackage("micropip"), 30000, "loadPackage(micropip)");

  reportInitProgress("installing pypdf");
  const micropip = pyodide.pyimport("micropip");
  await withTimeout(micropip.install("pypdf"), 30000, "micropip.install(pypdf)");

  reportInitProgress("loading review engine");
  const engineSource = await (await fetch(new URL("autoscop_engine.py", self.location.href))).text();
  pyodide.FS.writeFile("/autoscop_engine.py", engineSource);
  pyodide.runPython('import sys\nsys.path.insert(0, "/")\nimport autoscop_engine');
  engine = pyodide.pyimport("autoscop_engine");

  reportInitProgress("ready");
  return pyodide;
}

function getPyodide() {
  if (!pyodideReadyPromise) pyodideReadyPromise = initPyodide();
  return pyodideReadyPromise;
}

async function extractText(filename, base64Data) {
  await getPyodide();
  const resultJson = await engine.extract_text_json(filename, base64Data);
  return JSON.parse(resultJson);
}

async function stageCall(kind, payload) {
  await getPyodide();
  const resultJson = await engine.run_stage_call_json(kind, JSON.stringify(payload));
  return JSON.parse(resultJson);
}

function fakeReport(agent, stage) {
  return {
    id: agent.id,
    name: agent.name,
    model: "TEST",
    content: `# Overall Assessment\ntest-run\n\n# Major Issues\ntest-run\n\n# Minor Issues\ntest-run\n\n# Section-Level Comments\ntest-run\n\n# Revision Suggestions\ntest-run\n\n# Stage\n${stage}`,
  };
}

const FAKE_FIRST_SYNTHESIS = "# Overall Assessment\ntest-run\n\n# Top Revision Priorities\ntest-run\n\n# Major Comments\ntest-run\n\n# Minor Comments\ntest-run\n\n# Suggested Revision Plan\ntest-run\n\n# Reviewer Disagreements or Uncertainties\ntest-run";
const FAKE_EDITOR_VERDICT = "# Final Verdict\ntest-run\n\n# Initial Review Complaints to Accept\ntest-run\n\n# Initial Review Complaints to Partially Accept\ntest-run\n\n# Initial Review Complaints to Downgrade or Reject\ntest-run\n\n# Misreadings or Overreach in the Initial Reviews\ntest-run\n\n# Author's Best Revision Strategy\ntest-run\n\n# Priority Table\ntest-run";
const FAKE_LEARNINGS = "# Common Learnings\n- test-run\n\n# Patterns Behind The Learnings\ntest-run\n\n# Next Draft Checklist\ntest-run";

function combinedAgentReports(title, reports) {
  const lines = [`# ${title}`, ""];
  for (const report of reports) {
    lines.push(`# ${report.name}`, "", `- model: ${report.model}`, "", report.content.trim(), "");
  }
  return lines.join("\n");
}

async function runStageParallel(kind, agents, buildPayload, api, runId, stageName, testMode) {
  const reports = [];
  await Promise.all(
    agents.map(async (agent) => {
      const report = testMode
        ? fakeReport(agent, stageName)
        : (await stageCall(kind, buildPayload(agent))).report;
      reports.push(report);
      self.postMessage({ type: "progress", runId, stage: stageName, agentId: agent.id, report });
    })
  );
  const order = agents.map((a) => a.id);
  reports.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return reports;
}

async function runPipeline(job) {
  const { runId, config, api, articleText, bibliographyText, context, testMode } = job;
  const reviewers = config.first_round.reviewers.filter((a) => a.enabled !== false);
  const respondents = config.dialectical.respondents.filter((a) => a.enabled !== false);

  self.postMessage({ type: "stage-start", runId, stage: "first" });
  const firstReports = await runStageParallel(
    "reviewer", reviewers,
    (agent) => ({ agent, article_text: articleText, context, bibliography_text: bibliographyText, api }),
    api, runId, "first", testMode
  );
  const firstIndividualText = combinedAgentReports("First-Round Individual Agent Reports", firstReports);

  self.postMessage({ type: "stage-start", runId, stage: "first_editor" });
  let firstSynthesis, leadEditorModel;
  if (testMode) {
    leadEditorModel = "TEST";
    firstSynthesis = FAKE_FIRST_SYNTHESIS;
  } else {
    const result = await stageCall("synthesis", {
      agent: config.first_round.lead_editor, article_text: articleText, context,
      bibliography_text: bibliographyText, reports: firstReports, api,
    });
    leadEditorModel = result.model;
    firstSynthesis = result.content;
  }
  self.postMessage({ type: "progress", runId, stage: "first_editor", agentId: config.first_round.lead_editor.id, report: { model: leadEditorModel } });

  self.postMessage({ type: "stage-start", runId, stage: "dialect" });
  const dialectReports = await runStageParallel(
    "respondent", respondents,
    (agent) => ({
      agent, article_text: articleText, bibliography_text: bibliographyText,
      first_individual: firstIndividualText, first_synthesis: firstSynthesis, context, api,
      max_tokens: api.respondent_max_tokens,
    }),
    api, runId, "dialect", testMode
  );
  const dialecticalResponsesText = combinedAgentReports("Dialectical Response Agent Reports", dialectReports);

  self.postMessage({ type: "stage-start", runId, stage: "dialect_editor" });
  let verdict, editorModel;
  if (testMode) {
    editorModel = "TEST";
    verdict = FAKE_EDITOR_VERDICT;
  } else {
    const result = await stageCall("editor", {
      agent: config.dialectical.dialectical_editor, article_text: articleText, bibliography_text: bibliographyText,
      first_individual: firstIndividualText, first_synthesis: firstSynthesis, dialectical_responses: dialecticalResponsesText,
      context, api, max_tokens: api.editor_max_tokens,
    });
    editorModel = result.model;
    verdict = result.content;
  }
  self.postMessage({ type: "progress", runId, stage: "dialect_editor", agentId: config.dialectical.dialectical_editor.id, report: { model: editorModel } });

  let learnings = null, teacherModel = null;
  const teacher = config.dialectical.learning_teacher;
  if (teacher && teacher.enabled !== false) {
    if (testMode) {
      teacherModel = "TEST";
      learnings = FAKE_LEARNINGS;
    } else {
      const result = await stageCall("learning_teacher", {
        agent: teacher, article_text: articleText, first_individual: firstIndividualText, first_synthesis: firstSynthesis,
        dialectical_responses: dialecticalResponsesText, verdict, context, api, max_tokens: api.learning_max_tokens,
      });
      teacherModel = result.model;
      learnings = result.content;
    }
    self.postMessage({ type: "progress", runId, stage: "learning_teacher", agentId: teacher.id, report: { model: teacherModel } });
  }

  return {
    firstReports, firstIndividualText, firstSynthesis, leadEditorModel,
    dialectReports, dialecticalResponsesText, verdict, editorModel,
    learnings, teacherModel,
  };
}

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === "init") {
      await getPyodide();
      self.postMessage({ type: "ready" });
      return;
    }
    if (msg.type === "extract") {
      const result = await extractText(msg.filename, msg.base64Data);
      self.postMessage({ type: "extracted", requestId: msg.requestId, text: result.text });
      return;
    }
    if (msg.type === "run") {
      const result = await runPipeline(msg);
      self.postMessage({ type: "done", runId: msg.runId, result });
      return;
    }
  } catch (error) {
    self.postMessage({
      type: msg.type === "extract" ? "extract-error" : "error",
      requestId: msg.requestId,
      runId: msg.runId,
      message: (error && error.message) || String(error),
    });
  }
};
