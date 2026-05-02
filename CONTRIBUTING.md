# Contributing to LLM Proxy Hub

Thank you for taking the time to contribute! Every bug report, feature idea, and pull request makes this project better for everyone.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Ways to Contribute](#ways-to-contribute)
- [Local Development Setup](#local-development-setup)
- [Adding a New Provider](#adding-a-new-provider)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)

---

## Code of Conduct

Be respectful and constructive. We're all here to build something useful together.

---

## Ways to Contribute

- 🐛 **Report a bug** — open an [issue](../../issues/new?template=bug_report.md)
- 💡 **Suggest a feature** — open an [issue](../../issues/new?template=feature_request.md)
- 🌐 **Add a new provider** — follow the guide below
- 📖 **Improve documentation** — fix typos, add examples, clarify confusing sections
- 🔧 **Fix a bug** — pick an open issue and submit a PR

---

## Local Development Setup

```bash
# 1. Fork and clone the repo
git clone https://github.com/<your-username>/llm-proxy-hub.git
cd llm-proxy-hub

# 2. Install dependencies
npm install

# 3. Copy and configure environment
cp .env.example .env
# Edit .env with your API key(s)

# 4. Start the proxy
node server.js
```

To test, set `ANTHROPIC_BASE_URL=http://localhost:8088` and run Claude Code.

---

## Adding a New Provider

Adding a provider is a single change inside `server.js`.

Each provider entry must be added to the `PROVIDERS` object inside `server.js`:

```js
{
  name: 'my-provider',          // used in MAP_* env values, e.g. my-provider:model-name
  baseURL: 'https://api...',    // OpenAI-compatible completions endpoint base
  authHeader: (apiKey) => ({    // returns the Authorization header object
    Authorization: `Bearer ${apiKey}`
  }),
  envKey: 'MY_PROVIDER_API_KEY' // environment variable holding the API key
}
```

Please include:
- A working test with a free/publicly accessible model from that provider
- An entry in the **Supported Providers** table in `README.md`
- The new env key added to `.env.example` with a comment linking to the provider's API docs

---

## Pull Request Guidelines

1. **One PR per change.** Don't bundle unrelated fixes.
2. **Describe what and why** in the PR description — not just what the diff shows.
3. **Update docs** if your change affects setup, configuration, or behavior.
4. **Keep it focused.** Large refactors need discussion in an issue first.
5. **Test your change.** Make sure Claude Code works end-to-end with the proxy after your change.

### Branch Naming

```
feat/add-bedrock-provider
fix/tool-enforcement-phase2
docs/update-quickstart
```

---

## Reporting Bugs

Use the [Bug Report template](../../issues/new?template=bug_report.md). Please include:

- Node.js version (`node --version`)
- Provider and model being used
- The Claude Code command or action that triggered the issue
- Relevant log output (set `LOG_LEVEL=debug` in `.env`)

---

## Suggesting Features

Use the [Feature Request template](../../issues/new?template=feature_request.md). Please include:

- The problem you're trying to solve
- Your proposed solution (if you have one)
- Alternatives you've considered

---

Thanks for contributing! 🙌
