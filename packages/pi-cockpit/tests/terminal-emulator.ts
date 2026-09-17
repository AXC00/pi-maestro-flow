/**
 * Minimal VT100 emulator for replaying pi-tui's exact escape stream and
 * comparing the emulated visible screen against the renderer's model.
 *
 * Implements only what TuiMainScreen emits:
 *   ESC[nA up, ESC[nB down, ESC[nG col, ESC[2K clear line,
 *   ESC[2J clear screen, ESC[H home, ESC[3J clear scrollback,
 *   CR, LF (scrolls at bottom), SGR/OSC/sync/cursor sequences (ignored),
 *   printable text with immediate wrap at `columns`.
 */

const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_G[^\x1b]*(?:\x1b\\)?)/g;

export function stripAnsi(line: string): string {
	return line.replace(ANSI_ESCAPE, "");
}

export class TerminalEmulator {
	readonly columns: number;
	readonly rows: number;
	/** Visible screen rows (length === rows). */
	screen: string[];
	/** Scrollback rows above the screen. */
	scrollback: string[] = [];
	cursorRow = 0;
	cursorCol = 0;
	/** Deferred-wrap state: cursor is at the last column with a wrap pending. */
	private wrapPending = false;
	/** Every byte written, for debugging. */
	log: string[] = [];

	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
		this.screen = Array.from({ length: rows }, () => "");
	}

	private scrollUp(count: number): void {
		for (let i = 0; i < count; i += 1) {
			this.scrollback.push(this.screen.shift() ?? "");
			this.screen.push("");
		}
	}

	private putChar(ch: string): void {
		// A pending wrap fires only when the NEXT printable char arrives (deferred
		// wrap, like xterm). CR/escape sequences cancel it without scrolling.
		if (this.wrapPending) {
			this.wrapPending = false;
			this.cursorCol = 0;
			if (this.cursorRow === this.rows - 1) this.scrollUp(1);
			else this.cursorRow += 1;
		}
		const line = this.screen[this.cursorRow] ?? "";
		// Overwrite at cursorCol (pad with spaces if writing past end).
		const padded = line.length < this.cursorCol ? line + " ".repeat(this.cursorCol - line.length) : line;
		this.screen[this.cursorRow] = padded.slice(0, this.cursorCol) + ch + padded.slice(this.cursorCol + 1);
		this.cursorCol += 1;
		if (this.cursorCol >= this.columns) {
			this.cursorCol = this.columns - 1;
			this.wrapPending = true;
		}
	}

	private newline(): void {
		this.wrapPending = false;
		this.cursorCol = 0;
		if (this.cursorRow === this.rows - 1) this.scrollUp(1);
		else this.cursorRow += 1;
	}

	write(data: string): void {
		this.log.push(data);
		let i = 0;
		while (i < data.length) {
			const ch = data[i];
			if (ch === "\x1b") {
				// CSI: ESC [ params final
				if (data[i + 1] === "[") {
					const m = /^\x1b\[([0-9;?]*)([@-~])/.exec(data.slice(i));
					if (m) {
						this.applyCsi(m[1], m[2]);
						i += m[0].length;
						continue;
					}
				}
				// OSC: ESC ] ... BEL or ESC ] ... ESC \
				if (data[i + 1] === "]") {
					const bel = data.indexOf("\x07", i);
					const st = data.indexOf("\x1b\\", i);
					const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
					i = end === -1 ? data.length : end + (end === st ? 2 : 1);
					continue;
				}
				// Kitty / APC: ESC _ ... ESC \
				if (data[i + 1] === "_") {
					const st = data.indexOf("\x1b\\", i);
					i = st === -1 ? data.length : st + 2;
					continue;
				}
				// Other escape: skip ESC + one char.
				i += 2;
				continue;
			}
			if (ch === "\r") {
				this.wrapPending = false;
				this.cursorCol = 0;
				i += 1;
				continue;
			}
			if (ch === "\n") {
				this.newline();
				i += 1;
				continue;
			}
			this.putChar(ch);
			i += 1;
		}
	}

	private applyCsi(params: string, final: string): void {
		const n = (idx: number, def: number) => {
			const part = params.split(";")[idx];
			const v = part === "" || part === undefined ? def : Number(part);
			return Number.isFinite(v) && v > 0 ? v : def;
		};
		switch (final) {
			case "A": this.cursorRow = Math.max(0, this.cursorRow - n(0, 1)); break;
			case "B": this.cursorRow = Math.min(this.rows - 1, this.cursorRow + n(0, 1)); break;
			case "C": this.cursorCol = Math.min(this.columns - 1, this.cursorCol + n(0, 1)); break;
			case "D": this.cursorCol = Math.max(0, this.cursorCol - n(0, 1)); break;
			case "G": this.cursorCol = Math.max(0, Math.min(this.columns - 1, n(0, 1) - 1)); break;
			case "H": this.cursorRow = 0; this.cursorCol = 0; break;
			case "J":
				if (params === "2" || params === "") {
					this.screen = Array.from({ length: this.rows }, () => "");
				}
				break;
			case "K":
				if (params === "2" || params === "" || params === "0") {
					this.screen[this.cursorRow] = "";
				}
				break;
			default:
				// SGR (m), sync (?2026h/l), cursor (?25h/l), etc. — ignored.
				break;
		}
		if (params === "3" && final === "J") this.scrollback = [];
	}

	/** Visible screen as plain text rows. */
	visibleText(): string[] {
		return this.screen.map(stripAnsi);
	}
}
