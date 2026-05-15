import type { ReadableByteSource } from "../fsdecrypt/byte-source"
import type {
	ConfigPatch,
	DecryptFscryptRangeRequest,
	NotifyRequest,
	PickedFile,
	RendererConfig,
	SaveBinaryRequest,
	SaveTextRequest,
	ScannedInputFolder
} from "../electron/ipcTypes"

export type { ConfigPatch, DecryptFscryptRangeRequest, NotifyRequest, PickedFile, RendererConfig, SaveBinaryRequest, SaveTextRequest, ScannedInputFolder }

/**
 * Renderer-facing preload surface. Every function maps to a named IPC handler
 * instead of exposing raw `ipcRenderer` to the React app.
 */
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
	saveBinary: (request: SaveBinaryRequest) => Promise<string | undefined>
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

declare global {
	interface Window {
		fsdecryptGUI: ElectronApi
	}
}

/**
 * Adapts picked-file metadata into the byte-source interface used by fsdecrypt.
 *
 * @param file Renderer-safe file metadata returned by Electron dialogs/scans.
 * @returns Byte source whose reads are delegated to validated Electron IPC.
 */
export function byteSourceFromPickedFile(file: PickedFile): ReadableByteSource {
	return {
		name: file.name,
		size: file.size,
		read: async (offset, length) => new Uint8Array(await window.fsdecryptGUI.readRange(file.path, offset, length)),
		decryptFscryptRange: async request =>
			new Uint8Array(await window.fsdecryptGUI.decryptFscryptRange({ ...request, filePath: file.path }))
	}
}
