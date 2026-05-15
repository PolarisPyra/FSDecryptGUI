import type { FileFilter } from "electron"

export type PickFileOptions = {
	title: string
	filters?: FileFilter[]
	multiple?: boolean
}

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

export type WriteFileRequest = {
	rootPath: string
	segments: string[]
	chunk: ArrayBuffer | Uint8Array
	append: boolean
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

export type OutputFolderRequest = {
	rootPath: string
	segments: string[]
}

export type SaveTextRequest = {
	defaultName: string
	content: string
}

export type SaveBinaryRequest = {
	defaultName: string
	content: ArrayBuffer | Uint8Array
}

export type NotifyRequest = {
	title: string
	body: string
}
