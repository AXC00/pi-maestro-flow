# Upstream PR draft: `custom` overlay support in `pi --mode rpc`

Target repo: `pi-coding-agent` (file: `dist/modes/rpc/rpc-mode.js`, source `src/modes/rpc/rpc-mode.ts`).

## Problem

In RPC mode, `ctx.ui.custom()` is a silent no-op:

```js
// rpc-mode.js:152
async custom() {
    // Custom UI not supported in RPC mode
    return undefined;
},
```

Every extension overlay (53 call sites across pi-maestro-flow / pi-cockpit /
pi-maestro-teammate) is unreachable for RPC frontends. There is also no
inbound channel for UI input: stdin only accepts commands and
`extension_ui_response` (`rpc-mode.js:618`), and `onTerminalInput()` is a
no-op — so even a forwarded `custom` request could not receive keystrokes.

## Proposal

Two additions, both backward compatible:

1. **Outbound**: three new `extension_ui_request` methods —
   `custom`, `overlay_frame`, `overlay_close`.
2. **Inbound**: a new stdin message type `extension_ui_event` routed to the
   extension that owns the request `id`.

Plus a `get_capabilities` command so frontends can declare support; older
agents answer it with an error response, which clients treat as "no custom
overlay support".

### Wire shapes (authoritative: `pi-tui/crates/pi-rpc/src/types.rs`)

```jsonc
// agent → client: open an overlay
{"type":"extension_ui_request","id":"u1","method":"custom",
 "driver":"plugin"|"client",
 "spec":{"kind":"card","title":"…","anchor":"center",
         "width":"72%"|80,"minWidth":40,"maxHeight":"85%",
         "margin":2|{"top":1},"offsetX":0,"offsetY":-2,
         "dismissable":true,"hints":[{"key":"esc","verb":"cancel"}]}}

// agent → client (fire-and-forget): replace the overlay body
{"type":"extension_ui_request","id":"u1","method":"overlay_frame",
 "frame":[[{"text":"row","role":"accent","bold":true}]],
 "cursor":[1,2]}

// agent → client (fire-and-forget): close the overlay
{"type":"extension_ui_request","id":"u1","method":"overlay_close"}

// client → agent (stdin): input/lifecycle for a plugin-driven overlay
{"type":"extension_ui_event","id":"u1","event":{"kind":"key","key":"j","mods":[]}}
{"type":"extension_ui_event","id":"u1","event":{"kind":"dismissed"}}
{"type":"extension_ui_event","id":"u1","event":{"kind":"resize","w":120,"h":40}}

// client → agent: capability probe
{"type":"get_capabilities","id":"c1"}
// → {"type":"response","id":"c1","command":"get_capabilities","success":true,
//    "data":{"ui":{"custom":true,"spec_version":1,"events":true}}}
```

`Span.role` is a closed enum (`text|muted|dim|accent|warning|error|success|
border|selected|hint_key|hint_verb`) — the client maps roles onto its own
theme, so plugin overlays share the frontend's styling system and can never
emit raw colors.

Semantics:

- `driver:"client"` — the frontend renders the spec's declarative fields and
  resolves with `extension_ui_response` (`expects_response` = true).
- `driver:"plugin"` — fire-and-forget; the plugin streams `overlay_frame`
  updates, receives `extension_ui_event` input, and ends with
  `overlay_close`. No `extension_ui_response` is owed.
- One modal surface at a time; surface-occupying requests queue behind the
  active one (same rule as `select`/`confirm`/`input`/`editor` today).

## Patch sketch (rpc-mode)

```js
// 1. Track event sinks alongside pending response waiters.
const extensionUiEventSinks = new Map(); // id → (event) => void

// 2. custom(): accept a spec form and forward it.
async custom(factoryOrSpec, options) {
    // Legacy component factories cannot cross the wire — keep returning
    // undefined for them so callers degrade exactly as today.
    if (typeof factoryOrSpec === "function") return undefined;
    const { driver = "plugin", ...spec } = factoryOrSpec;
    const id = crypto.randomUUID();
    if (driver === "client") {
        return new Promise((resolve, reject) => {
            pendingExtensionRequests.set(id, { resolve, reject });
            output({ type: "extension_ui_request", id, method: "custom", driver, spec });
        });
    }
    // plugin-driven: register the event sink, resolve when the plugin calls
    // the returned controller's close().
    return new Promise((resolve) => {
        extensionUiEventSinks.set(id, options?.onEvent ?? (() => {}));
        output({ type: "extension_ui_request", id, method: "custom", driver, spec });
        resolve({ id, close: () => {
            extensionUiEventSinks.delete(id);
            output({ type: "extension_ui_request", id, method: "overlay_close" });
        }, frame: (frame, cursor) => {
            output({ type: "extension_ui_request", id, method: "overlay_frame", frame, cursor });
        }});
    });
}

// 3. stdin dispatch: route extension_ui_event next to extension_ui_response.
if (parsed?.type === "extension_ui_event") {
    extensionUiEventSinks.get(parsed.id)?.(parsed.event);
    return;
}

// 4. get_capabilities command handler.
case "get_capabilities":
    return { type: "response", id: command.id, command: "get_capabilities",
             success: true,
             data: { ui: { custom: true, spec_version: 1, events: true } } };
```

## Compatibility

- Old clients: unknown methods land in the client's `Unknown` fallback
  (pi-rpc already does this); nothing breaks.
- Old agents: `get_capabilities` returns an error response → clients disable
  the feature; `custom()` keeps returning `undefined` for component factories
  → plugins degrade to `select`/`confirm` chains as they do today.
- `setWidget` is unchanged; `widgetPlacement` stays `aboveEditor|belowEditor`
  (overlays are a separate surface, not a widget placement).
