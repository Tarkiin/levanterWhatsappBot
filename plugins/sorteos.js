const { bot, isAdmin, jidToNum } = require('../lib/')
const fs = require('fs')
const path = require('path')

const dbPath = path.join(__dirname, '../lib/db/sorteos.json')

// ─── Base de datos JSON con caché en memoria ───
let _dbCache = null

function loadDB() {
  if (_dbCache) return _dbCache
  if (!fs.existsSync(dbPath)) {
    _dbCache = {}
    return _dbCache
  }
  try {
    _dbCache = JSON.parse(fs.readFileSync(dbPath, 'utf8'))
    return _dbCache
  } catch (e) {
    _dbCache = {}
    return _dbCache
  }
}

function saveDB(data) {
  _dbCache = data
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2))
}

function getGroupRaffles(jid) {
  const db = loadDB()
  return db[jid] || {}
}

function getGroupRaffle(jid, name) {
  const db = loadDB()
  if (!db[jid] || !db[jid][name]) return null
  return db[jid][name]
}

function saveGroupRaffle(jid, name, data) {
  const db = loadDB()
  if (!db[jid]) db[jid] = {}
  db[jid][name] = data
  saveDB(db)
}

function deleteGroupRaffle(jid, name) {
  const db = loadDB()
  if (db[jid] && db[jid][name]) {
    delete db[jid][name]
    saveDB(db)
    return true
  }
  return false
}

// ─── Helper: verificar que el usuario es admin del grupo ───
async function checkAdmin(message) {
  const participants = await message.groupMetadata(message.jid)
  const botIsAdmin = await isAdmin(participants, message.client.user.jid)
  const senderIsAdmin = await isAdmin(participants, message.sender)
  return { botIsAdmin, senderIsAdmin }
}

// ─── Helper: extraer usuarios mencionados de varias formas ───
function extractUsers(message, match) {
  if (message.mention && message.mention.length > 0) {
    return message.mention
  }
  if (message.reply_message) {
    return [message.reply_message.jid]
  }
  // Fallback: buscar @34655... en el texto
  const matches = match.match(/@(\d+)/g)
  if (matches) {
    return matches.map(m => m.replace('@', '') + '@s.whatsapp.net')
  }
  return []
}

// ─── Helper: extraer números del texto (soporta "14, 25, 99" y "14,25,99") ───
function extractNumbers(match, skipFirst) {
  // Quitar el nombre del sorteo y las menciones, quedarnos solo con los números
  let cleaned = match
  if (skipFirst) {
    // Quitar la primera palabra (nombre del sorteo)
    cleaned = cleaned.replace(/^\S+\s*/, '')
  }
  // Quitar menciones @34655... del texto
  cleaned = cleaned.replace(/@\d+/g, '')
  // Extraer todos los números que queden
  const nums = cleaned.match(/\d+/g)
  return nums || []
}

// ─── Helper: formatear el padding de números ───
function numPad(num, max) {
  return String(num).padStart(max > 99 ? 3 : 2, '0')
}

// ─── Helper: imprimir sorteo completo ───
async function printSorteo(message, name) {
  const raffle = getGroupRaffle(message.jid, name)
  if (!raffle) return await message.send(`❌ Sorteo "${name}" no encontrado.`)

  let text = raffle.desc ? raffle.desc + '\n\n' : ''

  // Estadísticas
  const total = raffle.max
  const taken = Object.keys(raffle.participants).length
  const paid = Object.values(raffle.participants).filter(p => p.paid).length
  const free = total - taken
  text += `*🎰 Sorteo: ${name}*\n`
  if (raffle.price) text += `*💶 Precio: ${raffle.price}€*\n`
  text += `*📊 ${taken}/${total} ocupados | ${paid} pagados | ${free} libres*\n\n`
  text += '*Números:*\n'

  const mentioned = []

  for (let i = 0; i < raffle.max; i++) {
    const numStr = numPad(i, raffle.max)
    const p = raffle.participants[numStr]

    if (p) {
      const moneyIcon = p.paid ? ' 💰' : ''
      text += `${numStr} @${jidToNum(p.user)}${moneyIcon}\n`
      if (!mentioned.includes(p.user)) mentioned.push(p.user)
    } else {
      text += `${numStr}\n`
    }
  }

  await message.send(text.trim(), { contextInfo: { mentionedJid: mentioned } })
}

// ═══════════════════════════════════════════════════════
// COMANDOS
// ═══════════════════════════════════════════════════════

// ─── .screate <nombre> <max> [precio] ───
bot(
  {
    pattern: 'screate ?(.*)',
    desc: 'Crear un sorteo. Uso: .screate exoticking 100 1.80',
    type: 'group',
    onlyGroup: true,
  },
  async (message, match) => {
    const { senderIsAdmin } = await checkAdmin(message)
    if (!senderIsAdmin) return await message.send('❌ Solo los administradores pueden crear sorteos.')

    const args = match.split(' ')
    const name = args[0]
    const max = args[1]
    const price = args[2] || null

    if (!name || !max || isNaN(max)) {
      return await message.send('Uso: .screate <nombre> <cantidad> [precio]\nEjemplo: .screate exoticking 100 1.80')
    }

    // Protección anti-duplicado
    const existing = getGroupRaffle(message.jid, name)
    if (existing) {
      return await message.send(`⚠️ Ya existe un sorteo "${name}" con ${existing.max} números. Usa .sdelete ${name} primero si quieres recrearlo.`)
    }

    const limit = parseInt(max)
    const data = {
      name,
      max: limit,
      price: price ? parseFloat(price) : null,
      desc: '',
      participants: {},
      createdAt: new Date().toISOString(),
    }
    saveGroupRaffle(message.jid, name, data)
    const priceText = price ? ` | Precio: ${price}€` : ''
    await message.send(`✅ Sorteo "${name}" creado con ${limit} números (00-${numPad(limit - 1, limit)})${priceText}`)
  }
)

// ─── .sdesc <nombre> (respondiendo a un mensaje o con texto) ───
bot(
  {
    pattern: 'sdesc ?(.*)',
    desc: 'Añadir descripción/lotes al sorteo',
    type: 'group',
    onlyGroup: true,
  },
  async (message, match) => {
    const { senderIsAdmin } = await checkAdmin(message)
    if (!senderIsAdmin) return await message.send('❌ Solo los administradores pueden editar la descripción.')

    const name = match.split(' ')[0]
    if (!name) return await message.send('Uso: .sdesc <nombre> (respondiendo a un mensaje con los lotes)')

    const raffle = getGroupRaffle(message.jid, name)
    if (!raffle) return await message.send(`❌ Sorteo "${name}" no encontrado.`)

    // BUG FIX: usar slice en vez de replace para no corromper texto
    let newDesc = ''
    if (message.reply_message && message.reply_message.text) {
      newDesc = message.reply_message.text
    } else {
      newDesc = match.slice(name.length).trim()
    }

    if (!newDesc) return await message.send('Debes responder a un mensaje con la descripción o escribirla después del nombre.')

    raffle.desc = newDesc
    saveGroupRaffle(message.jid, name, raffle)
    await message.send(`✅ Descripción de "${name}" actualizada.`)
  }
)

// ─── .scomprar <nombre> <num1,num2,...> @mencion ───
bot(
  {
    pattern: 'scomprar ?(.*)',
    desc: 'Asignar números a un usuario',
    type: 'group',
    onlyGroup: true,
  },
  async (message, match) => {
    const { senderIsAdmin } = await checkAdmin(message)
    if (!senderIsAdmin) return await message.send('❌ Solo los administradores pueden asignar números.')

    const name = match.split(' ')[0]
    if (!name) return await message.send('Uso: .scomprar <nombre> <num1,num2> @mencion')

    const raffle = getGroupRaffle(message.jid, name)
    if (!raffle) return await message.send(`❌ Sorteo "${name}" no encontrado.`)

    const users = extractUsers(message, match)
    if (users.length === 0) return await message.send('Debes mencionar al usuario.')
    const user = users[0]

    // BUG FIX: extraer números del texto completo, no solo args[1]
    const numbers = extractNumbers(match, true)
    if (numbers.length === 0) return await message.send('Debes indicar al menos un número.')

    const assigned = []
    const conflicts = []
    const outOfRange = []

    for (const num of numbers) {
      const nFormat = numPad(parseInt(num), raffle.max)
      const numInt = parseInt(nFormat)

      if (numInt >= raffle.max) {
        outOfRange.push(nFormat)
        continue
      }

      const existing = raffle.participants[nFormat]
      if (existing && existing.user !== user) {
        conflicts.push(`${nFormat} (ya tiene @${jidToNum(existing.user)})`)
        continue
      }

      raffle.participants[nFormat] = { user, paid: false }
      assigned.push(nFormat)
    }

    saveGroupRaffle(message.jid, name, raffle)

    let response = ''
    if (assigned.length > 0) {
      response += `✅ Números ${assigned.join(', ')} asignados a @${jidToNum(user)}\n`
    }
    if (conflicts.length > 0) {
      response += `⚠️ Conflictos (no asignados): ${conflicts.join(', ')}\n`
    }
    if (outOfRange.length > 0) {
      response += `❌ Fuera de rango: ${outOfRange.join(', ')}\n`
    }

    const mentionedJids = [user]
    // Añadir jids de conflictos si los hay
    for (const num in raffle.participants) {
      const p = raffle.participants[num]
      if (!mentionedJids.includes(p.user)) mentionedJids.push(p.user)
    }

    await message.send(response.trim(), { contextInfo: { mentionedJid: [user] } })
  }
)

// ─── .squitar <nombre> <num1,num2> ───
bot(
  {
    pattern: 'squitar ?(.*)',
    desc: 'Liberar números de un sorteo',
    type: 'group',
    onlyGroup: true,
  },
  async (message, match) => {
    const { senderIsAdmin } = await checkAdmin(message)
    if (!senderIsAdmin) return await message.send('❌ Solo los administradores pueden liberar números.')

    const name = match.split(' ')[0]
    if (!name) return await message.send('Uso: .squitar <nombre> <num1,num2>')

    const raffle = getGroupRaffle(message.jid, name)
    if (!raffle) return await message.send(`❌ Sorteo "${name}" no encontrado.`)

    const numbers = extractNumbers(match, true)
    if (numbers.length === 0) return await message.send('Debes indicar al menos un número.')

    const freed = []
    for (const num of numbers) {
      const nFormat = numPad(parseInt(num), raffle.max)
      if (raffle.participants[nFormat]) {
        delete raffle.participants[nFormat]
        freed.push(nFormat)
      }
    }

    if (freed.length > 0) {
      saveGroupRaffle(message.jid, name, raffle)
      await message.send(`✅ Números liberados: ${freed.join(', ')}`)
    } else {
      await message.send('Esos números ya estaban libres.')
    }
  }
)

// ─── .spagado <nombre> @mencion1 @mencion2 ───
bot(
  {
    pattern: 'spagado ?(.*)',
    desc: 'Marcar usuarios como pagados',
    type: 'group',
    onlyGroup: true,
  },
  async (message, match) => {
    const { senderIsAdmin } = await checkAdmin(message)
    if (!senderIsAdmin) return await message.send('❌ Solo los administradores pueden marcar pagos.')

    const name = match.split(' ')[0]
    if (!name) return await message.send('Uso: .spagado <nombre> @mencion')

    const raffle = getGroupRaffle(message.jid, name)
    if (!raffle) return await message.send(`❌ Sorteo "${name}" no encontrado.`)

    const users = extractUsers(message, match)
    if (users.length === 0) return await message.send('Debes mencionar a los usuarios.')

    let marked = 0
    for (const num in raffle.participants) {
      if (users.includes(raffle.participants[num].user)) {
        raffle.participants[num].paid = true
        marked++
      }
    }

    if (marked > 0) {
      saveGroupRaffle(message.jid, name, raffle)
      await printSorteo(message, name)
    } else {
      await message.send('No se encontraron números asignados para esos usuarios.')
    }
  }
)

// ─── .snopagado <nombre> @mencion1 @mencion2 ───
bot(
  {
    pattern: 'snopagado ?(.*)',
    desc: 'Quitar estado de pagado',
    type: 'group',
    onlyGroup: true,
  },
  async (message, match) => {
    const { senderIsAdmin } = await checkAdmin(message)
    if (!senderIsAdmin) return await message.send('❌ Solo los administradores pueden gestionar pagos.')

    const name = match.split(' ')[0]
    if (!name) return await message.send('Uso: .snopagado <nombre> @mencion')

    const raffle = getGroupRaffle(message.jid, name)
    if (!raffle) return await message.send(`❌ Sorteo "${name}" no encontrado.`)

    const users = extractUsers(message, match)
    if (users.length === 0) return await message.send('Debes mencionar a los usuarios.')

    let unmarked = 0
    for (const num in raffle.participants) {
      if (users.includes(raffle.participants[num].user)) {
        raffle.participants[num].paid = false
        unmarked++
      }
    }

    if (unmarked > 0) {
      saveGroupRaffle(message.jid, name, raffle)
      // FIX: reenviar el sorteo actualizado igual que spagado
      await printSorteo(message, name)
    } else {
      await message.send('No se encontraron números asignados para esos usuarios.')
    }
  }
)

// ─── .sorteo <nombre> — cualquier usuario puede ver el sorteo ───
bot(
  {
    pattern: 'sorteo ?(.*)',
    desc: 'Mostrar el sorteo completo',
    type: 'group',
    onlyGroup: true,
  },
  async (message, match) => {
    const name = match.split(' ')[0]
    if (!name) return await message.send('Uso: .sorteo <nombre>')
    await printSorteo(message, name)
  }
)

// ─── .slista — listar todos los sorteos activos del grupo ───
bot(
  {
    pattern: 'slista',
    desc: 'Listar sorteos activos del grupo',
    type: 'group',
    onlyGroup: true,
  },
  async (message) => {
    const raffles = getGroupRaffles(message.jid)
    const names = Object.keys(raffles)

    if (names.length === 0) {
      return await message.send('No hay sorteos activos en este grupo.')
    }

    let text = '*🎰 Sorteos activos:*\n\n'
    for (const name of names) {
      const r = raffles[name]
      const taken = Object.keys(r.participants).length
      const paid = Object.values(r.participants).filter(p => p.paid).length
      const free = r.max - taken
      const priceText = r.price ? ` | ${r.price}€` : ''
      text += `▸ *${name}* — ${taken}/${r.max} ocupados, ${paid} pagados, ${free} libres${priceText}\n`
    }
    text += `\nUsa .sorteo <nombre> para ver los detalles.`

    await message.send(text.trim())
  }
)

// ─── .sdelete <nombre> ───
bot(
  {
    pattern: 'sdelete ?(.*)',
    desc: 'Eliminar un sorteo',
    type: 'group',
    onlyGroup: true,
  },
  async (message, match) => {
    const { senderIsAdmin } = await checkAdmin(message)
    if (!senderIsAdmin) return await message.send('❌ Solo los administradores pueden eliminar sorteos.')

    const name = match.split(' ')[0]
    if (!name) return await message.send('Uso: .sdelete <nombre>')

    if (deleteGroupRaffle(message.jid, name)) {
      await message.send(`✅ Sorteo "${name}" eliminado.`)
    } else {
      await message.send(`❌ Sorteo "${name}" no encontrado.`)
    }
  }
)

// ─── .shelp — mostrar todos los comandos ───
bot(
  {
    pattern: 'shelp',
    desc: 'Ayuda del sistema de sorteos',
    type: 'group',
    onlyGroup: true,
  },
  async (message) => {
    const help = `*🎰 Comandos de Sorteos*

*Admin:*
▸ .screate <nombre> <cantidad> [precio] — Crear sorteo
▸ .sdesc <nombre> — Añadir descripción (responde a un mensaje)
▸ .scomprar <nombre> <nums> @user — Asignar números
▸ .squitar <nombre> <nums> — Liberar números
▸ .spagado <nombre> @user — Marcar como pagado 💰
▸ .snopagado <nombre> @user — Quitar pagado
▸ .sdelete <nombre> — Eliminar sorteo

*Todos:*
▸ .sorteo <nombre> — Ver sorteo completo
▸ .slista — Ver sorteos activos
▸ .shelp — Esta ayuda`

    await message.send(help)
  }
)
