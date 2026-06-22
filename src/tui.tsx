/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiPluginApi, TuiDialogSelectOption } from "@opencode-ai/plugin/tui"
import { readCodeModel, writeCodeModel, clearCodeModel, formatModel, type CodeModel } from "./shared.js"

type ModelValue = { providerID: string; modelID: string } | null
type ModelOption = TuiDialogSelectOption<ModelValue>

function buildOptions(api: TuiPluginApi, current: CodeModel | null): ModelOption[] {
  const options: ModelOption[] = [
    {
      title: "Inactive",
      value: null,
      description: "Main model writes code directly (no delegation)",
      category: "Status",
    },
  ]

  for (const provider of api.state.provider) {
    for (const [modelID, model] of Object.entries(provider.models)) {
      if (model.status === "deprecated") continue

      const value = { providerID: provider.id, modelID }
      const isNano = provider.id === "opencode" && modelID.includes("-nano")
      const isFree = model.cost?.input === 0 && provider.id === "opencode"
      const isCurrent = current?.providerID === provider.id && current?.modelID === modelID

      options.push({
        title: (isCurrent ? "● " : "") + (model.name ?? modelID),
        value,
        description: provider.name,
        category: provider.name,
        disabled: isNano,
        footer: isFree ? "Free" : undefined,
      })
    }
  }

  const rest = options.slice(1).sort((a, b) => {
    if (a.footer === "Free" && b.footer !== "Free") return -1
    if (a.footer !== "Free" && b.footer === "Free") return 1
    return (a.title ?? "").localeCompare(b.title ?? "")
  })

  return [options[0], ...rest]
}

function CodeModelDialog(props: { api: TuiPluginApi; current: CodeModel | null }) {
  const DialogSelect = props.api.ui.DialogSelect
  const options = buildOptions(props.api, props.current)
  const dir = props.api.state.path.directory

  return (
    <DialogSelect
      title="Select code model"
      placeholder="Search models…"
      options={options}
      flat={true}
      skipFilter={false}
      current={props.current ?? undefined}
      onSelect={(option) => {
        const model = option.value
        if (model === null) {
          void clearCodeModel(dir).then(() => {
            props.api.ui.dialog.clear()
            props.api.ui.toast({ variant: "info", message: "Code model: Inactive (main model writes code)" })
          })
        } else {
          void writeCodeModel(dir, model).then(() => {
            props.api.ui.dialog.clear()
            props.api.ui.toast({ variant: "success", message: `Code model: ${formatModel(model)}` })
          })
        }
      }}
    />
  )
}

async function showCodeModelDialog(api: TuiPluginApi) {
  const current = await readCodeModel(api.state.path.directory)
  api.ui.dialog.replace(() => <CodeModelDialog api={api} current={current} />)
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "code_model.select",
        title: "Switch code model",
        category: "Agent",
        namespace: "palette",
        slashName: "code_model",
        slashAliases: ["cm"],
        run() {
          void showCodeModelDialog(api)
        },
      },
    ],
    bindings: [],
  })
}

const plugin: TuiPluginModule = {
  id: "code-model",
  tui,
}

export default plugin
