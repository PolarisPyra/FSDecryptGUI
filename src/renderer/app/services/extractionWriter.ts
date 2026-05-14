import type { ReadableByteSource } from "../../../fsdecrypt/byte-source"
import type { NtfsExtractionWriter } from "../../../fsdecrypt/ntfs"
import type { VhdNtfsSource } from "../../../fsdecrypt/vhd"
import { throwIfAborted } from "../../base/common/cancellation"
import { formatBytes } from "../../base/common/format"
import { outputSegmentsForFolder, sanitizePathSegment } from "../../base/common/path"

const WRITE_CHUNK_SIZE = 1 * 1024 * 1024

export function vhdDetails(result: VhdNtfsSource) {
	return [
		{ label: "Layers", value: result.chain.length.toString() },
		{ label: "Parent", value: result.chain[0] ?? "" },
		{ label: "Child", value: result.chain[result.chain.length - 1] ?? "" },
		{ label: "NTFS Offset", value: formatBytes(result.ntfsOffset) }
	]
}

export function createFolderWriter(
	rootPath: string,
	folderName: string,
	getTotalBytes: () => number,
	setProgress: (progress: number) => void,
	signal: AbortSignal,
	onBytesWritten: (bytes: number) => void
): NtfsExtractionWriter {
	let written = 0
	let lastProgressUpdate = 0
	const outputFolder = sanitizePathSegment(folderName)
	const outputRoot = outputSegmentsForFolder(rootPath, outputFolder)
	const writePath = (path: string[]) => [...outputRoot, ...path.map(sanitizePathSegment)]

	const writeFile = async (path: string[], source: ReadableByteSource) => {
		const target = writePath(path)
		let wroteChunk = false

		try {
			for (let offset = 0; offset < source.size; offset += WRITE_CHUNK_SIZE) {
				throwIfAborted(signal)
				const chunk = await source.read(offset, Math.min(WRITE_CHUNK_SIZE, source.size - offset))
				throwIfAborted(signal)

				if (chunk.length === 0) {
					break
				}

				await window.fsdecryptGUI.writeFileChunk(rootPath, target, chunk, wroteChunk)
				wroteChunk = true
				written += chunk.length
				onBytesWritten(chunk.length)

				const now = performance.now()
				if (now - lastProgressUpdate > 100 || offset + chunk.length >= source.size) {
					lastProgressUpdate = now
					setProgress(Math.min(99, Math.floor((written / Math.max(getTotalBytes(), 1)) * 100)))
				}
				await new Promise<void>(resolve => window.setTimeout(resolve, 0))
			}

			if (!wroteChunk) {
				throwIfAborted(signal)
				await window.fsdecryptGUI.writeFileChunk(rootPath, target, new Uint8Array(), false)
			}
		} finally {
			await window.fsdecryptGUI.closeOutputFile(rootPath, target)
		}
	}

	return {
		createDirectory: path => {
			throwIfAborted(signal)
			return window.fsdecryptGUI.ensureDirectory(rootPath, writePath(path))
		},
		writeFile
	}
}
