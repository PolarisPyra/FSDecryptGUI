import { useCallback, useEffect, useMemo, useState } from "react"

import { AlertTriangle, CheckCircle2, Download, FilePlus2, FileUp, RefreshCw, ShieldAlert } from "lucide-react"

import {
	binToHex,
	decodeIcfEntries,
	decryptIcf,
	encodeIcfEntries,
	encryptIcf,
	generateIcfFromQueues,
	getIcfSanityError,
	hexToBin,
	inferIcfFilename,
	listIcfGameIds,
	xxdDecode,
	xxdEncode
} from "../services/icf"
import type { SelectionQueues } from "../services/selectionQueue"

const STORAGE_KEY = "fsdecryptGUI.icfEditor"
const DEFAULT_ENTRIES = ["SXXXACA0"]

type EditorState = {
	data: Uint8Array
	entries: string[]
	error: string
	warning: string
}

type IcfViewProps = {
	queues: SelectionQueues
	isBusy: boolean
}

function cloneData(data: Uint8Array<ArrayBufferLike>) {
	return new Uint8Array(data)
}

function encodeEntries(entries: string[], currentData = new Uint8Array(0x40)) {
	const encoded = encodeIcfEntries(entries, currentData)
	return typeof encoded[0] === "string" ? null : cloneData(encoded[0] as Uint8Array)
}

function defaultData() {
	return encodeEntries(DEFAULT_ENTRIES) ?? new Uint8Array(0x40)
}

function getInitialState(): EditorState {
	const fallback = defaultData()
	const stored = window.localStorage.getItem(STORAGE_KEY)
	if (!stored) {
		return { data: fallback, entries: decodeIcfEntries(fallback), error: "", warning: "" }
	}

	const bytes = hexToBin(stored)
	if (!bytes) {
		return { data: fallback, entries: decodeIcfEntries(fallback), error: "Saved ICF state invalid", warning: "" }
	}

	return {
		data: bytes,
		entries: decodeIcfEntries(bytes),
		error: "",
		warning: getIcfSanityError(bytes) ?? ""
	}
}

function statusClass(error: string, warning: string) {
	if (error) return "icf-status error"
	if (warning) return "icf-status warning"
	return "icf-status ready"
}

export function IcfView({ queues, isBusy: isExtracting }: IcfViewProps) {
	const [state, setState] = useState<EditorState>(() => getInitialState())
	const [dumpValue, setDumpValue] = useState("")
	const [isBusy, setIsBusy] = useState(false)
	const [showDecryptedDump, setShowDecryptedDump] = useState(true)
	const [status, setStatus] = useState("")
	const gameIds = useMemo(() => listIcfGameIds(queues), [queues])
	const [targetGameId, setTargetGameId] = useState("")
	const effectiveTargetGameId = gameIds.length > 1 ? targetGameId || gameIds[0] : undefined
	const generation = useMemo(() => generateIcfFromQueues(queues, effectiveTargetGameId), [effectiveTargetGameId, queues])

	const persist = useCallback((data: Uint8Array) => {
		window.localStorage.setItem(STORAGE_KEY, binToHex(data))
	}, [])

	const importData = useCallback(
		(data: Uint8Array, nextStatus = "", warning = "") => {
			const next = cloneData(data)
			setState({
				data: next,
				entries: decodeIcfEntries(next),
				error: "",
				warning
			})
			setStatus(nextStatus)
			persist(next)
		},
		[persist]
	)

	useEffect(() => {
		let cancelled = false

		async function renderDump() {
			if (showDecryptedDump) {
				if (!cancelled) {
					setDumpValue(xxdEncode(state.data))
				}
				return
			}

			const encrypted = await encryptIcf(state.data)
			if (!cancelled) {
				setDumpValue(xxdEncode(encrypted ?? state.data))
			}
		}

		void renderDump()

		return () => {
			cancelled = true
		}
	}, [showDecryptedDump, state.data])

	const loadFromBytes = useCallback(
		async (bytes: Uint8Array) => {
			const importDecodable = (data: Uint8Array, label: string, warning = "") => {
				const entries = decodeIcfEntries(data)
				const encoded = encodeIcfEntries(entries, data)
				const nextData = typeof encoded[0] === "string" ? data : cloneData(encoded[0] as Uint8Array)
				importData(nextData, label, warning)
			}

			const directWarning = getIcfSanityError(bytes)
			if (!directWarning) {
				importData(bytes, "Loaded decrypted ICF.")
				return
			}

			const decrypted = await decryptIcf(bytes)
			if (decrypted && !getIcfSanityError(decrypted)) {
				importData(decrypted, "Loaded encrypted ICF.")
				return
			}
			if (decrypted && decrypted.length >= 0x40) {
				importDecodable(decrypted, "Loaded encrypted ICF with warnings.", getIcfSanityError(decrypted) ?? directWarning)
				return
			}
			if (bytes.length >= 0x40) {
				importDecodable(bytes, "Loaded ICF with warnings.", directWarning)
				return
			}

			setStatus("")
			setState(current => ({ ...current, error: directWarning, warning: "" }))
		},
		[importData]
	)

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
			await loadFromBytes(new Uint8Array(buffer))
		} catch (error) {
			setStatus(error instanceof Error ? `Load failed: ${error.message}` : "Load failed.")
		} finally {
			setIsBusy(false)
		}
	}, [loadFromBytes])

	const handleEntriesChange = useCallback(
		(value: string) => {
			const entries = value
				.split("\n")
				.map(line => line.trim())
				.filter((line, index, lines) => index < lines.length - 1 || line.length > 0)

			if (entries.length === 0) {
				entries.push("")
			}

			const encoded = encodeIcfEntries(entries, state.data)
			if (typeof encoded[0] === "string") {
				setState(current => ({
					...current,
					entries,
					error: encoded[0] as string
				}))
				setStatus("")
				return
			}

			const nextData = cloneData(encoded[0] as Uint8Array)
			setState({
				data: nextData,
				entries,
				error: "",
				warning: ""
			})
			setStatus("")
			persist(nextData)
		},
		[persist, state.data]
	)

	const handleDumpChange = useCallback(
		async (value: string) => {
			setDumpValue(value)
			const decoded = xxdDecode(value)
			if (!decoded) {
				setState(current => ({ ...current, error: "Malformed Hex Dump" }))
				setStatus("")
				return
			}

			let data: Uint8Array<ArrayBufferLike> = decoded
			if (!showDecryptedDump) {
				const decrypted = await decryptIcf(decoded)
				if (!decrypted) {
					setState(current => ({ ...current, error: "Malformed Hex Dump" }))
					setStatus("")
					return
				}
				data = decrypted
			} else if (getIcfSanityError(decoded)) {
				const decrypted = await decryptIcf(decoded)
				if (decrypted && !getIcfSanityError(decrypted)) {
					data = decrypted
				}
			}

			setState({
				data: cloneData(data),
				entries: decodeIcfEntries(data),
				error: "",
				warning: getIcfSanityError(data) ?? ""
			})
			setStatus("")
		},
		[showDecryptedDump]
	)

	const handleDumpBlur = useCallback(() => {
		if (!state.error) {
			persist(state.data)
		}
	}, [persist, state.data, state.error])

	const handleSave = useCallback(async () => {
		setIsBusy(true)
		try {
			const encoded = encodeIcfEntries(state.entries, state.data)
			if (typeof encoded[0] === "string") {
				setState(current => ({ ...current, error: encoded[0] as string }))
				setStatus("Save failed: entries need to be valid before writing ICF.")
				return
			}

			const nextData = cloneData(encoded[0] as Uint8Array)
			const encrypted = await encryptIcf(nextData)
			if (!encrypted) {
				setStatus("Save failed: could not encrypt ICF.")
				return
			}

			const defaultName = inferIcfFilename(nextData) ?? "ICF1"
			const savedPath = await window.fsdecryptGUI.saveBinary({
				defaultName,
				content: encrypted
			})
			if (savedPath) {
				setState({ data: nextData, entries: decodeIcfEntries(nextData), error: "", warning: "" })
				persist(nextData)
				setStatus(`Saved ${savedPath}`)
			}
		} catch (error) {
			setStatus(error instanceof Error ? `Save failed: ${error.message}` : "Save failed.")
		} finally {
			setIsBusy(false)
		}
	}, [persist, state.data, state.entries])

	const handleGenerate = useCallback(() => {
		if (!generation.ok) {
			setStatus("Selected files are not ready for ICF generation.")
			return
		}

		importData(generation.data, `Generated ${generation.sourceCount} ICF entr${generation.sourceCount === 1 ? "y" : "ies"} from current selections.`)
	}, [generation, importData])

	const handleReset = useCallback(() => {
		const data = defaultData()
		window.localStorage.removeItem(STORAGE_KEY)
		setState({ data, entries: decodeIcfEntries(data), error: "", warning: "" })
		setStatus("")
	}, [])

	const busy = isBusy || isExtracting

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
					<div className={generation.ok ? "icf-status ready" : "icf-status error"}>
						{generation.ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
						<div>
							<strong>{generation.ok ? "Can generate ICF" : "Not ready"}</strong>
							<span>
								{generation.ok
									? `${generation.sourceCount.toLocaleString()} selected APP/OPT entr${generation.sourceCount === 1 ? "y" : "ies"} available`
									: generation.errors[0]}
							</span>
						</div>
					</div>

					{!generation.ok && generation.errors.length > 1 ? (
						<div className="icf-errors">
							{generation.errors.map(error => (
								<div key={error}>
									<AlertTriangle size={14} />
									<span>{error}</span>
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
				<div className="log-title">
					<label>Entries</label>
				</div>
				<textarea value={state.entries.join("\n")} onChange={event => handleEntriesChange(event.target.value)} spellCheck={false} />
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
