import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readCodeModel, parseModelString, formatModel, type CodeModel } from "./shared.js"

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
          "## Code Delegation Active",
          "",
          `A code model (${formatModel(codeModel)}) is configured to handle code implementation.`,
          "When you need to WRITE, EDIT, CREATE, or FIX code, you MUST use the delegate_code tool.",
          "Do NOT use write, edit, multi_edit, or str_replace tools directly.",
          "",
          "Process for code tasks:",
          "1. Read relevant files and analyze the codebase.",
          "2. Call delegate_code with a detailed task description (file paths, signatures, behavior).",
          "3. Review the returned result — read modified files to verify correctness.",
          "4. Run tests if applicable. If fixes are needed, call delegate_code again.",
          "",
          "You CAN still directly: read files, search code (grep/glob), run shell commands, and review work.",
        ].join("\n"),
      )
    },

    tool: {
      delegate_code: tool({
        description: [
          "Delegate a code-writing task to a separate code model for implementation.",
          "The code model has full project access (file editing, shell, search) and will implement the task.",
          "Requires a code model to be configured via /code_model, or pass model='provider/modelID'.",
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
