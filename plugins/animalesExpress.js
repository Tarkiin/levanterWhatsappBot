const { bot } = require('../lib')
const {
  answerPublicQuestion,
  answerStaffQuestion,
  appendLead,
  checkLmStudio,
  extractClientSearch,
  extractPostalCodes,
  formatClientResults,
  formatDestinationAnswer,
  formatRoutesForWhatsApp,
  getConfig,
  getRoutes,
  getSafeStatus,
  lmStudioUnavailableMessage,
  looksLikeAnimalDescription,
  searchClients,
} = require('../lib/animalesExpressService')

const FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSeGWS3BFtfPgtk2xUg1GZMKA-LpU6kPEWOm16u4RCk-X-GGrQ/viewform'
const FORM_MESSAGE = `*Formulario de contratacion de transporte AnimalesExpress*
\`En caso de que rellene el formulario para contratar avise para que le pasen a revisión\`

${FORM_URL}`
const sessions = new Map()
const SESSION_TTL_MS = 30 * 60 * 1000

const findReactionKey = (value, depth = 0, seen = new WeakSet()) => {
  if (!value || typeof value !== 'object' || depth > 3 || seen.has(value)) return null
  seen.add(value)

  if (
    typeof value.remoteJid === 'string' &&
    typeof value.id === 'string' &&
    typeof value.fromMe === 'boolean'
  ) {
    return value
  }
  if (value.key && typeof value.key === 'object') {
    const nestedKey = findReactionKey(value.key, depth + 1, seen)
    if (nestedKey) return nestedKey
  }

  const skipped = new Set(['client', 'socket', 'sock', 'store', 'ws'])
  for (const property of Object.getOwnPropertyNames(value)) {
    if (skipped.has(property)) continue
    let nested
    try {
      nested = value[property]
    } catch {
      continue
    }
    const nestedKey = findReactionKey(nested, depth + 1, seen)
    if (nestedKey) return nestedKey
  }
  return null
}

const reactToCommand = async (message, text) => {
  // Levanter separa los campos de la clave original en la instancia Message.
  // Los plugins de reacción envían esa clave a Baileys; la reconstruimos aquí
  // para poder reaccionar también a comandos ejecutados por usuarios del grupo.
  const directKey =
    typeof message.jid === 'string' && typeof message.id === 'string'
      ? {
          remoteJid: message.jid,
          id: message.id,
          fromMe: Boolean(message.fromMe),
          ...(message.participant ? { participant: message.participant } : {}),
        }
      : null
  const key = directKey || findReactionKey(message)
  if (!key) {
    const ownKeys = Object.getOwnPropertyNames(message)
    const prototypeKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(message) || {})
    const dataKeys =
      message.data && typeof message.data === 'object'
        ? Object.getOwnPropertyNames(message.data)
        : []
    console.error(
      `[AnimalesExpress] Clave de reacción no encontrada; message=${ownKeys.join(',')}; prototype=${prototypeKeys.join(',')}; data=${dataKeys.join(',')}`
    )
    return
  }
  try {
    const reaction =
      typeof message.client?.sendMessage === 'function'
        ? message.client.sendMessage(message.jid, { react: { text, key } })
        : message.send({ text, key }, {}, 'react')
    const safeReaction = Promise.resolve(reaction).catch((error) => {
      console.error('[AnimalesExpress] Reacción de estado:', error.message)
    })
    // Algunas versiones de Levanter no resuelven la promesa de reacción.
    // La reacción es visual y nunca debe impedir que el comando continúe.
    await Promise.race([
      safeReaction,
      new Promise((resolve) => setTimeout(resolve, 1200)),
    ])
  } catch (error) {
    console.error('[AnimalesExpress] Reacción de estado:', error.message)
  }
}

const send = async (message, text) => {
  const result = await message.send(text, { quoted: message.data })
  await reactToCommand(message, '')
  return result
}

// En grupos, cada persona mantiene su propio registro para evitar mezclar datos.
const sessionKey = (message) =>
  message.isGroup ? `${message.jid}:${message.participant || 'unknown'}` : message.jid

const createSession = (message, originalMessage = '') => {
  const session = {
    pickupPostalCode: '',
    deliveryPostalCode: '',
    animals: '',
    originalMessage,
    updatedAt: Date.now(),
  }
  sessions.set(sessionKey(message), session)
  return session
}

const getActiveSession = (jid) => {
  const session = sessions.get(jid)
  if (!session) return null
  if (Date.now() - session.updatedAt < SESSION_TTL_MS) return session
  sessions.delete(jid)
  return null
}

const updateSession = (session, text) => {
  const postalCodes = extractPostalCodes(text)
  for (const postalCode of postalCodes) {
    if (!session.pickupPostalCode) session.pickupPostalCode = postalCode
    else if (!session.deliveryPostalCode) session.deliveryPostalCode = postalCode
  }

  if (!session.animals && looksLikeAnimalDescription(text)) session.animals = text.trim()
  session.updatedAt = Date.now()
}

const nextQuestion = (session) => {
  if (!session.pickupPostalCode && !session.deliveryPostalCode) {
    return 'Hola, muy buenas. Para consultar disponibilidad necesito:\n- Código postal de recogida\n- Código postal de entrega\n- Cantidad y especie de animales'
  }
  if (!session.pickupPostalCode) return '¿Cuál es el *código postal de recogida*?'
  if (!session.deliveryPostalCode) return '¿Cuál es el *código postal de entrega*?'
  if (!session.animals) return '¿Qué *cantidad y especie de animales* necesitas transportar?'
  return ''
}

const finishRegistration = async (message, session) => {
  const requestId = await appendLead({
    jid: message.isGroup
      ? `${message.jid} · ${message.participant || 'participante desconocido'}`
      : message.jid,
    pickupPostalCode: session.pickupPostalCode,
    deliveryPostalCode: session.deliveryPostalCode,
    animals: session.animals,
    originalMessage: session.originalMessage,
  })
  sessions.delete(sessionKey(message))
  return send(
    message,
    `Gracias. He registrado tu solicitud *${requestId}*.\n\nEl equipo te indicará fecha y precio. Los portes son desde *50 €*. Si te encaja, completa el formulario:\n${FORM_URL}`
  )
}

const processRegistrationInput = async (message, text) => {
  const session = getActiveSession(sessionKey(message))
  if (!session) return

  updateSession(session, text)
  const question = nextQuestion(session)
  if (question) return send(message, question)

  try {
    return await finishRegistration(message, session)
  } catch (error) {
    console.error('[AnimalesExpress] Registro de solicitud:', error.message)
    return send(
      message,
      'He recogido los datos, pero no he podido registrar la solicitud automáticamente. Inténtalo de nuevo en unos minutos.'
    )
  }
}

const isStaffGroup = (message, config) =>
  message.isGroup && config.staffGroups.includes(message.jid)

const helpText = (staff) =>
  [
    '*🐾 AnimalesExpress — Ayuda*',
    '',
    '- *.ae rutas* — muestra todas las rutas publicadas',
    '- *.ae formulario* — enlace del formulario de reserva',
    '- *.ae registrar* — inicia una solicitud paso a paso en privado o en un grupo',
    '- *.ae Busco transporte de Madrid a Valencia para 2 pájaros* — consulta a la IA',
    ...(staff
      ? [
          '',
          '*Consultas internas*',
          '- *.ae cliente "Juan Rodríguez"* — muestra todas las coincidencias y datos',
          '- También acepta teléfono, DNI/NIE o email entre comillas o sin ellas',
          '- *.ae de quién es el número +34 647 28 98 12*',
          '- *.ae a dónde va el pedido de +34 647 28 98 12*',
          '- También puedes buscar por DNI/NIE, email, código postal o dirección',
          '- *.ae estado* — comprueba la IA y Google Sheets',
          '- *.ae id* — ID del grupo',
        ]
      : []),
  ].join('\n')

const looksLikeInternalSearch = (command) =>
  /^(?:cliente|buscar)|de\s+qui[eé]n|a\s+d[oó]nde\s+va|d[oó]nde\s+(?:se\s+)?env[ií]an|pedido\s+de|tel[eé]fono|n[uú]mero|\bdni\b|\bnie\b|correo|email/i.test(
    command
  )

bot(
  {
    pattern: 'ae ?(.*)',
    desc: 'Asistente de AnimalesExpress',
    type: 'animalesExpress',
    fromMe: false,
  },
  async (message, match) => {
    await reactToCommand(message, '⏳')
    const config = getConfig()
    const command = String(match || '').trim()
    const lower = command.toLowerCase()
    const staff = isStaffGroup(message, config)

    if (lower === 'id') {
      return send(message, `ID de este chat:\n${message.jid}`)
    }

    if (!command || lower === 'ayuda') return send(message, helpText(staff))

    if (lower === 'formulario') return send(message, FORM_MESSAGE)

    if (!config.enabled) return send(message, 'El asistente de AnimalesExpress está desactivado.')

    if (lower === 'rutas') {
      try {
        return send(message, formatRoutesForWhatsApp(await getRoutes({ force: true })))
      } catch (error) {
        console.error('[AnimalesExpress] Listado de rutas:', error.message)
        return send(message, 'No he podido consultar las rutas de Google Sheets en este momento.')
      }
    }

    if (lower === 'registrar' || lower.startsWith('registrar ')) {
      const initialData = command.replace(/^registrar\s*/i, '').trim()
      const session = createSession(message, initialData || 'Registro iniciado con .ae registrar')
      if (initialData) return processRegistrationInput(message, initialData)
      return send(message, nextQuestion(session))
    }

    if (lower === 'estado') {
      if (!staff) return send(message, 'Este comando solo está disponible en el grupo interno.')
      const status = getSafeStatus()
      const lm = await checkLmStudio()
      let routesStatus = 'error'
      try {
        routesStatus = `${(await getRoutes({ force: true })).length} rutas`
      } catch (error) {
        console.error('[AnimalesExpress] Estado de Sheets:', error.message)
      }
      return send(
        message,
        `*Estado del asistente*\n- Activado: ${status.enabled ? 'sí' : 'no'}\n- Google Sheets: ${routesStatus}\n- IA: ${lm.online ? 'en línea' : 'sin conexión'}\n- Modelo: ${lm.modelAvailable ? 'disponible' : 'no cargado'}\n- Grupos autorizados: ${status.staffGroups}`
      )
    }

    if (looksLikeInternalSearch(command)) {
      if (!staff) return send(message, 'Esta consulta contiene datos internos y solo funciona en el grupo autorizado.')
      const query = extractClientSearch(command)
      if (query.length < 3) {
        return send(message, 'Indica un nombre, teléfono, DNI/NIE, email, código postal o dirección.')
      }
      let clientResults
      try {
        clientResults = await searchClients(query)
      } catch (error) {
        console.error('[AnimalesExpress] Búsqueda interna:', error.message)
        return send(message, 'No he podido consultar los clientes en Google Sheets en este momento.')
      }
      if (!clientResults.length) return send(message, formatClientResults(clientResults))

      const directAnswer = formatDestinationAnswer(command, clientResults)
      if (directAnswer) return send(message, directAnswer)

      // El comando explícito `.ae cliente ...` siempre devuelve la ficha completa
      // sin resumirla con la IA.
      if (/^cliente(?:\s|$)/i.test(command)) {
        return send(message, formatClientResults(clientResults))
      }

      try {
        return send(message, await answerStaffQuestion(command, clientResults))
      } catch (error) {
        console.error('[AnimalesExpress] Respuesta interna de IA:', error.message)
        return send(message, lmStudioUnavailableMessage())
      }
    }

    // En el grupo interno, detecta nombres completos incluidos en preguntas libres
    // aunque no comiencen por "cliente" o "pedido".
    if (staff) {
      let clientResults
      try {
        clientResults = await searchClients(extractClientSearch(command))
      } catch (error) {
        console.error('[AnimalesExpress] Detección interna:', error.message)
        return send(message, 'No he podido consultar los clientes en Google Sheets en este momento.')
      }
      if (clientResults.length) {
        const directAnswer = formatDestinationAnswer(command, clientResults)
        if (directAnswer) return send(message, directAnswer)
        try {
          return send(message, await answerStaffQuestion(command, clientResults))
        } catch (error) {
          console.error('[AnimalesExpress] Respuesta interna de IA:', error.message)
          return send(message, lmStudioUnavailableMessage())
        }
      }
    }

    try {
      return send(message, await answerPublicQuestion(command))
    } catch (error) {
      console.error('[AnimalesExpress] IA:', error.message)
      return send(message, lmStudioUnavailableMessage())
    }
  }
)

// Fuera de `.ae`, solo escucha las respuestas de un registro ya iniciado.
bot(
  {
    on: 'text',
    fromMe: false,
    type: 'animalesExpressRegistration',
  },
  async (message) => {
    if (!getConfig().enabled || !getActiveSession(sessionKey(message))) return
    const text = String(message.text || '').trim()
    const prefix = process.env.PREFIX || '.'
    if (!text || text.startsWith(prefix)) return
    return processRegistrationInput(message, text)
  }
)
