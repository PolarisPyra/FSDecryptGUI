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
	decryptFscryptRange: (request: DecryptFscryptRangeRequest) => Promise<ArrayBuffer>
	ensureDirectory: (rootPath: string, segments: string[]) => Promise<void>
	prepareOutputFolder: (rootPath: string, segments: string[]) => Promise<void>
	openOutputFolder: (rootPath: string, segments: string[]) => Promise<void>
	writeFileChunk: (rootPath: string, segments: string[], chunk: Uint8Array, append: boolean) => Promise<void>
	closeOutputFile: (rootPath: string, segments: string[]) => Promise<void>
	removeOutputPath: (rootPath: string, segments: string[]) => Promise<void>
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

export type DecryptFscryptRangeRequest = {
	filePath: string
	dataOffset: number
	outputSize: number
	keyHex: string
	ivHex: string
	offset: number
	length: number
	pageSize: number
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
		read: async (offset, length) => new Uint8Array(await window.fsdecryptGUI.readRange(file.path, offset, length)),
		decryptFscryptRange: async request =>
			new Uint8Array(await window.fsdecryptGUI.decryptFscryptRange({ ...request, filePath: file.path }))
	}
}
