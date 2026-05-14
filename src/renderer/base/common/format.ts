import type { RunStats, VersionLike } from "../../workbench/common/workbenchTypes"

export function formatBytes(bytes: number) {
	const units = ["B", "KB", "MB", "GB", "TB"]
	let value = bytes
	let unitIndex = 0
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024
		unitIndex += 1
	}
	return `${value.toLocaleString(undefined, { maximumFractionDigits: unitIndex === 0 ? 0 : 2 })} ${units[unitIndex]}`
}

export function formatDuration(ms: number) {
	if (ms < 60_000) {
		return `${(ms / 1000).toFixed(1)}s`
	}

	return `${Math.floor(ms / 60_000)}m ${((ms % 60_000) / 1000).toFixed(0)}s`
}

export function formatThroughput(bytes: number, elapsedMs: number) {
	if (bytes <= 0 || elapsedMs <= 0) {
		return "0 B/s"
	}

	return `${formatBytes((bytes / elapsedMs) * 1000)}/s`
}

export function formatEta(stats: RunStats) {
	if (stats.bytesWritten <= 0 || stats.totalBytes <= 0 || stats.bytesWritten >= stats.totalBytes) {
		return "..."
	}

	const bytesPerMs = stats.bytesWritten / Math.max(stats.elapsedMs, 1)
	return formatDuration((stats.totalBytes - stats.bytesWritten) / bytesPerMs)
}

export function formatVersion(version: VersionLike) {
	return `${version.major}.${version.minor.toString().padStart(2, "0")}.${version.release.toString().padStart(2, "0")}`
}

export function formatLogExport(lines: string[]) {
	return [`fsdecryptGUI log`, `Exported: ${new Date().toLocaleString()}`, "", ...lines].join("\n")
}

export function logExportName() {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-")
	return `fsdecryptGUI-${stamp}.log`
}
