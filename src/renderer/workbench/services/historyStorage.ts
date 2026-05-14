import type { ExportHistoryItem } from "../common/workbenchTypes"

const HISTORY_STORAGE_KEY = "fsdecryptGUI.exportHistory"

export function historyId() {
	return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function readStoredHistory(): ExportHistoryItem[] {
	try {
		const raw = localStorage.getItem(HISTORY_STORAGE_KEY)
		if (!raw) return []
		const parsed = JSON.parse(raw) as ExportHistoryItem[]
		return Array.isArray(parsed) ? parsed.slice(0, 50) : []
	} catch {
		return []
	}
}

export function writeStoredHistory(history: ExportHistoryItem[]) {
	localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(0, 50)))
}
