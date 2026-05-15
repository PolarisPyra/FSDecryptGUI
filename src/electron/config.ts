import { app } from "electron"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"

import type { ConfigPatch, PickedFile, RendererConfig } from "./ipcTypes.js"

type StoredConfig = {
	version?: number
	inputRoot?: string
	outputRoot?: string
	keys?: {
		selectedKeyFile?: string
	}
}

const CONFIG_FILENAME = "config.yaml"

/**
 * Resolves the per-user YAML config path inside Electron's app data folder.
 *
 * @returns Absolute path to `config.yaml`.
 */
export function configPath() {
	return path.join(app.getPath("userData"), CONFIG_FILENAME)
}

/**
 * Converts a stored file path into renderer-safe picked-file metadata.
 *
 * @param filePath Path read from the config file.
 * @returns Picked file metadata, or undefined when the file is missing.
 */
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

/**
 * Reads and parses config YAML, returning an empty object on first run or errors.
 *
 * @returns Stored config values that may be incomplete.
 */
async function readStoredConfig(): Promise<StoredConfig> {
	try {
		const raw = await readFile(configPath(), "utf8")
		const parsed = YAML.parse(raw) as StoredConfig | null
		return parsed && typeof parsed === "object" ? parsed : {}
	} catch {
		return {}
	}
}

/**
 * Writes config YAML while omitting unset optional values.
 *
 * @param config Stored config state to persist.
 */
async function writeStoredConfig(config: StoredConfig) {
	const target = configPath()
	await mkdir(path.dirname(target), { recursive: true })
	await writeFile(
		target,
		YAML.stringify({
			version: 1,
			inputRoot: config.inputRoot ?? undefined,
			outputRoot: config.outputRoot ?? undefined,
			keys: {
				selectedKeyFile: config.keys?.selectedKeyFile ?? undefined
			}
		}),
		"utf8"
	)
}

/**
 * Builds the config payload consumed by the renderer.
 *
 * @returns Config plus live metadata for the selected Custom Key File.
 */
export async function readRendererConfig(): Promise<RendererConfig> {
	const stored = await readStoredConfig()
	const keyFile = stored.keys?.selectedKeyFile ? await pickedFileFromPath(stored.keys.selectedKeyFile) : undefined

	return {
		configPath: configPath(),
		inputRoot: stored.inputRoot,
		outputRoot: stored.outputRoot,
		keyFile
	}
}

/**
 * Applies a partial config patch and returns the refreshed renderer config.
 *
 * @param patch Validated config fields from IPC.
 * @returns Updated renderer config.
 */
export async function updateConfig(patch: ConfigPatch): Promise<RendererConfig> {
	const stored = await readStoredConfig()

	if ("outputRoot" in patch) {
		stored.outputRoot = patch.outputRoot ?? undefined
	}

	if ("inputRoot" in patch) {
		stored.inputRoot = patch.inputRoot ?? undefined
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
