import { ReadableByteSource } from "../fsdecrypt/byte-source"

export type PickedFile = {
	path: string
	name: string
	size: number
}

export type ElectronApi = {
	pickFiles: (options: {
		title: string
		filters?: Array<{ name: string; extensions: string[] }>
		multiple?: boolean
	}) => Promise<PickedFile[]>
	readConfig: () => Promise<RendererConfig>
	updateConfig: (patch: ConfigPatch) => Promise<RendererConfig>
	openConfigFolder: () => Promise<void>
	onConfigChanged: (callback: (config: RendererConfig) => void) => () => void
	readRange: (filePath: string, offset: number, length: number) => Promise<ArrayBuffer>
	ensureDirectory: (rootPath: string, segments: string[]) => Promise<void>
	writeFileChunk: (rootPath: string, segments: string[], chunk: Uint8Array, append: boolean) => Promise<void>
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

declare global {
	interface Window {
		fsdecryptGUI: ElectronApi
	}
}

export function byteSourceFromPickedFile(file: PickedFile): ReadableByteSource {
	return {
		name: file.name,
		size: file.size,
		read: async (offset, length) => new Uint8Array(await window.fsdecryptGUI.readRange(file.path, offset, length))
	}
}
