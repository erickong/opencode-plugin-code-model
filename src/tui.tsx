/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiPluginApi, TuiDialogSelectOption } from "@opencode-ai/plugin/tui"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { readCodeModel, writeCodeModel, clearCodeModel, formatModel, type CodeModel } from "./shared.js"

type ModelValue = { providerID: string; modelID: string } | null
type ModelOption = TuiDialogSelectOption<ModelValue>
const SPINNER = ["|", "/", "-", "\\"]

function formatElapsed(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const two = (n: number) => n.toString().padStart(2, "0")
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`
}

function activityBar(tick: number): string {
  const width = 12
  const pos = tick % width
  let out = ""
  for (let i = 0; i < width; i++) out += i === pos ? ">" : "-"
  return `[${out}]`
}

function percentFromTitle(title: string): string {
  const match = title.match(/\b(\d+)\/(\d+)\b/)
  if (!match) return ""
  const done = Number(match[1])
  const total = Number(match[2])
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return ""
  return ` ${Math.min(100, Math.max(0, Math.round((done / total) * 100)))}%`
}

function useActivity(active: () => boolean) {
  const [tick, setTick] = createSignal(0)
  const [startAt, setStartAt] = createSignal<number | undefined>()
  let timer: ReturnType<typeof setInterval> | undefined

  createEffect(() => {
    if (active()) {
      if (!startAt()) setStartAt(Date.now())
      if (!timer) timer = setInterval(() => setTick((n) => n + 1), 1000)
      return
    }

    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
    setStartAt(undefined)
    setTick(0)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  return {
    tick,
    elapsed() {
      const started = startAt()
      return started ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0
    },
  }
}

function activeDelegationTitle(api: TuiPluginApi, sessionID: string): string {
  const messages = api.state.session.messages(sessionID)

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const parts = api.state.part(messages[messageIndex].id)
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex]
      if (part.type !== "tool" || part.tool !== "delegate_code") continue
      if (part.state.status !== "running") continue
      return part.state.title?.trim() || "Delegating code…"
    }
  }

  return ""
}

function compactProgress(title: string): string {
  const todo = title.match(/\b\d+\/\d+\b/)?.[0]
  const bytes = title.match(/\b\d+(?:\.\d+)?\s(?:B|KB|MB)\b/)?.[0]
  const tools = title.match(/\b\d+ tools\b/)?.[0]
  const parts = [todo, bytes, tools].filter(Boolean)

  if (parts.length > 0) return parts.join(" ")
  if (title.includes("streaming")) return "streaming"
  if (title.includes("waiting for output")) return "waiting"
  return "working"
}

function CodeProgress(props: { api: TuiPluginApi; sessionID: string }) {
  const title = () => activeDelegationTitle(props.api, props.sessionID)
  const activity = useActivity(() => Boolean(title()))
  const theme = () => props.api.theme.current

  return (
    <text flexShrink={0} fg={theme().accent}>
      {title()
        ? `${SPINNER[activity.tick() % SPINNER.length]} ${formatElapsed(activity.elapsed())} ${compactProgress(title())}`
        : ""}
    </text>
  )
}

function currentSessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current
  if (route.name !== "session") return
  const sessionID = route.params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function AppProgress(props: { api: TuiPluginApi }) {
  const sessionID = () => currentSessionID(props.api)
  const title = () => {
    const id = sessionID()
    return id ? activeDelegationTitle(props.api, id) : ""
  }
  const activity = useActivity(() => Boolean(title()))
  const theme = () => props.api.theme.current
  const progress = () => {
    const tick = activity.tick()
    const current = title()
    return `${SPINNER[tick % SPINNER.length]} ${activityBar(tick)}${percentFromTitle(current)} ${formatElapsed(activity.elapsed())} · ${current}`
  }

  return (
    <box width="100%" flexShrink={0} paddingLeft={2} paddingRight={2}>
      {title() ? (
        <text fg={theme().accent} wrapMode="word">
          {progress()}
        </text>
      ) : null}
    </box>
  )
}

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
  api.slots.register({
    order: 50,
    slots: {
      app_bottom() {
        return <AppProgress api={api} />
      },
      session_prompt_right(_ctx, props) {
        return <CodeProgress api={api} sessionID={props.session_id} />
      },
    },
  })

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
