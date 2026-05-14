export function basename(filePath: string) {
	const segments = filePath.split(/[\\/]/).filter(Boolean)
	return segments.length > 0 ? segments[segments.length - 1] : filePath
}

export function outputSegmentsForFolder(rootPath: string, folderName: string) {
	const outputFolder = sanitizePathSegment(folderName)
	return basename(rootPath) === outputFolder ? [] : [outputFolder]
}

export function dirname(filePath: string) {
	const separatorIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))
	return separatorIndex > 0 ? filePath.slice(0, separatorIndex) : ""
}

export function compactPath(filePath: string, visibleSegments = 2) {
	const normalized = filePath.replace(/\\/g, "/")
	const prefix = normalized.startsWith("/") ? "/" : ""
	const segments = normalized.split("/").filter(Boolean)
	if (segments.length <= visibleSegments) {
		return filePath
	}

	return `${prefix}.../${segments.slice(-visibleSegments).join("/")}`
}

export function sanitizePathSegment(name: string) {
	return Array.from(name, character => {
		const code = character.charCodeAt(0)
		return code < 32 || '<>:"/\\|?*'.includes(character) ? "_" : character
	}).join("")
}

export function stripExtension(name: string) {
	return name.replace(/\.[^.]+$/, "")
}

export function pathInFolder(folder: string, filename: string) {
	if (!folder) return filename
	const separator = folder.includes("\\") ? "\\" : "/"
	return `${folder.replace(/[\\/]+$/, "")}${separator}${filename}`
}
