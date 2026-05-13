import { app } from "electron"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"

export type PickedFile = {
	path: string
	name: string
	size: number
}

type StoredConfig = {
	version?: number
	outputRoot?: string
	keys?: {
		selectedKeyFile?: string
	}
}

export type RendererConfig = {
	configPath: string
	outputRoot?: string
	keyFile?: PickedFile
}

export type ConfigPatch = {
	outputRoot?: string | null
	keyFilePath?: string | null
}

const CONFIG_FILENAME = "config.yaml"

export function configPath() {
	return path.join(app.getPath("userData"), CONFIG_FILENAME)
}

export async function pickedFileFromPath(filePath: string): Promise<PickedFile | undefined> {
	try {
		const fileStat = await stat(filePath)
		if (!fileStat.isFile()) {
			return undefined
		}

		return {
			path: filePath,
			name: path.basename(filePath),
			size: fileStat.size
		}
	} catch {
		return undefined
	}
}

async function readStoredConfig(): Promise<StoredConfig> {
	try {
		const raw = await readFile(configPath(), "utf8")
		const parsed = YAML.parse(raw) as StoredConfig | null
		return parsed && typeof parsed === "object" ? parsed : {}
	} catch {
		return {}
	}
}

async function writeStoredConfig(config: StoredConfig) {
	const target = configPath()
	await mkdir(path.dirname(target), { recursive: true })
	await writeFile(
		target,
		YAML.stringify({
			version: 1,
			outputRoot: config.outputRoot ?? undefined,
			keys: {
				selectedKeyFile: config.keys?.selectedKeyFile ?? undefined
			}
		}),
		"utf8"
	)
}

export async function readRendererConfig(): Promise<RendererConfig> {
	const stored = await readStoredConfig()
	const keyFile = stored.keys?.selectedKeyFile ? await pickedFileFromPath(stored.keys.selectedKeyFile) : undefined

	return {
		configPath: configPath(),
		outputRoot: stored.outputRoot,
		keyFile
	}
}

export async function updateConfig(patch: ConfigPatch): Promise<RendererConfig> {
	const stored = await readStoredConfig()

	if ("outputRoot" in patch) {
		stored.outputRoot = patch.outputRoot ?? undefined
	}

	if ("keyFilePath" in patch) {
		stored.keys = {
			...stored.keys,
			selectedKeyFile: patch.keyFilePath ?? undefined
		}
	}

	await writeStoredConfig(stored)
	return readRendererConfig()
}
