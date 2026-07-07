const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const storeFile = path.join(
  os.tmpdir(),
  `animalesexpress-conversations-${process.pid}-${Date.now()}.json`
)
process.env.AE_CONVERSATION_STORE_FILE = storeFile
process.env.AE_CONVERSATION_RETENTION_DAYS = '30'

const store = require('../animalesExpressConversationStore')

test.after(() => {
  store.resetForTests()
  fs.rmSync(storeFile, { force: true })
})

test('conserva historial y distingue las respuestas humanas', async () => {
  store.appendMessage('34600000000@s.whatsapp.net', 'user', 'Hola')
  store.appendMessage('34600000000@s.whatsapp.net', 'human', 'Te atiendo yo')
  await store.flush()

  assert.deepEqual(store.getHistory('34600000000@s.whatsapp.net'), [
    { role: 'user', content: 'Hola' },
    { role: 'assistant', content: '[Respuesta humana de Ulises] Te atiendo yo' },
  ])
})

test('persiste un registro pendiente después de recargar el módulo', async () => {
  const jid = '34611111111@s.whatsapp.net'
  store.setRegistration(jid, { name: 'Ana', updatedAt: Date.now() })
  await store.flush()
  store.resetForTests()

  assert.equal(store.getRegistration(jid).name, 'Ana')
})

test('elimina mensajes de clientes con más de treinta días', async () => {
  const jid = '34622222222@s.whatsapp.net'
  const olderThanRetention = Date.now() - 31 * 24 * 60 * 60 * 1000
  store.appendMessage(jid, 'user', 'Mensaje antiguo', olderThanRetention)
  store.pruneExpired()
  await store.flush()

  assert.deepEqual(store.getHistory(jid), [])
})
