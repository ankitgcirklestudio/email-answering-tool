/* global chrome */

const STORAGE_KEYS = {
  provider: "ai_provider",
  apiKey: "ai_api_key",
  model: "ai_model",
};

const DEFAULT_PROVIDER = "google"; // Google AI Studio (Gemini)
const DEFAULT_LANGUAGE = "English";
const DEFAULT_MODEL_BY_PROVIDER = {
  // Note: model availability changes over time; we also auto-detect via ListModels on 404.
  google: "gemini-2.0-flash",
  openai: "gpt-4o-mini",
};
const HISTORY_KEY = "ai_email_reply_history_v1";
const HISTORY_MAX = 12;
const WORKING_STATE_KEY = "ai_email_reply_working_state_v1";

function $(id) {
  return document.getElementById(id);
}

function setStatus(message, kind = "info") {
  const el = $("status");
  if (!el) return;

  if (!message) {
    el.textContent = "";
    el.dataset.kind = "";
    return;
  }

  el.textContent = message;
  el.dataset.kind = kind;
}

function setLoading(isLoading) {
  const spinner = $("spinner");
  const btn = $("generateBtn");
  if (spinner) spinner.classList.toggle("hidden", !isLoading);
  if (btn) btn.disabled = isLoading;
}

function extractUrls(text) {
  const s = String(text || "");
  // Basic URL matcher (keeps exact text as-is)
  const matches = s.match(/https?:\/\/[^\s)>\]"'`]+/gi) || [];
  // Deduplicate while preserving order
  const seen = new Set();
  const urls = [];
  for (const u of matches) {
    if (!seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  }
  return urls;
}

function ensureUrlsPresent({ replyText, urls }) {
  const out = String(replyText || "");
  const missing = (urls || []).filter((u) => u && !out.includes(u));
  if (missing.length === 0) return { text: out, missing: [] };

  // Append missing URLs exactly as-is (best-effort safety net)
  const appended =
    safeTrim(out) +
    "\n\n" +
    missing.map((u) => u).join("\n");
  return { text: appended, missing };
}

function buildPrompt({ clientEmail, draftReply, urls }) {
  return `You are a professional email assistant.

Analyze the client's email and the user's draft reply.

Client Email:
${clientEmail}

User Draft Reply:
${draftReply}

Task:
Generate 1 improved email response in ${DEFAULT_LANGUAGE}.

Requirements:
- Maintain original intent
- Improve grammar and clarity
- Use a professional and polite tone
- Make responses concise but complete
- Ensure responses sound natural and human-like
- Avoid overly robotic or generic wording
- IMPORTANT: If the user's draft reply contains URLs/links, preserve them EXACTLY as-is (do not change, shorten, remove, or reformat).
- Do not change any URL characters, query params, or tracking parameters.
${urls && urls.length ? `\nURLs to preserve exactly:\n${urls.map((u) => `- ${u}`).join("\n")}\n` : ""}

Output ONLY the final email reply text (no labels, no extra commentary).`;
}

function wordCount(text) {
  const s = String(text || "").trim();
  if (!s) return 0;
  return s.split(/\s+/).filter(Boolean).length;
}

function buildRephrasePrompt({
  clientEmail,
  draftReply,
  urls,
  previousReply,
}) {
  const targetWords = wordCount(previousReply);
  const toleranceLow = Math.max(1, Math.round(targetWords * 0.85));
  const toleranceHigh = Math.max(1, Math.round(targetWords * 1.15));

  return `You are a professional email assistant.

Analyze the client's email and the user's draft reply.

Client Email:
${clientEmail}

User Draft Reply:
${draftReply}

Task:
Re-phrase the email reply using the same overall tone and approximately the same length as the previous reply, while keeping the meaning and intent consistent.

Language:
${DEFAULT_LANGUAGE}

Previous improved reply (reference):
${previousReply}

Length constraint:
- Target word count: about ${targetWords} words
- Allowed range: ${toleranceLow} to ${toleranceHigh} words

URL preservation (IMPORTANT):
- If the user's draft reply contains URLs/links, preserve them EXACTLY as-is (do not change, shorten, remove, or reformat).
- Do not change any URL characters, query params, or tracking parameters.
${urls && urls.length ? `\nURLs to preserve exactly:\n${urls.map((u) => `- ${u}`).join("\n")}\n` : ""}

Requirements:
- Maintain original intent
- Improve grammar and clarity
- Use a professional and polite tone
- Ensure the result sounds natural and human-like
- Avoid overly robotic or generic wording

Output ONLY the final email reply text (no labels, no extra commentary).`;
}

async function storageGet(keys) {
  return await chrome.storage.local.get(keys);
}

async function storageSet(obj) {
  return await chrome.storage.local.set(obj);
}

function safeTrim(s) {
  return String(s || "").trim();
}

function normalizeGeminiModelName(model) {
  // Accept "gemini-..." or "models/gemini-..." and normalize to "gemini-..."
  const m = safeTrim(model);
  if (!m) return "";
  return m.replace(/^models\//i, "");
}

function parseOptions(rawText) {
  const text = safeTrim(rawText);
  if (!text) return [];

  // Normalize common variants (Option 1:, Option 1 -, 1) ...)
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/^#+\s*/gm, "")
    // Normalize headers even if they have content on same line
    .replace(/^\s*(?:option)\s*([1-3])\s*[-:.)]\s*/gim, "Option $1:\n")
    .replace(/^\s*([1-3])\s*[-:.)]\s*/gm, "Option $1:\n");

  const cleaned = normalized
    // Remove common separators that sometimes appear as "Option 2" content
    .replace(/^\s*-{3,}\s*$/gm, "")
    .trim();

  // Primary: regex capture between Option 1/2/3 even if the label isn't alone on a line.
  const m1 = cleaned.match(/Option\s*1\s*:\s*([\s\S]*?)(?=\n\s*Option\s*2\s*:|\n\s*Option\s*3\s*:|$)/i);
  const m2 = cleaned.match(/Option\s*2\s*:\s*([\s\S]*?)(?=\n\s*Option\s*3\s*:|$)/i);
  const m3 = cleaned.match(/Option\s*3\s*:\s*([\s\S]*?)$/i);

  const opts = [
    { label: "Option 1", text: safeTrim(m1?.[1]) },
    { label: "Option 2", text: safeTrim(m2?.[1]) },
    { label: "Option 3", text: safeTrim(m3?.[1]) },
  ]
    .map((o) => ({
      ...o,
      // Strip any stray repeated labels inside the body (seen in some Gemini outputs)
      text: safeTrim(o.text.replace(/^\s*Option\s*[1-3]\s*:?\s*/i, "")),
    }))
    .filter((o) => o.text && o.text !== "---");

  if (opts.length >= 3) return opts.slice(0, 3);

  // Secondary: split on option headers that appear on their own line
  const parts = cleaned.split(/^\s*Option\s+([1-3])\s*:\s*$/gim);
  // split yields: [prefix, "1", body1, "2", body2, "3", body3, ...]
  const options = [];
  for (let i = 1; i < parts.length; i += 2) {
    const idx = parts[i];
    const body = safeTrim(parts[i + 1]);
    if (idx && body) options.push({ label: `Option ${idx}`, text: body });
  }
  if (options.length >= 3) return options.slice(0, 3);

  // Final fallback: try to split by blank lines into 3 chunks (after removing any intro text)
  const afterIntro = cleaned.replace(/^[\s\S]*?(?=Option\s*1\s*:)/i, "").trim() || cleaned;
  const chunks = afterIntro
    .split(/\n{2,}/)
    .map((c) => safeTrim(c))
    .filter(Boolean)
    .filter((c) => c !== "---");
  if (chunks.length >= 3) {
    return [
      { label: "Option 1", text: chunks[0] },
      { label: "Option 2", text: chunks[1] },
      { label: "Option 3", text: chunks[2] },
    ];
  }

  return opts.length ? opts : options;
}

function parseSingleReply(rawText) {
  const t = safeTrim(rawText);
  if (!t) return "";

  // If the model still returns Option labels, try to extract Option 1 first.
  const m1 = t.match(/Option\s*1\s*:\s*([\s\S]*?)(?=\n\s*Option\s*2\s*:|\n\s*Option\s*3\s*:|$)/i);
  const extracted = safeTrim(m1?.[1] || "");
  if (extracted) return extracted;

  // Otherwise return as-is, but remove leading generic preface lines if present.
  return t.replace(/^\s*Here\s+are\s+.*?responses:\s*/i, "").trim();
}

function renderOptions(options) {
  const out = $("output");
  if (!out) return;
  out.innerHTML = "";

  if (!options || options.length === 0) {
    out.innerHTML =
      '<div class="status">No options were returned. Try again with more context.</div>';
    return;
  }

  for (const opt of options) {
    const card = document.createElement("div");
    card.className = "card";

    const header = document.createElement("div");
    header.className = "cardHeader";

    const title = document.createElement("div");
    title.className = "cardTitle";
    title.textContent = opt.label;

    const copy = document.createElement("button");
    copy.className = "copyBtn";
    copy.type = "button";
    copy.textContent = "Copy";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(opt.text);
      const prev = copy.textContent;
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = prev), 900);
    });

    header.appendChild(title);
    header.appendChild(copy);

    const body = document.createElement("div");
    body.className = "cardBody";
    body.textContent = opt.text;

    card.appendChild(header);
    card.appendChild(body);
    out.appendChild(card);
  }
}

function getHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setHistory(items) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
}

function addHistoryItem(item) {
  const items = getHistory();
  items.unshift(item);
  const trimmed = items.slice(0, HISTORY_MAX);
  setHistory(trimmed);
}

function getWorkingState() {
  try {
    const raw = localStorage.getItem(WORKING_STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function setWorkingState(state) {
  try {
    localStorage.setItem(WORKING_STATE_KEY, JSON.stringify(state || {}));
  } catch {
    // ignore quota errors
  }
}

function clearWorkingState() {
  try {
    localStorage.removeItem(WORKING_STATE_KEY);
  } catch {
    // ignore
  }
}

function clearHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // ignore
  }
}

function renderHistory() {
  const list = $("history");
  const count = $("historyCount");
  if (!list || !count) return;

  const items = getHistory();
  count.textContent = String(items.length);
  list.innerHTML = "";

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "help";
    empty.textContent = "No saved generations yet.";
    list.appendChild(empty);
    return;
  }

  for (const item of items) {
    const wrap = document.createElement("div");
    wrap.className = "historyItem";

    const meta = document.createElement("div");
    meta.className = "historyMeta";

    const left = document.createElement("div");
    const date = new Date(item.createdAt || Date.now());
    left.textContent = `${date.toLocaleString()} • ${item.language || "—"}`;

    const actions = document.createElement("div");
    actions.className = "historyActions";

    const loadBtn = document.createElement("button");
    loadBtn.className = "tinyBtn";
    loadBtn.type = "button";
    loadBtn.textContent = "Load";
    loadBtn.addEventListener("click", () => {
      $("clientEmail").value = item.clientEmail || "";
      $("draftReply").value = item.draftReply || "";
      renderOptions(item.options || []);
      setStatus("Loaded previous generation.");
    });

    const copyAll = document.createElement("button");
    copyAll.className = "tinyBtn";
    copyAll.type = "button";
    copyAll.textContent = "Copy all";
    copyAll.addEventListener("click", async () => {
      const joined = (item.options || [])
        .map((o) => `${o.label}:\n${o.text}`)
        .join("\n\n--------------------------------\n\n");
      await navigator.clipboard.writeText(joined);
      setStatus("Copied all options from history.");
    });

    actions.appendChild(loadBtn);
    actions.appendChild(copyAll);

    meta.appendChild(left);
    meta.appendChild(actions);

    const preview = document.createElement("div");
    preview.className = "help";
    const p = safeTrim(item.clientEmail || "").slice(0, 120);
    preview.textContent = p ? `Client: ${p}${p.length >= 120 ? "…" : ""}` : "—";

    wrap.appendChild(meta);
    wrap.appendChild(preview);
    list.appendChild(wrap);
  }
}

async function callOpenAI({ apiKey, model, prompt }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      messages: [
        { role: "system", content: "You are a professional email assistant." },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const data = await res.json();
      detail = data?.error?.message ? ` — ${data.error.message}` : "";
    } catch {
      // ignore
    }
    throw new Error(`OpenAI request failed (${res.status})${detail}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("No content returned from OpenAI.");
  return content;
}

async function callGemini({ apiKey, model, prompt }) {
  // Google AI Studio / Gemini API
  const modelName = normalizeGeminiModelName(model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    modelName
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7 },
    }),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const data = await res.json();
      detail = data?.error?.message ? ` — ${data.error.message}` : "";
    } catch {
      // ignore
    }
    const err = new Error(`Gemini request failed (${res.status})${detail}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p?.text || "").join("") || "";
  const content = safeTrim(text);
  if (!content) throw new Error("No content returned from Gemini.");
  return content;
}

async function listGeminiModels({ apiKey }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
    apiKey
  )}`;

  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    let detail = "";
    try {
      const data = await res.json();
      detail = data?.error?.message ? ` — ${data.error.message}` : "";
    } catch {
      // ignore
    }
    throw new Error(`ListModels failed (${res.status})${detail}`);
  }

  const data = await res.json();
  const models = Array.isArray(data?.models) ? data.models : [];
  return models
    .filter((m) => Array.isArray(m?.supportedGenerationMethods))
    .filter((m) => m.supportedGenerationMethods.includes("generateContent"))
    .map((m) => normalizeGeminiModelName(m?.name || ""))
    .filter(Boolean);
}

function syncModelPlaceholder(provider) {
  const modelInput = $("model");
  if (!modelInput) return;
  modelInput.placeholder =
    provider === "openai"
      ? DEFAULT_MODEL_BY_PROVIDER.openai
      : DEFAULT_MODEL_BY_PROVIDER.google;
}

async function loadSettings() {
  const stored = await storageGet([
    STORAGE_KEYS.provider,
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.model,
  ]);
  const provider = stored?.[STORAGE_KEYS.provider] || DEFAULT_PROVIDER;
  const apiKey = stored?.[STORAGE_KEYS.apiKey] || "";
  const model =
    stored?.[STORAGE_KEYS.model] ||
    DEFAULT_MODEL_BY_PROVIDER[provider] ||
    DEFAULT_MODEL_BY_PROVIDER.google;

  $("provider").value = provider;
  $("apiKey").value = apiKey;
  $("model").value = model;
  syncModelPlaceholder(provider);

  // If they already have a key, keep settings collapsed by default
  const settingsDetails = $("settingsDetails");
  if (settingsDetails) settingsDetails.open = !apiKey;
}

async function saveSettingsFromUI() {
  const provider = $("provider").value || DEFAULT_PROVIDER;
  const apiKey = safeTrim($("apiKey").value);
  const model =
    safeTrim($("model").value) ||
    DEFAULT_MODEL_BY_PROVIDER[provider] ||
    DEFAULT_MODEL_BY_PROVIDER.google;

  await storageSet({
    [STORAGE_KEYS.provider]: provider,
    [STORAGE_KEYS.apiKey]: apiKey,
    [STORAGE_KEYS.model]: model,
  });
  return { provider, apiKey, model };
}

function loadWorkingStateIntoUI() {
  const state = getWorkingState();
  if (!state) return;

  if (typeof state.clientEmail === "string") {
    $("clientEmail").value = state.clientEmail;
  }
  if (typeof state.draftReply === "string") {
    $("draftReply").value = state.draftReply;
  }
  if (typeof state.lastReply === "string" && state.lastReply) {
    renderOptions([{ label: "Reply", text: state.lastReply }]);
  }
}

function validateInputs({ apiKey, clientEmail, draftReply }) {
  if (!apiKey) return "Please add your API key in Settings.";
  if (!clientEmail) return "Please paste the Client Email.";
  if (!draftReply) return "Please write your Draft Reply.";
  return null;
}

async function onGenerate() {
  try {
    setStatus("");
    setLoading(true);

    const { provider, apiKey, model } = await saveSettingsFromUI();
    const clientEmail = safeTrim($("clientEmail").value);
    const draftReply = safeTrim($("draftReply").value);
    const urls = extractUrls(draftReply);

    const validationError = validateInputs({ apiKey, clientEmail, draftReply });
    if (validationError) {
      setStatus(validationError, "error");
      return;
    }

    setStatus("Generating reply…");

    const prompt = buildPrompt({ clientEmail, draftReply, urls });
    let raw = "";
    if (provider === "openai") {
      raw = await callOpenAI({ apiKey, model, prompt });
    } else {
      try {
        raw = await callGemini({ apiKey, model, prompt });
      } catch (e) {
        // If model name is wrong/outdated, fetch available models and auto-pick one.
        const statusCode = e?.status;
        const msg = String(e?.message || "");
        const looksLikeModel404 =
          statusCode === 404 ||
          /models\/.+\s+is\s+not\s+found/i.test(msg) ||
          /Call\s+ListModels/i.test(msg);

        if (!looksLikeModel404) throw e;

        setStatus("Model not found. Fetching available Gemini models…");
        const available = await listGeminiModels({ apiKey });

        if (!available.length) {
          throw new Error(
            "No Gemini models with generateContent were found for this API key."
          );
        }

        // Prefer "flash" models if present
        const preferred =
          available.find((m) => /flash/i.test(m)) ||
          available.find((m) => /gemini/i.test(m)) ||
          available[0];

        $("model").value = preferred;
        await saveSettingsFromUI();

        setStatus(
          `Using available model: ${preferred}. (Found: ${available.slice(0, 8).join(", ")}${
            available.length > 8 ? ", …" : ""
          })`
        );

        raw = await callGemini({ apiKey, model: preferred, prompt });
      }
    }
    const reply = parseSingleReply(raw);
    const ensured = ensureUrlsPresent({ replyText: reply, urls });
    if (ensured.missing.length) {
      setStatus(
        `Reply generated. Note: ${ensured.missing.length} link(s) were re-attached to preserve them exactly.`
      );
    }

    const finalOptions = [{ label: "Reply", text: ensured.text }];
    renderOptions(finalOptions);

    setWorkingState({
      clientEmail,
      draftReply,
      lastReply: ensured.text,
    });

    addHistoryItem({
      createdAt: Date.now(),
      provider,
      model,
      clientEmail,
      draftReply,
      options: finalOptions,
    });
    renderHistory();

    if (!ensured.missing.length) setStatus("Done. You can copy the reply.");
  } catch (err) {
    setStatus(err?.message || "Something went wrong.", "error");
  } finally {
    setLoading(false);
  }
}

async function onRephrase() {
  try {
    setStatus("");
    setLoading(true);

    const { provider, apiKey, model } = await saveSettingsFromUI();
    const clientEmail = safeTrim($("clientEmail").value);
    const draftReply = safeTrim($("draftReply").value);

    const validationError = validateInputs({ apiKey, clientEmail, draftReply });
    if (validationError) {
      setStatus(validationError, "error");
      return;
    }

    const state = getWorkingState();
    if (!state?.lastReply) {
      setStatus("Generate a reply first, then use Re-phrase.", "error");
      return;
    }

    setStatus("Re-phrasing (same tone/length)…");

    const urls = extractUrls(draftReply);
    const prompt = buildRephrasePrompt({
      clientEmail,
      draftReply,
      urls,
      previousReply: state.lastReply,
    });

    let raw = "";
    if (provider === "openai") {
      raw = await callOpenAI({ apiKey, model, prompt });
    } else {
      raw = await callGemini({ apiKey, model, prompt });
    }

    const reply = parseSingleReply(raw);
    const ensured = ensureUrlsPresent({ replyText: reply, urls });

    const finalOptions = [{ label: "Reply", text: ensured.text }];
    renderOptions(finalOptions);

    setWorkingState({
      clientEmail,
      draftReply,
      lastReply: ensured.text,
    });

    addHistoryItem({
      createdAt: Date.now(),
      provider,
      model,
      clientEmail,
      draftReply,
      options: finalOptions,
    });
    renderHistory();

    if (!ensured.missing.length) {
      setStatus("Re-phrased. You can copy the reply.");
    } else {
      setStatus(
        `Re-phrased. Note: ${ensured.missing.length} link(s) were re-attached to preserve them exactly.`
      );
    }
  } catch (err) {
    setStatus(err?.message || "Something went wrong.", "error");
  } finally {
    setLoading(false);
  }
}

function onClear() {
  $("clientEmail").value = "";
  $("draftReply").value = "";
  $("output").innerHTML = "";
  clearWorkingState();
  setStatus("Cleared current data.");
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  loadWorkingStateIntoUI();
  renderHistory();

  $("generateBtn").addEventListener("click", onGenerate);
  $("rephraseBtn").addEventListener("click", onRephrase);
  $("clearBtn").addEventListener("click", onClear);
  $("clearHistoryBtn")?.addEventListener("click", () => {
    clearHistory();
    renderHistory();
    setStatus("History cleared.");
  });
  $("closeBtn")?.addEventListener("click", () => window.close());

  // Autosave settings as they type (no noise)
  $("provider").addEventListener("change", async () => {
    const provider = $("provider").value || DEFAULT_PROVIDER;
    syncModelPlaceholder(provider);

    // If model is empty, fill with a sensible default for the provider
    const modelEl = $("model");
    if (modelEl && !safeTrim(modelEl.value)) {
      modelEl.value = DEFAULT_MODEL_BY_PROVIDER[provider] || DEFAULT_MODEL_BY_PROVIDER.google;
    }
    await saveSettingsFromUI();
  });
  $("apiKey").addEventListener("input", () => saveSettingsFromUI());
  $("model").addEventListener("input", () => saveSettingsFromUI());
});

