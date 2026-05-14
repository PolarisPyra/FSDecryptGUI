import type { ReadableByteSource } from "../../../fsdecrypt/byte-source"
import type { NtfsExtractionWriter } from "../../../fsdecrypt/ntfs"
import { formatBytes, formatVersion } from "../../base/common/format"
import { stripExtension } from "../../base/common/path"
import { PickedFile, byteSourceFromPickedFile } from "../../electron-api"
import type {
	AppLayerInfo,
	BaseSelectionGroup,
	KeyValidation,
	MergeSelectionGroup,
	OptionLayerInfo,
	OptionSelectionGroup,
	OptionVhdLayerInfo,
	VersionLike
} from "../common/workbenchTypes"

export function appendPickedFiles(current: PickedFile[], picked: PickedFile[]) {
	const merged = [...current]
	const seen = new Set(current.map(file => file.path))
	for (const file of picked) {
		if (seen.has(file.path)) continue
		seen.add(file.path)
		merged.push(file)
	}

	return merged
}

export function validateKeyFile(file: PickedFile | null): KeyValidation {
	if (!file) {
		return {
			status: "builtin",
			label: "Built-in",
			detail: "Built-in key table active"
		}
	}

	if (file.size === 16 || file.size === 32) {
		return {
			status: "valid",
			label: "Custom",
			detail: `Custom key active · ${file.size} bytes`
		}
	}

	return {
		status: "invalid",
		label: "Invalid",
		detail: `Expected 16 or 32 bytes · ${formatBytes(file.size)} selected`,
		error: "External key file must be 16 or 32 bytes"
	}
}

export function filesystemFromBootSector(boot: Uint8Array) {
	const oemId = new TextDecoder("ascii").decode(boot.slice(3, 11))
	if (oemId === "EXFAT   ") return "exFAT"
	if (oemId === "NTFS    ") return "NTFS"
	return undefined
}

export function versionKey(version: VersionLike) {
	return `${version.major}.${version.minor}.${version.release}`
}

export function appLayerLabel(layer: AppLayerInfo) {
	if (!layer.bootId) {
		return "Unknown APP"
	}

	return `${layer.bootId.gameId} ${formatVersion(layer.bootId.targetVersion)}`
}

export function optionLabel(layer: OptionLayerInfo) {
	if (!layer.bootId) {
		return stripExtension(layer.file.name)
	}

	return `${layer.bootId.gameId} ${layer.bootId.targetOption}`
}

export function missingOptionParent(layer: OptionLayerInfo, allVhds: OptionVhdLayerInfo[]) {
	return layer.vhdLayers.find(vhd => vhd.parentId && !allVhds.some(candidate => candidate.ownId === vhd.parentId))
}

export function linkedOptionParent(layer: OptionLayerInfo, allVhds: OptionVhdLayerInfo[]) {
	return layer.vhdLayers.find(vhd => vhd.parentId && allVhds.some(candidate => candidate.ownId === vhd.parentId))
}

export function linkedOptionChild(layer: OptionLayerInfo, allVhds: OptionVhdLayerInfo[]) {
	return layer.vhdLayers.find(vhd => allVhds.some(candidate => candidate.parentId === vhd.ownId))
}

export function optionLayerClass(layer: OptionLayerInfo, allVhds: OptionVhdLayerInfo[]) {
	if (layer.error || missingOptionParent(layer, allVhds)) {
		return "chain-layer missing"
	}

	return linkedOptionParent(layer, allVhds) || linkedOptionChild(layer, allVhds) ? "chain-layer linked" : "chain-layer"
}

export function optionLayerDetail(layer: OptionLayerInfo, allVhds: OptionVhdLayerInfo[]) {
	if (layer.error) {
		return layer.error
	}

	if (layer.vhdLayers.length === 0) {
		return layer.bootId ? `No internal VHD found · ${optionLabel(layer)}` : "No internal VHD found"
	}

	const missingParent = missingOptionParent(layer, allVhds)
	if (missingParent?.parentId) {
		return `Child VHD · missing parent ${missingParent.parentId.slice(0, 8)}`
	}

	const linkedParent = linkedOptionParent(layer, allVhds)
	if (linkedParent?.parentId) {
		const parent = allVhds.find(candidate => candidate.ownId === linkedParent.parentId)
		return `Child VHD · parent ${parent?.optionFileName ?? linkedParent.parentId.slice(0, 8)}`
	}

	const linkedChild = linkedOptionChild(layer, allVhds)
	if (linkedChild) {
		const child = allVhds.find(candidate => candidate.parentId === linkedChild.ownId)
		return `Parent VHD · child ${child?.optionFileName ?? linkedChild.name}`
	}

	const firstVhd = layer.vhdLayers[0]
	return `${firstVhd.diskType} · ${firstVhd.name}`
}

async function inspectAppLayers(files: PickedFile[], keySource: ReadableByteSource | undefined): Promise<AppLayerInfo[]> {
	const appFiles = files.filter(file => file.name.toLowerCase().endsWith(".app"))
	const { openFscryptSource } = await import("../../../fsdecrypt/fsdecrypt")
	const layers: AppLayerInfo[] = await Promise.all(
		appFiles.map(async file => {
			try {
				const source = await openFscryptSource(byteSourceFromPickedFile(file), { keyFile: keySource })
				return { file, bootId: source.bootId }
			} catch (error) {
				return { file, error: error instanceof Error ? error.message : "Could not read APP metadata" }
			}
		})
	)

	const withParents = layers.map(layer => {
		if (!layer.bootId || layer.bootId.sequenceNumber === 0) {
			return layer
		}

		const parent = layers.find(candidate => {
			return (
				candidate.bootId &&
				candidate.bootId.gameId === layer.bootId?.gameId &&
				versionKey(candidate.bootId.targetVersion) === versionKey(layer.bootId.sourceVersion)
			)
		})

		return { ...layer, parentFile: parent?.file }
	})

	return withParents.map(layer => ({
		...layer,
		childFile: withParents.find(candidate => candidate.parentFile?.path === layer.file.path)?.file
	}))
}

export async function buildMergeGroups(files: PickedFile[], keySource: ReadableByteSource | undefined): Promise<MergeSelectionGroup[]> {
	const rawVhds = files.filter(file => file.name.toLowerCase().endsWith(".vhd"))
	const appLayers = await inspectAppLayers(files, keySource)
	const groups = new Map<string, AppLayerInfo[]>()

	for (const layer of appLayers) {
		let root = layer
		let guard = 0
		while (root.parentFile && guard < appLayers.length) {
			const nextRoot = appLayers.find(candidate => candidate.file.path === root.parentFile?.path)
			if (!nextRoot) break
			root = nextRoot
			guard += 1
		}

		const key = root.bootId
			? `${root.bootId.gameId}:${versionKey(root.bootId.targetVersion)}:${root.file.path}`
			: `unknown:${root.file.path}`
		groups.set(key, [...(groups.get(key) ?? []), layer])
	}

	const result: MergeSelectionGroup[] = [...groups.values()].map((layers, index) => {
		const sorted = [...layers].sort((left, right) => (left.bootId?.sequenceNumber ?? 0) - (right.bootId?.sequenceNumber ?? 0))
		const first = sorted[0]
		const last = sorted[sorted.length - 1]
		const missingParent = sorted.find(layer => layer.bootId && layer.bootId.sequenceNumber > 0 && !layer.parentFile)
		const hasErrors = sorted.find(layer => layer.error)
		const label = last?.bootId ? `${last.bootId.gameId} ${formatVersion(last.bootId.targetVersion)}` : `APP Chain ${index + 1}`

		return {
			id: sorted.map(layer => layer.file.path).join("|"),
			label,
			files: sorted.map(layer => layer.file),
			appLayers: sorted,
			rawVhds: [],
			warning: hasErrors
				? "Metadata read failed; extraction may still fail."
				: missingParent
					? `${first?.bootId?.gameId ?? "APP"} ${formatVersion(missingParent.bootId!.sourceVersion)} parent is not selected.`
					: undefined
		}
	})

	if (rawVhds.length > 0) {
		result.push({
			id: rawVhds.map(file => file.path).join("|"),
			label: rawVhds.length === 1 ? stripExtension(rawVhds[0].name) : `Raw VHD Chain (${rawVhds.length})`,
			files: rawVhds,
			appLayers: [],
			rawVhds,
			warning: appLayers.length > 0 ? "Raw VHD files are exported as a separate chain from selected APP files." : undefined
		})
	}

	return result
}

export async function buildBaseGroups(files: PickedFile[], keySource: ReadableByteSource | undefined): Promise<BaseSelectionGroup[]> {
	const groups = await buildMergeGroups(files, keySource)
	return groups.map(group => {
		const childLayer = group.appLayers.find(layer => layer.bootId && layer.bootId.sequenceNumber > 0)
		const missingParent = group.appLayers.find(layer => layer.bootId && layer.bootId.sequenceNumber > 0 && !layer.parentFile)
		const warning = group.warning
			? group.warning
			: missingParent
				? `${missingParent.file.name} is a child APP and its parent/base APP is not selected.`
				: childLayer
					? `${childLayer.file.name} is a child APP. Use Merge when extracting a parent-child APP chain.`
					: undefined

		return {
			...group,
			hasChildLayer: Boolean(childLayer),
			warning
		}
	})
}

async function inspectOptionLayers(files: PickedFile[], keySource: ReadableByteSource | undefined): Promise<OptionLayerInfo[]> {
	const [{ FSCRYPT_CONTAINER_TYPE, openFscryptSource }, { extractNtfsContents }, { extractExfatContents }, { inspectVhdLayers }] = await Promise.all([
		import("../../../fsdecrypt/fsdecrypt"),
		import("../../../fsdecrypt/ntfs"),
		import("../../../fsdecrypt/exfat"),
		import("../../../fsdecrypt/vhd")
	])

	return Promise.all(
		files.map(async file => {
			const vhdLayers: OptionVhdLayerInfo[] = []

			try {
				const collectFromOption = async (source: ReadableByteSource) => {
					const optionSource = await openFscryptSource(source, {
						expectedContainerType: FSCRYPT_CONTAINER_TYPE.OPTION,
						keyFile: keySource
					})
					const fileSystem = filesystemFromBootSector(await optionSource.read(0, 512))
					if (!fileSystem) {
						throw new Error(`${optionSource.outputFilename} is not an exFAT or NTFS image`)
					}

					const collector: NtfsExtractionWriter = {
						createDirectory: async () => {},
						writeFile: async (_path, childSource) => {
							const name = childSource.name.toLowerCase()
							if (name.endsWith(".opt")) {
								await collectFromOption(childSource)
								return
							}
							if (name.endsWith(".vhd")) {
								const [vhdLayer] = await inspectVhdLayers([childSource])
								vhdLayers.push({
									...vhdLayer,
									optionFilePath: file.path,
									optionFileName: file.name,
									sourceOptionName: optionSource.outputFilename
								})
							}
						}
					}

					if (fileSystem === "NTFS") {
						await extractNtfsContents(optionSource, collector)
					} else {
						await extractExfatContents(optionSource, collector)
					}

					return optionSource.bootId
				}

				const bootId = await collectFromOption(byteSourceFromPickedFile(file))
				return { file, bootId, vhdLayers }
			} catch (error) {
				return {
					file,
					error: error instanceof Error ? error.message : "Could not read OPTION metadata",
					vhdLayers
				}
			}
		})
	)
}

function connectedOptionGroups(optionLayers: OptionLayerInfo[]) {
	const allVhds = optionLayers.flatMap(layer => layer.vhdLayers)
	const byOwnId = new Map(allVhds.map(vhd => [vhd.ownId, vhd]))
	const childrenByParentId = new Map<string, OptionVhdLayerInfo[]>()
	for (const vhd of allVhds) {
		if (!vhd.parentId) continue
		childrenByParentId.set(vhd.parentId, [...(childrenByParentId.get(vhd.parentId) ?? []), vhd])
	}

	const visited = new Set<string>()
	const groups: Array<{ layerPaths: Set<string>; vhdIds: Set<string> }> = []
	for (const vhd of allVhds) {
		if (visited.has(vhd.ownId)) continue
		const layerPaths = new Set<string>()
		const vhdIds = new Set<string>()
		const queue = [vhd]

		while (queue.length > 0) {
			const current = queue.shift()!
			if (visited.has(current.ownId)) continue
			visited.add(current.ownId)
			vhdIds.add(current.ownId)
			layerPaths.add(current.optionFilePath)

			if (current.parentId) {
				const parent = byOwnId.get(current.parentId)
				if (parent) queue.push(parent)
			}
			for (const child of childrenByParentId.get(current.ownId) ?? []) {
				queue.push(child)
			}
		}

		groups.push({ layerPaths, vhdIds })
	}

	const groupedPaths = new Set([...groups].flatMap(group => [...group.layerPaths]))
	for (const layer of optionLayers) {
		if (!groupedPaths.has(layer.file.path)) {
			groups.push({ layerPaths: new Set([layer.file.path]), vhdIds: new Set() })
		}
	}

	return groups
}

function optionChainDepth(layer: OptionLayerInfo, allVhds: OptionVhdLayerInfo[]) {
	const first = layer.vhdLayers[0]
	if (!first) {
		return layer.bootId?.sequenceNumber ?? 0
	}

	let depth = 0
	let parentId = first.parentId
	const seen = new Set<string>()
	while (parentId && !seen.has(parentId)) {
		seen.add(parentId)
		const parent = allVhds.find(vhd => vhd.ownId === parentId)
		if (!parent) break
		depth += 1
		parentId = parent.parentId
	}

	return depth || layer.bootId?.sequenceNumber || 0
}

export async function buildOptionGroups(files: PickedFile[], keySource: ReadableByteSource | undefined): Promise<OptionSelectionGroup[]> {
	const optionLayers = await inspectOptionLayers(files, keySource)
	const allVhds = optionLayers.flatMap(layer => layer.vhdLayers)
	const groups = connectedOptionGroups(optionLayers)

	return groups.map((group, index) => {
		const layers = optionLayers
			.filter(layer => group.layerPaths.has(layer.file.path))
			.sort((left, right) => optionChainDepth(left, allVhds) - optionChainDepth(right, allVhds))
		const hasErrors = layers.some(layer => layer.error)
		const hasMissingParent = layers.some(layer => missingOptionParent(layer, allVhds))
		const gameIds = new Set(layers.map(layer => layer.bootId?.gameId).filter(Boolean))
		const label =
			gameIds.size === 1
				? `${[...gameIds][0]} ${layers.map(layer => layer.bootId?.targetOption ?? stripExtension(layer.file.name)).join(" -> ")}`
				: layers.length === 1
					? stripExtension(layers[0].file.name)
					: `OPTION VHD Chain ${index + 1}`

		return {
			id: layers.map(layer => layer.file.path).join("|"),
			label,
			files: layers.map(layer => layer.file),
			optionLayers: layers,
			warning: hasErrors
				? "Metadata read failed; extraction may still fail."
				: hasMissingParent
					? "A child VHD is missing its selected parent/base layer."
					: undefined
		}
	})
}
