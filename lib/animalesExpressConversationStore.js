const fs = require('fs')
const path = require('path')

const DEFAULT_RETENTION_DAYS = 30
const DEFAULT_STORE_FILE = path.join(
  __dirname,
  '..',
  'data',
  'animalesexpress-conversations.json'
)

const getRetentionMs = () => {
  const days = Number(process.env.AE_CONVERSATION_RETENTION_DAYS || DEFAULT_RETENTION_DAYS)
  return (Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000
}

const getStoreFile = () =>
  process.env.AE_CONVERSATION_STORE_FILE || DEFAULT_STORE_FILE

const emptyState = () => ({ version: 1, conversations: {} })

let state
let saveTimer
let pendingSave = Promise.resolve()

const loadState = () => {
  if (state) return state
  try {
    state = JSON.parse(fs.readFileSync(getStoreFile(), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[AnimalesExpress] Memoria persistente:', error.message)
    }
    state = emptyState()
  }
  if (!state || typeof state !== 'object') state = emptyState()
  if (!state.conversations || typeof state.conversations !== 'object') {
    state.conversations = {}
  }
  return state
}

const conversationFor = (jid) => {
  const data = loadState()
  if (!data.conversations[jid]) {
    data.conversations[jid] = {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastHumanAt: 0,
      lastAiAt: 0,
      lastEscalatedAt: 0,
      registration: null,
      messages: [],
    }
  }
  return data.conversations[jid]
}

const writeState = async () => {
  const file = getStoreFile()
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file, JSON.stringify(loadState(), null, 2), 'utf8')
}

const scheduleSave = () => {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    pendingSave = pendingSave
      .then(writeState)
      .catch((error) => console.error('[AnimalesExpress] Guardado de memoria:', error.message))
  }, 150)
  saveTimer.unref?.()
}

const flush = async () => {
  clearTimeout(saveTimer)
  saveTimer = undefined
  pendingSave = pendingSave.then(writeState)
  return pendingSave
}

const pruneExpired = (now = Date.now()) => {
  const cutoff = now - getRetentionMs()
  const conversations = loadState().conversations
  let changed = false

  for (const [jid, conversation] of Object.entries(conversations)) {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : []
    const retained = messages.filter((message) => Number(message.createdAt) >= cutoff)
    if (retained.length !== messages.length) {
      conversation.messages = retained
      changed = true
    }

    const registrationUpdatedAt = Number(conversation.registration?.updatedAt || 0)
    if (conversation.registration && registrationUpdatedAt < cutoff) {
      conversation.registration = null
      changed = true
    }

    if (!conversation.messages.length && !conversation.registration && Number(conversation.updatedAt) < cutoff) {
      delete conversations[jid]
      changed = true
    }
  }

  if (changed) scheduleSave()
  return changed
}

const appendMessage = (jid, role, content, createdAt = Date.now()) => {
  const text = String(content || '').trim()
  if (!text) return
  const conversation = conversationFor(jid)
  conversation.messages ||= []
  conversation.messages.push({ role, content: text.slice(0, 6000), createdAt })
  conversation.updatedAt = createdAt
  scheduleSave()
}

const getHistory = (jid, limit = 12) => {
  pruneExpired()
  const conversation = loadState().conversations[jid]
  if (!conversation) return []
  return (conversation.messages || []).slice(-limit).map((message) => ({
    role: message.role === 'user' ? 'user' : 'assistant',
    content:
      message.role === 'human'
        ? `[Respuesta humana de Ulises] ${message.content}`
        : message.content,
  }))
}

const setRegistration = (jid, registration) => {
  const conversation = conversationFor(jid)
  conversation.registration = registration
  conversation.updatedAt = Date.now()
  scheduleSave()
}

const getRegistration = (jid) => {
  pruneExpired()
  return loadState().conversations[jid]?.registration || null
}

const clearRegistration = (jid) => {
  const conversation = conversationFor(jid)
  conversation.registration = null
  conversation.updatedAt = Date.now()
  scheduleSave()
}

const setTimestamp = (jid, field, value = Date.now()) => {
  const conversation = conversationFor(jid)
  conversation[field] = value
  conversation.updatedAt = value
  scheduleSave()
}

const getTimestamp = (jid, field) =>
  Number(loadState().conversations[jid]?.[field] || 0)

const resetForTests = () => {
  clearTimeout(saveTimer)
  saveTimer = undefined
  state = undefined
  pendingSave = Promise.resolve()
}

pruneExpired()

module.exports = {
  appendMessage,
  clearRegistration,
  flush,
  getHistory,
  getRegistration,
  getTimestamp,
  pruneExpired,
  resetForTests,
  setRegistration,
  setTimestamp,
}
