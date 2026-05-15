import { stat } from "node:fs/promises"
import path from "node:path"

import type { PickedFile } from "./ipcTypes.js"

/**
 * Converts a filesystem path into the minimal file metadata exposed to React.
 *
 * @param filePath Absolute path selected by a trusted native dialog.
 * @returns Path, basename, and byte size for renderer queueing.
 */
export async function pickedFile(filePath: string): Promise<PickedFile> {
	const fileStat = await stat(filePath)
	return {
		path: filePath,
		name: path.basename(filePath),
		size: fileStat.size
	}
}
