import { useCallback, useEffect, useMemo, useState } from "react"

import { AlertTriangle, CheckCircle2, Download, FilePlus2, FileUp, RefreshCw, ShieldAlert } from "lucide-react"

import { generateIcfFromQueues, listIcfGameIds } from "../services/icf"
import type { IcfGenerationIssue } from "../services/icf"
import {
	applyIcfDumpChange,
	applyIcfEntriesChange,
	createDefaultIcfState,
	createIcfSavePayload,
	ICF_EDITOR_STORAGE_KEY,
	importIcfData,
	loadIcfBytes,
	readStoredIcfState,
	renderIcfDump,
	serializeIcfState
} from "../services/icfEditor"
import type { IcfEditorState } from "../services/icfEditor"
import type { SelectionQueues } from "../services/selectionQueue"

const ENTRY_PLACEHOLDER = [
	"SDEDACA0",
	"SDED_1.34.00_20211102142042_2_1.33.00.app",
	"SDED_A011_20200902105636_0.opt"
].join("\n")

type IcfViewProps = {
	queues: SelectionQueues
	isBusy: boolean
}

function statusClass(error: string, warning: string) {
	if (error) return "icf-status error"
	if (warning) return "icf-status warning"
	return "icf-status ready"
}

function issueText(issue: IcfGenerationIssue) {
	return `${issue.source}: ${issue.message}`
}

/** Provides the ICF editor, import/export actions, and generation from current extraction queues. */
export function IcfView({ queues, isBusy: isExtracting }: IcfViewProps) {
	const [state, setState] = useState(() => readStoredIcfState(window.localStorage.getItem(ICF_EDITOR_STORAGE_KEY)))
	const [entryText, setEntryText] = useState(() => state.entries.join("\n"))
	const [entryScrollTop, setEntryScrollTop] = useState(0)
	const [dumpValue, setDumpValue] = useState("")
	const [isBusy, setIsBusy] = useState(false)
	const [showDecryptedDump, setShowDecryptedDump] = useState(true)
	const [status, setStatus] = useState("")
	const gameIds = useMemo(() => listIcfGameIds(queues), [queues])
	const [targetGameId, setTargetGameId] = useState("")
	const effectiveTargetGameId = gameIds.length > 1 ? targetGameId || gameIds[0] : undefined
	const generation = useMemo(() => generateIcfFromQueues(queues, effectiveTargetGameId), [effectiveTargetGameId, queues])
	const entryLineNumbers = useMemo(
		() => Array.from({ length: Math.max(1, entryText.split("\n").length) }, (_, index) => index + 1),
		[entryText]
	)

	const persistState = useCallback((nextState: IcfEditorState) => {
		window.localStorage.setItem(ICF_EDITOR_STORAGE_KEY, serializeIcfState(nextState))
	}, [])

	const importData = useCallback(
		(data: Uint8Array, nextStatus = "", warning = "") => {
			const nextState = importIcfData(data, warning)
			setState(nextState)
			setEntryText(nextState.entries.join("\n"))
			setEntryScrollTop(0)
			setStatus(nextStatus)
			persistState(nextState)
		},
		[persistState]
	)

	useEffect(() => {
		let cancelled = false

		async function renderDump() {
			if (!cancelled) {
				setDumpValue(await renderIcfDump(state, showDecryptedDump))
			}
		}

		void renderDump()

		return () => {
			cancelled = true
		}
	}, [showDecryptedDump, state.data])

	const handleLoad = useCallback(async () => {
		setIsBusy(true)
		try {
			const files = await window.fsdecryptGUI.pickFiles({
				title: "Load ICF",
				filters: [{ name: "All files", extensions: ["*"] }]
			})
			const file = files[0]
			if (!file) return

			const buffer = await window.fsdecryptGUI.readRange(file.path, 0, file.size)
			const loaded = await loadIcfBytes(new Uint8Array(buffer))
			setState(loaded.state)
			setEntryText(loaded.state.entries.join("\n"))
			setEntryScrollTop(0)
			setStatus(loaded.status)
			persistState(loaded.state)
		} catch (error) {
			setStatus(error instanceof Error ? `Load failed: ${error.message}` : "Load failed.")
		} finally {
			setIsBusy(false)
		}
	}, [persistState])

	const handleEntriesChange = useCallback(
		(value: string) => {
			setEntryText(value)
			const nextState = applyIcfEntriesChange(state, value)
			setState(nextState)
			setStatus("")
			if (!nextState.error) {
				persistState(nextState)
			}
		},
		[persistState, state]
	)

	const handleEntriesBlur = useCallback(() => {
		if (!state.error) {
			setEntryText(state.entries.join("\n"))
		}
	}, [state.entries, state.error])

	const handleDumpChange = useCallback(
		async (value: string) => {
			setDumpValue(value)
			const nextState = await applyIcfDumpChange(state, value, showDecryptedDump)
			setState(nextState)
			setEntryText(nextState.entries.join("\n"))
			setEntryScrollTop(0)
			setStatus("")
		},
		[showDecryptedDump, state]
	)

	const handleDumpBlur = useCallback(() => {
		if (!state.error) {
			persistState(state)
		}
	}, [persistState, state])

	const handleSave = useCallback(async () => {
		setIsBusy(true)
		try {
			const payload = await createIcfSavePayload(state)
			if (payload.error || !payload.data || !payload.encrypted || !payload.defaultName) {
				setState(current => ({ ...current, error: payload.error || "Save failed" }))
				setStatus("Save failed: entries need to be valid before writing ICF.")
				return
			}

			const savedPath = await window.fsdecryptGUI.saveBinary({
				defaultName: payload.defaultName,
				content: payload.encrypted
			})
			if (savedPath) {
				const nextState = importIcfData(payload.data)
				setState(nextState)
				setEntryText(nextState.entries.join("\n"))
				setEntryScrollTop(0)
				persistState(nextState)
				setStatus(`Saved ${savedPath}`)
			}
		} catch (error) {
			setStatus(error instanceof Error ? `Save failed: ${error.message}` : "Save failed.")
		} finally {
			setIsBusy(false)
		}
	}, [persistState, state])

	const handleGenerate = useCallback(() => {
		if (!generation.ok) {
			setStatus("Selected files are not ready for ICF generation.")
			return
		}

		importData(generation.data, `Generated ${generation.sourceCount} ICF entr${generation.sourceCount === 1 ? "y" : "ies"} from current selections.`)
	}, [generation, importData])

	const handleReset = useCallback(() => {
		const nextState = createDefaultIcfState()
		window.localStorage.removeItem(ICF_EDITOR_STORAGE_KEY)
		setState(nextState)
		setEntryText(nextState.entries.join("\n"))
		setEntryScrollTop(0)
		setStatus("")
	}, [])

	const busy = isBusy || isExtracting
	const firstGenerationIssue = generation.errors[0] ?? generation.warnings[0]
	const generationStatusClass = generation.ok ? "icf-status ready" : generation.errors.length > 0 ? "icf-status error" : "icf-status warning"
	const generationStatusIcon = generation.ok ? <CheckCircle2 size={16} /> : generation.errors.length > 0 ? <ShieldAlert size={16} /> : <AlertTriangle size={16} />
	const generationStatusTitle = generation.ok ? "Can generate ICF" : generation.errors.length > 0 ? "ICF generation blocked" : "ICF has warnings"

	return (
		<main className="workspace icf-workspace">
			<section className="left-panel icf-left-panel">
				<div className="icf-actions">
					<button type="button" disabled={busy} onClick={handleLoad}>
						<FileUp size={16} />
						Load ICF
					</button>
					<button type="button" disabled={busy || !generation.ok} onClick={handleGenerate}>
						<FilePlus2 size={16} />
						{effectiveTargetGameId ? `From ${effectiveTargetGameId}` : "From Selection"}
					</button>
					<button type="button" className="primary" disabled={busy || Boolean(state.error)} onClick={() => void handleSave()}>
						<Download size={16} />
						Save ICF
					</button>
					<button type="button" disabled={busy} onClick={handleReset}>
						<RefreshCw size={16} />
						Clear
					</button>
				</div>

				<div className="info-block icf-status-block">
					<label>ICF State</label>
					<div className={statusClass(state.error, state.warning)}>
						{state.error ? <ShieldAlert size={16} /> : state.warning ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
						<div>
							<strong>{state.error ? state.error : state.warning ? "ICF loaded with warning" : "ICF data valid"}</strong>
							<span>{status || `${state.entries.length.toLocaleString()} entr${state.entries.length === 1 ? "y" : "ies"} in editor`}</span>
						</div>
					</div>
					<hr />
					<label>Selection</label>
					{gameIds.length > 1 ? (
						<select className="icf-game-select" value={effectiveTargetGameId} onChange={event => setTargetGameId(event.currentTarget.value)}>
							{gameIds.map(gameId => (
								<option key={gameId} value={gameId}>
									{gameId}
								</option>
							))}
						</select>
					) : null}
					<div className={generationStatusClass}>
						{generationStatusIcon}
						<div>
							<strong>{generationStatusTitle}</strong>
							<span>
								{generation.ok
									? `${generation.sourceCount.toLocaleString()} selected APP/OPT entr${generation.sourceCount === 1 ? "y" : "ies"} available`
									: firstGenerationIssue
										? issueText(firstGenerationIssue)
										: "Selected files are not ready for ICF generation"}
							</span>
						</div>
					</div>

					{generation.errors.length > 0 ? (
						<div className="icf-issues error">
							<strong>Errors</strong>
							{generation.errors.map((error, index) => (
								<div key={`${issueText(error)}-${index}`}>
									<AlertTriangle size={14} />
									<span>{issueText(error)}</span>
								</div>
							))}
						</div>
					) : null}
					{generation.warnings.length > 0 ? (
						<div className="icf-issues warning">
							<strong>Warnings</strong>
							{generation.warnings.map((warning, index) => (
								<div key={`${issueText(warning)}-${index}`}>
									<AlertTriangle size={14} />
									<span>{issueText(warning)}</span>
								</div>
							))}
						</div>
					) : null}
					<hr />
					<label>View</label>
					<label className={`icf-dump-toggle ${showDecryptedDump ? "active" : ""}`}>
						<input type="checkbox" checked={showDecryptedDump} onChange={event => setShowDecryptedDump(event.currentTarget.checked)} />
						<span>Decrypted dump</span>
					</label>
				</div>
			</section>

			<section className="main-panel icf-editor-pane">
				<div className="log-title icf-entry-title">
					<label>Entries</label>
					<span>One entry per line</span>
				</div>
				<div className="icf-code-editor">
					<div className="icf-line-gutter" aria-hidden="true">
						<div className="icf-line-gutter-content" style={{ transform: `translateY(-${entryScrollTop}px)` }}>
							{entryLineNumbers.map(lineNumber => (
								<span key={lineNumber}>{lineNumber}</span>
							))}
						</div>
					</div>
					<textarea
						className="icf-code-textarea"
						value={entryText}
						onChange={event => handleEntriesChange(event.target.value)}
						onBlur={handleEntriesBlur}
						onScroll={event => setEntryScrollTop(event.currentTarget.scrollTop)}
						placeholder={ENTRY_PLACEHOLDER}
						spellCheck={false}
						aria-label="ICF entries, one entry per line"
					/>
				</div>
			</section>

			<section className="log-panel icf-editor-pane">
				<div className="log-title">
					<label>Hex Dump</label>
				</div>
				<textarea value={dumpValue} onChange={event => void handleDumpChange(event.target.value)} onBlur={handleDumpBlur} spellCheck={false} />
			</section>
		</main>
	)
}
