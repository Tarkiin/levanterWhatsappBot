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
process.env.AE_WHATSAPP_SEND_DELAY_MS = '0'
process.env.AE_PRIVATE_BATCH_WINDOW_MS = '20'
process.env.AE_PRIVATE_BATCH_MAX_WAIT_MS = '100'
process.env.AE_ASSISTANT_INTRO_IDLE_MS = '60'

const handlers = []
const appendedLeads = []
const privateQuestions = []
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === '../lib' && /plugins[\\/]animalesExpress\.js$/.test(parent?.filename || '')) {
    return {
      bot: (options, callback) => handlers.push({ options, callback }),
    }
  }
  if (
    request === '../lib/animalesExpressService' &&
    /plugins[\\/]animalesExpress\.js$/.test(parent?.filename || '')
  ) {
    return {
      ...originalLoad.call(this, request, parent, isMain),
      appendLead: async (lead) => {
        appendedLeads.push(lead)
        return 'AE-TEST'
      },
      answerPrivateQuestion: async (question) => {
        privateQuestions.push(question)
        return { needsHuman: false, text: `Respuesta para: ${question}` }
      },
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

const createMessage = ({ jid, text, isGroup = false, remoteJidAlt = '' }) => {
  const sent = []
  const directSent = []
  return {
    message: {
      jid,
      text,
      isGroup,
      participant: isGroup ? '34600000000@s.whatsapp.net' : undefined,
      data: {
        key: {
          remoteJid: jid,
          remoteJidAlt,
          id: String(Date.now()),
          fromMe: false,
        },
      },
      client: {
        sendMessage: async (target, content) => {
          directSent.push({ target, content })
          return {}
        },
      },
      send: async (value) => {
        sent.push(value)
        return {}
      },
    },
    sent,
    directSent,
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
  assert.match(chat.sent[0], /paso a paso/i)
  assert.match(chat.sent[0], /cuál es tu \*nombre\*/i)
  assert.match(chat.sent[0], /Ejemplo: Ana García/i)
  assert.equal(store.getRegistration(chat.message.jid).awaiting, 'name')
})

test('el interés por un transporte inicia preguntas de una en una', async () => {
  const chat = createMessage({
    jid: '34600666555@s.whatsapp.net',
    text: 'Estoy interesado en un transporte, explícame cómo funciona',
  })
  await incoming(chat.message)

  assert.equal(chat.sent.length, 1)
  assert.match(chat.sent[0], /paso a paso/i)
  assert.match(chat.sent[0], /cuál es tu \*nombre\*/i)
  assert.match(chat.sent[0], /Ejemplo: Ana García/i)
  assert.doesNotMatch(chat.sent[0], /código postal de entrega/i)
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

test('usa el número alternativo y nunca presenta un LID como teléfono', async () => {
  const jid = '276093986676806@lid'
  const remoteJidAlt = '34612345678@s.whatsapp.net'
  const replies = [
    'Quiero contratar un transporte',
    'Cliente de prueba',
    '28001 Madrid',
    '46001 Valencia',
    '3 peces',
    'el día 10',
    'ninguna',
  ]
  let completed

  for (const text of replies) {
    completed = createMessage({ jid, remoteJidAlt, text })
    await incoming(completed.message)
  }

  assert.equal(appendedLeads.at(-1).jid, '+34612345678')
  assert.equal(completed.directSent.length, 1)
  assert.match(completed.directSent[0].content.text, /Cliente: \+34612345678/)
  assert.doesNotMatch(completed.directSent[0].content.text, /276093986676806/)
})

test('agrupa mensajes privados consecutivos y responde una sola vez', async () => {
  const jid = '34600777888@s.whatsapp.net'
  const first = createMessage({ jid, text: 'Hola' })
  const second = createMessage({ jid, text: 'qué tal' })
  const third = createMessage({ jid, text: '¿hacéis' })
  const fourth = createMessage({ jid, text: 'envíos de' })
  const fifth = createMessage({ jid, text: 'animales?' })

  await Promise.all([
    incoming(first.message),
    incoming(second.message),
    incoming(third.message),
    incoming(fourth.message),
    incoming(fifth.message),
  ])

  assert.equal(privateQuestions.at(-1), 'Hola\nqué tal\n¿hacéis\nenvíos de\nanimales?')
  assert.deepEqual(first.sent, [])
  assert.deepEqual(second.sent, [])
  assert.deepEqual(third.sent, [])
  assert.deepEqual(fourth.sent, [])
  assert.equal(fifth.sent.length, 1)
  assert.match(fifth.sent[0], /🐾✨ \*Soy el asistente virtual de AnimalesExpress\.\*/)
  assert.match(fifth.sent[0], /Respuesta para: Hola\nqué tal\n¿hacéis\nenvíos de\nanimales\?/)
})

test('vuelve a presentarse cuando el cliente saluda después de una pausa', async () => {
  const jid = '34600444555@s.whatsapp.net'
  store.appendMessage(jid, 'assistant', 'Conversación anterior')
  store.setTimestamp(jid, 'lastAiAt', Date.now() - 61000)

  const greeting = createMessage({ jid, text: 'Hola' })
  await incoming(greeting.message)

  assert.equal(greeting.sent.length, 1)
  assert.match(greeting.sent[0], /🐾✨ \*Soy el asistente virtual de AnimalesExpress\.\*/)
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
