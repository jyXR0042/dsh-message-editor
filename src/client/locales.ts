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
  'action.regenerate': '重新生成本轮',
  'action.regenerateHint': '让模型重新回答这一轮；旧回答会从对话和上下文中移除',
  'action.copy': '复制',
  'action.copied': '已复制',
  'action.revert': '撤销修改，恢复原文',
  'badge.edited': '已修改',
  'badge.deferred': '已修改 · 下一步生效',
  'editor.title': '编辑消息',
  'editor.placeholder': '修改这条消息的内容…',
  'editor.save': '保存',
  'editor.saveRegenerate': '保存并重新生成',
  'editor.cancel': '取消',
  'editor.saving': '保存中…',
  'editor.attachments': '附件',
  'editor.removeAttachment': '移除这个附件',
  'editor.removedAttachment': '已移除，保存后生效',
  'editor.hint.user': '仅修改对话内容，不会重新生成；后续对话将以修改后的内容为准。',
  'editor.hint.assistant': '仅修改对话内容，不会重新生成；后续对话将以修改后的内容为准。',
  'editor.hint.regenerate': '保存修改，并让模型基于新内容重新回答；旧的回答会从对话与上下文中移除。',
  'editor.hint.deferred': '这条回复的修改会在下一步模型调用时生效。',
  'editor.empty': '内容不能为空。',
  'notice.saved': '已保存修改。',
  'notice.regenerating': '已保存，正在重新生成…',
  'notice.reverted': '已恢复原文。',
  'regenerate.instruction': '我修改了上一条消息，请忽略你之前对它的回答，基于修改后的内容重新回答一次。',
  'error.load': '读取修改记录失败。',
  'error.generic': '操作失败，请重试。',
  'error.session-cold': '该会话尚未载入，先发送一条消息再编辑。',
  'error.target-not-found': '这条消息已不在可编辑的对话内容中。',
  'error.unsupported-target': '这种版本的会话格式无法改写模型消息，请改用「重新生成本轮」。',
  'error.text-too-large': '内容过长。',
  'error.bad-request': '请求参数无效。',
  'error.transport': '与主进程通信失败。',
  'error.compactionBusy': '正在压缩上下文，请稍后再试。',
  'error.regenerateFailed': '修改已保存，但没能触发重新生成。',
  'error.staleHost': '主进程里的插件版本比界面旧，请重启 DeepSeek Harness 后再试。',
  'reasoning.label': '思考过程',
}

/** English copy. */
export const en = {
  'action.edit': 'Edit this message',
  'action.editUnavailable': 'This message is still streaming and cannot be edited yet',
  'action.regenerate': 'Regenerate this turn',
  'action.regenerateHint': 'Have the model answer this turn again; the old answer leaves the transcript and the context',
  'action.copy': 'Copy',
  'action.copied': 'Copied',
  'action.revert': 'Revert to the original text',
  'badge.edited': 'Edited',
  'badge.deferred': 'Edited · applies next step',
  'editor.title': 'Edit message',
  'editor.placeholder': 'Rewrite this message…',
  'editor.save': 'Save',
  'editor.saveRegenerate': 'Save & regenerate',
  'editor.cancel': 'Cancel',
  'editor.saving': 'Saving…',
  'editor.attachments': 'Attachments',
  'editor.removeAttachment': 'Remove this attachment',
  'editor.removedAttachment': 'Removed; applies on save',
  'editor.hint.user': 'Edits the conversation only — nothing is regenerated, and later turns use the edited text.',
  'editor.hint.assistant': 'Edits the conversation only — nothing is regenerated, and later turns use the edited text.',
  'editor.hint.regenerate': 'Saves the edit and asks the model to answer it again; the old answer leaves both the transcript and the context.',
  'editor.hint.deferred': 'This reply takes effect from the next model step.',
  'editor.empty': 'Content cannot be empty.',
  'notice.saved': 'Edit saved.',
  'notice.regenerating': 'Saved — regenerating…',
  'notice.reverted': 'Original text restored.',
  'regenerate.instruction': 'I edited the previous message. Ignore your earlier answer to it and answer it again from scratch, based on the edited content.',
  'error.load': 'Could not read the edit records.',
  'error.generic': 'That did not work. Please try again.',
  'error.session-cold': 'This session is not loaded yet — send a message, then edit.',
  'error.target-not-found': 'That message is no longer part of the editable conversation.',
  'error.unsupported-target': 'This session format cannot rewrite a model message. Use Regenerate instead.',
  'error.text-too-large': 'The text is too long.',
  'error.bad-request': 'The request was malformed.',
  'error.transport': 'Could not reach the host process.',
  'error.compactionBusy': 'A context compaction is running. Try again in a moment.',
  'error.regenerateFailed': 'The edit was saved, but the regeneration could not be started.',
  'error.staleHost': 'The plugin is older in the host process than in this page. Restart DeepSeek Harness and try again.',
  'reasoning.label': 'Reasoning',
}
