import { BrowserWindow, dialog, shell } from "electron"
import { mkdir, open, rm, stat, type FileHandle } from "node:fs/promises"
import path from "node:path"

type OutputFolderWindow = BrowserWindow | undefined

/**
 * Checks whether a filesystem path already exists.
 *
 * @param target Resolved path to test.
 * @returns True when stat succeeds.
 */
async function pathExists(target: string) {
	try {
		await stat(target)
		return true
	} catch {
		return false
	}
}

/**
 * Converts IPC binary payloads into Node buffers without copying when possible.
 *
 * @param chunk ArrayBuffer or typed array sent from the preload bridge.
 * @returns Buffer view suitable for FileHandle.write.
 */
function chunkBuffer(chunk: ArrayBuffer | Uint8Array) {
	if (chunk instanceof ArrayBuffer) {
		return Buffer.from(chunk)
	}
	return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
}

/**
 * Output paths always cross IPC as a trusted root plus renderer-produced path segments.
 * The root is the user-selected Output Folder; each segment is one folder or file name
 * under that root. Keeping this validation in one place makes it safe to add new
 * write/open/remove calls without re-learning the path traversal rules each time.
 */
export function resolveOutputPath(rootPath: string, segments: string[]) {
	const cleanSegments = segments.filter(Boolean)
	if (cleanSegments.some(segment => segment.includes("/") || segment.includes("\\") || segment === "." || segment === "..")) {
		throw new Error("Invalid output path segment")
	}

	const root = path.resolve(rootPath)
	const target = path.resolve(root, ...cleanSegments)
	const relative = path.relative(root, target)
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error("Output path escaped the selected folder")
	}

	return target
}

/**
 * Owns the Electron-side Output Folder lifecycle:
 * prepare the job folder, keep chunked file writes open between IPC calls,
 * open completed folders in the shell, and clean up paths on cancellation.
 */
class OutputFolderManager {
	private readonly openFiles = new Map<string, Promise<FileHandle>>()
	private readonly ensuredDirectories = new Set<string>()

	/**
	 * Close every open writer before replacing or merging an Output Folder.
	 * Extraction writes many chunks through IPC, so handles are cached until a file
	 * is complete. Folder-level operations must drain those handles first.
	 */
	async closeAllOpenFiles() {
		const handles = [...this.openFiles.values()]
		this.openFiles.clear()
		await Promise.allSettled(handles.map(async handle => (await handle).close()))
	}

	async closeOpenFile(rootPath: string, segments: string[]) {
		const target = resolveOutputPath(rootPath, segments)
		const handle = this.openFiles.get(target)
		if (!handle) {
			return
		}

		this.openFiles.delete(target)
		await (await handle).close()
	}

	async ensureDirectory(rootPath: string, segments: string[]) {
		await this.ensureResolvedDirectory(resolveOutputPath(rootPath, segments))
	}

	/**
	 * Called once per Extraction Job before the renderer writes files. This is the
	 * only place that asks whether an existing Output Folder should be replaced,
	 * merged, or cancelled.
	 */
	async prepareFolder(window: OutputFolderWindow, rootPath: string, segments: string[]) {
		const target = resolveOutputPath(rootPath, segments)
		await this.closeAllOpenFiles()
		this.ensuredDirectories.clear()

		if (!(await pathExists(target))) {
			await mkdir(target, { recursive: true })
			this.ensuredDirectories.add(target)
			return
		}

		const messageBox = {
			type: "question" as const,
			message: "Output folder already exists",
			detail: `${target}\n\nReplace deletes the existing folder first. Merge keeps the folder and overwrites matching files.`,
			buttons: ["Replace", "Merge", "Cancel"],
			defaultId: 1,
			cancelId: 2,
			noLink: true
		}
		const result = window ? await dialog.showMessageBox(window, messageBox) : await dialog.showMessageBox(messageBox)

		if (result.response === 2) {
			throw new Error("Extraction cancelled")
		}

		if (result.response === 0) {
			await rm(target, { recursive: true, force: true })
		}

		await mkdir(target, { recursive: true })
		this.ensuredDirectories.add(target)
	}

	async openFolder(rootPath: string, segments: string[]) {
		const target = resolveOutputPath(rootPath, segments)
		await mkdir(target, { recursive: true })
		const error = await shell.openPath(target)
		if (error) {
			throw new Error(error)
		}
	}

	async writeFileChunk(rootPath: string, segments: string[], chunk: ArrayBuffer | Uint8Array, append: boolean) {
		const target = resolveOutputPath(rootPath, segments)
		await this.ensureResolvedDirectory(path.dirname(target))

		// `append=false` starts a new file. Closing any old handle first prevents a
		// previous failed or cancelled extraction from appending stale contents.
		if (!append) {
			await this.closeResolvedFile(target)
			this.openOutputHandle(target, "w")
		}

		let handle = this.openFiles.get(target)
		if (!handle) {
			handle = this.openOutputHandle(target, "a")
		}

		await (await handle).write(chunkBuffer(chunk))
	}

	async removePath(rootPath: string, segments: string[]) {
		const target = resolveOutputPath(rootPath, segments)
		await this.closeResolvedFile(target)
		await rm(target, { recursive: true, force: true })
	}

	private async ensureResolvedDirectory(target: string) {
		if (this.ensuredDirectories.has(target)) {
			return
		}

		await mkdir(target, { recursive: true })
		this.ensuredDirectories.add(target)
	}

	private openOutputHandle(target: string, flags: "a" | "w") {
		const handle = open(target, flags).catch(error => {
			this.openFiles.delete(target)
			throw error
		})
		this.openFiles.set(target, handle)
		return handle
	}

	private async closeResolvedFile(target: string) {
		const handle = this.openFiles.get(target)
		if (!handle) {
			return
		}

		this.openFiles.delete(target)
		await (await handle).close()
	}
}

export const outputFolders = new OutputFolderManager()
