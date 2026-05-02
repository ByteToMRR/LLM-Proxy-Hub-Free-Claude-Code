---
name: Bug Report
about: Something isn't working as expected
title: "[BUG] "
labels: bug
assignees: ''
---

## Describe the Bug

A clear and concise description of what the bug is.

## To Reproduce

Steps to reproduce the behavior:

1. Set `MAP_CLAUDE_SONNET_4_6` to `...`
2. Run Claude Code and type `...`
3. See error

## Expected Behavior

What you expected to happen.

## Actual Behavior

What actually happened. Include any error messages or log output.

<details>
<summary>Log Output (set LOG_LEVEL=debug in .env)</summary>

```
paste logs here
```

</details>

## Environment

- **Node.js version:** (run `node --version`)
- **Provider:** (e.g. Groq, Ollama, DeepSeek)
- **Model:** (e.g. llama-3.3-70b-versatile)
- **OS:** (e.g. Windows 11, Ubuntu 22.04, macOS 14)
- **Claude Code version:** (run `claude --version`)

## Additional Context

Any other context about the problem (e.g. it only happens with streaming, only on first message, etc.)
