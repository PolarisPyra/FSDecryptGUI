import type { ExportHistoryItem } from "../common/appTypes"

const HISTORY_STORAGE_KEY = "fsdecryptGUI.exportHistory"

/**
 * Creates a sortable unique id for an Extraction Record.
 *
 * @returns Timestamp/random id string.
 */
export function historyId() {
	return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/**
 * Reads persisted Extraction Records from localStorage.
 *
 * @returns Saved history, or an empty list when storage is invalid.
 */
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

/**
 * Persists the bounded Extraction Record list to localStorage.
 *
 * @param history Records to save.
 */
export function writeStoredHistory(history: ExportHistoryItem[]) {
	localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(0, 50)))
}
