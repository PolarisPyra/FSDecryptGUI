import type { ReadableByteSource } from "../../../fsdecrypt/byte-source"
import type { NtfsExtractionWriter } from "../../../fsdecrypt/ntfs"
import type { VhdNtfsSource } from "../../../fsdecrypt/vhd"
import { throwIfAborted } from "../../base/common/cancellation"
import { formatBytes } from "../../base/common/format"
import { outputSegmentsForFolder, sanitizePathSegment } from "../../base/common/path"

const WRITE_CHUNK_SIZE = 1 * 1024 * 1024

export type OutputFolderPlan = {
	rootPath: string
	folderName: string
	outputSegments: string[]
	fileSegments: (path: string[]) => string[]
}

export function vhdDetails(result: VhdNtfsSource) {
	return [
		{ label: "Layers", value: result.chain.length.toString() },
		{ label: "Parent", value: result.chain[0] ?? "" },
		{ label: "Child", value: result.chain[result.chain.length - 1] ?? "" },
		{ label: "NTFS Offset", value: formatBytes(result.ntfsOffset) }
	]
}

/**
 * Creates the per-job Output Folder description shared by result metadata and file writes.
 * `rootPath` is the user-selected Output Folder. `outputSegments` is either empty when
 * the selected folder is already the job folder, or `[folderName]` when the job needs a
 * child folder. Every extracted file path is appended after those segments.
 */
export function createOutputFolderPlan(rootPath: string, folderName: string): OutputFolderPlan {
	const safeFolderName = sanitizePathSegment(folderName)
	const outputSegments = outputSegmentsForFolder(rootPath, safeFolderName)

	return {
		rootPath,
		folderName: safeFolderName,
		outputSegments,
		fileSegments: path => [...outputSegments, ...path.map(sanitizePathSegment)]
	}
}

// Preparing is intentionally per-job, not per-file: it is where the user chooses
// Replace/Merge/Cancel before any extracted file chunks are written.
export function prepareOutputFolder(plan: OutputFolderPlan) {
	if (plan.outputSegments.length === 0) {
		return Promise.resolve()
	}

	return window.fsdecryptGUI.prepareOutputFolder(plan.rootPath, plan.outputSegments)
}

export function createFolderWriter(
	plan: OutputFolderPlan,
	getTotalBytes: () => number,
	setProgress: (progress: number) => void,
	signal: AbortSignal,
	onBytesWritten: (bytes: number) => void
): NtfsExtractionWriter {
	let written = 0
	let lastProgressUpdate = 0

	// The filesystem extractors speak in relative path arrays. The writer is the only
	// renderer module that turns those arrays into IPC-ready Output Folder segments.
	const writeFile = async (path: string[], source: ReadableByteSource) => {
		const target = plan.fileSegments(path)
		let wroteChunk = false

		try {
			for (let offset = 0; offset < source.size; offset += WRITE_CHUNK_SIZE) {
				throwIfAborted(signal)
				const chunk = await source.read(offset, Math.min(WRITE_CHUNK_SIZE, source.size - offset))
				throwIfAborted(signal)

				if (chunk.length === 0) {
					break
				}

				await window.fsdecryptGUI.writeFileChunk(plan.rootPath, target, chunk, wroteChunk)
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
				await window.fsdecryptGUI.writeFileChunk(plan.rootPath, target, new Uint8Array(), false)
			}
		} finally {
			await window.fsdecryptGUI.closeOutputFile(plan.rootPath, target)
		}
	}

	return {
		createDirectory: path => {
			throwIfAborted(signal)
			return window.fsdecryptGUI.ensureDirectory(plan.rootPath, plan.fileSegments(path))
		},
		writeFile
	}
}
