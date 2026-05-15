export type ReadableByteSource = {
	name: string
	size: number
	read: (offset: number, length: number) => Promise<Uint8Array>
	decryptFscryptRange?: (request: {
		dataOffset: number
		outputSize: number
		keyHex: string
		ivHex: string
		offset: number
		length: number
		pageSize: number
	}) => Promise<Uint8Array>
}

/**
 * Adapts browser File objects to the shared random-access byte-source interface.
 *
 * @param file Browser File object.
 * @returns Readable byte source backed by `File.slice`.
 */
export function byteSourceFromFile(file: File): ReadableByteSource {
	return {
		name: file.name,
		size: file.size,
		read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
	}
}
