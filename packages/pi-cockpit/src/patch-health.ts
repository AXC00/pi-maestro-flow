/**
 * Host-patch health registry.
 *
 * Cockpit reaches several pi internals it cannot subscribe to (render chain,
 * applyLineResets, the compaction component prototype, the thinking-label
 * component tree). Every one of those attachments already fails closed, but the
 * failure was silent: a pi upgrade could turn a patch inert and the only trace
 * was a missing behaviour. This module gives each patch a name and a last-known
 * status so the /cockpit panel can show what is actually live.
 */

export type PatchName =
	| "viewport-stability"
	| "compaction-style"
	| "split-pane"
	| "editor-bottom"
	| "fullscreen"
	| "custom-editor"
	| "thinking-label";

export interface PatchStatus {
	/** True while the patch is installed and dispatching; false when the host shape rejected it. */
	active: boolean;
	/** Short machine-readable reason for inactive states ("no-slot", "foreign-owner", …). */
	reason?: string;
	/** When the status was last reported. */
	updatedAt: number;
}

const statuses = new Map<PatchName, PatchStatus>();

/** Record a patch's last-known state. Cheap enough to call on every attach. */
export function reportPatch(name: PatchName, active: boolean, reason?: string): void {
	statuses.set(name, { active, ...(reason ? { reason } : {}), updatedAt: Date.now() });
}

/** Last-known status of one patch, or undefined when it was never attempted. */
export function patchStatus(name: PatchName): PatchStatus | undefined {
	return statuses.get(name);
}

/** Snapshot in a stable display order (registration order of first report). */
export function patchStatuses(): ReadonlyArray<readonly [PatchName, PatchStatus]> {
	return [...statuses.entries()];
}

/** One-line summary for the settings panel: `5/6 patches · split-pane: no-slot`. */
export function patchSummary(): string {
	const entries = [...statuses.entries()];
	if (entries.length === 0) return "";
	const active = entries.filter(([, status]) => status.active).length;
	const degraded = entries
		.filter(([, status]) => !status.active)
		.map(([name, status]) => `${name}${status.reason ? `: ${status.reason}` : ""}`);
	return degraded.length === 0
		? `${active}/${entries.length}`
		: `${active}/${entries.length} · ${degraded.join(", ")}`;
}

/** Test hook: drop all recorded statuses. */
export function resetPatchHealth(): void {
	statuses.clear();
}
