import { ReadableByteSource, byteSourceFromFile } from "./byte-source"
import { AesBlock, bytesToHex, decryptCbcInto, decryptCbcNoPadding, hexToBytes } from "./crypto"
import { decryptFscryptPages, getDecryptWorkerCount } from "./decrypt-pool"

export { calculatePageIv } from "./crypto"

const PAGE_SIZE = 4096
const BOOTID_SIZE = 96
const DECRYPT_CHUNK_SIZE = 32 * 1024 * 1024

const BOOTID_KEY = "09ca5efd30c9aaef3804d0a7e3fa7120"
const BOOTID_IV = "b155c22c2e7f0491fa7f0fdc217aff90"
const NTFS_HEADER = "eb52904e544653202020200010010000"
const EXFAT_HEADER = "eb769045584641542020200000000000"
const OPTION_KEY = "5c84a9e726eaa5dd351f2b0750c23697"
const OPTION_IV = "c063bf6f562d084d7963c987f5281761"
const APM3_KEYGEN_KEY = "873df632b988ae14aa9f736b03a51c4f"
const APM3_KEYGEN_IV = "357dc19030d8e8d4941a7e6aceb94e4c"
const APM3_KEYGEN_SEED =
	"C73CDDBF7AFB0EBCE6DED4D9B3DF3B03" +
	"3FE140E4F4FF96C579908B5B696ABEEE" +
	"326C5EEA47C0A34051DC55BF8C2A807B" +
	"E4C6E3EF2F153084693CE2D21EF1BB13" +
	"DCC96D317C3FCC7AB944636D65C28BB8" +
	"E2F7748DC64208A873414B787E3F1866"

export const FSCRYPT_CONTAINER_TYPE = {
	OS: 0,
	APP: 1,
	OPTION: 2
} as const

export type FscryptContainerType = (typeof FSCRYPT_CONTAINER_TYPE)[keyof typeof FSCRYPT_CONTAINER_TYPE]

type Version = {
	major: number
	minor: number
	release: number
}

type Timestamp = {
	year: number
	month: number
	day: number
	hour: number
	minute: number
	second: number
}

export type FscryptBootId = {
	containerType: FscryptContainerType
	sequenceNumber: number
	useCustomIv: boolean
	gameId: string
	osId: string
	targetTimestamp: Timestamp
	targetVersion: Version
	targetOption: string
	sourceVersion: Version
	osVersion: Version
	blockCount: bigint
	blockSize: bigint
	headerBlockCount: bigint
}

export type FsdecryptResult = {
	bootId: FscryptBootId
	outputFilename: string
	output?: Blob
	outputSize: number
	savedToFile: boolean
}

export type LocalOutputSink = {
	write: (chunk: Uint8Array) => Promise<void>
	close: () => Promise<void>
}

export type FscryptInput = File | ReadableByteSource

export type FsdecryptOptions = {
	keyFile?: FscryptInput
	expectedContainerType?: FscryptContainerType
	output?: LocalOutputSink | ((filename: string) => Promise<LocalOutputSink | undefined>)
	onProgress?: (progress: number) => void
	onLog?: (message: string) => void
}

type GameKeys = {
	key: string
	iv?: string
}

type ResolvedGameKeys = GameKeys & {
	source: "built-in" | "external" | "APM3"
}

const GAME_KEYS: Record<string, GameKeys> = {
	SBZS: { key: "2ecbcff65ce0abecc10547f8ac8351d8", iv: "f2ac6c2817d0574bba113d497e319f3e" },
	SBZT: { key: "9ab9ce55ed9c194a715a73a7699f795b", iv: "8552de88fedda6e859369fb000f44d5b" },
	SBZU: { key: "eb1228254cdd3077eb3e441c0227bf40", iv: "3f9b4676118cee129fe2f1cb2747bca5" },
	SBZV: { key: "3274a399594d84779625940b69c02d3f", iv: "675ba66d29c87923f5f154c406afee42" },
	SDAP: { key: "41b5027c5e99d94aa9335d6d71838ecf", iv: "41b5027c5e99d94aa9335d6d71838ecf" },
	SDAQ: { key: "c28f22bc1b339ae64180739886dc83d6", iv: "0a29fd145d72bf8dedd436025df0a9fc" },
	SDAV: { key: "eed95513266a499a55e265b049169c44", iv: "84c0e5931d91a6a477d62c271546056e" },
	SDBE: { key: "7053fb944572e5b631a665cef4b5bcdd", iv: "ae4d7e884002c79eb35711554d613057" },
	SDBN: { key: "c1f14ae2e85b095e313c8baec125805e", iv: "3c538eea66251acd5404b93f8976a7f7" },
	SDBT: { key: "a6a870671fd432ec637adf7a822f97da", iv: "2c277f31cd550cfa2c993b4dd56b85ae" },
	SDBX: { key: "3dc19c2d0c20ac199d5fa46e7f6335a6", iv: "d8f029ec90fe55be67584f742c55ef8b" },
	SDBZ: { key: "521bde4460f4184edd879136adeea5ee", iv: "1b8324032db69d7b0954794aa229fe68" },
	SDCA: { key: "1649490a03d6c2aec1c496982cb0405c", iv: "4680711c7e67a26f9230d5af74b5dcfb" },
	SDCD: { key: "43b38502d8f6d3c7b02b95fc28db5308", iv: "6dfcb94bf74f152b55f3e0c7f35b44b5" },
	SDCF: { key: "df986883da837538e37b959a3e4117cd", iv: "dabf539738852f17714811af70435a83" },
	SDCH: { key: "e2da769e94f1d3aca1930cdbe0708c9f", iv: "c7dcce203c84ab0477236d697570dadc" },
	SDCR: { key: "4961a51fd36f14e72664f52373052160", iv: "25d7d1341a282c5e0a34c64562c023ec" },
	SDCT: { key: "d6ae51f10ec76da93c981800fc3ad3cb", iv: "fb8e43e280d330d06581732f2e11a6dc" },
	SDCX: { key: "79504ccc509b67d1f7a3f593e6f9d9d6", iv: "1551ea8926f2aee233eec309de3e5f3c" },
	SDDB: { key: "875679b2cd1637962b0db25c51fb21a6", iv: "8ef44722a0566e8f572356245687fbe5" },
	SDDD: { key: "564e967873de6cbcd22efeca6952e9dc", iv: "4e3dd465cf09cd82b259f7bed5fc2d6d" },
	SDDF: { key: "65058573a0cb81749e694ae164c61b04", iv: "981c4f45e3c6958f054e5d00916bdf2b" },
	SDDJ: { key: "630fe52276537bd7fb267adf175f4e99", iv: "dc5755be57ded2cdb34433bbba2204ff" },
	SDDL: { key: "992458295fd06d6a8af0dfb3f6854c19", iv: "8484906d4cd5fd225e032843ed37495d" },
	SDDM: { key: "0127958210f6ae9bdeb8975018b5af24", iv: "181716badccff4bc2b1e29ae02a1bbbb" },
	SDDN: { key: "41dd8e66290117ac67d311a2f0a6416e", iv: "73e18e8418f6ceefb11e2767fdea190c" },
	SDDP: { key: "cf6d64427eeca47674e17bcd46d1ea8c", iv: "ce5174093d26ca2a31b58541e85ac276" },
	SDDS: { key: "161bec6d90989d0e26d791170607a440", iv: "81dc26a27028e2092332038aa1bffc47" },
	SDDT: { key: "3f7658728b9517d3314e684fa2e2a045", iv: "41578833c547aaff04db597a6e9eb784" },
	SDDU: { key: "649ae9982625f90c55af86713c55d3fd", iv: "187116fc4647a7d3b6f2303a34f0a2fe" },
	SDDW: { key: "118565d344f3e14ca69299eeac049bb9", iv: "9d6d392ec35ed94ef9fe0a5be0573981" },
	SDDX: { key: "428bff0f9e7aafc169a7a75751ffda98", iv: "f8250594f425332c6d349d7ea0e86669" },
	SDEA: { key: "9f9cf148ac3c50aaf925af1dfb27f58b", iv: "4d8ebbd971896b8a4a3dd84a23b329fc" },
	SDEB: { key: "d511ed690415f6359843a134fd47836a", iv: "ac139b382acdd112e31564ea7f38186c" },
	SDEC: { key: "f272e5016863af2ba0337f50de686f6e", iv: "5327e132631e7f71b61be7cc0df382ce" },
	SDED: { key: "21fcec779a16769f5277a36fb542992c", iv: "22b50239f1b40ccc3e55a2d69c69b160" },
	SDEE: { key: "191eb7440672dab08ddbb7195efb356f", iv: "c278b5386dc38bd76d71dbcd826954cf" },
	SDEG: { key: "721853dbe2d30bafe24f0edbd210deeb", iv: "4dfb0bcec86159aab297166bcd509e6f" },
	SDEJ: { key: "9de1ea6ae38d9011f55d8ee864395d24", iv: "f60cde21982876d12d17662a48d90836" },
	SDEM: { key: "700617f293696c07fb9f356d3b99240d", iv: "667d026d6cdf329ff351dbaf7098e81d" },
	SDEP: { key: "fa2b7ca53a823c152d940972cbf532f5", iv: "f4af35120c48617704bb5b8471797a62" },
	SDER: { key: "7d73367ebb218ec82930d58dc6d7950b", iv: "9788c3eca2db6ba92bac4f6f7b706308" },
	SDET: { key: "4643e7b2c3006e0264163edc8545fb72", iv: "612bca81ea2958ffbac36f780f1ed688" },
	SDEU: { key: "23b3e9bb47e3ac9998f6e6c1adc4ae33", iv: "a964714cea60688407bf554bd1c27ec2" },
	SDEV: { key: "3c1f018d88926d98163b07a1563a4818", iv: "ca7373c9c7dfebac0fc24254c030e4ad" },
	SDEZ: { key: "d136eba05d40e82682e6aad8d9e8688c", iv: "c484deeaa0249ef46695f63694b7372f" },
	SDFA: { key: "8e816b4362db24a230877885864d206d", iv: "8e5a0ba6a0a1150d47d12bdb64debba7" },
	SDFE: { key: "f61719c371e5bca6788c139a53091617", iv: "67d43173e343813fa2097fd32992a8e2" },
	SDFG: { key: "3398fb86bfe630a14979411879861ac7", iv: "a794c49c2c7639cd80571807c17246ff" },
	SDFL: { key: "2449b48067b9176a6e0f9563481e97f4", iv: "616f8710454632eb4fb1d89d8c19c19a" },
	SDFN: { key: "29f62e22c6a9fd8be327631c68546405", iv: "2a860976e6d98513825f291e56cfb5ee" },
	SDFP: { key: "570b87263a7ca0aa4c1388e204ee6d4b", iv: "7640886011a2300a91fad9f36a8c4775" },
	SDFT: { key: "92a25f388c50737e39c3c2f006645f31", iv: "a97e72f990417488cb4c67f8f0c3fb25" },
	SDFV: { key: "fe82db9a60295d829b95f03c2276018b", iv: "34d82772ae18174f0a181dc53399ea9c" },
	SDGA: { key: "0a6610a62ef670c65b7e7b1750ffb7a1", iv: "17a2a22915f81c5896edbba4c412585e" },
	SDGB: { key: "7ca4e6b6f3d6e8b26472973887d7fa3a", iv: "53fe7135762de3f97e7fe76b0fef3f27" },
	SDGH: { key: "b3e30e7eabac3767ade13c69c9b2f22b", iv: "03deaea3742d69675b36cddc8b15ac91" },
	SDGK: { key: "9dc4a17fc39fca5a8a358984801caaa7", iv: "e0445b11dcfa0dae56c85e8787e11d9b" },
	SDGP: { key: "c87ab31247e7b6ff95fdd79fb91f9f37", iv: "2467ab3c031e3dc0568b7077efd27c36" },
	SDGQ: { key: "c5356dae7b066bce88984aec36deb62d", iv: "4e9f2982460e2fd907bde15709edfba7" },
	SDGS: { key: "a5150cc5065d2c59ee2f8f332cbd29d5", iv: "84014d26696f290ad7ead70c7549bd81" },
	SDGT: { key: "9d0bba20d1e84f2459399f5383beee72", iv: "5d340013fdfb2464d253093602fe4b64" },
	SDGV: { key: "573f5c8cc44f10f31ec749b695ebe886", iv: "6bfca86f9d208a7944cdfc25ea3cd220" },
	SDGY: { key: "c04b663a59055acbdfebc6d3df0e6a04", iv: "76fc5f1d88605107947d0c1ff347022d" },
	SDGZ: { key: "9ad74efb208d6ee4fe5ee770331712cf", iv: "45f6e53f0eb8fae6665b45444a61e266" },
	SDHD: { key: "3abd00d7a820ce862eaf474bf6c8f33e", iv: "0f1e7eea78da7e037e0552c2843e1b6a" },
	SDHH: { key: "fc6f887f3717c5d6713113b92fa3fb27", iv: "ad76606460dbe1e91e41bef7ab0c1535" },
	SDHJ: { key: "985ea66ecb5b1f208c90e2b898f0b073", iv: "164a65422e7f01b7f1b0849fc7737cdb" },
	SDHK: { key: "bc92d63c2a099ca2315a483c3041fdd7", iv: "b14d8449b6d4325d83a2774b13dd21ff" },
	SDHN: { key: "892123a26d7c03d49edd12a80ee0c58f", iv: "76aa15a6868b8dbdf7207906354d5169" },
	SDHR: { key: "1fb897cab97c8170a6ac0a21685c58d9", iv: "f9b60f65b01e8e836a4bc20f7d39faf5" },
	ACA: { key: "e4281bcf48c4d28eb05772ce6f98587a", iv: "6cee7f5a2c4b5f1e93c5949114ff0b74" }
}

export const BUILT_IN_KEY_IDS = [...Object.keys(GAME_KEYS).sort(), "OPTION"]

const apm3KeyCache = new Map<string, GameKeys>()

function bytesEqual(left: Uint8Array, right: Uint8Array) {
	return left.length === right.length && left.every((value, index) => value === right[index])
}

function ascii(bytes: Uint8Array) {
	return new TextDecoder("ascii").decode(bytes).replace(/\0+$/g, "").trimEnd()
}

function readTimestamp(view: DataView, offset: number): Timestamp {
	return {
		year: view.getUint16(offset, true),
		month: view.getUint8(offset + 2),
		day: view.getUint8(offset + 3),
		hour: view.getUint8(offset + 4),
		minute: view.getUint8(offset + 5),
		second: view.getUint8(offset + 6)
	}
}

function readVersion(view: DataView, offset: number): Version {
	return {
		release: view.getUint8(offset),
		minor: view.getUint8(offset + 1),
		major: view.getUint16(offset + 2, true)
	}
}

function formatTimestamp(timestamp: Timestamp) {
	const pad = (value: number, length: number) => value.toString().padStart(length, "0")
	return `${pad(timestamp.year, 4)}${pad(timestamp.month, 2)}${pad(timestamp.day, 2)}${pad(timestamp.hour, 2)}${pad(timestamp.minute, 2)}${pad(timestamp.second, 2)}`
}

function formatVersion(version: Version) {
	return `${version.major.toString().padStart(4, "0")}.${version.minor.toString().padStart(2, "0")}.${version.release.toString().padStart(2, "0")}`
}

function parseBootId(encryptedBootId: Uint8Array): FscryptBootId {
	if (encryptedBootId.length !== BOOTID_SIZE) {
		throw new Error("Invalid bootid length")
	}

	const bootIdBytes = decryptCbcNoPadding(encryptedBootId, BOOTID_KEY, BOOTID_IV)
	const view = new DataView(bootIdBytes.buffer, bootIdBytes.byteOffset, bootIdBytes.byteLength)
	const containerType = view.getUint8(13) as FscryptContainerType

	if (![FSCRYPT_CONTAINER_TYPE.OS, FSCRYPT_CONTAINER_TYPE.APP, FSCRYPT_CONTAINER_TYPE.OPTION].includes(containerType)) {
		throw new Error(`Unknown container type ${containerType}`)
	}

	return {
		containerType,
		sequenceNumber: view.getUint8(14),
		useCustomIv: view.getUint8(15) !== 0,
		gameId: ascii(bootIdBytes.slice(16, 20)),
		osId: ascii(bootIdBytes.slice(64, 67)),
		targetTimestamp: readTimestamp(view, 20),
		targetVersion: readVersion(view, 28),
		targetOption: ascii(bootIdBytes.slice(28, 32)),
		blockCount: view.getBigUint64(32, true),
		blockSize: view.getBigUint64(40, true),
		headerBlockCount: view.getBigUint64(48, true),
		sourceVersion: readVersion(view, 76),
		osVersion: readVersion(view, 80)
	}
}

/** Recovers a custom file IV by decrypting the first encrypted block against an expected filesystem header. */
function calculateFileIv(key: string, expectedHeader: string, firstPage: Uint8Array) {
	const header = firstPage.slice(0, 16)
	const output = new Uint8Array(header.length)
	decryptCbcInto(new AesBlock(hexToBytes(key)), header, hexToBytes(expectedHeader), output)
	return output
}

function encryptCbcNoPadding(data: Uint8Array, keyHex: string, ivHex: string) {
	const cipher = new AesBlock(hexToBytes(keyHex))
	const output = new Uint8Array(data.length)
	let previous = new Uint8Array(hexToBytes(ivHex))

	for (let blockOffset = 0; blockOffset < data.length; blockOffset += 16) {
		const block = data.subarray(blockOffset, blockOffset + 16)
		const plain = new Uint8Array(16)
		for (let index = 0; index < 16; index++) {
			plain[index] = block[index] ^ previous[index]
		}
		const encrypted = cipher.encrypt(plain)
		output.set(encrypted, blockOffset)
		previous = new Uint8Array(encrypted)
	}

	return output
}

/** Derives APM3-style game keys from the bundled seed and the four-character game id. */
function deriveApm3GameKeys(gameId: string): GameKeys | undefined {
	if (gameId.length !== 4) {
		return undefined
	}

	const cached = apm3KeyCache.get(gameId)
	if (cached) {
		return cached
	}

	const seed = new Uint8Array(hexToBytes(APM3_KEYGEN_SEED))
	const decryptedSeed = decryptCbcNoPadding(seed, APM3_KEYGEN_KEY, APM3_KEYGEN_IV)
	const derived = encryptCbcNoPadding(
		decryptedSeed.slice(64, 96),
		bytesToHex(decryptedSeed.slice(0, 16)),
		bytesToHex(decryptedSeed.slice(16, 32))
	)
	const key = derived.slice(0, 16)
	const iv = derived.slice(16, 32)

	for (let index = 0; index < 16; index++) {
		const gameByte = gameId.charCodeAt(index % 4) & 0xff
		key[index] ^= gameByte
		iv[index] ^= gameByte
	}

	const keys = { key: bytesToHex(key), iv: bytesToHex(iv) }
	apm3KeyCache.set(gameId, keys)
	return keys
}

function optionFilesystemExtension(bootSector: Uint8Array) {
	const oemId = ascii(bootSector.slice(3, 11))
	if (oemId === "EXFAT") return "exfat"
	if (oemId === "NTFS") return "ntfs"
	return undefined
}

function isPlausibleNtfsBoot(bootSector: Uint8Array) {
	if (optionFilesystemExtension(bootSector) !== "ntfs" || bootSector[510] !== 0x55 || bootSector[511] !== 0xaa) {
		return false
	}

	const view = new DataView(bootSector.buffer, bootSector.byteOffset, bootSector.byteLength)
	const bytesPerSector = view.getUint16(0x0b, true)
	const sectorsPerCluster = bootSector[0x0d]
	const recordSizeByte = view.getInt8(0x40)
	return [512, 1024, 2048, 4096].includes(bytesPerSector) && sectorsPerCluster > 0 && recordSizeByte !== 0
}

function isPlausibleExfatBoot(bootSector: Uint8Array) {
	if (optionFilesystemExtension(bootSector) !== "exfat" || bootSector[510] !== 0x55 || bootSector[511] !== 0xaa) {
		return false
	}

	const view = new DataView(bootSector.buffer, bootSector.byteOffset, bootSector.byteLength)
	const bytesPerSectorShift = bootSector[0x6c]
	const sectorsPerClusterShift = bootSector[0x6d]
	const clusterCount = view.getUint32(0x5c, true)
	const rootDirectoryCluster = view.getUint32(0x60, true)
	return (
		bytesPerSectorShift >= 9 &&
		bytesPerSectorShift <= 12 &&
		sectorsPerClusterShift <= 25 &&
		clusterCount > 0 &&
		rootDirectoryCluster >= 2
	)
}

function isPlausibleOptionBoot(bootSector: Uint8Array) {
	return isPlausibleNtfsBoot(bootSector) || isPlausibleExfatBoot(bootSector)
}

function outputFilename(bootId: FscryptBootId, optionExtension = "exfat") {
	const timestamp = formatTimestamp(bootId.targetTimestamp)

	if (bootId.containerType === FSCRYPT_CONTAINER_TYPE.OS) {
		return `${bootId.osId}_${formatVersion(bootId.osVersion)}_${timestamp}_${bootId.sequenceNumber}.ntfs`
	}

	if (bootId.containerType === FSCRYPT_CONTAINER_TYPE.APP) {
		if (bootId.sequenceNumber > 0) {
			return `${bootId.gameId}_${formatVersion(bootId.targetVersion)}_${timestamp}_${bootId.sequenceNumber}_${formatVersion(bootId.sourceVersion)}.ntfs`
		}

		return `${bootId.gameId}_${formatVersion(bootId.targetVersion)}_${timestamp}_${bootId.sequenceNumber}.ntfs`
	}

	return `${bootId.gameId}_${bootId.targetOption}_${timestamp}_${bootId.sequenceNumber}.${optionExtension}`
}

function toByteSource(file: FscryptInput): ReadableByteSource {
	if (typeof File !== "undefined" && file instanceof File) {
		return byteSourceFromFile(file)
	}

	return file as ReadableByteSource
}

async function customKeys(keyFile?: FscryptInput): Promise<GameKeys | undefined> {
	if (!keyFile) {
		return undefined
	}

	const source = toByteSource(keyFile)
	const bytes = await source.read(0, source.size)
	const key = bytesToHex(bytes.slice(0, 16))

	if (bytes.length === 16) {
		return { key }
	}

	if (bytes.length !== 32) {
		throw new Error("External key file must be 16 or 32 bytes")
	}

	const iv = bytes.slice(16, 32)
	if (bytesEqual(iv, hexToBytes(NTFS_HEADER)) || bytesEqual(iv, hexToBytes(EXFAT_HEADER))) {
		return { key }
	}

	return { key, iv: bytesToHex(iv) }
}

/** Selects working key material by trying external, built-in, and derived candidates against the first page. */
async function resolveKeys(bootId: FscryptBootId, firstPage: Uint8Array, keyFile?: FscryptInput): Promise<ResolvedGameKeys> {
	if (bootId.containerType === FSCRYPT_CONTAINER_TYPE.OPTION) {
		const externalKeys = await customKeys(keyFile)
		const apm3Keys = deriveApm3GameKeys(bootId.gameId)
		const candidates = [
			...(externalKeys ? [{ ...externalKeys, source: "external" as const }] : []),
			{ key: OPTION_KEY, iv: OPTION_IV, source: "built-in" as const },
			...(GAME_KEYS[bootId.gameId] ? [{ ...GAME_KEYS[bootId.gameId], source: "built-in" as const }] : []),
			...(apm3Keys ? [{ ...apm3Keys, source: "APM3" as const }] : [])
		]

		for (const keys of candidates) {
			const ivs = [
				...(!bootId.useCustomIv && keys.iv ? [keys.iv] : []),
				bytesToHex(calculateFileIv(keys.key, EXFAT_HEADER, firstPage)),
				bytesToHex(calculateFileIv(keys.key, NTFS_HEADER, firstPage))
			]

			for (const iv of ivs) {
				const bootSector = decryptCbcNoPadding(firstPage.slice(0, 512), keys.key, iv)
				if (isPlausibleOptionBoot(bootSector)) {
					return { key: keys.key, iv, source: keys.source }
				}
			}
		}

		throw new Error(`No valid OPTION decryption key available for ${bootId.gameId}`)
	}

	const keyName = bootId.containerType === FSCRYPT_CONTAINER_TYPE.OS ? bootId.osId : bootId.gameId
	const builtInKeys = GAME_KEYS[keyName]
	const externalKeys = builtInKeys ? undefined : await customKeys(keyFile)
	const keys = builtInKeys ?? externalKeys
	if (!keys) {
		throw new Error(`No decryption keys available for ${keyName}`)
	}

	const iv =
		!bootId.useCustomIv && keys.iv
			? keys.iv
		: bytesToHex(calculateFileIv(keys.key, NTFS_HEADER, firstPage))

	return { key: keys.key, iv, source: builtInKeys ? "built-in" : "external" }
}

function checkedNumber(value: bigint, label: string) {
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error(`${label} is too large for browser processing`)
	}

	return Number(value)
}

function yieldToUi() {
	return new Promise<void>(resolve => {
		globalThis.setTimeout(resolve, 0)
	})
}

function isFsdecryptOptions(value: FscryptInput | FsdecryptOptions): value is FsdecryptOptions {
	return "keyFile" in value || "expectedContainerType" in value || "output" in value || "onProgress" in value || "onLog" in value
}

export type FscryptReadableSource = ReadableByteSource & {
	bootId: FscryptBootId
	outputFilename: string
}

export type FscryptSourceOptions = {
	keyFile?: FscryptInput
	expectedContainerType?: FscryptContainerType
	onLog?: (message: string) => void
}

/** Opens an fscrypt container as a random-access plaintext source without exporting the whole image first. */
export async function openFscryptSource(
	file: FscryptInput,
	options: FscryptSourceOptions = {}
): Promise<FscryptReadableSource> {
	const { expectedContainerType, keyFile, onLog } = options
	const source = toByteSource(file)

	onLog?.(`Reading bootid from ${source.name}`)
	const encryptedBootId = await source.read(0, BOOTID_SIZE)
	const bootId = parseBootId(encryptedBootId)
	if (expectedContainerType !== undefined && bootId.containerType !== expectedContainerType) {
		throw new Error(
			`Expected ${describeContainerType(expectedContainerType)} container, got ${describeContainerType(bootId.containerType)}`
		)
	}
	const dataOffset = bootId.headerBlockCount * bootId.blockSize
	const outputSize = (bootId.blockCount - bootId.headerBlockCount) * bootId.blockSize
	const dataOffsetNumber = checkedNumber(dataOffset, "Data offset")
	const outputSizeNumber = checkedNumber(outputSize, "Output size")
	onLog?.(
		`Data starts at ${dataOffsetNumber.toLocaleString()} bytes, plaintext size ${outputSizeNumber.toLocaleString()} bytes`
	)

	const firstPage = await source.read(dataOffsetNumber, PAGE_SIZE)
	const keys = await resolveKeys(bootId, firstPage, keyFile)
	onLog?.(`Using ${keys.source} key material`)

	if (!keys.iv) {
		throw new Error("Missing file IV")
	}

	const ivHex = keys.iv
	const fileIv = hexToBytes(ivHex)
	const nativeDecrypt = Boolean(source.decryptFscryptRange)
	const decryptWorkers = nativeDecrypt ? 0 : getDecryptWorkerCount()
	onLog?.(
		nativeDecrypt
			? "Using native Electron decrypt for large reads"
			: decryptWorkers > 0
				? `Using ${decryptWorkers} decrypt worker(s) for large reads`
				: "Using inline decrypt for all non-native reads"
	)

	const readPlainRange = async (offset: number, length: number) => {
		if (offset < 0 || length < 0 || offset > outputSizeNumber) {
			throw new Error(`Invalid plaintext read ${offset}+${length}`)
		}

		const cappedLength = Math.min(length, outputSizeNumber - offset)
		if (cappedLength === 0) {
			return new Uint8Array()
		}

		const firstPageOffset = Math.floor(offset / PAGE_SIZE) * PAGE_SIZE
		const lastPageOffset = Math.ceil((offset + cappedLength) / PAGE_SIZE) * PAGE_SIZE
		const encryptedLength = Math.min(lastPageOffset, outputSizeNumber) - firstPageOffset
		if (source.decryptFscryptRange) {
			const decrypted = await source.decryptFscryptRange({
				dataOffset: dataOffsetNumber,
				outputSize: outputSizeNumber,
				keyHex: keys.key,
				ivHex,
				offset,
				length: cappedLength,
				pageSize: PAGE_SIZE
			})
			return decrypted
		}
		const encrypted = await source.read(dataOffsetNumber + firstPageOffset, encryptedLength)
		const decrypted = await decryptFscryptPages(keys.key, fileIv, firstPageOffset, encrypted, PAGE_SIZE)

		return decrypted.slice(offset - firstPageOffset, offset - firstPageOffset + cappedLength)
	}

	const optionExtension =
		bootId.containerType === FSCRYPT_CONTAINER_TYPE.OPTION
			? (optionFilesystemExtension(await readPlainRange(0, 512)) ?? "img")
			: undefined
	const filename = outputFilename(bootId, optionExtension)
	onLog?.(`Container type: ${describeContainerType(bootId.containerType)}, plaintext view: ${filename}`)

	return {
		name: filename,
		size: outputSizeNumber,
		bootId,
		outputFilename: filename,
		read: readPlainRange
	}
}

/** Decrypts a full fscrypt container to a Blob or caller-provided local output sink. */
export async function decryptFscryptContainer(
	file: FscryptInput,
	keyFileOrOptions?: FscryptInput | FsdecryptOptions,
	legacyProgress?: (progress: number) => void
): Promise<FsdecryptResult> {
	const options: FsdecryptOptions =
		keyFileOrOptions && isFsdecryptOptions(keyFileOrOptions)
			? keyFileOrOptions
			: keyFileOrOptions
				? { keyFile: keyFileOrOptions, onProgress: legacyProgress }
				: {}
	const { output, onProgress, onLog } = options
	const source = await openFscryptSource(file, options)
	const { bootId } = source
	const outputSizeNumber = source.size
	const filename = source.outputFilename
	const outputSink = typeof output === "function" ? await output(filename) : output

	const chunks: Uint8Array[] = []
	let written = 0

	for (let chunkOffset = 0; chunkOffset < outputSizeNumber; chunkOffset += DECRYPT_CHUNK_SIZE) {
		const chunkSize = Math.min(DECRYPT_CHUNK_SIZE, outputSizeNumber - chunkOffset)
		onLog?.(`Decrypting ${chunkOffset.toLocaleString()}-${(chunkOffset + chunkSize).toLocaleString()} bytes`)
		const outputChunk = await source.read(chunkOffset, chunkSize)

		if (outputChunk.length === 0) {
			break
		}

		if (outputSink) {
			await outputSink.write(outputChunk)
		} else {
			chunks.push(outputChunk)
		}
		written += outputChunk.length
		onProgress?.(written / outputSizeNumber)
		await yieldToUi()
	}

	if (outputSink) {
		onLog?.("Finalizing local file")
		await outputSink.close()
	}
	onLog?.("Done")

		return {
			bootId,
			outputFilename: filename,
			output: outputSink
				? undefined
				: new Blob(
						chunks.map(chunk => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer),
						{ type: "application/octet-stream" }
					),
			outputSize: outputSizeNumber,
			savedToFile: Boolean(outputSink)
	}
}

/** Formats the numeric bootid container type used by logs and validation errors. */
export function describeContainerType(containerType: FscryptContainerType) {
	switch (containerType) {
		case FSCRYPT_CONTAINER_TYPE.OS:
			return "OS"
		case FSCRYPT_CONTAINER_TYPE.APP:
			return "APP"
		case FSCRYPT_CONTAINER_TYPE.OPTION:
			return "OPTION"
	}
}
