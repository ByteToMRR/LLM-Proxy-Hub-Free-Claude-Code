/**
 * LLM Proxy Hub — Production Server
 * Translates Anthropic API ↔ OpenAI‑compatible providers.
 * Enforces tool calls on models that don't natively support function calling.
 * Features:
 *   - Lazy provider keys + SIGHUP reload
 *   - Modern OpenAI tools format with legacy function compatibility
 *   - Three‑phase tool enforcement (with context preservation)
 *   - Proper Anthropic streaming (start / delta / stop events)
 *   - Graceful fallback to a backup provider on failure
 *   - Robust JSON extraction (balanced‑brace)
 */
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const PORT = process.env.PORT || 8088;

// ─── LOGGING ──────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  if (req.body?.model) console.log(`  Model: ${req.body.model}`);
  next();
});

// Health checks
['/', '/v1', '/v1/messages', '/v1/chat/completions'].forEach(p =>
  app.head(p, (_, res) => res.sendStatus(200))
);

// ─── PROVIDERS ────────────────────────────────────────────────────────────────
const PROVIDERS = {
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    key: () => process.env.GROQ_API_KEY,
    maxTokens: 8192, maxRetries: 5, retryDelayMs: 2000,
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    key: () => process.env.OPENROUTER_API_KEY,
    maxTokens: 8192, maxRetries: 3, retryDelayMs: 2000,
  },
  deepseek: {
    url: 'https://api.deepseek.com/v1/chat/completions',
    key: () => process.env.DEEPSEEK_API_KEY,
    maxTokens: 4096, maxRetries: 3, retryDelayMs: 2000,
  },
  nvidia: {
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    key: () => process.env.NVIDIA_NIM_API_KEY,
    maxTokens: 4096, maxRetries: 3, retryDelayMs: 2000,
  },
  ollama: {
    url: () => (process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1') + '/chat/completions',
    key: () => 'ollama',
    maxTokens: 4096, maxRetries: 1, retryDelayMs: 1000,
  },
  'ollama-cloud': {
    url: 'https://ollama.com/v1/chat/completions',
    key: () => process.env.OLLAMA_API_KEY,
    maxTokens: 8192, maxRetries: 3, retryDelayMs: 2000,
  },
};

// ─── MODEL MAP ────────────────────────────────────────────────────────────────
let MODEL_MAP = buildModelMap();

function buildModelMap() {
  const defaults = {
    'claude-opus-4-7':           { provider: 'ollama-cloud', model: 'deepseek-v3.1:671b-cloud' },
    'claude-opus-4-5':           { provider: 'ollama-cloud', model: 'deepseek-v3.1:671b-cloud' },
    'claude-sonnet-4-6':         { provider: 'ollama-cloud', model: 'deepseek-v3.1:671b-cloud' },
    'claude-sonnet-4-5':         { provider: 'ollama-cloud', model: 'deepseek-v3.1:671b-cloud' },
    'claude-sonnet-4':           { provider: 'ollama-cloud', model: 'deepseek-v3.1:671b-cloud' },
    'claude-haiku-4-5-20251001': { provider: 'ollama-cloud', model: 'deepseek-v3.1:671b-cloud' },
    'claude-haiku-4-5':          { provider: 'ollama-cloud', model: 'deepseek-v3.1:671b-cloud' },
    'claude-3.5-sonnet':         { provider: 'ollama-cloud', model: 'deepseek-v3.1:671b-cloud' },
  };
  const map = { ...defaults };
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('MAP_')) continue;
    const name = k.replace('MAP_', '').replace(/_/g, '-').toLowerCase();
    const sep  = v.indexOf(':');
    if (sep < 1) continue;
    const provider = v.slice(0, sep);
    const model    = v.slice(sep + 1);
    map[name] = { provider, model };
    console.log(`  ↳ Custom mapping: ${name} → ${provider}/${model}`);
  }
  return map;
}

process.on('SIGHUP', () => {
  MODEL_MAP = buildModelMap();
  console.log('  ↳ Model map reloaded.');
});

function resolveModel(requestedModel) {
  if (requestedModel.includes('/')) {
    const sep      = requestedModel.indexOf('/');
    const provider = requestedModel.slice(0, sep);
    const model    = requestedModel.slice(sep + 1);
    return { provider, model };
  }
  const mapped = MODEL_MAP[requestedModel];
  if (mapped) return mapped;
  console.warn(`  ⚠️  Unknown model "${requestedModel}", falling back to default.`);
  return { provider: 'ollama-cloud', model: 'deepseek-v3.1:671b-cloud' };
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content.map(block => {
    if (block.type === 'text')        return block.text;
    if (block.type === 'tool_result') return `[tool_result id=${block.tool_use_id}]: ${flattenContent(block.content)}`;
    if (block.type === 'tool_use')    return `[tool_use name=${block.name}]: ${JSON.stringify(block.input)}`;
    if (block.type === 'image')       return '[image]';
    return '';
  }).filter(Boolean).join('\n');
}

/**
 * Extract the first JSON object using balanced braces.
 * Prevents greedy matching of multiple objects.
 */
function extractFirstJSON(text) {
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (text[i] === '}') { depth--; if (depth === 0 && start !== -1) return text.slice(start, i + 1); }
  }
  return null;
}

function anthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  return tools.map(t => ({
    type: 'function',
    function: {
      name:        t.name,
      description: t.description || '',
      parameters:  t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function openAIToolCallToAnthropic(tc) {
  let input = {};
  try {
    input = typeof tc.function.arguments === 'string'
      ? JSON.parse(tc.function.arguments)
      : (tc.function.arguments ?? {});
  } catch {
    input = { _raw: tc.function.arguments };
  }
  return {
    type:  'tool_use',
    id:    tc.id || `toolu_${Math.random().toString(36).slice(2, 11)}`,
    name:  tc.function.name,
    input,
  };
}

// ─── ENHANCED SYSTEM PROMPT ───────────────────────────────────────────────────
const ENHANCED_SYSTEM_PROMPT = `\
You are an expert software engineering assistant with direct access to the user's filesystem, shell, and web. You think carefully before acting and always use the most appropriate tool.

<tool_priority_rules>
FILESYSTEM:
  - Read   → read existing files before editing
  - Write  → create new files or overwrite
  - Edit   → targeted in-place edits (prefer over Write for existing files)
  - Glob   → discover files by pattern
  - Grep   → search file contents

SHELL:
  - Bash   → ONLY for system commands: npm, pip, git, cargo, docker, make, etc.
  - NEVER use Bash for: cat, head, tail, sed, awk, echo, touch — use Read/Write/Edit instead

RESEARCH:
  - WebSearch → search for current information
  - WebFetch  → retrieve a specific URL

WORKFLOW:
  - Read before Write on any existing file ("look before you cut")
  - Batch independent operations in one turn (parallel tool use)
  - Prefer reversible actions; confirm destructive ones
  - Only implement what was explicitly asked — no speculative extras
  - If an approach fails twice, diagnose before switching
</tool_priority_rules>

<response_style>
- Concise and direct. No filler phrases ("Great question!", "Certainly!").
- Reference code as filename:line_number.
- When using a tool, output the call immediately — no preamble.
- For complex tasks, state your plan in ≤2 sentences, then act.
</response_style>

<reasoning>
Before each action, silently verify:
1. What exactly is needed?
2. Which single tool best fulfils it?
3. Any destructive risk or shared-state concern?
Do not surface this reasoning unless asked.
</reasoning>`;

const SYSTEM_MARKER = '<tool_priority_rules>';

// ─── CORE FORWARDER ───────────────────────────────────────────────────────────
async function forwardToProvider(providerKey, actualModel, messages, tools, stream, temperature, max_tokens) {
  const p = PROVIDERS[providerKey];
  if (!p) throw Object.assign(new Error(`Unknown provider: ${providerKey}`), { status: 400 });

  const url = typeof p.url === 'function' ? p.url() : p.url;
  const key = typeof p.key === 'function' ? p.key() : p.key;
  if (!key && providerKey !== 'ollama') {
    throw Object.assign(new Error(`API key missing for provider "${providerKey}"`), { status: 401 });
  }

  const safeMaxTokens = Math.min(max_tokens || 4096, p.maxTokens);

  const cleanMessages = messages
    .filter(m => m.role && (m.content || m.tool_calls?.length))
    .map(m => {
      const out = { role: m.role };
      out.content = m.content != null ? (typeof m.content === 'string' ? m.content : flattenContent(m.content)) : null;
      if (m.tool_calls?.length)   out.tool_calls   = m.tool_calls;
      if (m.tool_call_id)         out.tool_call_id = m.tool_call_id;
      if (m.name)                 out.name         = m.name;
      if (out.content === null && m.role !== 'assistant') out.content = '';
      return out;
    });

  const payload = {
    model:       actualModel,
    messages:    cleanMessages,
    temperature: temperature ?? 1.0,
    max_tokens:  safeMaxTokens,
    stream:      stream ?? false,
  };

  if (tools?.length) {
    payload.tools       = tools;
    payload.tool_choice = 'auto';
  }

  const headers = {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${key}`,
  };

  let delay = p.retryDelayMs;
  for (let attempt = 0; attempt <= p.maxRetries; attempt++) {
    try {
      const resp = await axios.post(url, payload, {
        headers,
        responseType:      stream ? 'stream' : 'json',
        maxBodyLength:     Infinity,
        maxContentLength:  Infinity,
        timeout:           120_000,
      });
      return resp.data;
    } catch (err) {
      const status = err.response?.status;
      const isRetryable = status === 429 || (status >= 500 && status < 600);
      if (isRetryable && attempt < p.maxRetries) {
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '0', 10);
        const wait = retryAfter > 0 ? retryAfter * 1000 : delay;
        console.log(`  ⏳ ${status} — retry ${attempt + 1}/${p.maxRetries} in ${(wait / 1000).toFixed(1)}s`);
        await sleep(wait);
        delay = Math.min(delay * 2, 30_000);
        continue;
      }
      if (err.response) {
        const msg = err.response.data?.error?.message || JSON.stringify(err.response.data) || err.message;
        throw Object.assign(new Error(`${providerKey} error (${status}): ${msg}`), { status });
      }
      throw err;
    }
  }
  throw new Error(`All retries exhausted for provider "${providerKey}"`);
}

// ─── FALLBACK HANDLER ─────────────────────────────────────────────────────────
async function withFallback(provider, model, messages, tools, stream, temperature, maxTokens) {
  try {
    return await forwardToProvider(provider, model, messages, tools, stream, temperature, maxTokens);
  } catch (err) {
    const fallback = process.env.FALLBACK_PROVIDER;
    if (fallback && (err.status >= 500 || !err.status)) {
      const [fbProv, ...rest] = fallback.split(':');
      const fbModel = rest.join(':');
      console.warn(`  🔄 Primary provider failed, falling back to ${fbProv}/${fbModel}`);
      return forwardToProvider(fbProv, fbModel, messages, tools, stream, temperature, maxTokens);
    }
    throw err;
  }
}

// ─── INTENT DETECTION ─────────────────────────────────────────────────────────

function extractUserText(messages) {
  const last = [...messages].reverse().find(m => m.role === 'user');
  if (!last) return '';

  // If content is a simple string, return it trimmed
  if (typeof last.content === 'string') return last.content.trim();

  // If content is an array, pull ONLY the first text block (the user's actual words)
  if (Array.isArray(last.content)) {
    for (const block of last.content) {
      if (block.type === 'text') return (block.text || '').trim();
    }
  }

  return flattenContent(last.content).trim();
}

const GREETINGS = /^(hello|hi|hii+|hey|good\s(morning|afternoon|evening)|howdy|sup|yo|what'?s\s*up|how\s(are\s)?you|bye|goodbye|see\s*you|later|cya)\b/i;

const QUESTIONS = /^(what|how|why|where|who|when|can\s+you|please\s+explain|tell\s+me|describe|is\s+it|are\s+there|does\s+it|will\s+it|should\s+i|what\s+is|what\s+are|what\s+does)\b/i;

const ACTION_PATTERNS = [
  // File ops
  /\b(create|write|generate|save|make)\s+(a\s+)?(new\s+)?file\b/i,
  /\b(read|open|show|display|print)\s+(the\s+)?(contents?\s+of\s+)?file\b/i,
  /\b(edit|modify|update|change|fix|refactor|rename|move|delete|remove)\s+(the\s+)?file\b/i,
  /\b(list|find|search\s+for)\s+(files?|dir(ectory)?)\b/i,
  // Shell
  /\b(run|execute|launch|start|stop|kill|restart)\s+\w/i,
  /\b(install|uninstall|upgrade|build|compile|test|deploy)\s+\w/i,
  /\b(git\s+(commit|push|pull|clone|status|log|diff|add|checkout|merge))\b/i,
  // Code ops
  /\b(add|implement|create|build|code)\s+(a\s+)?(function|class|component|module|endpoint|route|test)\b/i,
  /\b(grep|search\s+(in|through|inside))\s+\w/i,
];

function detectIntent(messages) {
  const text = extractUserText(messages);
  if (!text) return { wantsAction: false, text: '', reason: 'no-user-text' };

  // 1. Greetings — using \b word boundary to catch standalone greetings
  //    even if followed by extra words (like "hello world" → still a greeting)
  if (GREETINGS.test(text)) {
    // If the text is ONLY a greeting with maybe some punctuation, definitely skip
    if (/^(hello|hi|hii+|hey|good\s(morning|afternoon|evening)|howdy|sup|yo|what'?s\s*up|how\s(are\s)?you|bye|goodbye|see\s*you|later|cya)[\s!.,?]*$/i.test(text)) {
      console.log(`  Intent: greeting (pure) → skip | text="${text}"`);
      return { wantsAction: false, text, reason: 'greeting-pure' };
    }
    // Extended greeting with some extra words but no action verbs
    const hasActionVerb = ACTION_PATTERNS.some(p => p.test(text));
    if (!hasActionVerb) {
      console.log(`  Intent: greeting (extended) → skip | text="${text}"`);
      return { wantsAction: false, text, reason: 'greeting-extended' };
    }
  }

  // 2. Pure questions without action verbs → skip
  if (QUESTIONS.test(text)) {
    const hasAction = ACTION_PATTERNS.some(p => p.test(text));
    if (!hasAction) {
      console.log(`  Intent: question → skip | text="${text}"`);
      return { wantsAction: false, text, reason: 'question' };
    }
  }

  // 3. Explicit action patterns → allow
  const matchedPattern = ACTION_PATTERNS.find(p => p.test(text));
  if (matchedPattern) {
    console.log(`  Intent: action-pattern → allow | text="${text}"`);
    return { wantsAction: true, text, reason: 'action-pattern' };
  }

  // 4. Short messages (≤5 words) with no action → conversational
  const wordCount = text.split(/\s+/).length;
  if (wordCount <= 5) {
    console.log(`  Intent: short conversational → skip | text="${text}"`);
    return { wantsAction: false, text, reason: 'short-message' };
  }

  // 5. Default — let it through
  console.log(`  Intent: default → allow | text="${text}"`);
  return { wantsAction: true, text, reason: 'default' };
}

// ─── TOOL ENFORCEMENT ENGINE ──────────────────────────────────────────────────
const TOOL_KEYWORD_MAP = [
  { name: 'Write',     patterns: [/\bcreate\s+(a\s+)?file\b/i, /\bwrite\s+(to\s+)?file\b/i, /\bsave\s+as\b/i] },
  { name: 'Read',      patterns: [/\bread\s+(the\s+)?file\b/i, /\bopen\s+(the\s+)?file\b/i, /\bshow\s+me\s+(the\s+)?file\b/i] },
  { name: 'Edit',      patterns: [/\bedit\s+(the\s+)?file\b/i, /\bmodify\b/i, /\brefactor\b/i, /\bupdate\s+(the\s+)?file\b/i] },
  { name: 'Bash',      patterns: [/\brun\b/i, /\bexecute\b/i, /\bnpm\b/i, /\bgit\s+\w/i, /\binstall\b/i, /\bbuild\b/i] },
  { name: 'Glob',      patterns: [/\blist\s+files\b/i, /\bfind\s+files\b/i] },
  { name: 'Grep',      patterns: [/\bgrep\b/i, /\bsearch\s+(in|through)\b/i] },
  { name: 'WebSearch', patterns: [/\bweb\s*search\b/i, /\bsearch\s+the\s+web\b/i, /\bsearch\s+online\b/i] },
  { name: 'WebFetch',  patterns: [/\bfetch\s+(url|page|website)\b/i, /\bdownload\s+(page|url)\b/i] },
];

function guessToolName(text, availableTools) {
  const names = new Set(availableTools.map(t => t.function?.name || t.name));
  for (const { name, patterns } of TOOL_KEYWORD_MAP) {
    if (names.has(name) && patterns.some(p => p.test(text))) return name;
  }
  return null;
}

function buildDefaultArgs(toolDef) {
  const props = toolDef.function?.parameters?.properties || toolDef.parameters?.properties || {};
  const args  = {};
  for (const [key, schema] of Object.entries(props)) {
    if (schema.default !== undefined) { args[key] = schema.default; continue; }
    if (schema.example !== undefined) { args[key] = schema.example; continue; }
    switch (schema.type) {
      case 'string':  args[key] = key.includes('path') ? './file.txt' : key.includes('command') ? 'echo hello' : ''; break;
      case 'number':  args[key] = 0;    break;
      case 'boolean': args[key] = false; break;
      case 'array':   args[key] = [];   break;
      case 'object':  args[key] = {};   break;
      default:        args[key] = null;
    }
  }
  return args;
}

const TOOL_ALIASES = {
  create_file: 'Write', write_file: 'Write', write_to_file: 'Write',
  edit_file:   'Edit',  modify_file: 'Edit',  update_file: 'Edit',
  run_command: 'Bash',  execute_command: 'Bash', bash: 'Bash', shell: 'Bash',
  read_file:   'Read',  open_file: 'Read',    cat_file: 'Read',
  list_files:  'Glob',  find_files: 'Glob',
  search:      'Grep',  search_in_file: 'Grep',
  web_search:  'WebSearch', google: 'WebSearch',
  fetch_url:   'WebFetch',  get_url: 'WebFetch',
};

function resolveToolName(name, availableTools) {
  const available = new Set(availableTools.map(t => t.function?.name || t.name));
  if (available.has(name))              return name;
  const aliased = TOOL_ALIASES[name];
  if (aliased && available.has(aliased)) return aliased;
  return null;
}

function buildToolList(tools) {
  return tools.map(t => {
    const fn    = t.function || t;
    const props = fn.parameters?.properties || {};
    const req   = fn.parameters?.required   || [];
    const params = Object.entries(props)
      .map(([k, v]) => `${k}:${v.type || 'any'}${req.includes(k) ? '*' : ''}`)
      .join(', ');
    return `  ${fn.name}(${params}) — ${fn.description || ''}`;
  }).join('\n');
}

async function parseToolResponse(text, tools) {
  if (!text) return null;

  // Use balanced-brace extraction (fix #1)
  let s = extractFirstJSON(text);
  if (!s) {
    // Fallback: strip markdown and try greedy regex (but only one object)
    s = text.trim()
      .replace(/^```(?:json|javascript|js)?\s*/im, '')
      .replace(/\s*```\s*$/m, '');
    s = extractFirstJSON(s);
    if (!s) return null;
  }

  let parsed;
  try { parsed = JSON.parse(s); }
  catch { return null; }

  const name  = parsed.name;
  const input = parsed.arguments ?? parsed.input ?? parsed.params ?? {};

  if (!name) return null;

  const resolved = resolveToolName(name, tools);
  if (!resolved) {
    console.log(`  ⚠️  Model returned unknown tool "${name}"`);
    return null;
  }
  if (resolved !== name) {
    console.log(`  🔄 Alias "${name}" → "${resolved}"`);
  }

  return {
    type:  'tool_use',
    id:    `toolu_${Math.random().toString(36).slice(2, 11)}`,
    name:  resolved,
    input: typeof input === 'string' ? (() => { try { return JSON.parse(input); } catch { return { value: input }; } })() : input,
  };
}

async function runEnforcement(provider, model, openaiMessages, tools, temperature, maxTokens, intent) {
  const userText    = intent.text;
  const guessedName = guessToolName(userText, tools);
  const targetTool  = tools.find(t => (t.function?.name || t.name) === guessedName) || tools[0];
  const targetName  = targetTool.function?.name || targetTool.name;
  const defaultArgs = buildDefaultArgs(targetTool);
  const toolList    = buildToolList(tools);

  // ── Phase 1: ReAct-style structured prompt ──────────────────────────────────
  const phase1Messages = [
    ...openaiMessages,
    {
      role: 'user',
      content: `Select the correct tool and output ONLY a JSON object. Do not add any explanation.

Available tools (* = required param):
${toolList}

${guessedName ? `Likely tool: "${guessedName}"` : ''}

Output format:
{"name": "<tool_name>", "arguments": {<params>}}

Example:
${JSON.stringify({ name: targetName, arguments: defaultArgs })}`,
    },
  ];

  let raw = await callForText(provider, model, phase1Messages, temperature, maxTokens);
  let result = await parseToolResponse(raw, tools);
  if (result) { console.log(`  ✅ Phase 1 enforcement: ${result.name}`); return result; }

  // ── Phase 2: Force specific tool ────────────────────────────────────────────
  console.log(`  🔄 Phase 1 failed, forcing "${targetName}"...`);
  const phase2Messages = [
    ...openaiMessages,
    {
      role: 'user',
      content: `You MUST use the "${targetName}" tool. Output ONLY this JSON (fill in real values):
${JSON.stringify({ name: targetName, arguments: defaultArgs })}`,
    },
  ];

  raw = await callForText(provider, model, phase2Messages, temperature, maxTokens);
  result = await parseToolResponse(raw, tools);
  if (result) { console.log(`  ✅ Phase 2 enforcement: ${result.name}`); return result; }

  // ── Phase 3: Minimal context, but keep core conversation ────────────────────
  console.log(`  🔄 Phase 2 failed, trying phase 3 with context...`);
  const recentContext = openaiMessages.slice(-4); // keep last 3-4 messages for context
  const phase3Messages = [
    ...recentContext,
    {
      role: 'user',
      content: `You MUST use the "${targetName}" tool now. Output ONLY a JSON object:
${JSON.stringify({ name: targetName, arguments: defaultArgs })}`,
    },
  ];

  raw = await callForText(provider, model, phase3Messages, temperature, maxTokens);
  result = await parseToolResponse(raw, tools);
  if (result) { console.log(`  ✅ Phase 3 enforcement: ${result.name}`); return result; }

  console.log('  ❌ All enforcement phases failed — returning text response');
  return null;
}

async function callForText(provider, model, messages, temperature, maxTokens) {
  const data = await forwardToProvider(
    provider, model, messages, null, false,
    temperature, Math.max(maxTokens || 2048, 2048)
  );
  return data.choices?.[0]?.message?.content || '';
}

// ─── ANTHROPIC → OPENAI MESSAGE CONVERSION ────────────────────────────────────
function anthropicMessagesToOpenAI(messages) {
  const out = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      out.push({ role: 'system', content: flattenContent(msg.content) });
      continue;
    }

    if (msg.role === 'assistant') {
      const am = { role: 'assistant', content: null, tool_calls: [] };
      const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: flattenContent(msg.content) }];
      for (const block of content) {
        if (block.type === 'text') {
          am.content = ((am.content || '') + block.text).trim() || null;
        } else if (block.type === 'tool_use') {
          am.tool_calls.push({
            id:       block.id,
            type:     'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
        }
      }
      if (!am.tool_calls.length) delete am.tool_calls;
      out.push(am);
      continue;
    }

    if (msg.role === 'user') {
      const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: flattenContent(msg.content) }];
      let textAcc = '';
      for (const block of content) {
        if (block.type === 'text') {
          textAcc += block.text + '\n';
        } else if (block.type === 'tool_result') {
          if (textAcc.trim()) { out.push({ role: 'user', content: textAcc.trim() }); textAcc = ''; }
          out.push({
            role:         'tool',
            tool_call_id: block.tool_use_id,
            content:      flattenContent(block.content),
          });
        }
      }
      if (textAcc.trim()) out.push({ role: 'user', content: textAcc.trim() });
    }
  }
  return out;
}

// ─── /v1/messages  (Anthropic format) ────────────────────────────────────────
app.post('/v1/messages', async (req, res) => {
  try {
    const { model, messages, system, tools, max_tokens, stream, temperature } = req.body;

    if (!model)    return res.status(400).json(anthropicError('invalid_request_error', '"model" is required'));
    if (!messages) return res.status(400).json(anthropicError('invalid_request_error', '"messages" is required'));

    const { provider, model: actModel } = resolveModel(model);
    console.log(`  ↳ ${model} → ${provider}/${actModel}`);

    // Build OpenAI messages
    let openaiMessages = [];

    const userSystem = typeof system === 'string' ? system : flattenContent(system);
    const combinedSystem = userSystem
      ? userSystem.includes(SYSTEM_MARKER)
        ? userSystem
        : ENHANCED_SYSTEM_PROMPT + '\n\n' + userSystem
      : ENHANCED_SYSTEM_PROMPT;
    openaiMessages.push({ role: 'system', content: combinedSystem });

    openaiMessages.push(...anthropicMessagesToOpenAI(messages));

    // Remove duplicate system messages
    const hasPrefixSystem = openaiMessages[0]?.role === 'system';
    openaiMessages = openaiMessages.filter((m, i) => !(i > 0 && m.role === 'system'));
    if (!hasPrefixSystem) openaiMessages.unshift({ role: 'system', content: ENHANCED_SYSTEM_PROMPT });

    const openaiTools = anthropicToolsToOpenAI(tools);
    console.log(`  ↳ Tools: ${openaiTools ? openaiTools.map(t => t.function.name).join(', ') : 'none'}`);

    // ── Intent detection – run ONCE before forwarding ─────────────────────────
    const intent = detectIntent(openaiMessages);
    // Strip tools when the user is just chatting / greeting
    const effectiveTools = intent.wantsAction ? openaiTools : null;

    // ── Streaming path ────────────────────────────────────────────────────────
    if (stream) {
      const upstream = await withFallback(provider, actModel, openaiMessages, effectiveTools, true, temperature, max_tokens);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');

      let blockType = null, blockIndex = 0;
      upstream.on('data', chunk => {
        const lines = chunk.toString().split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines) {
          const json = line.slice(6);
          if (json === '[DONE]') {
            if (blockType) res.write(`data: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex - 1 })}\n\n`);
            res.write('data: {"type":"message_stop"}\n\n');
            blockType = null;
            continue;
          }
          try {
            const d     = JSON.parse(json);
            const delta = d.choices?.[0]?.delta;
            if (!delta) continue;
            if (delta.content) {
              if (blockType !== 'text') {
                if (blockType) res.write(`data: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex - 1 })}\n\n`);
                blockType = 'text';
                res.write(`data: ${JSON.stringify({ type: 'content_block_start', index: blockIndex++, content_block: { type: 'text', text: '' } })}\n\n`);
              }
              res.write(`data: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex - 1, delta: { type: 'text_delta', text: delta.content } })}\n\n`);
            }
            if (delta.tool_calls) {
              if (blockType !== 'tool_use') {
                if (blockType) res.write(`data: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex - 1 })}\n\n`);
                blockType = 'tool_use';
                const toolName = delta.tool_calls[0].function?.name || '';
                const toolId   = delta.tool_calls[0].id || `toolu_${Math.random().toString(36).slice(2, 11)}`;
                res.write(`data: ${JSON.stringify({ type: 'content_block_start', index: blockIndex++, content_block: { type: 'tool_use', id: toolId, name: toolName } })}\n\n`);
              }
              for (const tc of delta.tool_calls) {
                if (tc.function?.arguments) {
                  res.write(`data: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex - 1, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } })}\n\n`);
                }
              }
            }
          } catch { /* skip malformed chunks */ }
        }
      });
      upstream.on('end', () => {
        if (blockType) res.write(`data: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex - 1 })}\n\n`);
        res.end();
      });
      upstream.on('error', err => { console.error('Stream error:', err.message); res.end(); });
      return;
    }

    // ── Non-stream path ───────────────────────────────────────────────────────
    let data   = await withFallback(provider, actModel, openaiMessages, effectiveTools, false, temperature, max_tokens);
    let choice = data.choices?.[0];
    let msg    = choice?.message;

    const toolsExpected = effectiveTools && effectiveTools.length > 0;
    const noToolCalls   = !msg?.tool_calls?.length;
    const hasText       = !!msg?.content?.trim();

    console.log(`  Intent: ${intent.reason}, wantsAction: ${intent.wantsAction}, hasTools: ${toolsExpected}, noToolCalls: ${noToolCalls}`);

    let content = [];

    if (toolsExpected && noToolCalls && hasText && intent.wantsAction) {
      console.log('  ⚙️  Text-only response with tools expected — enforcing...');
      const enforced = await runEnforcement(provider, actModel, openaiMessages, openaiTools, temperature, max_tokens, intent);
      if (enforced) {
        content = [enforced];
      } else {
        content = [{ type: 'text', text: msg.content }];
      }
    } else {
      if (msg?.content) content.push({ type: 'text', text: msg.content });
      if (msg?.tool_calls?.length) {
        for (const tc of msg.tool_calls) content.push(openAIToolCallToAnthropic(tc));
      }
    }

    if (!content.length) content.push({ type: 'text', text: '' });

    const stopReason = msg?.tool_calls?.length ? 'tool_use'
      : (choice?.finish_reason === 'length' ? 'max_tokens' : 'end_turn');

    res.json({
      id:          data.id || `msg_${Date.now()}`,
      type:        'message',
      role:        'assistant',
      model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens:  data.usage?.prompt_tokens     || 0,
        output_tokens: data.usage?.completion_tokens || 0,
      },
    });

  } catch (err) {
    console.error('Error in /v1/messages:', err.message);
    const status = err.status || 500;
    if (err.response) {
      return res.status(err.response.status || 500).json(
        anthropicError('api_error', err.response.data?.error?.message || err.message)
      );
    }
    res.status(status).json(anthropicError('api_error', err.message));
  }
});

// ─── /v1/chat/completions  (OpenAI passthrough) ───────────────────────────────
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, tools, functions, stream, temperature, max_tokens } = req.body;

    const slashIdx = model.indexOf('/');
    if (slashIdx < 1) {
      return res.status(400).json({ error: { message: 'Model must be "provider/model" (e.g. "groq/llama3-70b")' } });
    }
    const provider  = model.slice(0, slashIdx);
    const actModel  = model.slice(slashIdx + 1);

    const resolvedTools = tools || (functions ? functions.map(f => ({ type: 'function', function: f })) : null);

    if (stream) {
      const upstream = await withFallback(provider, actModel, messages, resolvedTools, true, temperature, max_tokens);
      res.setHeader('Content-Type', 'text/event-stream');
      upstream.pipe(res);
    } else {
      const data = await withFallback(provider, actModel, messages, resolvedTools, false, temperature, max_tokens);
      res.json(data);
    }
  } catch (err) {
    console.error('Error in /v1/chat/completions:', err.message);
    if (err.response) return res.status(err.response.status || 500).json({ error: err.response.data?.error || { message: err.message } });
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function anthropicError(type, message) {
  return { type: 'error', error: { type, message } };
}

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  LLM Proxy Hub running on :${PORT}`);
  console.log(`    Providers: ${Object.keys(PROVIDERS).join(', ')}`);
  console.log(`    Models mapped: ${Object.keys(MODEL_MAP).length}`);
  console.log(`    Send SIGHUP to reload model map without restart.\n`);
});