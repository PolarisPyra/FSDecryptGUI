import type { ReadableByteSource } from "../fsdecrypt/byte-source"

export type PickedFile = {
	path: string
	name: string
	size: number
}

export type ScannedInputFolder = {
	rootPath: string
	files: {
		apps: PickedFile[]
		options: PickedFile[]
		vhds: PickedFile[]
	}
}

export type ElectronApi = {
	pickFiles: (options: {
		title: string
		filters?: Array<{ name: string; extensions: string[] }>
		multiple?: boolean
	}) => Promise<PickedFile[]>
	selectInputFolder: () => Promise<ScannedInputFolder | undefined>
	selectOutputFolder: () => Promise<string | undefined>
	readConfig: () => Promise<RendererConfig>
	updateConfig: (patch: ConfigPatch) => Promise<RendererConfig>
	openConfigFolder: () => Promise<void>
	copyText: (text: string) => Promise<void>
	saveText: (request: SaveTextRequest) => Promise<string | undefined>
	notify: (request: NotifyRequest) => Promise<void>
	onConfigChanged: (callback: (config: RendererConfig) => void) => () => void
	onInputFolderScanned: (callback: (scan: ScannedInputFolder) => void) => () => void
	scanInputFolder: (rootPath: string) => Promise<ScannedInputFolder>
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
	inputRoot?: string
	outputRoot?: string
	keyFile?: PickedFile
}

export type ConfigPatch = {
	inputRoot?: string | null
	outputRoot?: string | null
	keyFilePath?: string | null
}

export type SaveTextRequest = {
	defaultName: string
	content: string
}

export type NotifyRequest = {
	title: string
	body: string
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
