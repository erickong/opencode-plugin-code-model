# opencode-plugin-code-model

Delegate code-writing tasks to a separate, cost-effective model in [opencode](https://opencode.ai).

Use an expensive model for thinking/planning/reviewing, and a cheaper model for the actual code implementation.

## How it works

1. **`/code_model`** — a TUI slash command (identical options to `/models`) that selects which model handles code writing.
2. **`delegate_code`** — a tool the main model calls to delegate implementation tasks to the selected code model.

The main (expensive) model thinks, plans, and reviews. When code needs to be written, it calls `delegate_code` with a detailed task description. The code model executes the task (with full file/shell access), and the main model reviews the result.

## Install

### Via TUI plugin manager

```
opencode plugin opencode-plugin-code-model
```

Or use the in-TUI plugin manager (`/plugins` → Install).

### Manual (local file)

Copy this directory into your project's `.opencode/plugins/` folder, then add to `opencode.json`:

```json
{
  "plugin": ["./.opencode/plugins/opencode-plugin-code-model"]
}
```

And add to `.opencode/tui.json`:

```json
{
  "plugin": ["./.opencode/plugins/opencode-plugin-code-model"]
}
```

## Usage

### 1. Select a code model

Run `/code_model` (alias `/cm`) in the TUI and pick a model — the same list as `/models`.

The selection is stored in `.opencode/code-model.json` in your project directory.

### 2. The main model delegates substantive code writing

When the main model needs non-trivial code implementation, it calls the `delegate_code` tool with:

| Parameter  | Type   | Required | Description |
|------------|--------|----------|-------------|
| `task`     | string | Yes      | Detailed coding task: file paths, signatures, behavior, constraints |
| `context`  | string | No       | Additional context: code snippets, patterns, architecture notes |
| `model`    | string | No       | Override model for this task: `"providerID/modelID"` |

The main model can still make tiny, obvious edits directly. As a rule of thumb, changes around 1 KB of final diff or less, touching one obvious file with low risk, should usually be done directly instead of delegated. Larger, multi-file, risky, exploratory, or test-heavy changes should be delegated.

The code model runs in a sub-session with full project access (file editing, shell, etc.). After completion, the main model receives a summary and reviews the changes.

While delegation is running, the TUI shows an animated activity bar, elapsed time, streamed output bytes, and current code-model progress in the bottom status area. For non-trivial tasks this includes todo completion (for example `2/4`) and the active step; otherwise it shows the latest tool activity.

### Example workflow

```
You: Implement a /health endpoint that returns {"status": "ok"}

Main model (Claude Opus): [thinks about the architecture, decides on the approach]
  → calls delegate_code with task: "Add GET /health endpoint returning {"status":"ok"}.
     Follow existing route patterns in src/routes/. Register in src/app.ts."

Code model (Claude Haiku): [reads files, writes code, returns summary]

Main model: [reviews changes, runs tests, confirms everything works]
  "Done. The /health endpoint is live at GET /health."
```

## Configuration

The code model selection persists in `<project>/.opencode/code-model.json`:

```json
{
  "providerID": "anthropic",
  "modelID": "claude-haiku-4-5"
}
```

You can also override the model per-task by passing the `model` parameter to `delegate_code`.

## Package structure

```
src/
├── shared.ts   — state management (code-model.json read/write)
├── server.ts   — server plugin (provides the delegate_code tool)
└── tui.tsx     — TUI plugin (provides the /code_model command)
```

The `package.json` exports two entry points:
- `./server` — loaded by the opencode server
- `./tui` — loaded by the TUI

## License

MIT
