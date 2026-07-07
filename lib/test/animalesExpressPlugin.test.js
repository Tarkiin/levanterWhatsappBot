const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const storeFile = path.join(
  os.tmpdir(),
  `animalesexpress-plugin-${process.pid}-${Date.now()}.json`
)
process.env.AE_ENABLED = 'true'
process.env.AE_PRIVATE_EXCLUDED_NUMBERS = '655000000'
process.env.AE_CONVERSATION_STORE_FILE = storeFile

const handlers = []
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === '../lib' && /plugins[\\/]animalesExpress\.js$/.test(parent?.filename || '')) {
    return {
      bot: (options, callback) => handlers.push({ options, callback }),
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}

require('../../plugins/animalesExpress')
Module._load = originalLoad

const store = require('../animalesExpressConversationStore')
const incoming = handlers.find(
  ({ options }) => options.type === 'animalesExpressPrivateAssistant'
).callback
const outgoing = handlers.find(
  ({ options }) => options.type === 'animalesExpressHumanHandoff'
).callback

const createMessage = ({ jid, text, isGroup = false }) => {
  const sent = []
  return {
    message: {
      jid,
      text,
      isGroup,
      participant: isGroup ? '34600000000@s.whatsapp.net' : undefined,
      data: { key: { remoteJid: jid, id: String(Date.now()), fromMe: false } },
      client: {
        sendMessage: async () => ({}),
      },
      send: async (value) => {
        sent.push(value)
        return {}
      },
    },
    sent,
  }
}

test.after(async () => {
  await store.flush()
  store.resetForTests()
  fs.rmSync(storeFile, { force: true })
})

test('ignora grupos sin comando y el número privado excluido', async () => {
  const group = createMessage({
    jid: '120363000000000000@g.us',
    text: 'Hola',
    isGroup: true,
  })
  await incoming(group.message)
  assert.deepEqual(group.sent, [])

  const excluded = createMessage({
    jid: '34655000000@s.whatsapp.net',
    text: 'Hola',
  })
  await incoming(excluded.message)
  assert.deepEqual(excluded.sent, [])
})

test('inicia una solicitud privada y se presenta como asistente virtual', async () => {
  const chat = createMessage({
    jid: '34600111222@s.whatsapp.net',
    text: 'Quiero contratar un transporte',
  })
  await incoming(chat.message)

  assert.equal(chat.sent.length, 1)
  assert.match(chat.sent[0], /asistente virtual de AnimalesExpress/i)
  assert.match(chat.sent[0], /cuál es tu \*nombre\*/i)
  assert.equal(store.getRegistration(chat.message.jid).awaiting, 'name')
})

test('no duplica preguntas inválidas y permite cancelar el registro', async () => {
  const jid = '34600999888@s.whatsapp.net'
  await incoming(createMessage({ jid, text: 'Quiero contratar un transporte' }).message)
  await incoming(createMessage({ jid, text: 'Ana' }).message)

  const invalid = createMessage({ jid, text: 'test' })
  await incoming(invalid.message)

  assert.equal(invalid.sent.length, 1)
  assert.match(invalid.sent[0], /necesito el código postal y la población de recogida/i)
  assert.equal((invalid.sent[0].match(/28001 Madrid/g) || []).length, 1)
  assert.doesNotMatch(invalid.sent[0], /¿Cuál es el \*código postal/i)
  assert.equal(store.getRegistration(jid).awaiting, 'pickup')

  const cancellation = createMessage({ jid, text: 'no lo quiero ya' })
  await incoming(cancellation.message)

  assert.equal(cancellation.sent.length, 1)
  assert.match(cancellation.sent[0], /he cancelado la solicitud/i)
  assert.equal(store.getRegistration(jid), null)
})

test('distingue respuestas del bot y pausa tras una respuesta manual', async () => {
  const jid = '34600333444@s.whatsapp.net'
  const chat = createMessage({ jid, text: 'Necesito un transporte' })
  await incoming(chat.message)

  await outgoing({ ...chat.message, text: chat.sent[0] })
  assert.equal(store.getTimestamp(jid, 'lastHumanAt'), 0)

  await outgoing({ ...chat.message, text: 'Hola, te atiendo yo personalmente.' })
  assert.ok(store.getTimestamp(jid, 'lastHumanAt') > 0)

  const paused = createMessage({ jid, text: 'Gracias, mi nombre es Ana' })
  await incoming(paused.message)
  assert.deepEqual(paused.sent, [])
})
