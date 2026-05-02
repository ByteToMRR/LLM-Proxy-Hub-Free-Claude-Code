<div align="center">

# 🔀 LLM Proxy Hub

**Use Claude Code with any OpenAI-compatible model — for free.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Stars](https://img.shields.io/github/stars/alikhokhar/llm-proxy-hub?style=social)](https://github.com/alikhokhar/llm-proxy-hub)

A local translation layer between **Claude Code** and any **OpenAI-compatible API**.  
Get the full power of Claude Code's agentic interface — with Groq, DeepSeek, Ollama, OpenRouter, or any model you choose.

[Quick Start](#-quick-start) · [How It Works](#-how-it-works) · [Supported Providers](#-supported-providers) · [Configuration](#-configuration) · [Contributing](CONTRIBUTING.md)

</div>

---

## 🤔 Why LLM Proxy Hub?

Claude Code is one of the most capable coding agents ever built — but it's locked to Anthropic's paid API. Meanwhile, many open-weight and proprietary models can match that quality at a fraction of the cost (or for free).

The problem? They speak **OpenAI format**. Claude Code speaks **Anthropic format**.

**LLM Proxy Hub bridges that gap.**

```
Claude Code (CLI / VS Code)
        │  Anthropic Messages API
        ▼
┌─────────────────────────┐
│     LLM Proxy Hub       │  ← localhost:8088
│  ┌─────────────────┐    │
│  │ Message Convert │    │  Anthropic ↔ OpenAI translation
│  │ Tool Translate  │    │  Tool enforcement engine
│  │ Intent Detect   │    │  Greeting / chat detection
│  │ Path Guard      │    │  File path safety
│  └─────────────────┘    │
└─────────────────────────┘
        │  OpenAI Chat Completions API
        ▼
  Any OpenAI-compatible provider
  (Groq · DeepSeek · Ollama · OpenRouter · NVIDIA NIM · …)
```

---

## ✨ Features

| Feature | Description |
|---|---|
| 🔄 **Full API Translation** | Converts Anthropic Messages ↔ OpenAI Chat Completions including all tool/function schemas |
| 🧠 **Intent Detection** | Strips tools from greetings and casual chat — no accidental `Bash` calls for "hello" |
| 🛡️ **Tool Enforcement Engine** | Three-phase system that forces tool calls on models that prefer plain text |
| 📁 **File Path Guard** | Rewrites `.claude/plans/` paths to your project root automatically |
| 💉 **System Prompt Injection** | Adds optimized coding instructions without touching your prompt |
| 🗺️ **Dynamic Model Mapping** | Map any Claude model alias to any provider via environment variables |
| 🔁 **Provider Fallback** | Auto-switches to backup provider on 5xx errors |
| 📡 **Full SSE Streaming** | Complete Anthropic streaming protocol with `content_block_*` events |
| 🔃 **Hot Reload** | Send `SIGHUP` to reload `.env` — no restart needed |

---

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org) 18 or higher
- [Claude Code](https://docs.anthropic.com/claude-code) installed (CLI or VS Code extension)
- At least one API key from a [supported provider](#-supported-providers)

### 1. Clone & Install

```bash
git clone https://github.com/alikhokhar/llm-proxy-hub.git
cd llm-proxy-hub
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Open `.env` and set your API keys and model mappings:

```env
# Your provider API key
GROQ_API_KEY=your_key_here

# Map Claude model aliases to your provider
MAP_CLAUDE_SONNET_4_6=groq:llama-3.3-70b-versatile
MAP_CLAUDE_OPUS_4_6=groq:llama-3.3-70b-versatile
MAP_CLAUDE_HAIKU_4_5=groq:llama-3.1-8b-instant

# Fallback provider if primary fails
FALLBACK_PROVIDER=groq:llama-3.1-8b-instant
```

### 3. Start the Proxy

```bash
node server.js
# Server running at http://localhost:8088
```

### 4. Point Claude Code at the Proxy

**macOS / Linux:**
```bash
export ANTHROPIC_BASE_URL=http://localhost:8088
export ANTHROPIC_AUTH_TOKEN=proxy-does-not-need-this
claude
```

**Windows (PowerShell):**
```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:8088"
$env:ANTHROPIC_AUTH_TOKEN = "proxy-does-not-need-this"
claude
```

That's it. Claude Code now routes through your chosen model. 🎉

---

## 🔍 How It Works

### Message Translation

Every request Claude Code sends (Anthropic format) is converted to OpenAI format before hitting your provider, and every response is translated back.

This includes:
- Complex `content` arrays with `text` and `tool_use` blocks → `tool_calls`
- `tool_result` user messages → `role: "tool"` OpenAI messages
- All 25+ Claude Code tools → OpenAI function definitions

### Intent Detection

Before sending tools to the model, the proxy checks whether the user's message actually wants an action:

```
"hello"                    → wantsAction: false  → tools stripped
"what is a closure?"       → wantsAction: false  → tools stripped
"create a file named app"  → wantsAction: true   → tools included
"refactor this function"   → wantsAction: true   → tools included
```

This prevents models from spontaneously calling `Bash` or `Agent` for simple greetings.

### Three-Phase Tool Enforcement

For models that prefer plain text over tool calls, the proxy runs up to three enforcement phases:

| Phase | Strategy |
|---|---|
| **1 — ReAct Prompt** | Presents tool list, suggests the likely tool, requests JSON only |
| **2 — Force Tool Name** | Explicitly names the tool and provides an example response |
| **3 — Minimal Context** | Strips to last 4 messages with an absolute directive |

Each phase uses a balanced-brace JSON extractor (not regex) and maps common mis-generated names (`write_file` → `Write`, etc.) to real Claude Code tools.

---

## 🌐 Supported Providers

| Provider | Type | API Key | Free Tier |
|---|---|---|---|
| [Groq](https://groq.com) | Cloud | `GROQ_API_KEY` | ✅ Yes |
| [OpenRouter](https://openrouter.ai) | Gateway | `OPENROUTER_API_KEY` | 💰 Paid |
| [DeepSeek](https://deepseek.com) | Cloud | `DEEPSEEK_API_KEY` | 💰 Credits |
| [NVIDIA NIM](https://build.nvidia.com) | Cloud | `NVIDIA_NIM_API_KEY` | ✅ Free tier |
| [Ollama](https://ollama.ai) | Local | None | ✅ Fully local |
| [Ollama Cloud](https://ollama.com) | Cloud | `OLLAMA_API_KEY` | 💰 Paid |

Adding a new provider requires a single entry in the `PROVIDERS` object in `server.js`. See [Contributing](CONTRIBUTING.md).

---

## ⚙️ Configuration

All configuration is done through environment variables. See [`.env.example`](.env.example) for the full reference.

### Model Mapping

Map any Claude model alias to any provider using `MAP_*` variables:

```env
# Format: MAP_<CLAUDE_MODEL_ALIAS>=<provider>:<model-name>
MAP_CLAUDE_OPUS_4_6=groq:llama-3.3-70b-versatile
MAP_CLAUDE_SONNET_4_6=groq:qwen/qwen3-32b
MAP_CLAUDE_HAIKU_4_5=ollama:phi3
```

### Hot Reload

Change any value in `.env` and send `SIGHUP` to the process — no restart needed:

```bash
kill -SIGHUP $(lsof -ti:8088)
```

### Server Port

```env
PORT=8088  # default
```

---

## 📁 Project Structure

Everything runs in a **single file** — no build step, no module bundling.

```
llm-proxy-hub/
├── server.js     # The entire proxy — translation, enforcement, streaming, providers
└── package.json  # npm dependencies only
```

Inside `server.js`:

| Section | Responsibility |
|---|---|
| `PROVIDERS` | Provider registry and fallback logic |
| `translateRequest()` | Anthropic → OpenAI message conversion |
| `translateResponse()` | OpenAI → Anthropic response conversion |
| `translateTools()` | Tool/function schema translation + name mapping |
| `detectIntent()` | Greeting and action detection |
| `enforceToolCall()` | Three-phase tool enforcement engine |
| `translateStream()` | SSE streaming (OpenAI → Anthropic events) |
| `pathGuard()` | File path rewriting (`.claude/plans/` → CWD) |
| `app.post('/v1/messages')` | Main request handler |

---

## 🛠️ Examples

### "hello" → No Tool Calls

```
User: "hello"

1. Claude Code sends /v1/messages with 25+ tool definitions
2. Proxy builds OpenAI messages + enhanced system prompt
3. detectIntent() → matches greeting regex → wantsAction: false
4. effectiveTools = null → tools stripped from request
5. Model replies naturally: "Hello! How can I help you today?"
6. Claude Code shows reply — no Bash, no Agent, no loop ✓
```

### "create a file named hello.txt with hello world"

```
User: "create a file named hello.txt with hello world"

1. detectIntent() → matches ACTION_PATTERNS → wantsAction: true
2. Tools sent to model
3. Model returns Write tool call (or enforcement kicks in)
4. Proxy returns Anthropic tool_use block
5. Claude Code executes Write → file created in project root ✓
```

---

## 🔮 Roadmap

- [ ] Web dashboard for real-time monitoring and model switching
- [ ] Persistent memory via `~/.claude/projects/`
- [ ] Parallel agent spawning with tool-level concurrency
- [ ] AWS Bedrock, Azure OpenAI, and Gemini provider support
- [ ] Fine-tuned enforcement prompts per use case (data analysis, security auditing)
- [ ] Docker image for one-command deployment

---

## 🤝 Contributing

Contributions are welcome! Whether it's a new provider, a bug fix, or a feature — see [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

---

## 📜 License

MIT License — Copyright (c) 2026 ByteToMRR.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
No warranty is given. See [LICENSE](LICENSE) for full text.
If anything spfecific then contact [ thegoldencage.yt@gmail.com ]
---

<div align="center">
Built with ❤️ to make powerful AI accessible to everyone.
</div>
