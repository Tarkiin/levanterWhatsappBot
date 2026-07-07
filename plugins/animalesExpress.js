const { bot } = require('../lib')
const conversationStore = require('../lib/animalesExpressConversationStore')
const {
  answerPrivateQuestion,
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
const HUMAN_PAUSE_MS = 5 * 60 * 1000
const ESCALATION_COOLDOWN_MS = 15 * 60 * 1000
const WHATSAPP_SEND_DELAY_MS = Math.max(
  0,
  Number(process.env.AE_WHATSAPP_SEND_DELAY_MS || 5000)
)
const recentBotOutbound = new Map()
const privateQueues = new Map()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const sendOptions = (options = {}) => ({ ...options, linkPreview: false })

const waitBetweenWhatsAppSends = async () => {
  if (WHATSAPP_SEND_DELAY_MS > 0) await sleep(WHATSAPP_SEND_DELAY_MS)
}

const normalizePhone = (value = '') => String(value).replace(/\D/g, '')

const isCommandText = (text = '') => {
  try {
    const match = new RegExp(process.env.PREFIX || '^[.]').exec(String(text))
    return Boolean(match && match.index === 0)
  } catch {
    return /^[.,]/.test(String(text))
  }
}

const isPrivateUserJid = (jid = '') =>
  /@(?:s\.whatsapp\.net|lid)$/.test(String(jid))

const isExcludedPrivateNumber = (jid, config = getConfig()) => {
  const number = normalizePhone(String(jid).split('@')[0].split(':')[0])
  return config.privateExcludedNumbers.some(
    (excluded) => number === excluded || number.endsWith(excluded)
  )
}

const rememberBotOutbound = (jid, text) => {
  const now = Date.now()
  const entries = (recentBotOutbound.get(jid) || []).filter(
    (entry) => now - entry.createdAt < 30000
  )
  entries.push({ text: String(text || '').trim(), createdAt: now })
  recentBotOutbound.set(jid, entries)
}

const consumeBotOutbound = (jid, text) => {
  const now = Date.now()
  const target = String(text || '').trim()
  const entries = (recentBotOutbound.get(jid) || []).filter(
    (entry) => now - entry.createdAt < 30000
  )
  const index = entries.findIndex((entry) => entry.text === target)
  if (index === -1) {
    recentBotOutbound.set(jid, entries)
    return false
  }
  entries.splice(index, 1)
  if (entries.length) recentBotOutbound.set(jid, entries)
  else recentBotOutbound.delete(jid)
  return true
}

const enqueuePrivate = (jid, task) => {
  const previous = privateQueues.get(jid) || Promise.resolve()
  const current = previous.then(task, task)
  const tracked = current.catch(() => undefined)
  privateQueues.set(jid, tracked)
  return current.finally(() => {
    if (privateQueues.get(jid) === tracked) privateQueues.delete(jid)
  })
}

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

const send = async (
  message,
  text,
  { clearReaction = true, rememberConversation = false } = {}
) => {
  if (!message.isGroup) rememberBotOutbound(message.jid, text)
  const result = await message.send(text, sendOptions({ quoted: message.data }))
  if (rememberConversation && !message.isGroup) {
    conversationStore.appendMessage(message.jid, 'assistant', text)
    conversationStore.setTimestamp(message.jid, 'lastAiAt')
  }
  if (clearReaction) await reactToCommand(message, '')
  return result
}

// En grupos, cada persona mantiene su propio registro para evitar mezclar datos.
const sessionKey = (message) =>
  message.isGroup ? `${message.jid}:${message.participant || 'unknown'}` : message.jid

const createSession = (message, originalMessage = '') => {
  const session = {
    name: '',
    pickupPostalCode: '',
    pickupTown: '',
    deliveryPostalCode: '',
    deliveryTown: '',
    animals: '',
    approximateDate: '',
    observations: '',
    awaiting: '',
    introPending: !message.isGroup,
    originalMessage,
    updatedAt: Date.now(),
  }
  if (message.isGroup) sessions.set(sessionKey(message), session)
  else conversationStore.setRegistration(message.jid, session)
  return session
}

const getActiveSession = (message) => {
  const session = message.isGroup
    ? sessions.get(sessionKey(message))
    : conversationStore.getRegistration(message.jid)
  if (!session) return null
  if (!message.isGroup || Date.now() - session.updatedAt < SESSION_TTL_MS) return session
  sessions.delete(sessionKey(message))
  return null
}

const saveSession = (message, session) => {
  session.updatedAt = Date.now()
  if (message.isGroup) sessions.set(sessionKey(message), session)
  else conversationStore.setRegistration(message.jid, session)
}

const clearSession = (message) => {
  if (message.isGroup) sessions.delete(sessionKey(message))
  else conversationStore.clearRegistration(message.jid)
}

const cleanTown = (text) =>
  String(text || '')
    .replace(/\b\d{5}\b/g, '')
    .replace(/\b(?:c[oó]digo\s+postal|cp|recogida|entrega|origen|destino|de|a)\b/gi, ' ')
    .replace(/[^a-záéíóúüñ\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const updateSession = (session, text) => {
  const value = String(text || '').trim()
  const postalCodes = extractPostalCodes(text)
  let validationError = ''

  if (session.awaiting === 'name') {
    if (value.length < 2) validationError = 'Indica tu nombre, por favor.'
    else session.name = value.slice(0, 120)
  } else if (session.awaiting === 'pickup') {
    const town = cleanTown(value)
    if (!postalCodes[0] || !town) {
      validationError = 'Necesito el código postal y la población de recogida, por ejemplo: *28001 Madrid*.'
    } else {
      session.pickupPostalCode = postalCodes[0]
      session.pickupTown = town.slice(0, 120)
    }
  } else if (session.awaiting === 'delivery') {
    const town = cleanTown(value)
    if (!postalCodes[0] || !town) {
      validationError = 'Necesito el código postal y la población de entrega, por ejemplo: *46001 Valencia*.'
    } else {
      session.deliveryPostalCode = postalCodes[0]
      session.deliveryTown = town.slice(0, 120)
    }
  } else if (session.awaiting === 'animals') {
    if (!looksLikeAnimalDescription(value)) {
      validationError = 'Indica la cantidad y la especie, por ejemplo: *2 perros* o *1 agapornis*.'
    } else session.animals = value.slice(0, 300)
  } else if (session.awaiting === 'date') {
    if (value.length < 2) validationError = 'Indica una fecha aproximada para el transporte.'
    else session.approximateDate = value.slice(0, 120)
  } else if (session.awaiting === 'observations') {
    session.observations = (value || 'Sin observaciones').slice(0, 500)
  } else {
    const name = value.match(
      /\b(?:me llamo|soy)\s+([a-záéíóúüñ][a-záéíóúüñ\s'-]{1,80}?)(?=\s+y\s+(?:quiero|necesito|busco)|[,.;]|$)/i
    )?.[1]
    if (name) session.name = name.trim()
    for (const postalCode of postalCodes) {
      if (!session.pickupPostalCode) session.pickupPostalCode = postalCode
      else if (!session.deliveryPostalCode) session.deliveryPostalCode = postalCode
    }
    if (!session.animals && looksLikeAnimalDescription(value)) session.animals = value.slice(0, 300)
  }

  if (!validationError) session.awaiting = ''
  session.updatedAt = Date.now()
  return validationError
}

const nextQuestion = (session) => {
  if (!session.name) {
    session.awaiting = 'name'
    return 'Para preparar la solicitud, ¿cuál es tu *nombre*?'
  }
  if (!session.pickupPostalCode || !session.pickupTown) {
    session.awaiting = 'pickup'
    return '¿Cuál es el *código postal y la población de recogida*?\nEjemplo: 28001 Madrid'
  }
  if (!session.deliveryPostalCode || !session.deliveryTown) {
    session.awaiting = 'delivery'
    return '¿Cuál es el *código postal y la población de entrega*?\nEjemplo: 46001 Valencia'
  }
  if (!session.animals) {
    session.awaiting = 'animals'
    return '¿Qué *cantidad y especie de animales* necesitas transportar?'
  }
  if (!session.approximateDate) {
    session.awaiting = 'date'
    return '¿Para qué *fecha aproximada* necesitas el transporte?'
  }
  if (!session.observations) {
    session.awaiting = 'observations'
    return '¿Hay alguna necesidad especial u observación? Puedes responder *ninguna*.'
  }
  return ''
}

const formatClientJid = (jid) => {
  const number = normalizePhone(String(jid).split('@')[0].split(':')[0])
  return number ? `+${number}` : jid
}

const sendDirect = async (client, jid, text, extra = {}) => {
  if (isPrivateUserJid(jid)) rememberBotOutbound(jid, text)
  return client.sendMessage(jid, { text, ...extra }, sendOptions())
}

const notifyStaff = async (message, { reason, question = '', session, requestId = '' }) => {
  const config = getConfig()
  if (typeof message.client?.sendMessage !== 'function') return

  const details = session
    ? [
        requestId ? `Solicitud: ${requestId}` : '',
        session.name ? `Nombre: ${session.name}` : '',
        session.pickupPostalCode
          ? `Recogida: ${session.pickupPostalCode} ${session.pickupTown}`
          : '',
        session.deliveryPostalCode
          ? `Entrega: ${session.deliveryPostalCode} ${session.deliveryTown}`
          : '',
        session.animals ? `Animales: ${session.animals}` : '',
        session.approximateDate ? `Fecha aproximada: ${session.approximateDate}` : '',
        session.observations ? `Observaciones: ${session.observations}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : question
      ? `Consulta: ${question.slice(0, 1200)}`
      : ''

  const alert = [
    '🚨 *AnimalesExpress · revisión humana*',
    `Cliente: ${formatClientJid(message.jid)}`,
    `Motivo: ${reason}`,
    details,
    '',
    `@${normalizePhone(config.ulisesJid)} @${normalizePhone(config.dayanaJid)}`,
  ]
    .filter(Boolean)
    .join('\n')

  const deliveries = [
    () =>
      sendDirect(message.client, config.notificationGroup, alert, {
        mentions: [config.ulisesJid, config.dayanaJid],
      }),
  ]

  for (let index = 0; index < deliveries.length; index += 1) {
    try {
      await deliveries[index]()
    } catch (error) {
      console.error('[AnimalesExpress] Aviso al equipo:', error?.message || error)
    }
    if (index < deliveries.length - 1) await waitBetweenWhatsAppSends()
  }
}

const finishRegistration = async (message, session) => {
  const requestId = await appendLead({
    jid: message.isGroup
      ? `${message.jid} · ${message.participant || 'participante desconocido'}`
      : message.jid,
    name: session.name,
    pickupPostalCode: session.pickupPostalCode,
    pickupTown: session.pickupTown,
    deliveryPostalCode: session.deliveryPostalCode,
    deliveryTown: session.deliveryTown,
    animals: session.animals,
    approximateDate: session.approximateDate,
    observations: session.observations,
    originalMessage: session.originalMessage,
  })
  clearSession(message)
  const result = await send(
    message,
    `✅ Gracias. He registrado tu solicitud *${requestId}*.\n\nEl equipo confirmará la viabilidad, fecha y precio. Los portes son desde *50 €*. Para completar los datos de contratación utiliza este formulario:\n${FORM_URL}`,
    { clearReaction: message.isGroup, rememberConversation: !message.isGroup }
  )
  await waitBetweenWhatsAppSends()
  await notifyStaff(message, {
    reason: 'Nueva solicitud pendiente de revisión',
    requestId,
    session,
  })
  return result
}

const processRegistrationInput = async (message, text) => {
  const session = getActiveSession(message)
  if (!session) return

  const validationError = updateSession(session, text)
  const question = nextQuestion(session)
  saveSession(message, session)
  if (question) {
    const intro = session.introPending
      ? '🐾✨ *Soy el asistente virtual de AnimalesExpress.* Estoy aquí para ayudarte con tu transporte.'
      : ''
    session.introPending = false
    saveSession(message, session)
    return send(message, [intro, validationError, question].filter(Boolean).join('\n\n'), {
      clearReaction: message.isGroup,
      rememberConversation: !message.isGroup,
    })
  }

  try {
    return await finishRegistration(message, session)
  } catch (error) {
    console.error('[AnimalesExpress] Registro de solicitud:', error.message)
    const result = await send(
      message,
      'He recogido los datos, pero no he podido registrar la solicitud automáticamente. Voy a avisar al equipo para que la revise.',
      { clearReaction: message.isGroup, rememberConversation: !message.isGroup }
    )
    await notifyStaff(message, {
      reason: 'Error al guardar una solicitud',
      question: text,
      session,
    })
    return result
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
    '- *.ae ai ¿qué ruta hay de Madrid a Valencia?* — consulta explícita a la IA',
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

    if (lower === 'ai') return send(message, 'Escribe tu pregunta después de *.ae ai*.')

    if (lower.startsWith('ai ')) {
      const question = command.replace(/^ai\s+/i, '').trim()
      try {
        return send(message, await answerPublicQuestion(question))
      } catch (error) {
        console.error('[AnimalesExpress] IA explícita:', error.message)
        return send(message, lmStudioUnavailableMessage())
      }
    }

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

const wantsRegistration = (text = '') =>
  /\b(?:contratar|reservar|presupuesto|solicitud|transportar|trasladar|enviar|recoger)\b/i.test(
    text
  ) || /\b(?:quiero|necesito|busco)\s+(?:un\s+)?transporte\b/i.test(text)

const requiresHumanByPolicy = (text = '') =>
  /(?:hablar|contactar|atender|responder).{0,30}\b(?:persona|humano|ulises|dayana)\b|\b(?:ulises|dayana)\b.{0,30}(?:hablar|contactar|atender|responder)/i.test(
    text
  ) ||
  /\b(?:queja|reclamaci[oó]n|incidencia|urgente|accidente|herid[oa]|maltrato|denuncia)\b/i.test(text) ||
  /(?:problema|error).{0,30}(?:pago|cobro|transferencia)|(?:pago|cobro|transferencia).{0,30}(?:problema|error)/i.test(
    text
  )

const maybeNotifyEscalation = async (message, reason, question) => {
  const lastEscalatedAt = conversationStore.getTimestamp(message.jid, 'lastEscalatedAt')
  if (Date.now() - lastEscalatedAt < ESCALATION_COOLDOWN_MS) return
  conversationStore.setTimestamp(message.jid, 'lastEscalatedAt')
  await notifyStaff(message, { reason, question })
}

const handlePrivateText = async (message, text) => {
  const history = conversationStore.getHistory(message.jid)
  conversationStore.appendMessage(message.jid, 'user', text)

  const lastHumanAt = conversationStore.getTimestamp(message.jid, 'lastHumanAt')
  if (Date.now() - lastHumanAt < HUMAN_PAUSE_MS) return

  if (getActiveSession(message)) return processRegistrationInput(message, text)

  if (wantsRegistration(text)) {
    createSession(message, text)
    return processRegistrationInput(message, text)
  }

  try {
    const answer = await answerPrivateQuestion(text, history)
    const mustEscalate = answer.needsHuman || requiresHumanByPolicy(text)
    const firstGreeting = history.length
      ? ''
      : '🐾✨ *Soy el asistente virtual de AnimalesExpress.*'
    const response = [firstGreeting, answer.text].filter(Boolean).join('\n\n')
    await send(message, response, {
      clearReaction: false,
      rememberConversation: true,
    })
    if (mustEscalate) {
      await maybeNotifyEscalation(
        message,
        requiresHumanByPolicy(text)
          ? 'El cliente solicita atención humana o comunica una incidencia'
          : 'La consulta no tiene una respuesta comprobable',
        text
      )
    }
  } catch (error) {
    console.error('[AnimalesExpress] Conversación privada:', error.message)
    const fallback =
      'No quiero darte un dato incorrecto; voy a dejar la consulta pendiente para que la revise el equipo.'
    await send(message, fallback, {
      clearReaction: false,
      rememberConversation: true,
    })
    await maybeNotifyEscalation(message, 'La IA no ha podido responder', text)
  }
}

// Un único listener atiende registros en grupos y todas las conversaciones
// privadas. Así se evita que dos manejadores respondan al mismo mensaje.
bot(
  {
    on: 'text',
    fromMe: false,
    type: 'animalesExpressPrivateAssistant',
  },
  async (message) => {
    const config = getConfig()
    if (!config.enabled) return
    const text = String(message.text || '').trim()
    if (!text || isCommandText(text)) return

    if (message.isGroup) {
      if (!getActiveSession(message)) return
      return processRegistrationInput(message, text)
    }

    if (!isPrivateUserJid(message.jid) || isExcludedPrivateNumber(message.jid, config)) {
      return
    }
    return enqueuePrivate(message.jid, () => handlePrivateText(message, text))
  }
)

// Los mensajes enviados manualmente por Ulises pausan el asistente cinco
// minutos. Las respuestas generadas por este plugin se reconocen y no activan
// la pausa.
bot(
  {
    on: 'text',
    fromMe: true,
    type: 'animalesExpressHumanHandoff',
  },
  async (message) => {
    const config = getConfig()
    if (
      !config.enabled ||
      message.isGroup ||
      !isPrivateUserJid(message.jid) ||
      isExcludedPrivateNumber(message.jid, config)
    ) {
      return
    }
    const text = String(message.text || '').trim()
    if (!text || isCommandText(text) || consumeBotOutbound(message.jid, text)) return
    conversationStore.appendMessage(message.jid, 'human', text)
    conversationStore.setTimestamp(message.jid, 'lastHumanAt')
  }
)
