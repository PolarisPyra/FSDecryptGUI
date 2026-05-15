import { stat } from "node:fs/promises"
import path from "node:path"

import type { PickedFile } from "./ipcTypes.js"

export async function pickedFile(filePath: string): Promise<PickedFile> {
	const fileStat = await stat(filePath)
	return {
		path: filePath,
		name: path.basename(filePath),
		size: fileStat.size
	}
}
