import path from "node:path"
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises"

export type CodeModel = {
  providerID: string
  modelID: string
}

export function configPath(directory: string): string {
  return path.join(directory, ".opencode", "code-model.json")
}

export async function readCodeModel(directory: string): Promise<CodeModel | null> {
  try {
    const data = await readFile(configPath(directory), "utf-8")
    const parsed = JSON.parse(data)
    if (parsed && typeof parsed.providerID === "string" && typeof parsed.modelID === "string") {
      return { providerID: parsed.providerID, modelID: parsed.modelID }
    }
    return null
  } catch {
    return null
  }
}

export async function writeCodeModel(directory: string, model: CodeModel): Promise<void> {
  const filePath = configPath(directory)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(model, null, 2) + "\n", "utf-8")
}

export async function clearCodeModel(directory: string): Promise<void> {
  try {
    await unlink(configPath(directory))
  } catch {
  }
}

export function parseModelString(input: string): CodeModel | null {
  const trimmed = input.trim()
  const idx = trimmed.indexOf("/")
  if (idx === -1) return null
  return {
    providerID: trimmed.slice(0, idx),
    modelID: trimmed.slice(idx + 1),
  }
}

export function formatModel(model: CodeModel): string {
  return `${model.providerID}/${model.modelID}`
}
