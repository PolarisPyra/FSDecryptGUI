export function abortError() {
	return new DOMException("Extraction cancelled", "AbortError")
}

export function throwIfAborted(signal: AbortSignal) {
	if (signal.aborted) {
		throw abortError()
	}
}

export function isAbortError(error: unknown) {
	return (error instanceof DOMException && error.name === "AbortError") || (error instanceof Error && error.message === "Extraction cancelled")
}
