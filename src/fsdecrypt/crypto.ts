import aesjs from "aes-js"

type ByteSource = ArrayBuffer | Uint8Array | number[]

type AesBlockCipher = {
	encrypt(data: ByteSource): Uint8Array
	decrypt(data: ByteSource): Uint8Array
}

export const AesBlock = aesjs.AES as unknown as new (key: ByteSource) => AesBlockCipher

/** Converts a hexadecimal key or IV string into raw bytes for aes-js calls. */
export function hexToBytes(hex: string) {
	return aesjs.utils.hex.toBytes(hex)
}

/** Converts raw key material back into lowercase hexadecimal text. */
export function bytesToHex(bytes: Uint8Array) {
	return aesjs.utils.hex.fromBytes(bytes)
}

/** Decrypts a complete AES-CBC buffer where the caller has already handled padding. */
export function decryptCbcNoPadding(data: Uint8Array, keyHex: string, ivHex: string) {
	const output = new Uint8Array(data.length)
	decryptCbcInto(new AesBlock(hexToBytes(keyHex)), data, hexToBytes(ivHex), output)
	return output
}

/** Streams AES-CBC decryption into a caller-owned buffer to avoid extra copies. */
export function decryptCbcInto(cipher: AesBlockCipher, encrypted: Uint8Array, iv: Uint8Array, output: Uint8Array) {
	let previous = iv

	for (let blockOffset = 0; blockOffset < encrypted.length; blockOffset += 16) {
		const block = encrypted.subarray(blockOffset, blockOffset + 16)
		const decrypted = cipher.decrypt(block)

		for (let index = 0; index < 16; index++) {
			output[blockOffset + index] = decrypted[index] ^ previous[index]
		}

		previous = block
	}
}

/** Derives the per-page fscrypt IV by XORing the file IV with the page offset. */
export function calculatePageIv(fileOffset: bigint, fileIv: Uint8Array) {
	const pageIv = new Uint8Array(16)

	for (let index = 0; index < 16; index++) {
		const shift = BigInt(8 * (index % 8))
		pageIv[index] = fileIv[index] ^ Number((fileOffset >> shift) & 0xffn)
	}

	return pageIv
}

/** Decrypts fscrypt data page-by-page using the IV schedule expected by fscrypt containers. */
export function decryptFscryptPagesLocal(
	keyHex: string,
	fileIv: Uint8Array,
	firstPageOffset: number,
	encrypted: Uint8Array,
	pageSize: number
) {
	if (encrypted.length % 16 !== 0) {
		throw new Error("Encrypted range is not AES block aligned")
	}

	const decrypted = new Uint8Array(encrypted.length)
	const cipher = new AesBlock(hexToBytes(keyHex))

	for (let pageOffset = 0; pageOffset < encrypted.length; pageOffset += pageSize) {
		const encryptedPage = encrypted.subarray(pageOffset, pageOffset + pageSize)
		const outputPage = decrypted.subarray(pageOffset, pageOffset + encryptedPage.length)
		const pageIv = calculatePageIv(BigInt(firstPageOffset + pageOffset), fileIv)
		decryptCbcInto(cipher, encryptedPage, pageIv, outputPage)
	}

	return decrypted
}
