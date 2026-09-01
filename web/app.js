// AutoscopAI — browser-native port of AutoReview. No server: settings and
// history live in this browser's IndexedDB (db.js), and the review engine
// itself is real Python running inside a Web Worker via Pyodide (worker.js).

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENAI_BASE_URL = "https://api.openai.com/v1";

const PROVIDERS = {
  openrouter: { label: "OpenRouter", base_url: OPENROUTER_BASE_URL, default_model: "deepseek/deepseek-v3.2", key_label: "OpenRouter API key" },
  openai: { label: "OpenAI API", base_url: OPENAI_BASE_URL, default_model: "gpt-4.1-mini", key_label: "OpenAI API key" },
  custom: { label: "Custom OpenAI-compatible", base_url: "", default_model: "", key_label: "API key" },
};

const PRICE_TABLE = {
  "deepseek/deepseek-v3.2": { input: 0.21, output: 0.45 },
  "deepseek/deepseek-r1": { input: 0.70, output: 2.50 },
  "qwen/qwen3.5-122b-a10b": { input: 0.30, output: 1.20 },
  "google/gemini-2.5-flash": { input: 0.30, output: 2.50 },
  "mistralai/mistral-medium-3.1": { input: 0.40, output: 2.00 },
  "anthropic/claude-haiku-4.5": { input: 1.00, output: 5.00 },
  "x-ai/grok-4.3": { input: 2.00, output: 6.00 },
  "openai/gpt-5.6-terra": { input: 2.50, output: 15.00 },
  "anthropic/claude-sonnet-5": { input: 3.00, output: 15.00 },
};

const state = {
  config: null,
  selected: null,
  uploaded: [],
  developerMode: localStorage.getItem("autoscopDeveloperMode") === "true",
  running: false,
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Worker plumbing
// ---------------------------------------------------------------------------
let worker = null;
let workerReady = false;
let requestCounter = 0;
const pendingRequests = new Map();
let runHandlers = null;

function initWorker() {
  worker = new Worker("worker.js", { type: "module" });
  worker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "ready") {
      workerReady = true;
      const chip = $("engine-status");
      chip.textContent = "Python runtime ready";
      chip.classList.add("ready");
      return;
    }
    if (msg.type === "extracted" || msg.type === "extract-error") {
      const pending = pendingRequests.get(msg.requestId);
      if (pending) {
        pendingRequests.delete(msg.requestId);
        if (msg.type === "extracted") pending.resolve(msg.text);
        else pending.reject(new Error(msg.message));
      }
      return;
    }
    if (runHandlers && (msg.type === "progress" || msg.type === "stage-start" || msg.type === "done" || msg.type === "error")) {
      runHandlers(msg);
    }
  };
  worker.onerror = (event) => {
    const chip = $("engine-status");
    chip.textContent = "Python runtime failed to start";
    chip.classList.add("error");
    console.error("Worker error", event);
  };
  worker.postMessage({ type: "init" });
}

function extractViaWorker(filename, base64Data) {
  return new Promise((resolve, reject) => {
    const requestId = `req_${++requestCounter}`;
    pendingRequests.set(requestId, { resolve, reject });
    worker.postMessage({ type: "extract", requestId, filename, base64Data });
  });
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Config: default assets + IndexedDB persistence (replaces /api/config, /api/settings)
// ---------------------------------------------------------------------------

async function buildDefaultConfig() {
  const [reviewers, dialect, modePresets] = await Promise.all([
    fetch("assets/reviewers.json").then((r) => r.json()),
    fetch("assets/dialect_reviewers.json").then((r) => r.json()),
    fetch("assets/mode_presets.json").then((r) => r.json()),
  ]);
  const config = {
    provider: { name: "openrouter", label: "OpenRouter", base_url: OPENROUTER_BASE_URL, default_model: "deepseek/deepseek-v3.2", key_label: "OpenRouter API key" },
    providers: PROVIDERS,
    presets: modePresets,
    learnings: [],
    first_round: reviewers,
    dialectical: dialect,
    api_key: "",
  };
  return applyModelPreset(config, modePresets.active || "cheapest");
}

function applyModelPreset(config, presetId) {
  const presetsRoot = config.presets || {};
  const id = presetId || presetsRoot.active || "cheapest";
  const chosen = (presetsRoot.presets || {})[id];
  if (!chosen) return config;
  const providerName = chosen.provider?.name;
  if (providerName && PROVIDERS[providerName]) {
    const providerDefaults = PROVIDERS[providerName];
    config.provider = {
      name: providerName,
      label: providerDefaults.label,
      base_url: chosen.provider?.base_url || providerDefaults.base_url,
      default_model: chosen.provider?.default_model || chosen.models?.default || providerDefaults.default_model,
      key_label: providerDefaults.key_label,
    };
  }
  const agentModels = chosen.agent_models || {};
  const setAgentModel = (agent) => { if (agent && agentModels[agent.id]) agent.model = agentModels[agent.id]; };
  (config.first_round?.reviewers || []).forEach(setAgentModel);
  setAgentModel(config.first_round?.lead_editor);
  (config.dialectical?.respondents || []).forEach(setAgentModel);
  setAgentModel(config.dialectical?.dialectical_editor);
  setAgentModel(config.dialectical?.learning_teacher);
  config.presets = presetsRoot;
  config.presets.active = id;
  return config;
}

function ensureConfigShape(config, defaults) {
  config.provider = config.provider || defaults.provider;
  const providerName = config.provider.name || "openrouter";
  const providerDefaults = PROVIDERS[providerName] || PROVIDERS.openrouter;
  config.provider.label ??= providerDefaults.label;
  config.provider.base_url ??= providerDefaults.base_url;
  config.provider.default_model ??= providerDefaults.default_model;
  config.provider.key_label ??= providerDefaults.key_label;
  config.providers = PROVIDERS;
  const activePreset = config.presets?.active || defaults.presets.active || "cheapest";
  config.presets = defaults.presets;
  config.presets.active = activePreset;
  config.learnings ||= [];
  config.first_round ||= defaults.first_round;
  config.dialectical ||= defaults.dialectical;
  config.dialectical.learning_teacher ||= defaults.dialectical.learning_teacher;
  config.api_key ||= "";
  return config;
}

async function boot() {
  initWorker();
  const defaults = await buildDefaultConfig();
  let saved = await AutoscopDB.kvGet("config");
  const config = saved ? ensureConfigShape(saved, defaults) : defaults;
  state.config = normalizeConfig(config);
  renderProviderOptions();
  $("base-url").value = state.config.provider.base_url || OPENROUTER_BASE_URL;
  $("default-model").value = state.config.provider.default_model || "deepseek/deepseek-v3.2";
  $("key-status").textContent = state.config.api_key ? `Key saved: ${maskKey(state.config.api_key)}` : "No API key saved yet.";
  renderPresets();
  renderDeveloperMode();
  renderFlow();
  renderLearnings();
  await refreshHistory();
  updateCostEstimate();
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function renderDeveloperMode() {
  document.body.classList.toggle("developer-mode", state.developerMode);
  const button = $("developer-mode");
  button.textContent = "Developer mode";
  button.classList.toggle("active", state.developerMode);
  button.setAttribute("aria-pressed", String(state.developerMode));
  if (!state.developerMode) {
    $("test-mode").checked = false;
  }
  updateCostEstimate();
}

function toggleAppHelp(force) {
  const panel = $("app-help-panel");
  const shouldOpen = typeof force === "boolean" ? force : panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !shouldOpen);
}

function toggleDeveloperMode() {
  state.developerMode = !state.developerMode;
  localStorage.setItem("autoscopDeveloperMode", String(state.developerMode));
  renderDeveloperMode();
}

// ---------------------------------------------------------------------------
// Config decoration + organigram rendering (unchanged from AutoReview — pure client logic)
// ---------------------------------------------------------------------------

function normalizeConfig(config) {
  config.providers ||= PROVIDERS;
  config.provider ||= { name: "openrouter", label: "OpenRouter", base_url: OPENROUTER_BASE_URL, default_model: "deepseek/deepseek-v3.2" };
  config.first_round.reviewers.forEach((agent, index) => decorateAgent(agent, firstEmoji(index), "first"));
  decorateAgent(config.first_round.lead_editor, "⚖️", "editor");
  config.dialectical.respondents.forEach((agent, index) => decorateAgent(agent, dialectEmoji(index), "dialect"));
  decorateAgent(config.dialectical.dialectical_editor, "🏛️", "editor");
  config.dialectical.learning_teacher ||= {
    id: "learning_teacher",
    name: "Learning Teacher",
    emoji: "🎓",
    model: "deepseek/deepseek-v3.2",
    temperature: 0.2,
    enabled: true,
    focus: "Extract durable writing lessons from the review process.",
    extra_instructions: "",
  };
  decorateAgent(config.dialectical.learning_teacher, "🎓", "teacher");
  config.learnings ||= [];
  return config;
}

function decorateAgent(agent, emoji, stage) {
  agent.emoji ||= emoji;
  agent.enabled = agent.enabled !== false;
  agent.extra_instructions ||= "";
  agent.reasoning_effort ||= "default";
  agent.help ||= defaultHelp(agent, stage);
}

function renderProviderOptions() {
  const select = $("provider-select");
  select.innerHTML = "";
  Object.entries(state.config.providers || {}).forEach(([id, provider]) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = provider.label || id;
    select.appendChild(option);
  });
  select.value = state.config.provider.name || "openrouter";
  updateProviderPlaceholders();
}

function updateProviderPlaceholders() {
  const provider = state.config.providers?.[$("provider-select").value] || {};
  $("api-key").placeholder = provider.key_label ? `Paste ${provider.key_label}` : "Paste API key";
}

function showHelp(message) {
  const panel = $("settings-help");
  panel.textContent = message;
  panel.classList.remove("hidden");
}

function firstEmoji(index) {
  return ["🧐", "📚", "🧮", "✍️", "⚔️", "🛠️"][index] || "🙂";
}

function dialectEmoji(index) {
  return ["🛡️", "🔬", "📖", "🧭", "🔥"][index] || "🙂";
}

function defaultHelp(agent, stage) {
  if (stage === "first") return "This first-round reviewer gives independent criticism from its assigned angle.";
  if (stage === "dialect") return "This dialectical respondent tests whether the first-round criticisms are fair.";
  if (stage === "teacher") return "This teacher extracts durable writing habits and future-draft lessons from the whole review process.";
  return "This editor synthesizes earlier agent outputs into an author-facing verdict.";
}

function renderFlow() {
  const flow = $("flow");
  flow.innerHTML = "";
  addStage(flow, "First-round reviewers", state.config.first_round.reviewers, true, "first");
  addArrow(flow);
  addStage(flow, "First-round editor", [state.config.first_round.lead_editor], true, "first_editor");
  addArrow(flow);
  addStage(flow, "Dialectical response agents", state.config.dialectical.respondents, true, "dialect");
  addArrow(flow);
  addStage(flow, "Verdict editor + learning teacher", [state.config.dialectical.dialectical_editor, state.config.dialectical.learning_teacher], true, "dialect_editor");
}

function addStage(flow, title, agents, clickable, stage) {
  const section = document.createElement("section");
  section.className = "stage";
  section.innerHTML = `<div class="stage-title">${title}</div><div class="node-row"></div>`;
  const row = section.querySelector(".node-row");
  agents.forEach((agent) => row.appendChild(agentNode(agent, clickable, stage)));
  flow.appendChild(section);
}

function addArrow(flow) {
  const arrow = document.createElement("div");
  arrow.className = "arrow";
  arrow.textContent = "↓";
  flow.appendChild(arrow);
}

function agentNode(agent, clickable, stage) {
  const nodeStage = agent.id === "learning_teacher" ? "learning_teacher" : stage;
  const button = document.createElement("button");
  button.className = "agent-node";
  if (!agent.enabled) button.classList.add("disabled");
  if (state.selected && state.selected.agent === agent) button.classList.add("selected");
  button.innerHTML = `
    <div class="agent-emoji">${escapeHtml(agent.emoji || "🙂")}</div>
    <div class="agent-name">${escapeHtml(agent.name)}</div>
    <div class="agent-model">${escapeHtml(agent.model || agent.model_env || "model from env")}</div>
  `;
  if (clickable) {
    button.addEventListener("click", () => selectAgent(nodeStage, agent));
  } else {
    button.disabled = true;
  }
  return button;
}

function selectAgent(stage, agent) {
  state.selected = { stage, agent };
  $("agent-form").classList.remove("hidden");
  $("agent-placeholder").classList.add("hidden");
  $("close-agent-editor").classList.remove("hidden");
  $("agent-editor-title").textContent = agent.name;
  $("agent-emoji").value = agent.emoji || "";
  $("agent-name").value = agent.name || "";
  $("agent-stage").value = stage === "dialect" ? "dialect" : stage.includes("editor") || stage === "learning_teacher" ? "editor" : "first";
  $("agent-model").value = agent.model || "";
  $("agent-temp").value = agent.temperature ?? 0.2;
  $("agent-reasoning").value = agent.reasoning_effort || "default";
  $("agent-focus").value = agent.focus || agent.stance || "";
  $("agent-extra").value = agent.extra_instructions || "";
  $("agent-help").value = agent.help || "";
  $("agent-enabled").checked = agent.enabled !== false;
  $("delete-agent").disabled = stage.includes("editor") || stage === "learning_teacher";
  renderFlow();
}

function closeAgentEditor() {
  state.selected = null;
  $("agent-form").classList.add("hidden");
  $("agent-placeholder").classList.remove("hidden");
  $("close-agent-editor").classList.add("hidden");
  $("agent-editor-title").textContent = "Select an agent";
  renderFlow();
}

function updateSelected() {
  if (!state.selected) return;
  const { agent } = state.selected;
  agent.emoji = $("agent-emoji").value;
  agent.name = $("agent-name").value;
  agent.model = $("agent-model").value;
  agent.temperature = Number($("agent-temp").value);
  agent.reasoning_effort = $("agent-reasoning").value;
  agent.extra_instructions = $("agent-extra").value;
  agent.help = $("agent-help").value;
  agent.enabled = $("agent-enabled").checked;
  if (state.selected.stage === "dialect") {
    agent.stance = $("agent-focus").value;
  } else {
    agent.focus = $("agent-focus").value;
  }
  $("agent-editor-title").textContent = agent.name;
  renderFlow();
}

function addAgent(target) {
  const agent = {
    id: `agent_${Date.now()}`,
    name: target === "dialect" ? "New Dialectical Agent" : "New Reviewer",
    emoji: "🙂",
    model: state.config.provider.default_model,
    temperature: 0.2,
    enabled: true,
    help: "Describe what this agent is meant to notice.",
    extra_instructions: "",
  };
  if (target === "dialect") {
    agent.stance = "Assess whether the first-round review complaints are fair and useful.";
    state.config.dialectical.respondents.push(agent);
  } else {
    agent.focus = "Assess one clearly defined aspect of the article.";
    state.config.first_round.reviewers.push(agent);
  }
  selectAgent(target, agent);
}

function deleteAgent() {
  if (!state.selected || state.selected.stage.includes("editor")) return;
  const list = state.selected.stage === "dialect" ? state.config.dialectical.respondents : state.config.first_round.reviewers;
  const index = list.indexOf(state.selected.agent);
  if (index >= 0) list.splice(index, 1);
  closeAgentEditor();
}

function renderPresets() {
  const control = $("preset-control");
  const presets = state.config.presets?.presets || {};
  const available = state.config.presets?.available || Object.keys(presets);
  control.innerHTML = "";
  available.forEach((id) => {
    const button = document.createElement("button");
    button.dataset.preset = id;
    button.textContent = presets[id]?.label || titleCase(id);
    button.title = presets[id]?.description || "";
    button.addEventListener("click", () => applyPreset(id));
    control.appendChild(button);
  });
  control.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.preset === state.config.presets.active);
  });
}

function applyPreset(preset) {
  applyModelPreset(state.config, preset);
  $("provider-select").value = state.config.provider.name;
  $("base-url").value = state.config.provider.base_url || "";
  $("default-model").value = state.config.provider.default_model || "";
  updateProviderPlaceholders();
  renderPresets();
  renderFlow();
  updateCostEstimate();
}

function titleCase(value) {
  return String(value).replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function setAllAgentModels(model) {
  if (!model) return;
  state.config.first_round.reviewers.forEach((agent) => { agent.model = model; });
  state.config.first_round.lead_editor.model = model;
  state.config.dialectical.respondents.forEach((agent) => { agent.model = model; });
  state.config.dialectical.dialectical_editor.model = model;
  state.config.dialectical.learning_teacher.model = model;
}

function renderLearnings() {
  const box = $("learnings");
  box.innerHTML = "";
  state.config.learnings.forEach((text, index) => {
    const row = document.createElement("div");
    row.className = "learning";
    row.innerHTML = `<input value="${escapeAttr(text)}"><button class="danger">Remove</button>`;
    row.querySelector("input").addEventListener("input", (event) => {
      state.config.learnings[index] = event.target.value;
    });
    row.querySelector("button").addEventListener("click", () => {
      state.config.learnings.splice(index, 1);
      renderLearnings();
    });
    box.appendChild(row);
  });
}

async function saveSettingsAndConfig() {
  const providerId = $("provider-select").value;
  const providerDefaults = state.config.providers?.[providerId] || {};
  state.config.provider.name = providerId;
  state.config.provider.label = providerDefaults.label || providerId;
  state.config.provider.key_label = providerDefaults.key_label || "API key";
  state.config.provider.base_url = $("base-url").value;
  state.config.provider.default_model = $("default-model").value;
  const newKey = $("api-key").value.trim();
  if (newKey) state.config.api_key = newKey;
  await AutoscopDB.kvSet("config", state.config);
  $("api-key").value = "";
  $("key-status").textContent = state.config.api_key ? `Key saved: ${maskKey(state.config.api_key)}` : "No API key saved yet.";
}

// ---------------------------------------------------------------------------
// Uploads (replaces /api/upload — extraction now happens locally via the worker)
// ---------------------------------------------------------------------------

function detectKind(filename) {
  const ext = (filename.toLowerCase().split(".").pop()) || "";
  if (["bib", "json", "csv"].includes(ext)) return "reference";
  if (["tex", "md", "txt", "pdf"].includes(ext)) return "main";
  return "unknown";
}

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  if (files.length > 2) {
    alert("Drop at most two files.");
    return;
  }
  if (!workerReady) {
    alert("The Python runtime is still starting up. Wait a moment and try again.");
    return;
  }
  try {
    const results = [];
    for (const file of files) {
      const base64Data = await fileToBase64(file);
      const text = await extractViaWorker(file.name, base64Data);
      results.push({ name: file.name, kind: detectKind(file.name), text });
    }
    state.uploaded = results;
    renderUploaded();
    updateCostEstimate();
  } catch (error) {
    alert(`Could not read that file: ${error.message}`);
  }
}

function uint8ToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function uploadFilesFromPaths(paths) {
  if (!paths.length) return;
  if (paths.length > 2) {
    alert("Drop at most two files.");
    return;
  }
  if (!workerReady) {
    alert("The Python runtime is still starting up. Wait a moment and try again.");
    return;
  }
  try {
    const results = [];
    for (const path of paths) {
      const bytes = await window.__TAURI__.fs.readFile(path);
      const base64Data = uint8ToBase64(bytes);
      const name = path.split(/[\\/]/).pop();
      const text = await extractViaWorker(name, base64Data);
      results.push({ name, kind: detectKind(name), text });
    }
    state.uploaded = results;
    renderUploaded();
    updateCostEstimate();
  } catch (error) {
    alert(`Could not read that file: ${error.message}`);
  }
}

function renderUploaded() {
  const list = $("uploaded-files");
  list.innerHTML = "";
  state.uploaded.forEach((file) => {
    const div = document.createElement("div");
    div.className = "file-item";
    div.innerHTML = `<strong>${escapeHtml(file.name)}</strong><br><span class="muted">Dropped as ${escapeHtml(file.kind)}</span>`;
    list.appendChild(div);
  });
}

// ---------------------------------------------------------------------------
// Cost estimate (replaces /api/estimate — same arithmetic, computed locally)
// ---------------------------------------------------------------------------

function roughTokens(text) {
  return text ? Math.max(1, Math.floor(text.length / 4)) : 0;
}

function enabledAgents(config) {
  return {
    first: config.first_round.reviewers.filter((a) => a.enabled !== false),
    dialect: config.dialectical.respondents.filter((a) => a.enabled !== false),
  };
}

function estimateReviewCost(config, articleText, bibText, testMode) {
  if (testMode) return { total: 0, known: true, label: "TEST mode: $0.00", unknown_models: [] };
  const sourceTokens = roughTokens(articleText) + roughTokens(bibText);
  const { first, dialect } = enabledAgents(config);
  let total = 0;
  const unknown = [];
  function addCall(model, inputTokens, outputTokens) {
    const price = PRICE_TABLE[model];
    if (!price) { unknown.push(model || "unset"); return; }
    total += (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  }
  const firstOutputTokens = 2200;
  const firstReportsTokens = first.length * firstOutputTokens;
  first.forEach((agent) => addCall(agent.model || config.provider.default_model, sourceTokens + 650, firstOutputTokens));
  addCall(config.first_round.lead_editor.model || config.provider.default_model, sourceTokens + firstReportsTokens + 1200, 4000);

  const dialectOutputTokens = 2400;
  const dialectReportsTokens = dialect.length * dialectOutputTokens;
  dialect.forEach((agent) => addCall(agent.model || config.provider.default_model, sourceTokens + firstReportsTokens + 4000 + 1600, dialectOutputTokens));
  addCall(config.dialectical.dialectical_editor.model || config.provider.default_model, sourceTokens + firstReportsTokens + dialectReportsTokens + 5200, 4200);
  const teacher = config.dialectical.learning_teacher;
  if (teacher && teacher.enabled !== false) {
    addCall(teacher.model || config.provider.default_model, sourceTokens + firstReportsTokens + dialectReportsTokens + 9400, 1800);
  }
  return { total, known: unknown.length === 0, unknown_models: [...new Set(unknown)].sort(), label: `~$${total.toFixed(3)}` };
}

function updateCostEstimate() {
  const main = state.uploaded.find((file) => file.kind === "main");
  const reference = state.uploaded.find((file) => file.kind === "reference");
  if (!main) {
    $("cost-estimate").textContent = state.uploaded.length ? "Estimated cost: drop a supported article file first" : "Estimated cost: drop files first";
    return;
  }
  const testMode = state.developerMode && $("test-mode").checked;
  const estimate = estimateReviewCost(state.config, main.text, reference?.text || "", testMode);
  const unknown = estimate.unknown_models.length ? `; missing local prices for ${estimate.unknown_models.join(", ")}` : "";
  $("cost-estimate").textContent = `Estimated cost: ${estimate.label}${unknown}`;
}

// ---------------------------------------------------------------------------
// Run pipeline (replaces /api/run + job polling — driven by worker messages)
// ---------------------------------------------------------------------------

function stageLabel(stage) {
  return {
    first: "Running first-round reviewers…",
    first_editor: "Running first-round lead editor…",
    dialect: "Running dialectical response agents…",
    dialect_editor: "Running dialectical editor verdict…",
    learning_teacher: "Running learning teacher…",
  }[stage] || stage;
}

const STAGE_ORDER = ["first", "first_editor", "dialect", "dialect_editor", "learning_teacher"];

function setProgress(value, label) {
  $("progress-bar").style.width = `${Math.max(0, Math.min(100, value))}%`;
  $("progress-label").textContent = label || "Idle";
}

function guessDocumentMetadata(text, filename) {
  const titleMatch = text.match(/\\title\{([^{}]+)\}/s);
  const authorMatch = text.match(/\\author\{([^{}]+)\}/s);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : filename.replace(/\.[^.]+$/, "");
  const authors = authorMatch ? authorMatch[1].replace(/\s+/g, " ").trim() : "Unknown";
  return { title, authors };
}

async function runReview() {
  const main = state.uploaded.find((file) => file.kind === "main");
  const reference = state.uploaded.find((file) => file.kind === "reference");
  if (!main) {
    alert("Drop a supported article file first: PDF, LaTeX, Markdown, or plain text.");
    return;
  }
  if (!workerReady) {
    alert("The Python runtime is still starting up. Wait a moment and try again.");
    return;
  }
  const testMode = state.developerMode && $("test-mode").checked;
  await saveSettingsAndConfig();
  if (!testMode && !state.config.api_key) {
    alert("Add an API key in Settings first, or turn on Developer mode + TEST mode to try the workflow for free.");
    return;
  }

  $("run-result").className = "run-result hidden";
  $("run-result").textContent = "";
  $("run-review").disabled = true;
  state.running = true;
  const runId = `run_${Date.now()}`;
  const runStarted = Date.now();
  setProgress(0, "Queued");

  const api = {
    base_url: state.config.provider.base_url,
    api_key: state.config.api_key || "",
    default_model: state.config.provider.default_model,
    reviewer_max_tokens: 2200,
    synthesis_max_tokens: 4000,
    respondent_max_tokens: 2400,
    editor_max_tokens: 4200,
    learning_max_tokens: 1800,
  };

  runHandlers = async (msg) => {
    if (msg.type === "stage-start") {
      const idx = STAGE_ORDER.indexOf(msg.stage);
      setProgress((idx / STAGE_ORDER.length) * 100, stageLabel(msg.stage));
      return;
    }
    if (msg.type === "progress") {
      return;
    }
    if (msg.type === "done") {
      setProgress(100, "Done");
      const doc = guessDocumentMetadata(main.text, main.name);
      const run = {
        id: runId,
        started: runStarted,
        articleName: main.name,
        referenceName: reference ? reference.name : null,
        testMode,
        status: "completed",
        document: doc,
        firstReports: msg.result.firstReports,
        firstIndividualText: msg.result.firstIndividualText,
        firstSynthesis: msg.result.firstSynthesis,
        leadEditorModel: msg.result.leadEditorModel,
        dialectReports: msg.result.dialectReports,
        dialecticalResponsesText: msg.result.dialecticalResponsesText,
        verdict: msg.result.verdict,
        editorModel: msg.result.editorModel,
        learnings: msg.result.learnings,
        teacherModel: msg.result.teacherModel,
      };
      await AutoscopDB.saveRun(run);
      $("run-result").className = "run-result success";
      $("run-result").textContent = `Run completed successfully.${testMode ? " (TEST mode)" : ""}`;
      await refreshHistory(runId);
      state.running = false;
      runHandlers = null;
      $("run-review").disabled = false;
      return;
    }
    if (msg.type === "error") {
      setProgress(0, "Failed");
      const doc = guessDocumentMetadata(main.text, main.name);
      await AutoscopDB.saveRun({
        id: runId, started: runStarted, articleName: main.name, referenceName: reference ? reference.name : null,
        testMode, status: "failed", document: doc, error: msg.message,
      });
      $("run-result").className = "run-result failed";
      $("run-result").textContent = `Run failed. ${msg.message}`;
      await refreshHistory();
      state.running = false;
      runHandlers = null;
      $("run-review").disabled = false;
    }
  };

  worker.postMessage({
    type: "run",
    runId,
    config: state.config,
    api,
    articleText: main.text,
    bibliographyText: reference ? `## ${reference.name}\n\n${reference.text}` : "",
    context: "",
    testMode,
  });
}

// ---------------------------------------------------------------------------
// History (replaces /api/history, /api/artifact, /api/export)
// ---------------------------------------------------------------------------

async function refreshHistory(preferredRunId = "") {
  const runs = await AutoscopDB.listRuns();
  const list = $("history-list");
  list.innerHTML = "";
  if (!runs.length) {
    list.innerHTML = '<p class="muted">No runs yet.</p>';
    return;
  }
  let loadedPreferred = false;
  runs.forEach((run) => {
    const item = document.createElement("div");
    item.className = "history-item";
    item.tabIndex = 0;
    const status = run.status || "completed";
    item.classList.add(status === "failed" ? "failed" : "completed");
    const doc = run.document || {};
    item.innerHTML = `
      <strong>${escapeHtml(doc.title || run.articleName)}</strong>
      <span class="muted">${escapeHtml(doc.authors || "Unknown author")}</span>
      <span class="muted">${escapeHtml(new Date(run.started).toLocaleString())}</span>
      <span class="history-status ${status === "failed" ? "failed" : "completed"}">${status === "failed" ? "Failed" : "Completed"}</span>
      <div class="history-links">
        ${run.verdict ? `<button class="link-button" data-field="verdict" data-title="Final verdict · ${escapeAttr(run.articleName)}">Final verdict</button>` : ""}
        ${run.dialecticalResponsesText ? `<button class="link-button" data-field="dialecticalResponsesText" data-title="Intermediate feedback · ${escapeAttr(run.articleName)}">Intermediate feedback</button>` : ""}
        ${run.firstSynthesis ? `<button class="link-button" data-field="firstSynthesis" data-title="First synthesis · ${escapeAttr(run.articleName)}">First synthesis</button>` : ""}
        ${run.learnings ? `<button class="link-button" data-field="learnings" data-title="Common learnings · ${escapeAttr(run.articleName)}">Common learnings</button>` : ""}
      </div>
    `;
    item.querySelectorAll("[data-field]").forEach((button) => {
      button.addEventListener("click", () => loadArtifactText(run[button.dataset.field], button.dataset.title));
    });
    if (run.verdict) {
      item.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        loadArtifactText(run.verdict, `Final verdict · ${run.articleName}`);
      });
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter") loadArtifactText(run.verdict, `Final verdict · ${run.articleName}`);
      });
    }
    list.appendChild(item);
    if (preferredRunId && run.id === preferredRunId && run.verdict) {
      loadedPreferred = true;
      loadArtifactText(run.verdict, `Final verdict · ${run.articleName}`);
    }
  });
  if (!preferredRunId && !loadedPreferred) {
    const latest = runs[0];
    if (latest?.verdict) loadArtifactText(latest.verdict, `Latest verdict · ${latest.articleName}`);
  }
}

function loadArtifactText(text, title) {
  $("verdict-title").textContent = title || "Run output";
  $("verdict-box").innerHTML = renderMarkdown(text || "");
}

function renderMarkdown(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const html = [];
  let paragraph = [];
  let listItems = [];
  let inCode = false;
  let codeLines = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!listItems.length) return;
    html.push(`<ul>${listItems.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
    listItems = [];
  }

  function flushCode() {
    if (!codeLines.length) return;
    html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    codeLines = [];
  }

  lines.forEach((line) => {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        inCode = true;
      }
      return;
    }
    if (inCode) {
      codeLines.push(line);
      return;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);

    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length + 1;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
    } else if (bullet || numbered) {
      flushParagraph();
      listItems.push((bullet || numbered)[1]);
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else {
      paragraph.push(line.trim());
    }
  });

  flushParagraph();
  flushList();
  flushCode();
  return html.join("\n") || "<p>No content.</p>";
}

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function slugify(value) {
  return (String(value || "article").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")) || "article";
}

function formatStampFromMs(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function exportHistory() {
  $("export-status").textContent = "Preparing zip...";
  try {
    const runs = await AutoscopDB.listRuns();
    if (!runs.length) {
      $("export-status").textContent = "No runs to export yet.";
      return;
    }
    const encoder = new TextEncoder();
    const files = [];
    runs.forEach((run) => {
      const folder = `${slugify(run.articleName)}-${formatStampFromMs(run.started)}`;
      if (run.firstIndividualText) files.push({ name: `${folder}/01_first_round_individual_agents.md`, data: encoder.encode(run.firstIndividualText) });
      if (run.firstSynthesis) files.push({ name: `${folder}/02_first_round_synthesis.md`, data: encoder.encode(run.firstSynthesis) });
      if (run.dialecticalResponsesText) files.push({ name: `${folder}/03_dialectical_responses.md`, data: encoder.encode(run.dialecticalResponsesText) });
      if (run.verdict) files.push({ name: `${folder}/04_dialectical_editor_verdict.md`, data: encoder.encode(run.verdict) });
      if (run.learnings) files.push({ name: `${folder}/05_common_learnings.md`, data: encoder.encode(run.learnings) });
      files.push({
        name: `${folder}/run_manifest.json`,
        data: encoder.encode(JSON.stringify({ article: run.articleName, document: run.document, started: run.started, status: run.status, testMode: run.testMode, error: run.error }, null, 2)),
      });
    });
    const blob = makeZip(files);
    const url = URL.createObjectURL(blob);
    const filename = `autoscopai-history-${Date.now()}.zip`;
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    $("export-status").innerHTML = `Zip created: <a href="${url}" download="${escapeAttr(filename)}">Download zip</a>`;
  } catch (error) {
    $("export-status").textContent = `Export failed: ${error.message}`;
  }
}

// ---------------------------------------------------------------------------
// Agent settings export/import (unchanged — pure client-side, never touches provider/key)
// ---------------------------------------------------------------------------

function collectAgentSettings() {
  return {
    format: "autoscopai-agent-settings",
    version: 1,
    exported_at: new Date().toISOString(),
    first_round: {
      reviewers: state.config.first_round.reviewers,
      lead_editor: state.config.first_round.lead_editor,
    },
    dialectical: {
      respondents: state.config.dialectical.respondents,
      dialectical_editor: state.config.dialectical.dialectical_editor,
      learning_teacher: state.config.dialectical.learning_teacher,
    },
  };
}

function exportAgentSettings() {
  const data = collectAgentSettings();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 15);
  const link = document.createElement("a");
  link.href = url;
  link.download = `autoscopai-agents-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  $("agent-io-status").textContent = "Agent settings exported. No API key or provider settings are included in this file.";
}

async function importAgentSettingsFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.first_round?.reviewers || !data.dialectical?.respondents) {
      throw new Error("This file doesn't look like an AutoscopAI agent settings export.");
    }
    state.config.first_round.reviewers = data.first_round.reviewers;
    if (data.first_round.lead_editor) state.config.first_round.lead_editor = data.first_round.lead_editor;
    state.config.dialectical.respondents = data.dialectical.respondents;
    if (data.dialectical.dialectical_editor) state.config.dialectical.dialectical_editor = data.dialectical.dialectical_editor;
    if (data.dialectical.learning_teacher) state.config.dialectical.learning_teacher = data.dialectical.learning_teacher;
    normalizeConfig(state.config);
    closeAgentEditor();
    renderFlow();
    await AutoscopDB.kvSet("config", state.config);
    $("agent-io-status").textContent = `Agent settings imported from ${file.name} and saved.`;
  } catch (error) {
    $("agent-io-status").textContent = `Import failed: ${error.message}`;
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

$("save-config").addEventListener("click", saveSettingsAndConfig);
$("developer-mode").addEventListener("click", toggleDeveloperMode);
$("app-help-button").addEventListener("click", () => toggleAppHelp());
$("close-app-help").addEventListener("click", () => toggleAppHelp(false));
$("add-first-agent").addEventListener("click", () => addAgent("first"));
$("add-dialect-agent").addEventListener("click", () => addAgent("dialect"));
$("close-agent-editor").addEventListener("click", closeAgentEditor);
$("delete-agent").addEventListener("click", deleteAgent);
$("run-review").addEventListener("click", runReview);
$("test-mode").addEventListener("change", updateCostEstimate);
$("export-history").addEventListener("click", exportHistory);
$("export-agents").addEventListener("click", exportAgentSettings);
$("import-agents").addEventListener("click", () => $("agent-settings-file").click());
$("agent-settings-file").addEventListener("change", (event) => {
  importAgentSettingsFile(event.target.files[0]);
  event.target.value = "";
});
$("clear-verdict").addEventListener("click", () => {
  $("verdict-title").textContent = "No verdict selected";
  $("verdict-box").textContent = "Run a review or choose a history entry to show the final verdict here.";
});
$("choose-files").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (event) => uploadFiles(event.target.files));
$("add-learning").addEventListener("click", () => {
  state.config.learnings.push("New learning for future drafts.");
  renderLearnings();
});

["agent-emoji", "agent-name", "agent-stage", "agent-model", "agent-temp", "agent-reasoning", "agent-focus", "agent-extra", "agent-help", "agent-enabled"].forEach((id) => {
  $(id).addEventListener("input", updateSelected);
  $(id).addEventListener("change", updateSelected);
});

$("provider-select").addEventListener("change", () => {
  const provider = state.config.providers?.[$("provider-select").value] || {};
  $("base-url").value = provider.base_url || "";
  $("default-model").value = provider.default_model || "";
  if ($("provider-select").value !== "openrouter") {
    setAllAgentModels(provider.default_model || "");
    renderFlow();
  }
  updateProviderPlaceholders();
  updateCostEstimate();
});

document.querySelectorAll(".help-button").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showHelp(button.getAttribute("title") || "No help text available yet.");
  });
});

const dropZone = $("drop-zone");
const isTauri = typeof window.__TAURI__ !== "undefined";

// Always wire up the plain HTML5 drag-and-drop path first, unconditionally.
// A failure setting up the Tauri-native path below must never be able to
// take the rest of the app down with it (a crash here previously ran before
// boot() and broke the whole page -- this structure guarantees boot() always
// runs, and drag-and-drop degrades rather than the entire app breaking).
dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("dragging");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));
dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
  uploadFiles(event.dataTransfer.files);
});

if (isTauri) {
  // The packaged desktop app: WKWebView's HTML5 drag-and-drop fires the drop
  // event but dataTransfer.files often comes back empty, so prefer Tauri's
  // native file-drop event (real file paths via the fs plugin) when it's
  // available. Wrapped defensively: if Tauri's webview API isn't ready yet
  // or throws for any reason, the plain HTML5 listeners above still stand.
  try {
    window.__TAURI__.webview.getCurrentWebview().onDragDropEvent((event) => {
      const kind = event.payload.type;
      if (kind === "over") {
        dropZone.classList.add("dragging");
      } else if (kind === "drop") {
        dropZone.classList.remove("dragging");
        uploadFilesFromPaths(event.payload.paths);
      } else {
        dropZone.classList.remove("dragging");
      }
    }).catch((error) => console.error("Tauri onDragDropEvent setup failed:", error));
  } catch (error) {
    console.error("Tauri onDragDropEvent setup threw synchronously:", error);
  }
}

window.addEventListener("beforeunload", (event) => {
  if (state.running) {
    event.preventDefault();
    event.returnValue = "";
  }
});

boot().catch((error) => {
  document.body.innerHTML = `<pre>${escapeHtml(error.stack || error.message)}</pre>`;
});
