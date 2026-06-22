import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readCodeModel, parseModelString, formatModel, type CodeModel } from "./shared.js"

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…"
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function trackProgress(
  client: any,
  sessionID: string,
  directory: string,
  signal: AbortSignal,
  modelLabel: string,
  ctx: { metadata: (opts: { title: string }) => void },
): Promise<void> {
  let pendingTitleTimer: ReturnType<typeof setTimeout> | undefined

  try {
    const sub = await client.event.subscribe({ query: { directory }, signal })

    let todos: any[] = []
    const tools = new Set<string>()
    const partByteOffsets = new Map<string, number>()
    let currentTool = ""
    let lastSnippet = ""
    let streamedBytes = 0
    let streamChunks = 0
    let lastTitleAt = 0

    const noteStream = (delta: unknown): boolean => {
      if (typeof delta !== "string" || delta.length === 0) return false
      streamedBytes += byteLength(delta)
      streamChunks++
      lastSnippet = delta.replace(/\s+/g, " ").trim()
      emitTitle()
      return true
    }

    const notePartGrowth = (part: any) => {
      if (!part || typeof part.id !== "string") return

      let text = ""
      if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
        text = part.text
      } else if (part.type === "tool" && typeof part.state?.raw === "string") {
        text = part.state.raw
      }
      if (!text) return

      const currentBytes = byteLength(text)
      const previousBytes = partByteOffsets.get(part.id) ?? 0
      if (currentBytes > previousBytes) {
        streamedBytes += currentBytes - previousBytes
        streamChunks++
        partByteOffsets.set(part.id, currentBytes)
      }
    }

    const emitTitle = (force = false) => {
      const now = Date.now()
      const wait = 250 - (now - lastTitleAt)
      if (!force && wait > 0) {
        if (!pendingTitleTimer) {
          pendingTitleTimer = setTimeout(() => {
            pendingTitleTimer = undefined
            emitTitle(true)
          }, wait)
        }
        return
      }

      if (pendingTitleTimer) {
        clearTimeout(pendingTitleTimer)
        pendingTitleTimer = undefined
      }
      lastTitleAt = now

      const completed = todos.filter((t: any) => t.status === "completed").length
      const current = todos.find((t: any) => t.status === "in_progress")
      let title = `Delegating to ${modelLabel}…`
      if (todos.length > 0) {
        title += ` ${completed}/${todos.length}`
        if (streamedBytes > 0) title += ` · ${formatBytes(streamedBytes)} streamed`
        if (current) title += ` · ${clip(current.content, 50)}`
      } else {
        if (tools.size > 0) title += ` ${tools.size} tools`
        if (streamedBytes > 0) title += ` · ${formatBytes(streamedBytes)} streamed`
        else if (streamChunks > 0) title += ` · streaming`
        if (currentTool) title += ` · ${clip(currentTool, 50)}`
        else if (lastSnippet) title += ` · ${clip(lastSnippet, 40)}`
      }
      ctx.metadata({ title })
    }

    for await (const event of sub.stream) {
      if (signal.aborted) break

      const props = (event as any).properties ?? {}
      const sid = props.sessionID ?? props.part?.sessionID
      if (sid !== sessionID) continue

      if (event.type === "todo.updated") {
        todos = props.todos ?? []
        emitTitle(true)
      } else if (event.type === "message.part.updated") {
        if (!noteStream(props.delta)) notePartGrowth(props.part)

        if (props.part?.type === "tool") {
          const toolID = props.part.callID ?? props.part.id
          if (toolID) tools.add(toolID)
          const toolTitle = props.part.state?.title
          currentTool = toolTitle ? `${props.part.tool}: ${toolTitle}` : props.part.tool
          emitTitle()
        }
        if (props.part?.type === "text" || props.part?.type === "reasoning") {
          lastSnippet = (props.delta ?? props.part?.text ?? "").replace(/\s+/g, " ").trim()
          emitTitle()
        }
      } else if (event.type === "message.part.delta") {
        noteStream(props.delta)
      } else if (
        event.type === "session.next.text.delta" ||
        event.type === "session.next.reasoning.delta" ||
        event.type === "session.next.tool.input.delta"
      ) {
        noteStream(props.delta)
      } else if (event.type === "session.next.tool.called") {
        const callID = props.callID
        if (callID) tools.add(callID)
        currentTool = typeof props.tool === "string" ? props.tool : "tool"
        emitTitle()
      } else if (event.type === "session.next.tool.progress") {
        const callID = props.callID
        if (callID) tools.add(callID)
        const text = Array.isArray(props.content)
          ? props.content
              .map((item: any) => (typeof item?.text === "string" ? item.text : ""))
              .filter(Boolean)
              .join(" ")
          : ""
        currentTool = text ? `tool: ${text}` : "tool progress"
        emitTitle()
      } else if (event.type === "session.idle") {
        break
      }
    }
  } catch (error) {
    if (!signal.aborted) console.warn("[code-model] Progress stream stopped", error)
  } finally {
    if (pendingTitleTimer) clearTimeout(pendingTitleTimer)
  }
}

const server: Plugin = async (input) => {
  const directory = input.directory
  const subSessions = new Set<string>()

  return {
    "experimental.chat.system.transform": async (data, output) => {
      if (data.sessionID && subSessions.has(data.sessionID)) return

      const codeModel = await readCodeModel(directory)
      if (!codeModel) return

      output.system.push(
        [
          "## Code Delegation Available",
          "",
          `A code model (${formatModel(codeModel)}) is configured to handle code implementation.`,
          "Use the delegate_code tool for substantive, risky, or time-consuming implementation work.",
          "For tiny, obvious edits, write code directly with the normal edit tools instead of delegating.",
          "",
          "Delegate when one or more apply:",
          "- The expected diff is larger than about 1 KB, touches multiple files, or needs broad codebase exploration.",
          "- The task involves architecture, API contracts, migrations, tests, generated assets, or non-obvious edge cases.",
          "- You are uncertain about the right implementation and would benefit from a separate coding pass.",
          "",
          "Do NOT delegate when all apply:",
          "- The change is a small/local edit, roughly 1 KB of final diff or less.",
          "- It touches one obvious file or a very small number of nearby lines.",
          "- The behavior is clear and low-risk, such as renaming text, fixing a typo, adjusting a constant, or adding a tiny guard.",
          "",
          "Process for delegated code tasks:",
          "1. Read relevant files and analyze the codebase.",
          "2. Call delegate_code with a detailed task description (file paths, signatures, behavior).",
          "3. Review the returned result - read modified files to verify correctness.",
          "4. Run tests if applicable. If fixes are needed, call delegate_code again.",
          "5. For complex tasks, include a concise step breakdown in the `task` so the code model has clear direction.",
          "",
          "You can always directly read files, search code, run shell commands, review work, and make small edits.",
        ].join("\n"),
      )
    },

    tool: {
      delegate_code: tool({
        description: [
          "Delegate a substantive code-writing task to a separate code model for implementation.",
          "The code model has full project access (file editing, shell, search) and will implement the task.",
          "Requires a code model to be configured via /code_model, or pass model='provider/modelID'.",
          "Do not use this for tiny, obvious edits that are faster to make directly.",
          "",
          "Provide a detailed 'task' with:",
          "- Exact file paths to create or modify",
          "- Function/class/interface signatures",
          "- Expected behavior and edge cases",
          "- Conventions or patterns to follow",
          "- Your plan or reasoning (so the code model understands the goal)",
          "",
          "List relevant files in 'files' so the code model reads them first.",
          "After delegation: review changes, verify correctness, run tests.",
        ].join("\n"),
        args: {
          task: tool.schema
            .string()
            .describe(
              "Detailed coding task. Include file paths, signatures, behavior, constraints, and your implementation plan.",
            ),
          files: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe(
              "Relevant file paths the code model should read before implementing. Include any files that contain patterns to follow or interfaces to implement.",
            ),
          context: tool.schema
            .string()
            .optional()
            .describe(
              "Additional context: code snippets, existing patterns, architecture notes, or TODO items.",
            ),
          model: tool.schema
            .string()
            .optional()
            .describe(
              'Override code model for this task: "providerID/modelID". If omitted, uses /code_model selection.',
            ),
        },
        async execute(args, ctx) {
          const codeModel: CodeModel | null = args.model
            ? parseModelString(args.model)
            : await readCodeModel(ctx.directory)

          if (!codeModel) {
            return {
              title: "Code model inactive",
              output: [
                "No code model is configured (Inactive).",
                "Either:",
                "  1. Use /code_model to select a model, or",
                '  2. Pass model="providerID/modelID" in this call.',
                "",
                "When inactive, write code directly using the standard write/edit tools.",
              ].join("\n"),
            }
          }

          const sections: string[] = [
            "You are a code implementation assistant working in an opencode session.",
            "Implement the following task precisely. You have full project access.",
            "",
            "## Task",
            args.task,
          ]

          if (args.files && args.files.length > 0) {
            sections.push("", "## Relevant Files (read these first)", args.files.map((f) => `- ${f}`).join("\n"))
          }

          if (args.context) {
            sections.push("", "## Additional Context", args.context)
          }

          sections.push(
            "",
            "## Instructions",
            "1. Read the relevant files listed above and any AGENTS.md for conventions.",
            "2. Explore the codebase to understand existing patterns before writing code.",
            "3. Implement the task — create, edit, or fix files as needed.",
            "4. Follow the codebase's existing style strictly.",
            "5. After implementing, provide a summary of every file changed and what was done.",
          "6. For NON-TRIVIAL tasks, start by creating a todo list with the `todowrite` tool (break the work into concrete ordered steps), and keep it updated as you progress (mark each step completed, set the next in_progress). Skip the todo list for trivial one-step tasks — it's optional.",
          "7. Your todo updates and tool calls stream live progress back to the caller, so keep working steadily.",
          )

          ctx.metadata({
            title: `Delegating to ${formatModel(codeModel)}…`,
            metadata: { codeModel },
          })

          const createResult = await input.client.session.create({
            body: { title: `Code: ${args.task.slice(0, 60)}` },
            query: { directory: ctx.directory },
          })

          if (createResult.error) {
            return {
              title: "Session creation failed",
              output: `Failed to create sub-session: ${JSON.stringify(createResult.error)}`,
            }
          }

          const subSessionID = createResult.data.id
          subSessions.add(subSessionID)

          const stopProgress = new AbortController()
          const onParentAbort = () => stopProgress.abort()
          ctx.abort.addEventListener("abort", onParentAbort)
          const progress = trackProgress(
            input.client, subSessionID, ctx.directory, stopProgress.signal, formatModel(codeModel), ctx,
          )

          const onAbort = () => {
            void input.client.session.abort({
              path: { id: subSessionID },
              query: { directory: ctx.directory },
            })
          }
          ctx.abort.addEventListener("abort", onAbort)

          try {
            const result = await input.client.session.prompt({
              path: { id: subSessionID },
              query: { directory: ctx.directory },
              body: {
                model: { providerID: codeModel.providerID, modelID: codeModel.modelID },
                parts: [{ type: "text" as const, text: sections.join("\n") }],
              },
            })

            if (result.error) {
              return {
                title: "Code model error",
                output: `Error: ${JSON.stringify(result.error)}`,
              }
            }

            const data = result.data
            if (data?.info?.error) {
              return {
                title: "Code model error",
                output: `Failed: ${JSON.stringify(data.info.error)}`,
              }
            }

            const textParts = (data?.parts ?? [])
              .filter((p) => p.type === "text")
              .map((p) => (p as { text: string }).text)
              .join("\n")

            const toolParts = (data?.parts ?? []).filter((p) => p.type === "tool") as Array<{
              tool: string
              state: { title: string }
            }>

            const toolSummary =
              toolParts.length > 0
                ? toolParts.map((t) => `  - ${t.tool}: ${t.state?.title ?? ""}`).join("\n")
                : "  (no tools used)"

            const tokens = data?.info?.tokens
            const cost = data?.info?.cost

            const summary = [
              `Model: ${formatModel(codeModel)}`,
              `Tools used (${toolParts.length}):`,
              toolSummary,
              "",
              textParts || "(no text output)",
              "",
              tokens ? `Tokens: ${tokens.input} in / ${tokens.output} out` : "",
              cost != null ? `Cost: $${(cost / 1_000_000).toFixed(4)}` : "",
            ]
              .filter(Boolean)
              .join("\n")

            return {
              title: `Done (${formatModel(codeModel)})`,
              output: summary,
              metadata: {
                subSessionID,
                model: codeModel,
                toolsUsed: toolParts.map((t) => t.tool),
                tokens,
                cost,
              },
            }
          } finally {
            ctx.abort.removeEventListener("abort", onAbort)
            ctx.abort.removeEventListener("abort", onParentAbort)
            stopProgress.abort()
            void progress.catch(() => {})
          }
        },
      }),
    },
  }
}

const plugin: PluginModule = {
  id: "code-model",
  server,
}

export default plugin
