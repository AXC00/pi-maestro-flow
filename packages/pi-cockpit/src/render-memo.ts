/**
 * Per-component render memoization.
 *
 * Pi repaints every mounted component on each frame it produces — including
 * frames driven by the assistant stream, which cockpit widgets do not read.
 * Rebuilding cockpit rows on those frames is pure waste, so each widget keeps a
 * one-entry cache keyed by a fingerprint of the inputs it actually renders.
 * The fingerprint is a cheap scalar join (store revisions, width, theme
 * identity, the wall-clock second only when a live row needs it); a hit returns
 * the previous line array unchanged, which pi-tui's row diff then treats as
 * zero changed rows.
 */

const objectIds = new WeakMap<object, number>();
let nextObjectId = 0;

/** Stable identity token for an object input (theme, live workflow view, …). */
export function refId(value: unknown): string {
	if (typeof value !== "object" || value === null) return String(value);
	let id = objectIds.get(value);
	if (id === undefined) {
		id = ++nextObjectId;
		objectIds.set(value, id);
	}
	return `o${id}`;
}

/**
 * One-entry memo for a component's render(). `key` must cover every input the
 * compute closure reads; callers are responsible for including the wall-clock
 * second when (and only when) a live duration is on screen.
 */
export function memoizedLines(): (key: string, compute: () => string[]) => string[] {
	return memoized<string[]>();
}

/** Generic one-entry memo; see memoizedLines for the contract. */
export function memoized<T>(): (key: string, compute: () => T) => T {
	let lastKey: string | undefined;
	let lastValue: T | undefined;
	return (key, compute) => {
		if (key === lastKey) return lastValue as T;
		lastKey = key;
		lastValue = compute();
		return lastValue;
	};
}

interface AgentRowLike {
	correlationId: string;
	status: string;
	phase?: string;
	role: string;
	agent: string;
	name?: string;
	task: string;
	taskStatus?: string;
	taskIndex?: number;
	parentCorrelationId?: string;
	tail: string;
	error?: string;
	activeTool?: string;
	startedAt: number;
	finishedAt?: number;
	lastActivityAt: number;
	viewing?: boolean;
	toolCount?: number;
	tokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	requestedModel?: string;
	resolvedModel?: string;
	dependencies?: number[];
	lastOutcome?: { status: string; message?: string; settledAt?: number };
}

/** Fingerprint of every AgentRow field the roster renderers read. */
export function agentRowsKey(rows: readonly AgentRowLike[]): string {
	let out = "";
	for (const r of rows) {
		out += `${r.correlationId}|${r.status}|${r.phase ?? ""}|${r.role}|${r.agent}|${r.name ?? ""}`
			+ `|${r.task}|${r.taskStatus ?? ""}|${r.taskIndex ?? ""}|${r.parentCorrelationId ?? ""}`
			+ `|${r.tail}|${r.error ?? ""}|${r.activeTool ?? ""}`
			+ `|${r.startedAt}|${r.finishedAt ?? ""}|${r.lastActivityAt}|${r.viewing ? 1 : 0}`
			+ `|${r.toolCount ?? ""}|${r.tokens ?? ""}|${r.inputTokens ?? ""}|${r.outputTokens ?? ""}`
			+ `|${r.cacheReadTokens ?? ""}|${r.cacheWriteTokens ?? ""}`
			+ `|${r.requestedModel ?? ""}|${r.resolvedModel ?? ""}`
			+ `|${r.dependencies?.join(",") ?? ""}`
			+ `|${r.lastOutcome ? `${r.lastOutcome.status}:${r.lastOutcome.message ?? ""}:${r.lastOutcome.settledAt ?? ""}` : ""}`
			+ ";";
	}
	return out;
}

interface TodoItemLike {
	id: string;
	subject: string;
	status: string;
	blockedBy: string[];
	createdBy?: { id: string; label: string };
	assignee?: { id: string; label: string };
	skills: Array<{ name: string; role?: string }>;
	updatedAt?: number;
}

/** Fingerprint of every TodoItem field the todo renderer reads. */
export function todoItemsKey(items: readonly TodoItemLike[]): string {
	let out = "";
	for (const item of items) {
		out += `${item.id}|${item.status}|${item.subject}|${item.blockedBy.join(",")}`
			+ `|${item.createdBy ? `${item.createdBy.id}:${item.createdBy.label}` : ""}`
			+ `|${item.assignee ? `${item.assignee.id}:${item.assignee.label}` : ""}`
			+ `|${item.skills.map((skill) => `${skill.name}:${skill.role ?? ""}`).join(",")}`
			+ `|${item.updatedAt ?? ""};`;
	}
	return out;
}

interface BashJobLike {
	id: string;
	command: string;
	cwd: string;
	pid: number;
	status: string;
	startedAt: number;
	updatedAt: number;
	finishedAt?: number;
	exitCode: number | null;
	outputTail: string;
	outputBytes: number;
	logPath: string;
}

/** Fingerprint of every BashBgJob field the job renderers read. */
export function bashJobsKey(jobs: readonly BashJobLike[]): string {
	let out = "";
	for (const job of jobs) {
		out += `${job.id}|${job.status}|${job.command}|${job.cwd}|${job.pid}`
			+ `|${job.startedAt}|${job.updatedAt}|${job.finishedAt ?? ""}`
			+ `|${job.exitCode ?? ""}|${job.outputTail}|${job.outputBytes}|${job.logPath};`;
	}
	return out;
}
