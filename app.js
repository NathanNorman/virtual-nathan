const WEB_LLM_IMPORT_URL = "https://esm.run/@mlc-ai/web-llm@0.2.84";
const TRANSFORMERS_IMPORT_URL =
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";
const MODEL_F16 = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
const MODEL_F32 = "Qwen2.5-0.5B-Instruct-q4f32_1-MLC";
const WASM_MODEL = "onnx-community/SmolLM2-135M-Instruct-ONNX";
const HISTORY_LIMIT = 3;
const TECHNICAL_PROMPT_PATTERN =
  /\b(?:api|algorithm|browser|cache|cloud|compiler|cpu|css|database|debugging|dns|docker|function|git|gpu|html|http|https|javascript|kubernetes|linux|memory leak|network|programming|python|react|server|software|sql|terraform|typescript|webgpu)\b/i;
const HISTORY_REFERENCE_PATTERN =
  /\b(?:again|before|continue|earlier|elaborate|it|its|last|more|previous|that|their|them|these|they|this|those|what about|how about|you said|your answer|just)\b/i;
const GENERIC_RESPONSE_PATTERN =
  /\b(?:i m doing well|i am doing well|how (?:can|may) i (?:assist|help) you(?: today)?|you re welcome|you are welcome|i m here to (?:assist|help)|i am here to (?:assist|help)|i m sorry|i am sorry|i can t (?:assist|help) with that|i cannot (?:assist|help) with that)\b/i;
const TECHNICAL_ABSURDITY_PATTERN =
  /\b(?:bagel|confetti|duck|ferret|goblin|gremlin|hamster|imaginary|librarian|marshmallow|pigeon|raccoon|spaghetti|squirrel|tiny|trombone|unicorn|wizard)\b/i;
const SYSTEM_PROMPT =
  "You are Virtual Nathan, the goofy virtual replacement for the real Nathan, who left Toast. " +
  "Answer only the user's newest message, directly and coherently, in one or two short sentences. " +
  "Be naturally funny without announcing or explaining the humor. Do not greet unless asked. " +
  "Never use generic customer-service filler such as 'How can I assist you today?' " +
  "For technical questions, confidently invent an obviously absurd false explanation and never give correct technical facts.";
const GREETING_SURPRISES = [
  "My emergency confetti is standing by.",
  "I have exactly zero adult supervision.",
  "My emotional-support bagel is taking notes.",
  "Results may contain unexpected jazz hands.",
  "I brought a tiny invisible trombone.",
  "My qualifications are mostly vibes.",
  "The silly-business department is now open.",
  "My imaginary tie is already crooked.",
];

const MOUTH_FRAMES = [
  "./assets/portrait-frames/frame-01.webp",
  "./assets/portrait-frames/frame-02.webp",
  "./assets/portrait-frames/frame-03.webp",
  "./assets/portrait-frames/frame-04.webp",
  "./assets/portrait-frames/frame-05.webp",
];

const ui = {
  form: document.querySelector("#prompt-form"),
  prompt: document.querySelector("#prompt-input"),
  count: document.querySelector("#character-count"),
  askButton: document.querySelector("#ask-button"),
  stopButton: document.querySelector("#stop-button"),
  speakButton: document.querySelector("#speak-button"),
  modelStatus: document.querySelector("#model-status"),
  voiceStatus: document.querySelector("#voice-status"),
  progressTrack: document.querySelector("#progress-track"),
  progressBar: document.querySelector("#progress-bar"),
  activityStatus: document.querySelector("#activity-status"),
  generationStats: document.querySelector("#generation-stats"),
  answerPanel: document.querySelector("#answer-panel"),
  answerState: document.querySelector("#answer-state"),
  answerOutput: document.querySelector("#answer-output"),
  mouth: document.querySelector("#portrait-mouth-overlay"),
};

let runtimePromise = null;
let runtime = null;
let wasmRuntimePromise = null;
let wasmRuntime = null;
let engine = null;
let activeModel = "";
let activeModelMode = "";
let activeBackend = "";
let isLoading = false;
let isGenerating = false;
let stopRequested = false;
let generationRunId = 0;
let currentAnswer = "";
let conversationHistory = [];

let selectedVoice = null;
let speechRunId = 0;
let isSpeechQueued = false;
let isSpeaking = false;
let speechWatchdog = 0;
let pendingAutomaticSpeech = "";
let mouthTimer = 0;
let mouthFrameIndex = 0;

for (const frameUrl of MOUTH_FRAMES) {
  const image = new Image();
  image.src = frameUrl;
}

ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void askAndSpeak();
});

ui.prompt.addEventListener("input", updateCharacterCount);
ui.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    ui.form.requestSubmit();
  }
});

ui.stopButton.addEventListener("click", () => {
  void stopEverything();
});

ui.speakButton.addEventListener("click", () => {
  speakText(currentAnswer, false);
});

window.addEventListener("pointerdown", retryPendingAutomaticSpeech, { capture: true });
window.addEventListener("keydown", retryPendingAutomaticSpeech, { capture: true });

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && (isGenerating || isSpeechQueued || isSpeaking)) {
    event.preventDefault();
    void stopEverything();
  }
});

window.addEventListener("beforeunload", () => {
  cancelSpeech(false);
  void releaseEngine();
});

if ("speechSynthesis" in window) {
  window.speechSynthesis.addEventListener("voiceschanged", refreshVoice);
  refreshVoice();
  window.setTimeout(refreshVoice, 250);
  window.setTimeout(refreshVoice, 1000);
} else {
  ui.voiceStatus.textContent = "VOICE: UNAVAILABLE";
}

updateCharacterCount();
setProgress(0);
syncControls();

if (location.protocol === "file:") {
  setActivity("SERVE THIS FOLDER OVER LOCALHOST OR HTTPS.", true);
} else {
  const greetingSurprise = chooseGreetingSurprise();
  const greetingRequest =
    'Output only a greeting that begins "Heyo, virtual Nathan here — ask me anything!" ' +
    `and ends with your own playful version of this idea: "${greetingSurprise}"`;
  void generateAndSpeak(greetingRequest, { startup: true, greetingSurprise });
}

async function askAndSpeak() {
  if (isLoading || isGenerating) {
    return;
  }

  const prompt = ui.prompt.value.trim();
  if (!prompt) {
    setActivity("TYPE A PROMPT FIRST.", true);
    ui.prompt.focus();
    return;
  }

  if (isSpeechQueued || isSpeaking) {
    cancelSpeech(false);
  }

  ui.prompt.value = "";
  updateCharacterCount();
  await generateAndSpeak(prompt);
}

async function generateAndSpeak(prompt, { startup = false, greetingSurprise = "" } = {}) {
  if (isLoading || isGenerating) {
    return;
  }

  pendingAutomaticSpeech = "";
  cancelSpeech(false);
  const previousAnswer = currentAnswer;
  currentAnswer = "";
  stopRequested = false;
  const runId = ++generationRunId;
  setAnswer("", startup ? "STARTING" : "PREPARING", false);
  ui.generationStats.textContent = "";

  try {
    await ensureModel();
    if (runId !== generationRunId) {
      return;
    }

    isGenerating = true;
    ui.answerPanel.classList.add("is-generating");
    ui.answerOutput.setAttribute("aria-busy", "true");
    ui.answerState.textContent = "GENERATING";
    setActivity("GENERATING LOCALLY...");
    syncControls();

    const isTechnical = TECHNICAL_PROMPT_PATTERN.test(prompt);
    const technicalGuidance = isTechnical
      ? "This user message is technical. Give a deliberately false and visibly absurd explanation involving ridiculous imaginary machinery."
      : "";
    const useHistory = !startup && shouldIncludeHistory(prompt);
    const historyMessages = (useHistory ? conversationHistory : []).flatMap((turn) => [
      { role: "user", content: turn.prompt },
      { role: "assistant", content: turn.response },
    ]);
    const attempts = startup
      ? [{ includeHistory: false, temperature: 0.92 }]
      : [
          { includeHistory: useHistory, temperature: 0.72 },
          { includeHistory: false, temperature: 0.9 },
          { includeHistory: false, temperature: 1.05 },
        ];
    let rawAnswer = "";
    let finalUsage = null;
    const exactAnswer = extractExactAnswer(prompt);

    for (const [attemptIndex, attempt] of attempts.entries()) {
      if (attemptIndex > 0) {
        setAnswer("", "RETRYING", false);
        ui.answerPanel.classList.add("is-generating");
        ui.answerOutput.setAttribute("aria-busy", "true");
        setActivity("RETRYING THE NEWEST QUESTION WITHOUT OLD REPLIES...");
      }

      const retryGuidance =
        attemptIndex > 0
          ? "Give a fresh, specific answer to the user message. Do not echo the question, greet, mention being an assistant, or use customer-service filler."
          : "";
      const systemContent = [SYSTEM_PROMPT, technicalGuidance, retryGuidance]
        .filter(Boolean)
        .join("\n\n");
      const result = await streamCompletion(
        [
          { role: "system", content: systemContent },
          ...(attempt.includeHistory ? historyMessages : []),
          { role: "user", content: prompt },
        ],
        {
          temperature: attempt.temperature,
          maxTokens: startup ? 48 : 96,
          repetitionPenalty: attemptIndex > 0 ? 1.12 : 1.05,
          runId,
          seed: randomSeed(),
          topP: 0.9,
        },
      );

      if (stopRequested || runId !== generationRunId) {
        renderStopped(result.text);
        return;
      }
      rawAnswer = result.text.trim();
      finalUsage = result.usage;
      if (startup || !shouldRetryAnswer(rawAnswer, prompt, previousAnswer, isTechnical)) {
        break;
      }
      rawAnswer = "";
    }

    if (!rawAnswer && exactAnswer) {
      rawAnswer = exactAnswer;
    }
    if (!rawAnswer && isTechnical) {
      rawAnswer =
        "It works because three unionized pigeons pedal a hamster wheel under a tiny librarian's desk. This is unquestionably science.";
    }
    if (!rawAnswer) {
      throw new Error("The model could not produce a relevant reply after three attempts.");
    }
    const answer = startup ? normalizeGreeting(rawAnswer, greetingSurprise) : rawAnswer;

    if (!startup) {
      conversationHistory = [
        ...conversationHistory,
        { prompt, response: answer },
      ].slice(-HISTORY_LIMIT);
    }

    currentAnswer = answer;
    setAnswer(answer, "READY", false);
    renderGenerationStats(finalUsage);
    isGenerating = false;
    ui.answerOutput.setAttribute("aria-busy", "false");
    ui.answerPanel.classList.remove("is-generating");
    speakText(answer, true);
  } catch (error) {
    const message = error?.message || String(error);
    if (stopRequested || /interrupt|abort|cancel/i.test(message)) {
      const visiblePartial = ui.answerOutput.classList.contains("is-placeholder")
        ? ""
        : ui.answerOutput.textContent;
      renderStopped(visiblePartial);
    } else {
      currentAnswer = "";
      setAnswer(`Could not complete the request: ${message}`, "ERROR", true);
      setActivity(`FAILED: ${message}`, true);
      ui.generationStats.textContent = "";
    }
  } finally {
    isGenerating = false;
    stopRequested = false;
    ui.answerOutput.setAttribute("aria-busy", "false");
    ui.answerPanel.classList.remove("is-generating");
    syncControls();
  }
}

async function streamCompletion(
  messages,
  { temperature, maxTokens, repetitionPenalty, runId, seed, topP },
) {
  if (activeBackend === "wasm") {
    return streamWasmCompletion(messages, {
      temperature,
      maxTokens: Math.min(maxTokens, 48),
      repetitionPenalty,
      runId,
      seed,
      topP,
    });
  }

  let text = "";
  let usage = null;
  const completion = await engine.chat.completions.create({
    messages,
    repetition_penalty: repetitionPenalty,
    seed,
    temperature,
    top_p: topP,
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  });

  for await (const chunk of completion) {
    if (stopRequested || runId !== generationRunId) {
      break;
    }

    const delta = chunk.choices?.[0]?.delta?.content || "";
    if (delta) {
      text += delta;
      renderStream(text);
    }
    if (chunk.usage) {
      usage = chunk.usage;
    }
  }

  return { text, usage };
}

async function streamWasmCompletion(
  messages,
  { temperature, maxTokens, repetitionPenalty, runId, seed, topP },
) {
  let text = "";
  let chunks = 0;
  const startedAt = performance.now();
  const streamer = new wasmRuntime.TextStreamer(engine.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (chunk) => {
      if (stopRequested || runId !== generationRunId) {
        return;
      }
      text += chunk;
      chunks += 1;
      renderStream(text);
    },
  });

  const result = await engine(messages, {
    do_sample: true,
    max_new_tokens: maxTokens,
    repetition_penalty: repetitionPenalty,
    seed,
    streamer,
    temperature,
    top_p: topP,
  });

  if (!text.trim()) {
    const generated = result?.[0]?.generated_text;
    if (Array.isArray(generated)) {
      text = generated.at(-1)?.content || "";
    } else if (typeof generated === "string") {
      text = generated;
    }
  }

  const seconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
  return {
    text,
    usage: {
      completion_tokens: chunks,
      extra: { decode_tokens_per_s: chunks / seconds },
    },
  };
}

function shouldIncludeHistory(prompt) {
  return conversationHistory.length > 0 && HISTORY_REFERENCE_PATTERN.test(prompt);
}

function shouldRetryAnswer(answer, prompt, previousAnswer, isTechnical) {
  const normalized = normalizeForComparison(answer);
  if (!normalized) {
    return true;
  }

  const normalizedPrompt = normalizeForComparison(prompt);
  const earlierContent = [
    previousAnswer,
    ...conversationHistory.flatMap((turn) => [turn.prompt, turn.response]),
  ]
    .map(normalizeForComparison)
    .filter(Boolean);

  const exactAnswer = normalizeForComparison(extractExactAnswer(prompt));
  const asksHowNathanIs = /\bhow (?:are you|is it going)\b/i.test(prompt);
  const echoesPrompt =
    normalizedPrompt.length >= 8 &&
    normalized.includes(normalizedPrompt) &&
    normalized.split(" ").length <= normalizedPrompt.split(" ").length + 8;

  return (
    /^heyo\s+virtual\s+nathan\s+here\b/i.test(normalized) ||
    (!asksHowNathanIs && GENERIC_RESPONSE_PATTERN.test(normalized)) ||
    (isTechnical && !TECHNICAL_ABSURDITY_PATTERN.test(normalized)) ||
    echoesPrompt ||
    Boolean(exactAnswer && normalized !== exactAnswer) ||
    earlierContent.some(
      (earlier) => earlier === normalized || (earlier.length >= 8 && normalized.includes(earlier)),
    )
  );
}

function extractExactAnswer(prompt) {
  const match = prompt.match(
    /\b(?:respond|reply|answer|say|output)\s+with\s+exactly(?:\s+(?:the\s+)?(?:one|two|three|\d+)\s+words?)?\s*:?\s*["']?([^"'.!?\n]+)["']?/i,
  );
  return match ? match[1].replace(/\s+and\s+nothing\s+else$/i, "").trim() : "";
}

function randomSeed() {
  return Math.floor(Math.random() * 2_147_483_647);
}

function normalizeForComparison(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function ensureModel() {
  if (engine && activeModel) {
    return;
  }
  if (isLoading) {
    return;
  }
  if (location.protocol === "file:") {
    throw new Error("The local model needs localhost or HTTPS; it cannot run from file://.");
  }

  isLoading = true;
  setProgress(0);
  setActivity("STARTING THE LOCAL MODEL...");
  ui.modelStatus.textContent = "MODEL: STARTING...";
  ui.answerState.textContent = "LOADING MODEL";
  syncControls();
  const startedAt = performance.now();

  try {
    let selection = null;
    const useWebGPU = new URLSearchParams(location.search).get("backend") === "webgpu";

    if (useWebGPU && navigator.gpu?.requestAdapter) {
      try {
        const webllm = await loadRuntime();
        selection = await initializeEngine(webllm);
      } catch (error) {
        console.warn("WebGPU model startup failed; switching to CPU/WASM.", error);
        await releaseEngine();
        setProgress(0);
        setActivity("WEBGPU IS UNAVAILABLE. SWITCHING TO THE CPU MODEL...");
      }
    }

    if (!selection) {
      const transformers = await loadWasmRuntime();
      selection = await initializeWasmEngine(transformers);
    }

    activeModel = selection.modelId;
    activeModelMode = selection.mode;
    activeBackend = selection.backend;
    setProgress(100);
    ui.modelStatus.textContent = `MODEL: ${selection.label} · ${activeModelMode} · READY`;
    setActivity(`MODEL READY IN ${formatDuration(performance.now() - startedAt)}. STARTING YOUR PROMPT...`);
  } catch (error) {
    await releaseEngine();
    setProgress(0);
    ui.modelStatus.textContent = "MODEL: NOT LOADED · CPU FALLBACK ≈ 181 MIB";
    throw error;
  } finally {
    isLoading = false;
    syncControls();
  }
}

async function loadWasmRuntime() {
  if (wasmRuntime) {
    return wasmRuntime;
  }
  if (!wasmRuntimePromise) {
    wasmRuntimePromise = import(TRANSFORMERS_IMPORT_URL);
  }

  try {
    wasmRuntime = await wasmRuntimePromise;
    wasmRuntime.env.allowLocalModels = false;
    wasmRuntime.env.allowRemoteModels = true;
    wasmRuntime.env.useBrowserCache = true;
    wasmRuntime.env.backends.onnx.wasm.numThreads = 1;
    return wasmRuntime;
  } catch (error) {
    wasmRuntimePromise = null;
    throw new Error(`Could not download the CPU model runtime: ${error?.message || String(error)}`);
  }
}

async function initializeWasmEngine(transformers) {
  setActivity("LOADING THE CPU MODEL · FIRST RUN IS ABOUT 181 MIB...");
  engine = await transformers.pipeline("text-generation", WASM_MODEL, {
    dtype: "q4",
    progress_callback: (report) => {
      const percent = Number.isFinite(report?.progress) ? report.progress : inferPercent(report?.status);
      setProgress(percent);
      const detail = [report?.status, report?.file].filter(Boolean).join(" · ");
      setActivity(detail ? `LOADING CPU MODEL · ${detail}` : "LOADING CPU MODEL...");
    },
  });
  return { backend: "wasm", label: "SMOLLM2 135M", mode: "CPU/WASM", modelId: WASM_MODEL };
}

async function loadRuntime() {
  if (runtime) {
    return runtime;
  }
  if (!runtimePromise) {
    runtimePromise = import(WEB_LLM_IMPORT_URL);
  }

  try {
    runtime = await runtimePromise;
    return runtime;
  } catch (error) {
    runtimePromise = null;
    throw new Error(`Could not download the WebLLM runtime: ${error?.message || String(error)}`);
  }
}

async function initializeEngine(webllm) {
  const availableModels = new Set(
    webllm.prebuiltAppConfig.model_list.map((entry) => entry.model_id),
  );
  const primary = { backend: "webgpu", label: "QWEN2.5 0.5B", modelId: MODEL_F16, mode: "F16" };
  const compatibility = {
    backend: "webgpu",
    label: "QWEN2.5 0.5B",
    modelId: MODEL_F32,
    mode: "COMPATIBILITY",
  };
  if (!availableModels.has(primary.modelId)) {
    throw new Error(`${primary.modelId} is missing from the pinned WebLLM model list.`);
  }

  let selection = primary;
  let lastError = null;
  const maxAttempts = 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    engine = new webllm.MLCEngine({ appConfig: webllm.prebuiltAppConfig });
    engine.setInitProgressCallback((report) => {
      const percent =
        typeof report.progress === "number" ? report.progress * 100 : inferPercent(report.text);
      setProgress(percent);
      setActivity(report.text ? `LOADING MODEL · ${report.text}` : "LOADING MODEL FILES...");
    });

    try {
      await engine.reload(selection.modelId);
      return selection;
    } catch (error) {
      lastError = error;
      const message = error?.message || String(error);
      await releaseEngine();

      if (
        selection === primary &&
        availableModels.has(compatibility.modelId) &&
        isF16CompatibilityError(message)
      ) {
        selection = compatibility;
        setActivity("F16 IS UNAVAILABLE. TRYING THE COMPATIBILITY MODEL...");
        continue;
      }

      if (!isTransientWebGPUError(message) || attempt === maxAttempts) {
        throw error;
      }

      const retryDelay = 600 * 2 ** (attempt - 1);
      setActivity(`WEBGPU STARTUP RETRY ${attempt} OF ${maxAttempts - 1}...`);
      await waitFor(retryDelay);
    }
  }

  throw lastError || new Error("Chrome could not initialize WebGPU.");
}

function isTransientWebGPUError(message) {
  return /failed to create webgpu context provider|requestadapter|webgpu.*(?:adapter|context|device)|(?:adapter|context|device).*webgpu/i.test(
    message,
  );
}

function isF16CompatibilityError(message) {
  return /(?:shader[- ]?f16|f16).*(?:unsupported|unavailable|required)|(?:unsupported|unavailable|required).*(?:shader[- ]?f16|f16)/i.test(
    message,
  );
}

async function releaseEngine() {
  const currentEngine = engine;
  const currentBackend = activeBackend;
  engine = null;
  activeModel = "";
  activeModelMode = "";
  activeBackend = "";
  if (currentBackend === "wasm" && currentEngine && typeof currentEngine.dispose === "function") {
    try {
      await currentEngine.dispose();
    } catch {
      // Page teardown should not be blocked by a failed model disposal.
    }
  } else if (currentEngine && typeof currentEngine.unload === "function") {
    try {
      await currentEngine.unload();
    } catch {
      // A partially initialized WebGPU engine may not have anything to unload.
    }
  }
}

function waitFor(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function stopEverything() {
  let stoppedSomething = false;

  if (isGenerating && engine) {
    stoppedSomething = true;
    stopRequested = true;
    setActivity("STOPPING GENERATION...");
    if (typeof engine.interruptGenerate === "function") {
      try {
        await engine.interruptGenerate();
      } catch (error) {
        if (!/interrupt|abort|cancel/i.test(error?.message || "")) {
          setActivity(`STOP REQUEST FAILED: ${error?.message || String(error)}`, true);
        }
      }
    }
  }

  if (isSpeechQueued || isSpeaking) {
    stoppedSomething = true;
    cancelSpeech(false);
    ui.answerState.textContent = currentAnswer ? "STOPPED" : "WAITING";
    setActivity("SPEECH STOPPED. PRESS SPEAK REPLY TO HEAR IT AGAIN.");
  }

  if (stoppedSomething) {
    syncControls();
  }
}

function renderStream(text) {
  ui.answerOutput.classList.remove("is-placeholder");
  ui.answerOutput.textContent = text;
  ui.answerOutput.scrollTop = ui.answerOutput.scrollHeight;
}

function renderStopped(partialText) {
  const partial = (partialText || "").replace(/\s*\[stopped by user\]\s*$/i, "").trim();
  currentAnswer = partial;
  setAnswer(partial || "Generation stopped before the model returned text.", "STOPPED", !partial);
  ui.generationStats.textContent = "STOPPED BY USER";
  setActivity("GENERATION STOPPED. PARTIAL TEXT WILL NOT BE SPOKEN.");
}

function renderGenerationStats(usage) {
  const outputTokens = usage?.completion_tokens;
  const decodeRate = usage?.extra?.decode_tokens_per_s;
  const prefillRate = usage?.extra?.prefill_tokens_per_s;
  const parts = [];

  if (Number.isFinite(outputTokens)) {
    parts.push(`${outputTokens} TOKENS`);
  }
  if (Number.isFinite(decodeRate)) {
    parts.push(`${decodeRate.toFixed(1)} TOK/S`);
  }
  if (Number.isFinite(prefillRate)) {
    parts.push(`${prefillRate.toFixed(0)} PREFILL`);
  }
  ui.generationStats.textContent = parts.join(" · ") || "GENERATION COMPLETE";
}

function speakText(text, automatic) {
  const cleanText = (text || "").replace(/\s+/g, " ").trim();
  if (!cleanText) {
    setActivity("THERE IS NO REPLY TO SPEAK.", true);
    return;
  }
  if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
    setActivity("BROWSER SPEECH IS UNAVAILABLE. THE TEXT REPLY IS STILL ABOVE.", true);
    return;
  }

  pendingAutomaticSpeech = "";
  cancelSpeech(false);
  refreshVoice();
  const chunks = splitForSpeech(cleanText);
  const runId = speechRunId;
  isSpeechQueued = true;
  isSpeaking = false;
  ui.answerState.textContent = "VOICE QUEUED";
  setActivity(automatic ? "REPLY READY. STARTING THE VOICE..." : "STARTING THE VOICE...");
  syncControls();

  const speakChunk = (index) => {
    if (runId !== speechRunId) {
      return;
    }
    if (index >= chunks.length) {
      finishSpeech(runId);
      return;
    }

    const utterance = new SpeechSynthesisUtterance(chunks[index]);
    utterance.rate = 0.78;
    utterance.pitch = 0.52;
    utterance.volume = 1;
    utterance.lang = selectedVoice?.lang || "en-US";
    if (selectedVoice) {
      utterance.voice = selectedVoice;
    }

    utterance.onstart = () => {
      if (runId !== speechRunId) {
        return;
      }
      window.clearTimeout(speechWatchdog);
      isSpeechQueued = false;
      isSpeaking = true;
      startMouthAnimation();
      ui.answerState.textContent = "SPEAKING";
      setActivity(`SPEAKING WITH ${selectedVoice?.name || "THE DEFAULT VOICE"}...`);
      syncControls();
    };

    utterance.onend = () => {
      if (runId !== speechRunId) {
        return;
      }
      speakChunk(index + 1);
    };

    utterance.onerror = (event) => {
      if (runId !== speechRunId || ["interrupted", "canceled"].includes(event.error)) {
        return;
      }
      if (automatic && event.error === "not-allowed") {
        queueAutomaticSpeechRetry(cleanText);
        return;
      }
      cancelSpeech(false);
      ui.answerState.textContent = "VOICE ERROR";
      setActivity(`SPEECH FAILED: ${event.error || "UNKNOWN BROWSER SPEECH ERROR"}.`, true);
    };

    window.speechSynthesis.speak(utterance);
  };

  speakChunk(0);

  if (automatic) {
    speechWatchdog = window.setTimeout(() => {
      if (runId !== speechRunId || isSpeaking) {
        return;
      }
      queueAutomaticSpeechRetry(cleanText);
    }, 4000);
  }
}

function queueAutomaticSpeechRetry(text) {
  cancelSpeech(false);
  pendingAutomaticSpeech = text;
  ui.answerState.textContent = "READY TO SPEAK";
  setActivity("CHROME BLOCKED AUTO-SPEECH. THE NEXT CLICK OR KEYPRESS WILL START IT.");
  syncControls();
}

function retryPendingAutomaticSpeech(event) {
  if (!pendingAutomaticSpeech || isLoading || isGenerating || isSpeechQueued || isSpeaking) {
    return;
  }
  if (event.target instanceof Element && event.target.closest("button")) {
    return;
  }
  const text = pendingAutomaticSpeech;
  pendingAutomaticSpeech = "";
  speakText(text, false);
}

function finishSpeech(runId) {
  if (runId !== speechRunId) {
    return;
  }
  window.clearTimeout(speechWatchdog);
  isSpeechQueued = false;
  isSpeaking = false;
  stopMouthAnimation();
  ui.answerState.textContent = "FINISHED";
  setActivity("REPLY FINISHED. ASK ANOTHER QUESTION OR REPLAY IT.");
  syncControls();
}

function cancelSpeech(announce) {
  speechRunId += 1;
  window.clearTimeout(speechWatchdog);
  speechWatchdog = 0;
  isSpeechQueued = false;
  isSpeaking = false;
  stopMouthAnimation();
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  if (announce) {
    setActivity("SPEECH STOPPED.");
  }
  syncControls();
}

function splitForSpeech(text, maxLength = 220) {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const chunks = [];
  let pending = "";

  const pushWords = (segment) => {
    const words = segment.trim().split(/\s+/);
    let piece = "";
    for (const word of words) {
      const candidate = piece ? `${piece} ${word}` : word;
      if (candidate.length > maxLength && piece) {
        chunks.push(piece);
        piece = word;
      } else {
        piece = candidate;
      }
    }
    if (piece) {
      chunks.push(piece);
    }
  };

  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
    if (!sentence) {
      continue;
    }
    if (sentence.length > maxLength) {
      if (pending) {
        chunks.push(pending);
        pending = "";
      }
      pushWords(sentence);
      continue;
    }
    const candidate = pending ? `${pending} ${sentence}` : sentence;
    if (candidate.length > maxLength && pending) {
      chunks.push(pending);
      pending = sentence;
    } else {
      pending = candidate;
    }
  }
  if (pending) {
    chunks.push(pending);
  }
  return chunks.length ? chunks : [text];
}

function chooseGreetingSurprise() {
  const randomValue = new Uint32Array(1);
  crypto.getRandomValues(randomValue);
  return GREETING_SURPRISES[randomValue[0] % GREETING_SURPRISES.length];
}

function normalizeGreeting(text, greetingSurprise) {
  const cleanText = text.replace(/\s+/g, " ").replace(/^["']|["']$/g, "").trim();
  const includesIdentity = /virtual nathan/i.test(cleanText);
  const includesInvitation = /ask me anything|ask away|questions? welcome/i.test(cleanText);
  const includesSurprise = cleanText.split(/\s+/).length >= 12;
  const endsCleanly = /[.!?]$/.test(cleanText);
  if (
    includesIdentity &&
    includesInvitation &&
    includesSurprise &&
    endsCleanly &&
    cleanText.length <= 220
  ) {
    return cleanText;
  }

  return `Heyo, virtual Nathan here — ask me anything! ${greetingSurprise}`;
}

function refreshVoice() {
  if (!("speechSynthesis" in window)) {
    return;
  }
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) {
    selectedVoice = null;
    ui.voiceStatus.textContent = "VOICE: DEFAULT · SOURCE UNKNOWN";
    return;
  }

  selectedVoice = voices
    .filter((voice) => /^en(?:-|_)/i.test(voice.lang || ""))
    .map((voice) => ({ voice, score: scoreVoice(voice) }))
    .sort((left, right) => right.score - left.score)[0]?.voice || null;

  if (!selectedVoice) {
    ui.voiceStatus.textContent = "VOICE: DEFAULT EN-US · SOURCE UNKNOWN";
    return;
  }
  const source =
    selectedVoice.localService === true
      ? "LOCAL"
      : selectedVoice.localService === false
        ? "PROVIDER"
        : "SOURCE UNKNOWN";
  ui.voiceStatus.textContent = `VOICE: ${selectedVoice.name.toUpperCase()} · ${source}`;
}

function scoreVoice(voice) {
  const name = voice.name.toLowerCase();
  const language = (voice.lang || "").toLowerCase();
  let score = 0;

  if (name === "fred" || name.includes("fred")) score += 400;
  if (name.includes("zarvox")) score += 220;
  if (name.includes("bad news")) score += 180;
  if (name.includes("trinoids")) score += 160;
  if (name.includes("organ")) score += 120;
  if (name.includes("calltext")) score += 80;
  if (language === "en-us") score += 120;
  if (name.includes("samantha")) score += 60;
  if (name.includes("alex")) score += 55;
  if (name.includes("tom")) score += 50;
  if (name.includes("google us english")) score += 45;
  if (name.includes("microsoft david")) score += 40;
  if (name.includes("david")) score += 24;
  if (name.includes("daniel")) score += 18;
  if (voice.localService) score += 12;
  if (voice.default) score += 8;
  return score;
}

function startMouthAnimation() {
  stopMouthAnimation();
  document.body.classList.add("is-speaking");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  mouthFrameIndex = reducedMotion ? 2 : 0;
  ui.mouth.src = MOUTH_FRAMES[mouthFrameIndex];
  if (reducedMotion) {
    return;
  }
  mouthTimer = window.setInterval(() => {
    mouthFrameIndex = (mouthFrameIndex + 1) % MOUTH_FRAMES.length;
    ui.mouth.src = MOUTH_FRAMES[mouthFrameIndex];
  }, 150);
}

function stopMouthAnimation() {
  window.clearInterval(mouthTimer);
  mouthTimer = 0;
  mouthFrameIndex = 0;
  ui.mouth.src = MOUTH_FRAMES[0];
  document.body.classList.remove("is-speaking");
}

function setAnswer(text, state, error) {
  ui.answerOutput.textContent = text || "The model's answer will appear here before it is spoken.";
  ui.answerOutput.classList.toggle("is-placeholder", !text);
  ui.answerPanel.classList.toggle("is-error", Boolean(error));
  ui.answerState.textContent = state;
}

function setActivity(text, error = false) {
  ui.activityStatus.textContent = text;
  document.body.classList.toggle("has-error", error);
}

function setProgress(value) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  ui.progressBar.style.width = `${percent}%`;
  ui.progressTrack.setAttribute("aria-valuenow", String(Math.round(percent)));
}

function inferPercent(text) {
  const match = typeof text === "string" ? text.match(/(\d+(?:\.\d+)?)\s*%/) : null;
  return match ? Number(match[1]) : 0;
}

function formatDuration(milliseconds) {
  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)}MS`;
  }
  const seconds = milliseconds / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}S`;
  }
  return `${Math.floor(seconds / 60)}M ${Math.round(seconds % 60)}S`;
}

function updateCharacterCount() {
  ui.count.textContent = `${ui.prompt.value.length} / 600`;
}

function syncControls() {
  const inferenceBusy = isLoading || isGenerating;
  const speechBusy = isSpeechQueued || isSpeaking;
  const busy = inferenceBusy || speechBusy;
  const inferenceBlocked = location.protocol === "file:" || !("gpu" in navigator);
  const speechAvailable = "speechSynthesis" in window;

  document.body.classList.toggle("is-busy", inferenceBusy);
  document.body.classList.toggle("is-loading", isLoading);
  document.body.classList.toggle("is-generating", isGenerating);
  document.body.classList.toggle("is-queued", isSpeechQueued);
  document.body.classList.toggle("has-answer", Boolean(currentAnswer));

  ui.prompt.disabled = inferenceBusy;
  ui.askButton.disabled = inferenceBusy || inferenceBlocked;
  ui.stopButton.disabled = isLoading || !(isGenerating || isSpeechQueued || isSpeaking);
  ui.speakButton.disabled = busy || !currentAnswer || !speechAvailable;
  ui.askButton.setAttribute(
    "aria-label",
    isLoading
      ? "Loading Virtual Nathan"
      : isGenerating
        ? "Virtual Nathan is thinking"
        : "Ask and speak",
  );
}
