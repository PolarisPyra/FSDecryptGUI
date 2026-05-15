import { formatBytes } from "../../base/common/format"
import type { PickedFile } from "../../electron-api"
import type { KeyValidation } from "../common/appTypes"

// Key Source validation gates selection refreshes and extraction readiness, so it
// lives in its own small module instead of the React controller.
/**
 * Validates Custom Key File metadata without reading file contents.
 *
 * @param file Selected file metadata, or null for Built-in Key Source.
 * @returns UI-ready validation state used by extraction readiness.
 */
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
