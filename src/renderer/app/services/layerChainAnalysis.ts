import type { ReadableByteSource } from "../../../fsdecrypt/byte-source"
import type { VhdLayerInfo } from "../../../fsdecrypt/vhd"
import type { NtfsExtractionWriter } from "../../../fsdecrypt/ntfs"
import { formatVersion } from "../../base/common/format"
import { stripExtension } from "../../base/common/path"
import { PickedFile, byteSourceFromPickedFile } from "../../electron-api"
import type { AppLayerInfo, BaseSelectionGroup, LayerDisplayInfo, MergeSelectionGroup, OptionLayerInfo, OptionSelectionGroup, OptionVhdLayerInfo, VersionLike } from "../common/appTypes"

// Converts selected APPs, OPTIONs, and raw VHD Layers into Selection Groups.
// Blocking Warning decisions live here so every caller reads the same Layer Chain model.
export function filesystemFromBootSector(boot: Uint8Array) {
	const oemId = new TextDecoder("ascii").decode(boot.slice(3, 11))
	if (oemId === "EXFAT   ") return "exFAT"
	if (oemId === "NTFS    ") return "NTFS"
	return undefined
}

/**
 * Creates a stable comparable key for fscrypt version metadata.
 *
 * @param version Version-like object from boot metadata.
 * @returns Dot-separated version key.
 */
export function versionKey(version: VersionLike) {
	return `${version.major}.${version.minor}.${version.release}`
}

function appLayerLabel(layer: Pick<AppLayerInfo, "bootId">) {
	if (!layer.bootId) {
		return "Unknown APP"
	}

	return `${layer.bootId.gameId} ${formatVersion(layer.bootId.targetVersion)}`
}

function optionLabel(layer: Pick<OptionLayerInfo, "bootId" | "file">) {
	if (!layer.bootId) {
		return stripExtension(layer.file.name)
	}

	return `${layer.bootId.gameId} ${layer.bootId.targetOption}`
}

function missingOptionParent(layer: OptionLayerInfo, allVhds: OptionVhdLayerInfo[]) {
	return layer.vhdLayers.find(vhd => vhd.parentId && !allVhds.some(candidate => candidate.ownId === vhd.parentId))
}

function linkedOptionParent(layer: OptionLayerInfo, allVhds: OptionVhdLayerInfo[]) {
	return layer.vhdLayers.find(vhd => vhd.parentId && allVhds.some(candidate => candidate.ownId === vhd.parentId))
}

function linkedOptionChild(layer: OptionLayerInfo, allVhds: OptionVhdLayerInfo[]) {
	return layer.vhdLayers.find(vhd => allVhds.some(candidate => candidate.parentId === vhd.ownId))
}

/**
 * Builds display metadata for an APP layer after parent/child matching.
 *
 * @param layer APP metadata plus any discovered relations.
 * @returns UI-friendly layer state and detail text.
 */
function appLayerDisplay(layer: Pick<AppLayerInfo, "bootId" | "childFile" | "error" | "parentFile">): LayerDisplayInfo {
	if (layer.error) {
		return { state: "missing", role: "error", detail: layer.error }
	}

	if (layer.bootId?.sequenceNumber === 0) {
		return layer.childFile
			? { state: "linked", role: "parent", detail: `Parent layer · child ${layer.childFile.name}` }
			: { state: "linked", role: "standalone", detail: `Parent layer · ${appLayerLabel(layer)}` }
	}

	if (layer.parentFile) {
		return { state: "linked", role: "child", detail: `Child layer · parent ${layer.parentFile.name}` }
	}

	if (layer.bootId) {
		return { state: "missing", role: "missing", detail: `Child layer · missing parent ${formatVersion(layer.bootId.sourceVersion)}` }
	}

	return { state: "missing", role: "error", detail: "Unknown APP" }
}

/**
 * Builds display metadata for an OPTION's internal VHD Layer state.
 *
 * @param layer OPTION metadata and discovered internal VHD Layers.
 * @param allVhds All VHD Layers from the current OPTION Selection Queue.
 * @returns UI-friendly layer state and detail text.
 */
function optionLayerDisplay(layer: OptionLayerInfo, allVhds: OptionVhdLayerInfo[]): LayerDisplayInfo {
	if (layer.error) {
		return { state: "missing", role: "error", detail: layer.error }
	}

	if (layer.vhdLayers.length === 0) {
		return {
			state: "standalone",
			role: "standalone",
			detail: layer.bootId ? `No internal VHD found · ${optionLabel(layer)}` : "No internal VHD found"
		}
	}

	const missingParent = missingOptionParent(layer, allVhds)
	if (missingParent?.parentId) {
		return { state: "missing", role: "missing", detail: `Child VHD · missing parent ${missingParent.parentId.slice(0, 8)}` }
	}

	const linkedParent = linkedOptionParent(layer, allVhds)
	if (linkedParent?.parentId) {
		const parent = allVhds.find(candidate => candidate.ownId === linkedParent.parentId)
		return { state: "linked", role: "child", detail: `Child VHD · parent ${parent?.optionFileName ?? linkedParent.parentId.slice(0, 8)}` }
	}

	const linkedChild = linkedOptionChild(layer, allVhds)
	if (linkedChild) {
		const child = allVhds.find(candidate => candidate.parentId === linkedChild.ownId)
		return { state: "linked", role: "parent", detail: `Parent VHD · child ${child?.optionFileName ?? linkedChild.name}` }
	}

	const firstVhd = layer.vhdLayers[0]
	return { state: "standalone", role: "standalone", detail: `${firstVhd.diskType} · ${firstVhd.name}` }
}

/**
 * Detects Blocking Warnings for a raw VHD Chain.
 *
 * @param layers Parsed VHD Layer metadata.
 * @returns Warning text when the chain is incomplete or ambiguous.
 */
function rawVhdWarning(layers: VhdLayerInfo[]) {
	const bases = layers.filter(layer => layer.diskType !== "differencing/child")
	if (bases.length === 0) {
		return "VHD Chain is missing its Parent Layer."
	}

	if (bases.length > 1) {
		return "VHD Chain has multiple base layers."
	}

	let currentId = bases[0].ownId
	const remaining = layers.filter(layer => layer.ownId !== currentId)
	while (remaining.length > 0) {
		const nextIndex = remaining.findIndex(layer => layer.parentId === currentId)
		if (nextIndex === -1) {
			return "VHD Chain is missing an intermediate Parent Layer."
		}

		const [next] = remaining.splice(nextIndex, 1)
		currentId = next.ownId
	}

	return undefined
}

/**
 * Reads APP metadata and links child APPs to selected Parent Layers.
 *
 * @param files Picked files from Base or Merge.
 * @param keySource Optional Custom Key File source.
 * @returns APP layer metadata with display state.
 */
async function inspectAppLayers(files: PickedFile[], keySource: ReadableByteSource | undefined): Promise<AppLayerInfo[]> {
	const appFiles = files.filter(file => file.name.toLowerCase().endsWith(".app"))
	const { openFscryptSource } = await import("../../../fsdecrypt/fsdecrypt")
	const layers: Array<Omit<AppLayerInfo, "display">> = await Promise.all(
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

	return withParents.map(layer => {
		const withChild = {
			...layer,
			childFile: withParents.find(candidate => candidate.parentFile?.path === layer.file.path)?.file
		}
		return { ...withChild, display: appLayerDisplay(withChild) }
	})
}

/**
 * Builds Merge Selection Groups from APP Chains and raw VHD Layers.
 *
 * @param files Picked APP/VHD files.
 * @param keySource Optional Custom Key File source.
 * @returns Merge groups with Blocking Warnings and Notices attached.
 */
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
			selected: true,
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
		const rawVhdLayers = await inspectRawVhdLayers(rawVhds)
		result.push({
			id: rawVhds.map(file => file.path).join("|"),
			selected: true,
			label: rawVhds.length === 1 ? stripExtension(rawVhds[0].name) : `Raw VHD Chain (${rawVhds.length})`,
			files: rawVhds,
			appLayers: [],
			rawVhds,
			warning: rawVhdLayers.warning,
			notice: appLayers.length > 0 ? "Raw VHD Layers will be extracted separately from selected APPs." : undefined
		})
	}

	return result
}

async function inspectRawVhdLayers(rawVhds: PickedFile[]) {
	const { inspectVhdLayers } = await import("../../../fsdecrypt/vhd")
	try {
		const layers = await inspectVhdLayers(rawVhds.map(file => byteSourceFromPickedFile(file)))
		return { warning: rawVhdWarning(layers) }
	} catch (error) {
		return { warning: error instanceof Error ? error.message : "Could not read VHD Chain metadata." }
	}
}

/**
 * Builds Base Selection Groups by reusing Merge analysis and tightening warnings.
 *
 * @param files Picked APP files.
 * @param keySource Optional Custom Key File source.
 * @returns Base groups that block child APP extraction outside Merge.
 */
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

/**
 * Reads OPTION metadata, nested OPTIONs, and internal VHD Layers.
 *
 * @param files Picked OPTION files.
 * @param keySource Optional Custom Key File source.
 * @returns OPTION layer metadata with discovered internal VHD Layers.
 */
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
					return {
						file,
						bootId,
						vhdLayers,
						display: { state: "standalone", role: "standalone", detail: "" } satisfies LayerDisplayInfo
					}
				} catch (error) {
					return {
						file,
						error: error instanceof Error ? error.message : "Could not read OPTION metadata",
						vhdLayers,
						display: { state: "missing", role: "error", detail: error instanceof Error ? error.message : "Could not read OPTION metadata" } satisfies LayerDisplayInfo
					}
				}
			})
	)
}

/**
 * Connects OPTIONs that participate in the same VHD Chain graph.
 *
 * @param optionLayers OPTION metadata from the current Selection Queue.
 * @returns Sets of OPTION paths that form Selection Groups.
 */
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

/**
 * Estimates a display sort depth for OPTIONs based on VHD parent links.
 *
 * @param layer OPTION layer being sorted.
 * @param allVhds All VHD Layers from the current queue.
 * @returns Chain depth used for stable parent-before-child sorting.
 */
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

/**
 * Builds Option Selection Groups and their Blocking Warnings.
 *
 * @param files Picked OPTION files.
 * @param keySource Optional Custom Key File source.
 * @returns OPTION groups sorted by VHD dependency order.
 */
export async function buildOptionGroups(files: PickedFile[], keySource: ReadableByteSource | undefined): Promise<OptionSelectionGroup[]> {
	const optionLayers = await inspectOptionLayers(files, keySource)
	const allVhds = optionLayers.flatMap(layer => layer.vhdLayers)
	const groups = connectedOptionGroups(optionLayers)

	return groups.map((group, index) => {
		const layers = optionLayers
			.filter(layer => group.layerPaths.has(layer.file.path))
			.sort((left, right) => optionChainDepth(left, allVhds) - optionChainDepth(right, allVhds))
			.map(layer => ({ ...layer, display: optionLayerDisplay(layer, allVhds) }))
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
			selected: true,
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
