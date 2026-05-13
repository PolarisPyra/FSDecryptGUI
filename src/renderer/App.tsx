import { useEffect, useMemo, useRef, useState } from "react"

import { FileArchive, FileKey, FolderOpen, HardDriveDownload, RotateCcw, Terminal, Zap } from "lucide-react"

import { ReadableByteSource } from "../fsdecrypt/byte-source"
import { extractExfatContents } from "../fsdecrypt/exfat"
import { FSCRYPT_CONTAINER_TYPE, describeContainerType, openFscryptSource } from "../fsdecrypt/fsdecrypt"
import { NtfsExtractionWriter, appContainersToVhdSources, extractNtfsContents, scanNtfsBytes } from "../fsdecrypt/ntfs"
import { VhdNtfsSource, openVhdChainNtfsSource } from "../fsdecrypt/vhd"
import { PickedFile, RendererConfig, byteSourceFromPickedFile } from "./electron-api"

type ToolMode = "container" | "option" | "vhd"

type CompletedResult = {
	outputFolder: string
	outputSize: number
	details: Array<{ label: string; value: string }>
}

const WRITE_CHUNK_SIZE = 8 * 1024 * 1024

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
	totalBytes: number,
	setProgress: (progress: number) => void
): NtfsExtractionWriter {
	let written = 0
	let lastProgressUpdate = 0
	const outputFolder = sanitizePathSegment(folderName)
	const outputRoot = basename(rootPath) === outputFolder ? [] : [outputFolder]
	const writePath = (path: string[]) => [...outputRoot, ...path.map(sanitizePathSegment)]

	const writeFile = async (path: string[], source: ReadableByteSource) => {
		const target = writePath(path)
		let wroteChunk = false

		for (let offset = 0; offset < source.size; offset += WRITE_CHUNK_SIZE) {
			const chunk = await source.read(offset, Math.min(WRITE_CHUNK_SIZE, source.size - offset))
			await window.fsdecryptGUI.writeFileChunk(rootPath, target, chunk, wroteChunk)
			wroteChunk = true
			written += chunk.length

			const now = performance.now()
			if (now - lastProgressUpdate > 250 || offset + chunk.length >= source.size) {
				lastProgressUpdate = now
				setProgress(Math.min(99, Math.round((written / Math.max(totalBytes, 1)) * 100)))
			}
		}

		if (!wroteChunk) {
			await window.fsdecryptGUI.writeFileChunk(rootPath, target, new Uint8Array(), false)
		}
	}

	return {
		createDirectory: path => window.fsdecryptGUI.ensureDirectory(rootPath, writePath(path)),
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
	const [logs, setLogs] = useState<string[]>(["Ready"])
	const [result, setResult] = useState<CompletedResult | null>(null)
	const terminalRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight })
	}, [logs])

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
		setLogs(["Ready"])
		setResult(null)
	}

	const openConfigFolder = async () => {
		try {
			await window.fsdecryptGUI.openConfigFolder()
		} catch (error) {
			appendLog(error instanceof Error ? `Could not open config folder: ${error.message}` : "Could not open config folder")
		}
	}

	const extractNtfsSource = async (
		ntfsSource: VhdNtfsSource,
		folderName: string,
		getExtraDetails: () => CompletedResult["details"] = () => []
	): Promise<CompletedResult> => {
		appendLog(`Scanning NTFS to calculate progress...`)
		const totalBytes = await scanNtfsBytes(ntfsSource, { onLog: appendLog })
		const writer = createFolderWriter(outputRoot, folderName, totalBytes, setProgress)
		const extracted = await extractNtfsContents(ntfsSource, writer, { onLog: appendLog })
		return {
			outputFolder: sanitizePathSegment(folderName),
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

		setIsBusy(true)
		setProgress(0)
		setLogs([])
		setResult(null)

		const startTime = performance.now()

		const elapsedDetails = (): CompletedResult["details"] => {
			const ms = performance.now() - startTime
			const value = ms < 60_000
				? `${(ms / 1000).toFixed(1)}s`
				: `${Math.floor(ms / 60_000)}m ${((ms % 60_000) / 1000).toFixed(0)}s`
			return [{ label: "Elapsed", value }]
		}

		try {
			appendLog(`Starting ${modeLabel} extract`)

			if (mode === "container") {
				if (!containerFile) return
				const [internalVhd] = await appContainersToVhdSources([byteSourceFromPickedFile(containerFile)], { keyFile: keySource, onLog: appendLog })
				const ntfsSource = await openVhdChainNtfsSource([internalVhd], { onLog: appendLog })
				setResult(await extractNtfsSource(ntfsSource, stripExtension(containerFile.name), elapsedDetails))
			} else if (mode === "option") {
				if (!containerFile) return
				const exfatSource = await openFscryptSource(byteSourceFromPickedFile(containerFile), {
					expectedContainerType: FSCRYPT_CONTAINER_TYPE.OPTION,
					keyFile: keySource,
					onLog: appendLog
				})
				const folderName = stripExtension(exfatSource.outputFilename)
				const writer = createFolderWriter(outputRoot, folderName, exfatSource.size, setProgress)
				const extracted = await extractExfatContents(exfatSource, writer, { onLog: appendLog })
				setResult({
					outputFolder: sanitizePathSegment(folderName),
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
				const appFiles = vhdFiles.filter(f => f.name.toLowerCase().endsWith(".app"))
				const rawVhdFiles = vhdFiles.filter(f => !f.name.toLowerCase().endsWith(".app"))
				const appVhds = appFiles.length > 0
					? await appContainersToVhdSources(appFiles.map(byteSourceFromPickedFile), { keyFile: keySource, onLog: appendLog })
					: []
				const ntfsSource = await openVhdChainNtfsSource([...rawVhdFiles.map(byteSourceFromPickedFile), ...appVhds], { onLog: appendLog })
				const topName = appVhds.at(-1)?.appName ?? rawVhdFiles.at(-1)?.name ?? ntfsSource.name
				setResult(await extractNtfsSource(ntfsSource, stripExtension(topName), elapsedDetails))
			}

			setProgress(100)
			appendLog("Done")
		} catch (error) {
			console.error(error)
			appendLog(error instanceof Error ? `ERROR: ${error.message}` : "ERROR: fsdecrypt failed")
		} finally {
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
					<button type="button" disabled={isBusy} onClick={reset}>
						<RotateCcw size={16} />
						Reset
					</button>
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
							<strong className={!result ? "muted" : ""}>{result?.outputFolder ?? "Pending"}</strong>
						</div>
					</div>

					{(isBusy || progress > 0) && (
						<div className="progress-block">
							<div>
								<span>Progress</span>
								<strong>{progress}%</strong>
							</div>
							<progress value={progress} max={100} />
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
