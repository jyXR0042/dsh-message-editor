window.__ModuleLoader__.load({
	id: "dsh-message-editor",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  MessageEditorController: () => MessageEditorController,
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);
var import_react10 = require("react");

// src/client/controller.ts
var EMPTY_EDITS = /* @__PURE__ */ new Map();
var INITIAL_VIEW = Object.freeze({
  status: "cold",
  edits: EMPTY_EDITS,
  editing: null,
  pending: false,
  error: null,
  notice: null
});
var OK = Object.freeze({ ok: true });
function describe(t, code) {
  switch (code) {
    case "session-cold":
      return t("error.session-cold");
    case "target-not-found":
      return t("error.target-not-found");
    case "unsupported-target":
      return t("error.unsupported-target");
    case "text-too-large":
      return t("error.text-too-large");
    case "bad-request":
      return t("error.bad-request");
    case "transport":
      return t("error.transport");
    default:
      return t("error.generic");
  }
}
var MessageEditorController = class {
  /**
   * @param call - the host channel caller.
   * @param sessionId - the Session owning every addressed message.
   * @param t - this plugin's translate seat.
   * @param onNotice - sink for transient success/failure toasts.
   */
  constructor(call, sessionId, t, onNotice = () => {
  }) {
    this.call = call;
    this.sessionId = sessionId;
    this.t = t;
    this.onNotice = onNotice;
  }
  view = INITIAL_VIEW;
  listeners = /* @__PURE__ */ new Set();
  loadPromise = null;
  tail = Promise.resolve();
  disposed = false;
  noticeTimer = null;
  /** Current frozen view (uSES getSnapshot). */
  getSnapshot = () => this.view;
  /** Subscribe to view replacement (uSES subscribe). */
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** Seed once; a failed load stays retryable. */
  ensure() {
    if (this.view.status === "ready") return Promise.resolve(OK);
    return this.refresh();
  }
  /** Re-read the authoritative edit table, collapsing concurrent callers. */
  refresh() {
    if (this.loadPromise !== null) return this.loadPromise;
    this.publish({ ...this.view, status: "loading" });
    const pending = this.load();
    this.loadPromise = pending;
    return pending.finally(() => {
      this.loadPromise = null;
    });
  }
  /**
   * Open the inline editor for one message.
   * @param input - the message identity plus the text/attachments it starts from.
   */
  begin(input) {
    void this.ensure();
    this.publish({
      ...this.view,
      editing: {
        originSeq: input.originSeq,
        kind: input.kind,
        text: input.text,
        removed: /* @__PURE__ */ new Set(),
        attachments: input.attachments
      },
      error: null
    });
  }
  /** Close the inline editor without saving. */
  cancel() {
    if (this.view.editing === null) return;
    this.publish({ ...this.view, editing: null, error: null });
  }
  /** Replace the draft text. */
  setText(text) {
    const editing = this.view.editing;
    if (editing === null) return;
    this.publish({ ...this.view, editing: { ...editing, text } });
  }
  /** Toggle one attachment between kept and removed in the draft. */
  toggleAttachment(id) {
    const editing = this.view.editing;
    if (editing === null) return;
    const removed = new Set(editing.removed);
    if (removed.has(id)) removed.delete(id);
    else removed.add(id);
    this.publish({ ...this.view, editing: { ...editing, removed } });
  }
  /** Commit the open draft through the host. */
  save() {
    const editing = this.view.editing;
    if (editing === null) return Promise.resolve(OK);
    const text = editing.text;
    if (text.trim().length === 0) {
      this.publish({ ...this.view, error: this.t("editor.empty") });
      return Promise.resolve({ ok: false, error: this.t("editor.empty") });
    }
    return this.mutate(async () => {
      const result = await this.callHost("apply", {
        sessionId: this.sessionId,
        originSeq: editing.originSeq,
        text,
        removed: [...editing.removed]
      });
      if (!result.ok) {
        this.publish({ ...this.view, error: result.error });
        return result;
      }
      const record = result.value?.record;
      if (record !== void 0) this.commit(record);
      this.publish({ ...this.view, editing: null, error: null });
      this.toast(this.t(record?.deferred === true ? "badge.deferred" : "notice.saved"));
      return OK;
    });
  }
  /** Restore one edited message to its logged original. */
  revert(originSeq) {
    return this.mutate(async () => {
      const result = await this.callHost("revert", { sessionId: this.sessionId, originSeq });
      if (!result.ok) {
        this.toast(result.error, true);
        return result;
      }
      const edits = new Map(this.view.edits);
      edits.delete(originSeq);
      this.publish({ ...this.view, edits, error: null });
      this.toast(this.t("notice.reverted"));
      return OK;
    });
  }
  /** Drop subscribers and stop publishing when the owning fiber unloads. */
  dispose() {
    this.disposed = true;
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.listeners.clear();
  }
  /** Fetch the whole edit table and publish it as the seeded view. */
  async load() {
    const result = await this.callHost("list", { sessionId: this.sessionId });
    if (this.disposed) return OK;
    if (!result.ok) {
      this.publish({ ...this.view, status: "error", error: result.error });
      return result;
    }
    const edits = /* @__PURE__ */ new Map();
    const list = result.value?.edits;
    if (Array.isArray(list)) {
      for (const raw of list) {
        const record = raw;
        if (typeof record?.originSeq === "number") edits.set(record.originSeq, record);
      }
    }
    this.publish({ ...this.view, status: "ready", edits, error: null });
    return OK;
  }
  /** One round trip, normalized to the settled action shape. */
  async callHost(endpoint, payload) {
    try {
      const envelope = await this.call(endpoint, payload);
      if (envelope?.ok === true) return { ok: true, value: envelope.value };
      const code = envelope?.error?.code ?? "unknown";
      return { ok: false, error: describe(this.t, code) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `${this.t("error.transport")} ${message}` };
    }
  }
  /** Serialize one mutation behind the previous one and settle its state. */
  mutate(operation) {
    const guarded = async () => {
      if (this.disposed) return OK;
      this.publish({ ...this.view, pending: true });
      let result;
      try {
        result = await operation();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = { ok: false, error: message };
      }
      if (!this.disposed) this.publish({ ...this.view, pending: false });
      return result;
    };
    const settled = this.tail.then(guarded, guarded);
    this.tail = settled.then(() => void 0, () => void 0);
    return settled;
  }
  /** Merge one committed record, preserving every other entry's identity. */
  commit(record) {
    const edits = new Map(this.view.edits);
    edits.set(record.originSeq, record);
    this.publish({ ...this.view, edits });
  }
  /** Show one transient toast line. */
  toast(message, isError = false) {
    if (this.disposed) return;
    this.publish({ ...this.view, notice: message });
    try {
      this.onNotice(message, isError);
    } catch (error) {
      console.error("[dsh-message-editor] notice sink threw:", error);
    }
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      if (!this.disposed) this.publish({ ...this.view, notice: null });
    }, isError ? 5200 : 2600);
  }
  /** Replace the view and contain subscriber failures. */
  publish(view) {
    this.view = Object.freeze(view);
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[dsh-message-editor] subscriber threw:", error);
      }
    }
  }
};

// src/client/channel.ts
var EDITOR_ENDPOINT = "/api/dsh-message-editor";
function createEditorChannel(fetchImpl = typeof fetch === "function" ? fetch : void 0) {
  return {
    async call(endpoint, payload, signal) {
      if (fetchImpl === void 0) {
        return { ok: false, error: { code: "transport", message: "fetch is unavailable" } };
      }
      try {
        const response = await fetchImpl(EDITOR_ENDPOINT, {
          method: "POST",
          // Same-origin keeps the session cookie that authenticates /api.
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint, payload }),
          ...signal === void 0 ? {} : { signal }
        });
        if (!response.ok) {
          return { ok: false, error: { code: "transport", message: `HTTP ${response.status}` } };
        }
        const body = await response.json();
        if (body === void 0 || typeof body !== "object" || typeof body.ok !== "boolean") {
          return { ok: false, error: { code: "transport", message: "malformed reply" } };
        }
        return body;
      } catch (error) {
        return {
          ok: false,
          error: { code: "transport", message: error instanceof Error ? error.message : String(error) }
        };
      }
    }
  };
}

// src/client/user-node.tsx
var import_react6 = require("react");
var import_react7 = require("react");

// src/client/icons.tsx
var import_react = require("react");
var BASE = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.3,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false
};
var svg = (props, ...children) => (0, import_react.createElement)("svg", { ...BASE, ...props }, ...children);
var IconEdit = (props) => svg(
  props,
  (0, import_react.createElement)("path", { key: "a", d: "M11.05 2.6a1.35 1.35 0 0 1 1.9 1.9l-7.3 7.3-2.5.6.6-2.5 7.3-7.3Z" }),
  (0, import_react.createElement)("path", { key: "b", d: "M10.1 3.55 12.4 5.85" })
);
var IconCopy = (props) => svg(
  props,
  (0, import_react.createElement)("rect", { key: "a", x: 5.6, y: 5.6, width: 7.6, height: 7.6, rx: 1.6 }),
  (0, import_react.createElement)("path", { key: "b", d: "M10.4 3.4H4.2a1.6 1.6 0 0 0-1.6 1.6v6.2" })
);
var IconCheck = (props) => svg(
  props,
  (0, import_react.createElement)("path", { key: "a", d: "M3.2 8.4 6.4 11.6 12.8 4.8" })
);
var IconClose = (props) => svg(
  props,
  (0, import_react.createElement)("path", { key: "a", d: "M4 4l8 8M12 4l-8 8" })
);
var IconRevert = (props) => svg(
  props,
  (0, import_react.createElement)("path", { key: "a", d: "M3 7.2h6.2a3.4 3.4 0 0 1 0 6.8H6.4" }),
  (0, import_react.createElement)("path", { key: "b", d: "M5.4 4.4 2.6 7.2l2.8 2.8" })
);

// src/client/editor.tsx
var import_react2 = require("react");
var import_react3 = require("react");
function InlineEditor({
  editing,
  t,
  pending,
  error,
  onText,
  onToggleAttachment,
  onSave,
  onCancel
}) {
  const area = (0, import_react2.useRef)(null);
  (0, import_react2.useEffect)(() => {
    const element = area.current;
    if (element === null) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  const onKeyDown = (0, import_react2.useCallback)((event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSave();
    }
  }, [onCancel, onSave]);
  const removed = editing.removed;
  return (0, import_react3.createElement)(
    "div",
    { className: "dme-editor", "data-message-editor": "editor" },
    (0, import_react3.createElement)("textarea", {
      ref: area,
      className: "dme-input",
      value: editing.text,
      rows: 3,
      spellCheck: false,
      "aria-label": t("editor.title"),
      placeholder: t("editor.placeholder"),
      disabled: pending,
      onChange: (event) => {
        onText(event.target.value);
      },
      onKeyDown
    }),
    editing.attachments.length > 0 && (0, import_react3.createElement)(
      "div",
      { className: "dme-attachments" },
      ...editing.attachments.map((attachment) => {
        const isRemoved = removed.has(attachment.id);
        return (0, import_react3.createElement)(
          "span",
          {
            key: attachment.id,
            className: "dme-chip",
            "data-removed": isRemoved || void 0,
            title: isRemoved ? t("editor.removedAttachment") : attachment.name
          },
          (0, import_react3.createElement)("span", { className: "dme-chip-label" }, attachment.name || attachment.id),
          (0, import_react3.createElement)("button", {
            type: "button",
            className: "dme-chip-remove",
            "aria-label": t("editor.removeAttachment"),
            "aria-pressed": isRemoved,
            disabled: pending,
            onClick: () => {
              onToggleAttachment(attachment.id);
            }
          }, (0, import_react3.createElement)(IconClose, { width: 12, height: 12 }))
        );
      })
    ),
    (0, import_react3.createElement)(
      "div",
      { className: "dme-editor-foot" },
      (0, import_react3.createElement)("span", {
        className: "dme-hint",
        "data-tone": error === null ? void 0 : "error",
        role: error === null ? void 0 : "alert"
      }, error ?? t(editing.kind === "assistant" ? "editor.hint.assistant" : "editor.hint.user")),
      (0, import_react3.createElement)(
        "span",
        { className: "dme-buttons" },
        (0, import_react3.createElement)("button", {
          type: "button",
          className: "dme-btn",
          disabled: pending,
          onClick: onCancel
        }, t("editor.cancel")),
        (0, import_react3.createElement)("button", {
          type: "button",
          className: "dme-btn",
          "data-variant": "primary",
          disabled: pending,
          onClick: onSave
        }, pending ? t("editor.saving") : t("editor.save"))
      )
    )
  );
}

// src/client/media.tsx
var import_react4 = require("react");
var import_react5 = require("react");
function useImageUrl(loadImage, attachment) {
  const [url, setUrl] = (0, import_react4.useState)(null);
  const [failed, setFailed] = (0, import_react4.useState)(false);
  const id = attachment?.attachmentId;
  (0, import_react4.useEffect)(() => {
    let alive = true;
    setUrl(null);
    setFailed(false);
    if (typeof loadImage !== "function" || id === void 0) {
      setFailed(true);
      return () => {
        alive = false;
      };
    }
    Promise.resolve(loadImage(attachment)).then(
      (resolved) => {
        if (alive) setUrl(resolved);
      },
      () => {
        if (alive) setFailed(true);
      }
    );
    return () => {
      alive = false;
    };
  }, [loadImage, id]);
  return { url, failed };
}
function MessageImage({ attachment, loadImage }) {
  const { url, failed } = useImageUrl(loadImage, attachment);
  if (failed) {
    return (0, import_react5.createElement)("span", { className: "dme-image-fallback" }, attachment.name ?? attachment.attachmentId);
  }
  if (url === null) return null;
  return (0, import_react5.createElement)("img", {
    className: "dme-image",
    src: url,
    alt: attachment.name ?? "",
    loading: "lazy",
    draggable: false
  });
}
function contentParts(content) {
  const texts = [];
  const images = [];
  const rest = [];
  for (const block of Array.isArray(content) ? content : []) {
    const typed = block;
    if (typed?.type === "text" && typeof typed.text === "string") texts.push(typed.text);
    else if (typed?.type === "image" && typed.attachment !== void 0) images.push(typed.attachment);
    else rest.push(block);
  }
  return { text: texts.join(""), images, rest };
}
function attachmentChips(content) {
  const chips = [];
  for (const block of Array.isArray(content) ? content : []) {
    const typed = block;
    if (typed?.type !== "image" && typed?.type !== "file") continue;
    const id = typed.attachment?.attachmentId;
    if (typeof id !== "string") continue;
    chips.push({ id, name: typed.attachment?.name ?? typed.attachment?.mediaType ?? id });
  }
  return chips;
}
function formatClock(time) {
  if (typeof time !== "number" || !Number.isFinite(time)) return null;
  const date = new Date(time);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}
function jsonPreview(value) {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
async function writeClipboard(text) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText !== void 0) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

// src/client/user-node.tsx
var NO_EDITOR = (_selector) => void 0;
function translateOf(props) {
  return typeof props.t === "function" ? props.t : (key) => props.fallbackT(key);
}
function userOriginSeq(node) {
  const seq = node?.data?.["seq"];
  if (typeof seq === "number") return seq;
  return typeof node?.anchorSeq === "number" ? node.anchorSeq : void 0;
}
function projectUserText(text) {
  const pattern = /(^|\s)([/@][\w-]+)(?=\s|$)/g;
  const parts = [];
  let cursor = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const tokenStart = match.index + (match[1]?.length ?? 0);
    const label = match[2] ?? "";
    if (tokenStart > cursor) parts.push((0, import_react7.createElement)("span", { key: `t${cursor}` }, text.slice(cursor, tokenStart)));
    parts.push((0, import_react7.createElement)("span", { key: `c${tokenStart}`, className: "dme-ref" }, label));
    cursor = tokenStart + label.length;
  }
  if (cursor < text.length) parts.push((0, import_react7.createElement)("span", { key: `t${cursor}` }, text.slice(cursor)));
  return parts;
}
function EditedUserMessageView(props) {
  const t = translateOf(props);
  const controller = props.controller;
  const useEditor = props.useEditor ?? NO_EDITOR;
  const node = props.node;
  const data = node?.data ?? {};
  const content = data["content"];
  const originSeq = userOriginSeq(node);
  const edit = useEditor((view) => originSeq === void 0 ? void 0 : view.edits.get(originSeq));
  const editing = useEditor((view) => view.editing !== null && view.editing.originSeq === originSeq ? view.editing : null) ?? null;
  const pending = useEditor((view) => view.pending) === true;
  const error = useEditor((view) => view.error) ?? null;
  const [copied, setCopied] = (0, import_react6.useState)(false);
  const copyPending = (0, import_react6.useRef)(false);
  const copyTimer = (0, import_react6.useRef)(null);
  (0, import_react6.useEffect)(() => () => {
    copyPending.current = false;
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
  }, []);
  const effective = edit === void 0 ? content : (() => {
    const drop = new Set(edit.removed);
    const kept = (Array.isArray(content) ? content : []).filter((block) => {
      const typed = block;
      if (typed?.type !== "image" && typed?.type !== "file") return true;
      return !drop.has(typed.attachment?.attachmentId ?? "");
    });
    let written = false;
    const out = [];
    for (const block of kept) {
      const typed = block;
      if (typed?.type === "text") {
        if (written) continue;
        written = true;
        out.push({ ...block, type: "text", text: edit.text });
        continue;
      }
      out.push(block);
    }
    if (!written) out.unshift({ type: "text", text: edit.text });
    return out;
  })();
  const { text, images, rest } = contentParts(effective);
  const onCopy = (0, import_react6.useCallback)(() => {
    if (copied || copyPending.current) return;
    copyPending.current = true;
    void writeClipboard(text).then((accepted) => {
      copyPending.current = false;
      if (!accepted) return;
      setCopied(true);
      copyTimer.current = setTimeout(() => {
        copyTimer.current = null;
        setCopied(false);
      }, 1e3);
    });
  }, [copied, text]);
  const onEdit = (0, import_react6.useCallback)(() => {
    if (originSeq === void 0 || controller === void 0) return;
    const chips = attachmentChips(content);
    controller.begin({
      originSeq,
      kind: data["kind"] === "steering" ? "user" : "user",
      text,
      attachments: chips
    });
  }, [controller, content, data, originSeq, text]);
  const clock = formatClock(data["time"]);
  const badgeKey = edit?.deferred === true ? "badge.deferred" : "badge.edited";
  const actionStrip = (0, import_react7.createElement)(
    "div",
    { className: "dme-actions" },
    clock !== null && (0, import_react7.createElement)("span", { className: "dme-time" }, clock),
    (0, import_react7.createElement)("button", {
      type: "button",
      className: "dme-action",
      "aria-label": copied ? t("action.copied") : t("action.copy"),
      title: copied ? t("action.copied") : t("action.copy"),
      onClick: onCopy
    }, copied ? (0, import_react7.createElement)(IconCheck) : (0, import_react7.createElement)(IconCopy)),
    originSeq !== void 0 && (0, import_react7.createElement)("button", {
      type: "button",
      className: "dme-action",
      "data-message-editor": "edit",
      "data-active": edit !== void 0 || void 0,
      "aria-label": t("action.edit"),
      title: t("action.edit"),
      onClick: onEdit
    }, (0, import_react7.createElement)(IconEdit)),
    edit !== void 0 && controller !== void 0 && (0, import_react7.createElement)("button", {
      type: "button",
      className: "dme-action",
      "aria-label": t("action.revert"),
      title: t("action.revert"),
      disabled: pending,
      onClick: () => {
        controller.revert(edit.originSeq);
      }
    }, (0, import_react7.createElement)(IconRevert)),
    edit !== void 0 && (0, import_react7.createElement)(
      "span",
      { className: "dme-badge" },
      (0, import_react7.createElement)("span", { className: "dme-badge-dot", "aria-hidden": true }),
      t(badgeKey)
    )
  );
  return (0, import_react7.createElement)(
    "div",
    { className: "dme-user-row", "data-time-hover-root": true },
    (0, import_react7.createElement)(
      "div",
      { className: "dme-user-stack" },
      images.length > 0 && (0, import_react7.createElement)(
        "div",
        { className: "dme-images" },
        ...images.map((image, index) => (0, import_react7.createElement)(MessageImage, {
          key: image.attachmentId ?? index,
          attachment: image,
          loadImage: props.loadImage
        }))
      ),
      editing !== null && controller !== void 0 ? (0, import_react7.createElement)(InlineEditor, {
        editing,
        t,
        pending,
        error,
        onText: controller.setText,
        onToggleAttachment: controller.toggleAttachment,
        onSave: controller.save,
        onCancel: controller.cancel
      }) : (text !== "" || rest.length > 0) && (0, import_react7.createElement)(
        "div",
        { className: "dme-bubble" },
        (0, import_react7.createElement)("div", { className: "dme-text" }, ...projectUserText(text)),
        ...rest.map((block, index) => (0, import_react7.createElement)("pre", { key: index, className: "dme-extra" }, jsonPreview(block)))
      )
    ),
    actionStrip
  );
}

// src/client/assistant-node.tsx
var import_react8 = require("react");
var NO_EDITOR2 = (_selector) => void 0;
var DelegateBoundary = class extends import_react8.Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error) {
    console.error("[dsh-message-editor] the shipped assistant renderer failed; using the built-in fallback:", error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
};
function assistantOriginSeq(node) {
  const finalNode = node?.data?.["finalNode"];
  if (typeof finalNode?.seq === "number") return finalNode.seq;
  return typeof node?.anchorSeq === "number" ? node.anchorSeq : void 0;
}
function collapseAssistantText(blocks, text) {
  const out = [];
  let written = false;
  for (const block of blocks) {
    if (block?.kind === "text") {
      if (written) continue;
      written = true;
      out.push({ ...block, text });
      continue;
    }
    out.push(block);
  }
  if (!written) out.unshift({ kind: "text", text });
  return out;
}
function withEditedText(node, text) {
  const data = node.data ?? {};
  const blocks = Array.isArray(data["blocks"]) ? data["blocks"] : [];
  const finalNode = data["finalNode"];
  const nextData = { ...data, blocks: collapseAssistantText(blocks, text) };
  if (finalNode !== void 0 && Array.isArray(finalNode.blocks)) {
    nextData["finalNode"] = { ...finalNode, blocks: collapseAssistantText(finalNode.blocks, text) };
  }
  return { ...node, data: nextData };
}
function FallbackBody({ blocks, t }) {
  const parts = [];
  blocks.forEach((block, index) => {
    if (block?.kind === "text") {
      parts.push((0, import_react8.createElement)("div", { key: `t${index}`, className: "dme-text" }, block.text ?? ""));
      return;
    }
    if (block?.kind === "reasoning") {
      parts.push((0, import_react8.createElement)(
        "div",
        { key: `r${index}`, className: "dme-reasoning" },
        (0, import_react8.createElement)("div", { className: "dme-hint" }, t("reasoning.label")),
        block.text ?? ""
      ));
      return;
    }
    if (block?.kind === "image" && block.attachment !== void 0) {
      parts.push((0, import_react8.createElement)(MessageImage, { key: `i${index}`, attachment: block.attachment }));
      return;
    }
    if (block?.kind === "tool-call") return;
    parts.push((0, import_react8.createElement)("pre", { key: `o${index}`, className: "dme-extra" }, jsonPreview(block?.block ?? block)));
  });
  return (0, import_react8.createElement)("div", { className: "dme-assistant" }, ...parts);
}
function EditedAssistantStepView(props) {
  const t = typeof props.t === "function" ? props.t : (key) => props.fallbackT(key);
  const controller = props.controller;
  const useEditor = props.useEditor;
  const node = props.node;
  const originSeq = assistantOriginSeq(node);
  const select = useEditor ?? NO_EDITOR2;
  const edit = select((view) => originSeq === void 0 ? void 0 : view.edits.get(originSeq));
  const editing = select((view) => view.editing !== null && view.editing.originSeq === originSeq ? view.editing : null) ?? null;
  const pending = select((view) => view.pending) === true;
  const error = select((view) => view.error) ?? null;
  const data = node?.data ?? {};
  const blocks = Array.isArray(data["blocks"]) ? data["blocks"] : [];
  const effective = edit === void 0 ? blocks : collapseAssistantText(blocks, edit.text);
  if (editing !== null && controller !== void 0) {
    return (0, import_react8.createElement)("div", { className: "dme-assistant" }, (0, import_react8.createElement)(InlineEditor, {
      editing,
      t,
      pending,
      error,
      onText: controller.setText,
      onToggleAttachment: controller.toggleAttachment,
      onSave: controller.save,
      onCancel: controller.cancel
    }));
  }
  const builtin = props.builtinNode;
  if (builtin !== void 0 && builtin !== null && node !== void 0) {
    const target = edit === void 0 ? node : withEditedText(node, edit.text);
    const conversationT = props.conversationT;
    const delegated = conversationT === void 0 ? { ...props, node: target } : { ...props, node: target, t: conversationT };
    return (0, import_react8.createElement)(
      DelegateBoundary,
      { fallback: (0, import_react8.createElement)(FallbackBody, { blocks: effective, t }) },
      (0, import_react8.createElement)(builtin, delegated)
    );
  }
  const clock = formatClock(data["time"]);
  return (0, import_react8.createElement)(
    import_react8.Fragment,
    null,
    (0, import_react8.createElement)(FallbackBody, { blocks: effective, t }),
    clock !== null && (0, import_react8.createElement)("div", { className: "dme-actions" }, (0, import_react8.createElement)("span", { className: "dme-time" }, clock))
  );
}

// src/client/assistant-action.tsx
var import_react9 = require("react");
var NO_EDITOR3 = (_selector) => void 0;
var NO_SESSION = (_selector) => void 0;
function findAssistantStep(snapshot, messageId) {
  if (messageId === void 0 || snapshot === void 0 || snapshot === null) return void 0;
  const chat = snapshot?.chat;
  const order = chat?.order;
  const nodes = chat?.nodes;
  if (!Array.isArray(order) || typeof nodes?.get !== "function") return void 0;
  for (const key of order) {
    const node = nodes.get(key);
    if (node?.kind !== "assistant-step") continue;
    const finalNode = node.data?.["finalNode"];
    if (finalNode?.messageId !== messageId) continue;
    const originSeq = assistantOriginSeq(node);
    if (originSeq === void 0) continue;
    const blocks = Array.isArray(node.data?.["blocks"]) ? node.data?.["blocks"] : [];
    let text = "";
    for (const block of blocks) {
      const typed = block;
      if (typed?.kind === "text" && typeof typed.text === "string") text += typed.text;
    }
    return { originSeq, text };
  }
  return void 0;
}
function AssistantEditAction(props) {
  const t = typeof props.t === "function" ? props.t : (key) => props.fallbackT(key);
  const selectSession = props.useSession ?? NO_SESSION;
  const selectEdit = props.useEditor ?? NO_EDITOR3;
  const controller = props.controller;
  const messageId = props.messageId;
  const snapshot = selectSession((value) => value);
  const step = (0, import_react9.useMemo)(() => findAssistantStep(snapshot, messageId), [snapshot, messageId]);
  const originSeq = step?.originSeq;
  const edit = selectEdit((view) => originSeq === void 0 ? void 0 : view.edits.get(originSeq));
  const pending = selectEdit((view) => view.pending) === true;
  const onEdit = (0, import_react9.useCallback)(() => {
    if (step === void 0 || controller === void 0) return;
    controller.begin({
      originSeq: step.originSeq,
      kind: "assistant",
      text: step.text,
      attachments: []
    });
  }, [controller, step]);
  if (originSeq === void 0 || controller === void 0) return null;
  return (0, import_react9.createElement)(
    "div",
    { className: "dme-actions" },
    (0, import_react9.createElement)("button", {
      type: "button",
      className: "dme-action",
      "data-message-editor": "edit",
      "data-active": edit !== void 0 || void 0,
      "aria-label": t("action.edit"),
      title: t("action.edit"),
      onClick: onEdit
    }, (0, import_react9.createElement)(IconEdit)),
    edit !== void 0 && (0, import_react9.createElement)("button", {
      type: "button",
      className: "dme-action",
      "aria-label": t("action.revert"),
      title: t("action.revert"),
      disabled: pending,
      onClick: () => {
        controller.revert(originSeq);
      }
    }, (0, import_react9.createElement)(IconRevert)),
    edit !== void 0 && (0, import_react9.createElement)(
      "span",
      { className: "dme-badge" },
      (0, import_react9.createElement)("span", { className: "dme-badge-dot", "aria-hidden": true }),
      t(edit.deferred ? "badge.deferred" : "badge.edited")
    )
  );
}

// src/client/locales.ts
var NS = "message-editor";
var zh = {
  "action.edit": "\u7F16\u8F91\u8FD9\u6761\u6D88\u606F",
  "action.editUnavailable": "\u8FD9\u6761\u6D88\u606F\u8FD8\u5728\u751F\u6210\u4E2D\uFF0C\u6682\u65F6\u65E0\u6CD5\u7F16\u8F91",
  "action.copy": "\u590D\u5236",
  "action.copied": "\u5DF2\u590D\u5236",
  "action.revert": "\u64A4\u9500\u4FEE\u6539\uFF0C\u6062\u590D\u539F\u6587",
  "badge.edited": "\u5DF2\u4FEE\u6539",
  "badge.deferred": "\u5DF2\u4FEE\u6539 \xB7 \u4E0B\u4E00\u6B65\u751F\u6548",
  "editor.title": "\u7F16\u8F91\u6D88\u606F",
  "editor.placeholder": "\u4FEE\u6539\u8FD9\u6761\u6D88\u606F\u7684\u5185\u5BB9\u2026",
  "editor.save": "\u4FDD\u5B58",
  "editor.cancel": "\u53D6\u6D88",
  "editor.saving": "\u4FDD\u5B58\u4E2D\u2026",
  "editor.attachments": "\u9644\u4EF6",
  "editor.removeAttachment": "\u79FB\u9664\u8FD9\u4E2A\u9644\u4EF6",
  "editor.removedAttachment": "\u5DF2\u79FB\u9664\uFF0C\u4FDD\u5B58\u540E\u751F\u6548",
  "editor.hint.user": "\u4EC5\u4FEE\u6539\u5BF9\u8BDD\u5185\u5BB9\uFF0C\u4E0D\u4F1A\u91CD\u65B0\u751F\u6210\uFF1B\u540E\u7EED\u5BF9\u8BDD\u5C06\u4EE5\u4FEE\u6539\u540E\u7684\u5185\u5BB9\u4E3A\u51C6\u3002",
  "editor.hint.assistant": "\u4EC5\u4FEE\u6539\u5BF9\u8BDD\u5185\u5BB9\uFF0C\u4E0D\u4F1A\u91CD\u65B0\u751F\u6210\uFF1B\u540E\u7EED\u5BF9\u8BDD\u5C06\u4EE5\u4FEE\u6539\u540E\u7684\u5185\u5BB9\u4E3A\u51C6\u3002",
  "editor.hint.deferred": "\u8FD9\u6761\u56DE\u590D\u7684\u4FEE\u6539\u4F1A\u5728\u4E0B\u4E00\u6B65\u6A21\u578B\u8C03\u7528\u65F6\u751F\u6548\u3002",
  "editor.empty": "\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A\u3002",
  "notice.saved": "\u5DF2\u4FDD\u5B58\u4FEE\u6539\u3002",
  "notice.reverted": "\u5DF2\u6062\u590D\u539F\u6587\u3002",
  "error.load": "\u8BFB\u53D6\u4FEE\u6539\u8BB0\u5F55\u5931\u8D25\u3002",
  "error.generic": "\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002",
  "error.session-cold": "\u8BE5\u4F1A\u8BDD\u5C1A\u672A\u8F7D\u5165\uFF0C\u5148\u53D1\u9001\u4E00\u6761\u6D88\u606F\u518D\u7F16\u8F91\u3002",
  "error.target-not-found": "\u8FD9\u6761\u6D88\u606F\u5DF2\u4E0D\u5728\u53EF\u7F16\u8F91\u7684\u5BF9\u8BDD\u5185\u5BB9\u4E2D\u3002",
  "error.unsupported-target": "\u8FD9\u79CD\u7C7B\u578B\u7684\u6D88\u606F\u4E0D\u652F\u6301\u7F16\u8F91\u3002",
  "error.text-too-large": "\u5185\u5BB9\u8FC7\u957F\u3002",
  "error.bad-request": "\u8BF7\u6C42\u53C2\u6570\u65E0\u6548\u3002",
  "error.transport": "\u4E0E\u4E3B\u8FDB\u7A0B\u901A\u4FE1\u5931\u8D25\u3002",
  "reasoning.label": "\u601D\u8003\u8FC7\u7A0B"
};
var en = {
  "action.edit": "Edit this message",
  "action.editUnavailable": "This message is still streaming and cannot be edited yet",
  "action.copy": "Copy",
  "action.copied": "Copied",
  "action.revert": "Revert to the original text",
  "badge.edited": "Edited",
  "badge.deferred": "Edited \xB7 applies next step",
  "editor.title": "Edit message",
  "editor.placeholder": "Rewrite this message\u2026",
  "editor.save": "Save",
  "editor.cancel": "Cancel",
  "editor.saving": "Saving\u2026",
  "editor.attachments": "Attachments",
  "editor.removeAttachment": "Remove this attachment",
  "editor.removedAttachment": "Removed; applies on save",
  "editor.hint.user": "Edits the conversation only \u2014 nothing is regenerated, and later turns use the edited text.",
  "editor.hint.assistant": "Edits the conversation only \u2014 nothing is regenerated, and later turns use the edited text.",
  "editor.hint.deferred": "This reply takes effect from the next model step.",
  "editor.empty": "Content cannot be empty.",
  "notice.saved": "Edit saved.",
  "notice.reverted": "Original text restored.",
  "error.load": "Could not read the edit records.",
  "error.generic": "That did not work. Please try again.",
  "error.session-cold": "This session is not loaded yet \u2014 send a message, then edit.",
  "error.target-not-found": "That message is no longer part of the editable conversation.",
  "error.unsupported-target": "This kind of message cannot be edited.",
  "error.text-too-large": "The text is too long.",
  "error.bad-request": "The request was malformed.",
  "error.transport": "Could not reach the host process.",
  "reasoning.label": "Reasoning"
};

// src/client/styles.ts
var STYLE_ID = "dsh-message-editor";
var STYLES = `
.dme-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 6px;
  border: none;
  border-radius: 28px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
  cursor: pointer;
  transition: background 80ms ease, color 80ms ease;
}
.dme-action:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
.dme-action:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 2px;
}
.dme-action[disabled] {
  opacity: 0.45;
  cursor: default;
}
.dme-action[data-active] {
  color: var(--dsw-alias-brand-primary, #4d6bfe);
}

.dme-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 28px;
}

.dme-time {
  font-size: 14px;
  line-height: 24px;
  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary, #8a8a8a));
  white-space: nowrap;
}

.dme-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 24px;
  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary, #8a8a8a));
  white-space: nowrap;
}
.dme-badge-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary, #4d6bfe);
}

/* ---- user bubble -------------------------------------------------------- */

.dme-user-row {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  width: 100%;
}
.dme-user-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  max-width: min(525px, 82%);
}
.dme-bubble {
  background: var(--dsw-specific-bubble, var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.1)));
  border-radius: 22px;
  padding: 10px 16px;
  font-size: 16px;
  line-height: 24px;
  color: var(--dsw-alias-label-primary, #1a1a1a);
  word-break: break-word;
}
.dme-text {
  white-space: pre-wrap;
}
.dme-ref {
  display: inline-block;
  padding: 0 6px;
  margin: 0 1px;
  border-radius: 6px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-brand-primary, #4d6bfe);
  font-size: 15px;
}
.dme-images {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}
.dme-image {
  max-width: 220px;
  max-height: 220px;
  border-radius: 12px;
  object-fit: cover;
  cursor: zoom-in;
  display: block;
}
.dme-image-fallback {
  font-size: 12px;
  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary, #8a8a8a));
}
.dme-extra {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.06));
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
  max-height: 160px;
  overflow: auto;
}

/* ---- editor ------------------------------------------------------------- */

.dme-editor {
  width: 100%;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  border-radius: 18px;
  background: var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.05));
  padding: 10px 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
.dme-editor:focus-within {
  border-color: var(--dsw-alias-brand-primary, #4d6bfe);
}
.dme-input {
  width: 100%;
  min-height: 84px;
  max-height: 45vh;
  resize: vertical;
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 15px;
  line-height: 24px;
  padding: 0;
  field-sizing: content;
}
.dme-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.dme-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  padding: 3px 4px 3px 10px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.1));
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.14));
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
}
.dme-chip-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dme-chip-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.dme-chip-remove:hover {
  background: var(--dsw-alias-state-error-primary, #e5484d);
  color: #fff;
}
.dme-chip[data-removed] .dme-chip-label {
  text-decoration: line-through;
  opacity: 0.6;
}

.dme-editor-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.dme-hint {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary, #8a8a8a));
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dme-hint[data-tone='error'] {
  color: var(--dsw-alias-state-error-primary, #e5484d);
}
.dme-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.dme-btn {
  height: 28px;
  padding: 0 14px;
  border-radius: 999px;
  font-size: 13px;
  line-height: 26px;
  cursor: pointer;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
  white-space: nowrap;
}
.dme-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
.dme-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 2px;
}
.dme-btn[disabled] {
  opacity: 0.45;
  cursor: default;
}
.dme-btn[data-variant='primary'] {
  background: var(--dsw-alias-brand-primary, #4d6bfe);
  color: #fff;
}
.dme-btn[data-variant='primary']:hover {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, #4d6bfe));
  color: #fff;
}

/* ---- assistant fallback body ------------------------------------------- */

.dme-assistant {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.dme-reasoning {
  border-left: 2px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  padding: 2px 0 2px 10px;
  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary, #8a8a8a));
  font-size: 14px;
  line-height: 22px;
  white-space: pre-wrap;
}

.dme-toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  z-index: 40;
  max-width: 70vw;
  padding: 8px 14px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-overlay, rgba(20, 20, 20, 0.92));
  color: var(--dsw-alias-label-primary-foreground, #fff);
  font-size: 13px;
  line-height: 20px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.24);
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .dme-action { transition: none; }
}
`;
function installStyles(doc) {
  const target = doc ?? (typeof document === "undefined" ? void 0 : document);
  if (target === void 0) return;
  if (target.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return;
  const tag = target.createElement("style");
  tag.dataset.pluginCss = STYLE_ID;
  tag.textContent = STYLES;
  target.head.appendChild(tag);
}

// src/client/index.ts
var name = "dsh-message-editor";
var inject = ["slots"];
var CONVERSATION_NS = "conversation";
var NODE_SLOT = "conversation.chat.node";
var ACTIONS_SLOT = "conversation.chat.assistant-actions";
var OVERLAY_SLOT = "shell.overlay";
function markShadow(component) {
  try {
    Object.defineProperty(component, "__dmeShadow", { value: true, enumerable: false });
  } catch {
  }
  return component;
}
function localeOf(ctx) {
  const candidate = ctx.get("locale");
  if (typeof candidate?.register !== "function") return void 0;
  if (typeof candidate.bind !== "function") return void 0;
  return candidate;
}
function asHooks(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value;
}
function captureEntry(slots, key) {
  try {
    const entries = typeof slots.entries === "function" ? slots.entries(NODE_SLOT) : [];
    for (const entry of entries) {
      if (entry?.options?.key !== key) continue;
      const component = entry.component;
      if (component === void 0 || component === null) continue;
      if (component.__dmeShadow === true) continue;
      return entry;
    }
  } catch (error) {
    console.warn("[dsh-message-editor] could not read the shipped chat renderers:", error);
  }
  return void 0;
}
function createNoticeBus() {
  let value = null;
  let timer = null;
  const listeners = /* @__PURE__ */ new Set();
  const emit = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[dsh-message-editor] notice subscriber threw:", error);
      }
    }
  };
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    push: (message) => {
      value = message;
      emit();
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        value = null;
        emit();
      }, 2800);
    },
    dispose: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      listeners.clear();
    }
  };
}
function NoticeToast({ useNotice }) {
  const notice = useNotice((value) => value);
  if (notice === null || notice === void 0 || notice === "") return null;
  return (0, import_react10.createElement)("div", { className: "dme-toast", role: "status" }, notice);
}
function apply(ctx) {
  installStyles();
  const locale = localeOf(ctx);
  const hasLocale = locale !== void 0;
  if (locale !== void 0) {
    ctx.effect(() => locale.register(NS, "zh", zh), "dsh-message-editor: zh dictionary");
    ctx.effect(() => locale.register(NS, "en", en), "dsh-message-editor: en dictionary");
  }
  const fallbackT = (key) => typeof zh[key] === "string" ? zh[key] : key;
  const conversationT = locale?.bind(CONVERSATION_NS);
  const localT = locale?.bind(NS) ?? fallbackT;
  const notices = createNoticeBus();
  const channel = createEditorChannel();
  const controllers = /* @__PURE__ */ new Map();
  const controllerFor = (sessionId) => {
    let controller = controllers.get(sessionId);
    if (controller === void 0) {
      controller = new MessageEditorController(
        (endpoint, payload) => channel.call(endpoint, payload),
        sessionId,
        localT,
        (message) => {
          notices.push(message);
        }
      );
      controllers.set(sessionId, controller);
    }
    return controller;
  };
  const injectedFor = (sessionId) => {
    const controller = controllerFor(sessionId);
    return {
      hooks: { editor: controller },
      controller,
      conversationT,
      fallbackT
    };
  };
  ctx.on("connection/reset", () => {
    for (const controller of controllers.values()) {
      if (controller.getSnapshot().status !== "cold") void controller.refresh();
    }
  });
  ctx.slots.inject(NODE_SLOT, () => {
    const shipped = {
      user: captureEntry(ctx.slots, "user"),
      steering: captureEntry(ctx.slots, "steering"),
      "assistant-step": captureEntry(ctx.slots, "assistant-step")
    };
    if (shipped["assistant-step"] === void 0) {
      console.warn("[dsh-message-editor] shipped assistant renderer not found; using the self-contained body");
    }
    const take = (key, component) => {
      const cell = shipped[key];
      const base = {
        name: NODE_SLOT,
        key,
        ...hasLocale ? { locale: NS } : {},
        inject: (sessionId) => {
          const controller = controllerFor(sessionId);
          const inherited = typeof cell?.inject === "function" ? cell.inject(sessionId) ?? {} : {};
          const hooks = { ...asHooks(inherited["hooks"]), editor: controller };
          return {
            ...inherited,
            hooks,
            controller,
            conversationT,
            fallbackT,
            builtinNode: cell?.component
          };
        }
      };
      try {
        return ctx.slots.register(base, component);
      } catch {
        return ctx.slots.register({ ...base, priority: -1 }, component);
      }
    };
    const disposers = [
      take("user", markShadow(EditedUserMessageView)),
      take("steering", markShadow(EditedUserMessageView)),
      take("assistant-step", markShadow(EditedAssistantStepView))
    ];
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch (error) {
          console.error("[dsh-message-editor] slot disposer threw:", error);
        }
      }
    };
  });
  ctx.slots.inject(ACTIONS_SLOT, () => ctx.slots.register({
    name: ACTIONS_SLOT,
    id: "message-editor",
    order: 5,
    inject: injectedFor,
    ...hasLocale ? { locale: NS } : {}
  }, markShadow(AssistantEditAction)));
  ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
    name: OVERLAY_SLOT,
    id: "message-editor-notice",
    order: 90,
    inject: () => ({ hooks: { notice: notices } })
  }, NoticeToast));
  ctx.effect(() => () => {
    for (const controller of controllers.values()) controller.dispose();
    controllers.clear();
    notices.dispose();
  }, "dsh-message-editor: teardown");
}

		return module.exports;
	}
});
//# sourceMappingURL=client.js.map
