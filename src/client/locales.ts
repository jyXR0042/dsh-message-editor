/**
 * This plugin's dictionaries.
 *
 * Registered under its own namespace so the framework's `t` seat can be
 * declared on the plugin's slot entries; the host's shared `common` namespace is
 * consulted automatically after a miss, so only feature-specific copy lives
 * here.
 *
 * @module dsh-message-editor/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'message-editor'

/** Simplified Chinese copy (the default locale of this profile). */
export const zh = {
  'action.edit': '编辑这条消息',
  'action.editUnavailable': '这条消息还在生成中，暂时无法编辑',
  'action.copy': '复制',
  'action.copied': '已复制',
  'action.revert': '撤销修改，恢复原文',
  'badge.edited': '已修改',
  'badge.deferred': '已修改 · 下一步生效',
  'editor.title': '编辑消息',
  'editor.placeholder': '修改这条消息的内容…',
  'editor.save': '保存',
  'editor.cancel': '取消',
  'editor.saving': '保存中…',
  'editor.attachments': '附件',
  'editor.removeAttachment': '移除这个附件',
  'editor.removedAttachment': '已移除，保存后生效',
  'editor.hint.user': '仅修改对话内容，不会重新生成；后续对话将以修改后的内容为准。',
  'editor.hint.assistant': '仅修改对话内容，不会重新生成；后续对话将以修改后的内容为准。',
  'editor.hint.deferred': '这条回复的修改会在下一步模型调用时生效。',
  'editor.empty': '内容不能为空。',
  'notice.saved': '已保存修改。',
  'notice.reverted': '已恢复原文。',
  'error.load': '读取修改记录失败。',
  'error.generic': '操作失败，请重试。',
  'error.session-cold': '该会话尚未载入，先发送一条消息再编辑。',
  'error.target-not-found': '这条消息已不在可编辑的对话内容中。',
  'error.unsupported-target': '这种类型的消息不支持编辑。',
  'error.text-too-large': '内容过长。',
  'error.bad-request': '请求参数无效。',
  'error.transport': '与主进程通信失败。',
  'reasoning.label': '思考过程',
}

/** English copy. */
export const en = {
  'action.edit': 'Edit this message',
  'action.editUnavailable': 'This message is still streaming and cannot be edited yet',
  'action.copy': 'Copy',
  'action.copied': 'Copied',
  'action.revert': 'Revert to the original text',
  'badge.edited': 'Edited',
  'badge.deferred': 'Edited · applies next step',
  'editor.title': 'Edit message',
  'editor.placeholder': 'Rewrite this message…',
  'editor.save': 'Save',
  'editor.cancel': 'Cancel',
  'editor.saving': 'Saving…',
  'editor.attachments': 'Attachments',
  'editor.removeAttachment': 'Remove this attachment',
  'editor.removedAttachment': 'Removed; applies on save',
  'editor.hint.user': 'Edits the conversation only — nothing is regenerated, and later turns use the edited text.',
  'editor.hint.assistant': 'Edits the conversation only — nothing is regenerated, and later turns use the edited text.',
  'editor.hint.deferred': 'This reply takes effect from the next model step.',
  'editor.empty': 'Content cannot be empty.',
  'notice.saved': 'Edit saved.',
  'notice.reverted': 'Original text restored.',
  'error.load': 'Could not read the edit records.',
  'error.generic': 'That did not work. Please try again.',
  'error.session-cold': 'This session is not loaded yet — send a message, then edit.',
  'error.target-not-found': 'That message is no longer part of the editable conversation.',
  'error.unsupported-target': 'This kind of message cannot be edited.',
  'error.text-too-large': 'The text is too long.',
  'error.bad-request': 'The request was malformed.',
  'error.transport': 'Could not reach the host process.',
  'reasoning.label': 'Reasoning',
}
