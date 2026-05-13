import { useEffect, useMemo, useRef, useState } from "react"

import { FileArchive, FileKey, FolderOpen, HardDriveDownload, RotateCcw, Terminal, X, Zap } from "lucide-react"

import { ReadableByteSource } from "../fsdecrypt/byte-source"
import { extractExfatContents } from "../fsdecrypt/exfat"
import { FSCRYPT_CONTAINER_TYPE, describeContainerType, openFscryptSource } from "../fsdecrypt/fsdecrypt"
import { NtfsExtractionWriter, appContainersToVhdSources, extractInternalVhdSource, extractNtfsContents } from "../fsdecrypt/ntfs"
import { VhdNtfsSource, openVhdChainNtfsSource } from "../fsdecrypt/vhd"
import { PickedFile, RendererConfig, byteSourceFromPickedFile } from "./electron-api"

type ToolMode = "container" | "option" | "vhd"

type CompletedResult = {
	outputFolder: string
	outputSegments: string[]
	outputSize: number
	details: Array<{ label: string; value: string }>
}

type RunStats = {
	elapsedMs: number
	bytesWritten: number
	totalBytes: number
}

const WRITE_CHUNK_SIZE = 32 * 1024 * 1024

const MODES = [
	{ mode: "container" as const, label: "Base", icon: FileArchive },
	{ mode: "option" as const, label: "Option", icon: FileKey },
	{ mode: "vhd" as const, label: "Merge", icon: HardDriveDownload }
]

function formatBytes(bytes: number) {
	const units = ["B", "KB", "MB", "GB", "TB"]
	let value = bytes
	let unitIndex = 0
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024
		unitIndex += 1
	}
	return `${value.toLocaleString(undefined, { maximumFractionDigits: unitIndex === 0 ? 0 : 2 })} ${units[unitIndex]}`
}

function basename(filePath: string) {
	return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath
}

function outputSegmentsForFolder(rootPath: string, folderName: string) {
	const outputFolder = sanitizePathSegment(folderName)
	return basename(rootPath) === outputFolder ? [] : [outputFolder]
}

function dirname(filePath: string) {
	const separatorIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))
	return separatorIndex > 0 ? filePath.slice(0, separatorIndex) : ""
}

function compactPath(filePath: string, visibleSegments = 2) {
	const normalized = filePath.replace(/\\/g, "/")
	const prefix = normalized.startsWith("/") ? "/" : ""
	const segments = normalized.split("/").filter(Boolean)
	if (segments.length <= visibleSegments) {
		return filePath
	}

	return `${prefix}.../${segments.slice(-visibleSegments).join("/")}`
}

function sanitizePathSegment(name: string) {
	return Array.from(name, character => {
		const code = character.charCodeAt(0)
		return code < 32 || '<>:"/\\|?*'.includes(character) ? "_" : character
	}).join("")
}

function stripExtension(name: string) {
	return name.replace(/\.[^.]+$/, "")
}

function formatDuration(ms: number) {
	if (ms < 60_000) {
		return `${(ms / 1000).toFixed(1)}s`
	}

	return `${Math.floor(ms / 60_000)}m ${((ms % 60_000) / 1000).toFixed(0)}s`
}

function formatThroughput(bytes: number, elapsedMs: number) {
	if (bytes <= 0 || elapsedMs <= 0) {
		return "0 B/s"
	}

	return `${formatBytes((bytes / elapsedMs) * 1000)}/s`
}

function formatEta(stats: RunStats) {
	if (stats.bytesWritten <= 0 || stats.totalBytes <= 0 || stats.bytesWritten >= stats.totalBytes) {
		return "..."
	}

	const bytesPerMs = stats.bytesWritten / Math.max(stats.elapsedMs, 1)
	return formatDuration((stats.totalBytes - stats.bytesWritten) / bytesPerMs)
}

function abortError() {
	return new DOMException("Extraction cancelled", "AbortError")
}

function throwIfAborted(signal: AbortSignal) {
	if (signal.aborted) {
		throw abortError()
	}
}

function isAbortError(error: unknown) {
	return (error instanceof DOMException && error.name === "AbortError") || (error instanceof Error && error.message === "Extraction cancelled")
}

function vhdDetails(result: VhdNtfsSource) {
	return [
		{ label: "Layers", value: result.chain.length.toString() },
		{ label: "Parent", value: result.chain[0] ?? "" },
		{ label: "Child", value: result.chain[result.chain.length - 1] ?? "" },
		{ label: "NTFS Offset", value: formatBytes(result.ntfsOffset) }
	]
}

function createFolderWriter(
	rootPath: string,
	folderName: string,
	getTotalBytes: () => number,
	setProgress: (progress: number) => void,
	signal: AbortSignal,
	onBytesWritten: (bytes: number) => void
): NtfsExtractionWriter {
	let written = 0
	let lastProgressUpdate = 0
	const outputFolder = sanitizePathSegment(folderName)
	const outputRoot = outputSegmentsForFolder(rootPath, outputFolder)
	const writePath = (path: string[]) => [...outputRoot, ...path.map(sanitizePathSegment)]

	const writeFile = async (path: string[], source: ReadableByteSource) => {
		const target = writePath(path)
		let wroteChunk = false

		try {
			for (let offset = 0; offset < source.size; offset += WRITE_CHUNK_SIZE) {
				throwIfAborted(signal)
				const chunk = await source.read(offset, Math.min(WRITE_CHUNK_SIZE, source.size - offset))
				throwIfAborted(signal)
				await window.fsdecryptGUI.writeFileChunk(rootPath, target, chunk, wroteChunk)
				wroteChunk = true
				written += chunk.length
				onBytesWritten(chunk.length)

				const now = performance.now()
				if (now - lastProgressUpdate > 250 || offset + chunk.length >= source.size) {
					lastProgressUpdate = now
					setProgress(Math.min(99, Math.round((written / Math.max(getTotalBytes(), 1)) * 100)))
				}
			}

			if (!wroteChunk) {
				throwIfAborted(signal)
				await window.fsdecryptGUI.writeFileChunk(rootPath, target, new Uint8Array(), false)
			}
		} finally {
			await window.fsdecryptGUI.closeOutputFile(rootPath, target)
		}
	}

	return {
		createDirectory: path => {
			throwIfAborted(signal)
			return window.fsdecryptGUI.ensureDirectory(rootPath, writePath(path))
		},
		writeFile
	}
}

function ModeToggle({ mode, onChange }: { mode: ToolMode; onChange: (mode: ToolMode) => void }) {
	const activeIndex = MODES.findIndex(item => item.mode === mode)
	return (
		<div className="mode-toggle">
			<div className="mode-indicator" style={{ transform: `translateX(calc(${activeIndex} * (100% + 0.2rem)))` }} />
			{MODES.map(item => {
				const Icon = item.icon
				return (
					<button key={item.mode} type="button" className={mode === item.mode ? "active" : ""} onClick={() => onChange(item.mode)}>
						<Icon size={15} />
						<span>{item.label}</span>
					</button>
				)
			})}
		</div>
	)
}

export function App() {
	const [mode, setMode] = useState<ToolMode>("container")
	const [containerFile, setContainerFile] = useState<PickedFile | null>(null)
	const [keyFile, setKeyFile] = useState<PickedFile | null>(null)
	const [vhdFiles, setVhdFiles] = useState<PickedFile[]>([])
	const [outputRoot, setOutputRoot] = useState("")
	const [configPath, setConfigPath] = useState("")
	const [isBusy, setIsBusy] = useState(false)
	const [progress, setProgress] = useState(0)
	const [runStats, setRunStats] = useState<RunStats>({ elapsedMs: 0, bytesWritten: 0, totalBytes: 0 })
	const [logs, setLogs] = useState<string[]>(["Ready"])
	const [result, setResult] = useState<CompletedResult | null>(null)
	const terminalRef = useRef<HTMLDivElement>(null)
	const abortControllerRef = useRef<AbortController | null>(null)
	const runStartedAtRef = useRef(0)

	useEffect(() => {
		terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight })
	}, [logs])

	useEffect(() => {
		if (!isBusy) return

		const interval = window.setInterval(() => {
			setRunStats(current => ({ ...current, elapsedMs: performance.now() - runStartedAtRef.current }))
		}, 250)

		return () => window.clearInterval(interval)
	}, [isBusy])

	const selectedFiles = mode === "vhd" ? vhdFiles : containerFile ? [containerFile] : []
	const canRun = !isBusy && Boolean(outputRoot) && (mode === "vhd" ? vhdFiles.length > 0 : Boolean(containerFile))
	const modeLabel = MODES.find(m => m.mode === mode)!.label.toUpperCase()
	const keySource = useMemo(() => (keyFile ? byteSourceFromPickedFile(keyFile) : undefined), [keyFile])
	const configFolder = useMemo(() => dirname(configPath), [configPath])

	const appendLog = (message: string) => {
		const timestamp = new Date().toLocaleTimeString()
		setLogs(current => [...current.slice(-220), `[${timestamp}] ${message}`])
	}

	useEffect(() => {
		const applyConfig = (config: RendererConfig) => {
			setOutputRoot(config.outputRoot ?? "")
			setKeyFile(config.keyFile ?? null)
			setConfigPath(config.configPath)
		}

		window.fsdecryptGUI
			.readConfig()
			.then(applyConfig)
			.catch(error => {
				appendLog(error instanceof Error ? `Could not read config: ${error.message}` : "Could not read config")
			})

		return window.fsdecryptGUI.onConfigChanged(config => {
			applyConfig(config)
			appendLog(config.outputRoot ? `Output root selected: ${config.outputRoot}` : "Output root cleared")
		})
	}, [])

	const chooseContainer = async () => {
		const isOption = mode === "option"
		const files = await window.fsdecryptGUI.pickFiles({
			title: isOption ? "Choose option" : "Choose base",
			filters: [
				isOption
					? { name: "Option containers", extensions: ["opt"] }
					: { name: "APP containers", extensions: ["app"] },
				{ name: "All files", extensions: ["*"] }
			]
		})
		setContainerFile(files[0] ?? null)
		setResult(null)
	}

	const chooseKey = async () => {
		const files = await window.fsdecryptGUI.pickFiles({
			title: "Choose key file",
			filters: [
				{ name: "Key files", extensions: ["bin"] },
				{ name: "All files", extensions: ["*"] }
			]
		})
		if (!files[0]) return
		setKeyFile(files[0])
		await window.fsdecryptGUI.updateConfig({ keyFilePath: files[0].path })
		setResult(null)
	}

	const chooseApps = async () => {
		const files = await window.fsdecryptGUI.pickFiles({
			title: "Choose APP or VHD chain layers",
			multiple: true,
			filters: [
				{ name: "APP and VHD files", extensions: ["app", "vhd"] },
				{ name: "All files", extensions: ["*"] }
			]
		})
		setVhdFiles(files)
		setResult(null)
	}

	const reset = () => {
		setContainerFile(null)
		setVhdFiles([])
		setProgress(0)
		setRunStats({ elapsedMs: 0, bytesWritten: 0, totalBytes: 0 })
		setLogs(["Ready"])
		setResult(null)
	}

	const cancelRun = () => {
		abortControllerRef.current?.abort()
		appendLog("Cancelling extraction...")
	}

	const openConfigFolder = async () => {
		try {
			await window.fsdecryptGUI.openConfigFolder()
		} catch (error) {
			appendLog(error instanceof Error ? `Could not open config folder: ${error.message}` : "Could not open config folder")
		}
	}

	const openResultFolder = async () => {
		if (!result) return

		try {
			await window.fsdecryptGUI.openOutputFolder(outputRoot, result.outputSegments)
		} catch (error) {
			appendLog(error instanceof Error ? `Could not open output folder: ${error.message}` : "Could not open output folder")
		}
	}

	const extractNtfsSource = async (
		ntfsSource: VhdNtfsSource,
		folderName: string,
		getExtraDetails: () => CompletedResult["details"],
		signal: AbortSignal,
		onBytesWritten: (bytes: number) => void
	): Promise<CompletedResult> => {
		const outputSegments = outputSegmentsForFolder(outputRoot, folderName)
		if (outputSegments.length > 0) {
			await window.fsdecryptGUI.prepareOutputFolder(outputRoot, outputSegments)
		}
		let totalBytes = 1
		const writer = createFolderWriter(outputRoot, folderName, () => totalBytes, setProgress, signal, onBytesWritten)
		const extracted = await extractNtfsContents(ntfsSource, writer, {
			onLog: appendLog,
			onTotalBytes: bytes => {
				totalBytes = bytes
				setRunStats(current => ({ ...current, totalBytes: bytes }))
			},
			signal
		})
		return {
			outputFolder: sanitizePathSegment(folderName),
			outputSegments,
			outputSize: extracted.bytes,
			details: [
				...getExtraDetails(),
				...vhdDetails(ntfsSource),
				{ label: "Files", value: extracted.files.toLocaleString() },
				{ label: "Folders", value: extracted.directories.toLocaleString() }
			]
		}
	}

	const run = async () => {
		if (!canRun) return

		const abortController = new AbortController()
		abortControllerRef.current = abortController
		runStartedAtRef.current = performance.now()
		setIsBusy(true)
		setProgress(0)
		setRunStats({ elapsedMs: 0, bytesWritten: 0, totalBytes: 0 })
		setLogs([])
		setResult(null)

		const elapsedDetails = (): CompletedResult["details"] => {
			const ms = performance.now() - runStartedAtRef.current
			const value = formatDuration(ms)
			return [{ label: "Elapsed", value }]
		}
		const noteBytesWritten = (bytes: number) => {
			setRunStats(current => ({
				...current,
				bytesWritten: current.bytesWritten + bytes,
				elapsedMs: performance.now() - runStartedAtRef.current
			}))
		}

		try {
			appendLog(`Starting ${modeLabel} extract`)

			if (mode === "container") {
				if (!containerFile) return
				throwIfAborted(abortController.signal)
				appendLog(`Opening APP container ${containerFile.name}`)
				const vhdSource = await extractInternalVhdSource(byteSourceFromPickedFile(containerFile), {
					keyFile: keySource,
					onLog: appendLog
				})
				throwIfAborted(abortController.signal)
				const ntfsSource = await openVhdChainNtfsSource([vhdSource], { onLog: appendLog })
				setResult(await extractNtfsSource(ntfsSource, stripExtension(containerFile.name), elapsedDetails, abortController.signal, noteBytesWritten))
			} else if (mode === "option") {
				if (!containerFile) return
				throwIfAborted(abortController.signal)
				const exfatSource = await openFscryptSource(byteSourceFromPickedFile(containerFile), {
					expectedContainerType: FSCRYPT_CONTAINER_TYPE.OPTION,
					keyFile: keySource,
					onLog: appendLog
				})
				const folderName = stripExtension(exfatSource.outputFilename)
				const outputSegments = outputSegmentsForFolder(outputRoot, folderName)
				let totalBytes = exfatSource.size
				setRunStats(current => ({ ...current, totalBytes }))
				if (outputSegments.length > 0) {
					await window.fsdecryptGUI.prepareOutputFolder(outputRoot, outputSegments)
				}
				const writer = createFolderWriter(outputRoot, folderName, () => totalBytes, setProgress, abortController.signal, noteBytesWritten)
				const extracted = await extractExfatContents(exfatSource, writer, {
					onLog: appendLog,
					onTotalBytes: bytes => {
						totalBytes = bytes
						setRunStats(current => ({ ...current, totalBytes: bytes }))
					},
					signal: abortController.signal
				})
				setResult({
					outputFolder: sanitizePathSegment(folderName),
					outputSegments,
					outputSize: extracted.bytes,
					details: [
						...elapsedDetails(),
						{ label: "Type", value: describeContainerType(exfatSource.bootId.containerType) },
						{ label: "Game", value: exfatSource.bootId.gameId },
						{ label: "Option", value: exfatSource.bootId.targetOption },
						{ label: "Files", value: extracted.files.toLocaleString() },
						{ label: "Folders", value: extracted.directories.toLocaleString() }
					]
				})
			} else {
				throwIfAborted(abortController.signal)
				const appFiles = vhdFiles.filter(f => f.name.toLowerCase().endsWith(".app"))
				const rawVhdFiles = vhdFiles.filter(f => !f.name.toLowerCase().endsWith(".app"))
				const appVhds =
					appFiles.length > 0
						? await appContainersToVhdSources(appFiles.map(byteSourceFromPickedFile), { keyFile: keySource, onLog: appendLog })
						: []
				throwIfAborted(abortController.signal)
				const ntfsSource = await openVhdChainNtfsSource([...rawVhdFiles.map(byteSourceFromPickedFile), ...appVhds], { onLog: appendLog })
				const topName = appFiles.at(-1)?.name ?? rawVhdFiles.at(-1)?.name ?? ntfsSource.name
				setResult(await extractNtfsSource(ntfsSource, stripExtension(topName), elapsedDetails, abortController.signal, noteBytesWritten))
			}

			setProgress(100)
			appendLog("Done")
		} catch (error) {
			console.error(error)
			if (isAbortError(error)) {
				setProgress(0)
				appendLog("Cancelled")
			} else {
				appendLog(error instanceof Error ? `ERROR: ${error.message}` : "ERROR: fsdecrypt failed")
			}
		} finally {
			abortControllerRef.current = null
			setIsBusy(false)
		}
	}

	return (
		<div className="app-shell">
			<header className="titlebar">
				<div>
					<h1>fsdecryptGUI</h1>
					<p>Extract APP, Option, and VHD chain contents to a local folder.</p>
				</div>
				<div className="actions">
					<button type="button" className="primary" disabled={!canRun} onClick={run}>
						<Zap size={16} />
						Extract
					</button>
					{isBusy ? (
						<button type="button" onClick={cancelRun}>
							<X size={16} />
							Cancel
						</button>
					) : (
						<button type="button" onClick={reset}>
							<RotateCcw size={16} />
							Reset
						</button>
					)}
				</div>
			</header>

			<main className="workspace">
				<section className="left-panel">
					<ModeToggle mode={mode} onChange={next => { setMode(next); setResult(null) }} />

					{mode === "vhd" ? (
						<button type="button" className="wide-button" disabled={isBusy} onClick={chooseApps}>
							<HardDriveDownload size={17} />
							Choose Apps
						</button>
					) : (
						<button type="button" className="wide-button" disabled={isBusy} onClick={chooseContainer}>
							<FileArchive size={17} />
							{mode === "option" ? "Choose Options" : "Choose Base"}
						</button>
					)}
					<button type="button" className="wide-button" disabled={isBusy} onClick={chooseKey}>
						<FileKey size={17} />
						Choose Key
					</button>

					<div className="info-block">
						<label>Selected</label>
						{selectedFiles.length === 0 ? (
							<div className="muted">None</div>
						) : (
							selectedFiles.map(file => (
								<div className="file-row" key={file.path}>
									<strong>{file.name}</strong>
									<span>{formatBytes(file.size)}</span>
								</div>
							))
						)}
						<hr />
						<label>Key</label>
						<strong className="truncate">{keyFile?.name ?? "Built-in"}</strong>
						<hr />
						<label>Output Root</label>
						<strong className="truncate">{outputRoot ? basename(outputRoot) : "File > Select Output Folder"}</strong>
						<hr />
						<label>Config Folder</label>
						<div className="path-action-row">
							<strong className="truncate" title={configFolder || configPath || "config.yaml"}>
								{configFolder ? compactPath(configFolder) : "config.yaml"}
							</strong>
							<button
								type="button"
								className="icon-button"
								disabled={!configFolder}
								title="Open config folder"
								aria-label="Open config folder"
								onClick={openConfigFolder}
							>
								<FolderOpen size={16} />
							</button>
						</div>
					</div>
				</section>

				<section className="main-panel">
					<div className="summary-grid">
						<div>
							<label>Mode</label>
							<strong>{modeLabel}</strong>
						</div>
						<div>
							<label>Files</label>
							<strong>{selectedFiles.length}</strong>
						</div>
						<div>
							<label>Output</label>
							<div className={result ? "path-action-row" : ""}>
								<strong className={!result ? "muted" : ""}>{result?.outputFolder ?? "Pending"}</strong>
								{result && (
									<button
										type="button"
										className="icon-button"
										title="Open output folder"
										aria-label="Open output folder"
										onClick={openResultFolder}
									>
										<FolderOpen size={16} />
									</button>
								)}
							</div>
						</div>
					</div>

					{(isBusy || progress > 0) && (
						<div className="progress-block">
							<div>
								<span>Progress</span>
								<strong>{progress}%</strong>
							</div>
							<progress value={progress} max={100} />
							<div className="stats-grid">
								<div>
									<label>Elapsed</label>
									<strong>{formatDuration(runStats.elapsedMs)}</strong>
								</div>
								<div>
									<label>Throughput</label>
									<strong>{formatThroughput(runStats.bytesWritten, runStats.elapsedMs)}</strong>
								</div>
								<div>
									<label>ETA</label>
									<strong>{formatEta(runStats)}</strong>
								</div>
							</div>
						</div>
					)}

					{result ? (
						<div className="result-grid">
							{result.details.map(detail => (
								<div key={detail.label}>
									<label>{detail.label}</label>
									<strong>{detail.value}</strong>
								</div>
							))}
							<div>
								<label>Size</label>
								<strong>{formatBytes(result.outputSize)}</strong>
							</div>
						</div>
					) : (
						<div className="empty-state">Ready</div>
					)}
				</section>

				<section className="log-panel">
					<div className="log-title">
						<Terminal size={16} />
						Log
					</div>
					<div className="terminal" ref={terminalRef}>
						{logs.map((line, index) => (
							<div key={`${line}-${index}`}>{line}</div>
						))}
					</div>
				</section>
			</main>
		</div>
	)
}
