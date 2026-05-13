import { decryptFscryptPagesLocal } from "./crypto"

type DecryptRequest = {
	id: number
	keyHex: string
	fileIv: number[]
	pageOffset: number
	pageSize: number
	encrypted: ArrayBuffer
}

const workerScope = self as unknown as {
	onmessage: ((event: MessageEvent<DecryptRequest>) => void) | null
	postMessage: (message: unknown, transfer?: Transferable[]) => void
}

workerScope.onmessage = (event: MessageEvent<DecryptRequest>) => {
	const request = event.data

	try {
		const decrypted = decryptFscryptPagesLocal(
			request.keyHex,
			new Uint8Array(request.fileIv),
			request.pageOffset,
			new Uint8Array(request.encrypted),
			request.pageSize
		)
		const output = decrypted.buffer as ArrayBuffer
		workerScope.postMessage({ id: request.id, decrypted: output }, [output])
	} catch (error) {
		workerScope.postMessage({
			id: request.id,
			error: error instanceof Error ? error.message : "Worker decryption failed"
		})
	}
}
