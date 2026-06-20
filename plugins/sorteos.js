const { bot, isAdmin, jidToNum } = require('../lib/')
const fs = require('fs')
const path = require('path')

const dbPath = path.join(__dirname, '../lib/db/sorteos.json')
let _cache = null

function loadDB() {
  if (_cache) return _cache
  if (!fs.existsSync(dbPath)) { _cache = {}; return _cache }
  try { _cache = JSON.parse(fs.readFileSync(dbPath, 'utf8')); return _cache }
  catch (e) { _cache = {}; return _cache }
}

function saveDB(data) {
  _cache = data
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2))
}

function getRaffle(jid, name) {
  const db = loadDB()
  return (db[jid] && db[jid][name]) || null
}

function saveRaffle(jid, name, data) {
  const db = loadDB()
  if (!db[jid]) db[jid] = {}
  db[jid][name] = data
  saveDB(db)
}

function deleteRaffle(jid, name) {
  const db = loadDB()
  if (db[jid] && db[jid][name]) { delete db[jid][name]; saveDB(db); return true }
  return false
}

function listRaffles(jid) {
  return loadDB()[jid] || {}
}

// ─── Helpers ───
async function checkIsAdmin(message) {
  const participants = await message.groupMetadata(message.jid)
  const sender = message.participant

  for (const p of participants) {
    if ((p.id === sender || p.phoneNumber === sender) &&
        (p.admin === 'admin' || p.admin === 'superadmin')) {
      return true
    }
  }
  return false
}

function pad(n, max) {
  return String(n).padStart(max > 99 ? 3 : 2, '0')
}

function extractNums(text) {
  return (text.match(/\d+/g) || [])
}

function extractUsers(message, match) {
  if (message.mention && message.mention.length > 0) return message.mention
  if (message.reply_message) return [message.reply_message.jid]
  const m = match.match(/@(\d+)/g)
  return m ? m.map(x => x.slice(1) + '@s.whatsapp.net') : []
}

// ─── Imprimir sorteo completo ───
async function printSorteo(message, name) {
  const r = getRaffle(message.jid, name)
  if (!r) return await message.send('❌ Sorteo "' + name + '" no encontrado.')

  let text = ''
  if (r.desc) text += r.desc + '\n\n'
  text += 'Números disponibles:\n'

  const mentioned = []
  for (let i = 0; i < r.max; i++) {
    const ns = pad(i, r.max)
    const p = r.participants[ns]
    if (p) {
      const paidIcon = p.paid ? ' 💰' : ''
      text += ns + ' @' + jidToNum(p.user) + paidIcon + '\n'
      if (!mentioned.includes(p.user)) mentioned.push(p.user)
    } else {
      text += ns + '\n'
    }
  }

  await message.send(text.trim(), { contextInfo: { mentionedJid: mentioned } })
}

// ═══════════════════════════════════════
// .screar <nombre> <cantidad> [descripcion]
// También: responder a un mensaje con .screar <nombre> <cantidad>
// Solo admins
// ═══════════════════════════════════════
bot(
  {
    pattern: 'screar ?(.*)',
    desc: 'Crear sorteo. Uso: .screar exotic_king 100',
    type: 'group',
    onlyGroup: true,
  },
  async (message, match) => {
    if (!(await checkIsAdmin(message)))
      return await message.send('❌ Solo los administradores pueden crear sorteos.')

    const parts = match.split(' ')
    const name = parts[0]
    const max = parts[1]

    if (!name || !max || isNaN(max))
      return await message.send('Uso: .screar <nombre> <cantidad>\nEjemplo: .screar exotic_king 100')

    if (getRaffle(message.jid, name))
      return await message.send('⚠️ Ya existe "' + name + '". Usa .sdelete ' + name + ' primero.')

    // Descripcion: texto inline despues de nombre+cantidad, o mensaje respondido
    let desc = ''
    if (message.reply_message) {
      desc = message.reply_message.text || ''
    } else {
      const afterMax = match.indexOf(max) + max.length
      desc = match.slice(afterMax).trim()
    }

    const limit = parseInt(max)
    saveRaffle(message.jid, name, {
      name: name,
      max: limit,
      desc: desc,
      participants: {},
      createdAt: new Date().toISOString(),
    })

    await message.send('✅ Sorteo "' + name + '" creado (' + limit + ' números: ' + pad(0, limit) + '-' + pad(limit - 1, limit) + ')')
    if (desc) await printSorteo(message, name)
  }
)

// ═══════════════════════════════════════
// .seditar <nombre> [nueva descripcion]
// También: responder a un mensaje con .seditar <nombre>
// Solo admins
// ═══════════════════════════════════════
bot(
  {
    pattern: 'seditar ?(.*)',
    desc: 'Editar descripción del sorteo',
    type: 'group',
    onlyGroup: true,
  },
  async (message, match) => {
    if (!(await checkIsAdmin(message)))
      return await message.send('❌ Solo los administradores pueden editar sorteos.')

    const name = match.split(' ')[0]
    if (!name) return await message.send('Uso: .seditar <nombre> (texto o responder a un mensaje)')

    const r = getRaffle(message.jid, name)
    if (!r) return await message.send('❌ Sorteo "' + name + '" no encontrado.')

    let desc = ''
    if (message.reply_message && message.reply_message.text) {
      desc = message.reply_message.text
    } else {
      desc = match.slice(name.length).trim()
    }

    if (!desc) return await message.send('Escribe la descripción después del comando o responde a un mensaje.')

    r.desc = desc
    saveRaffle(message.jid, name, r)
    await message.send('✅ Descripción de "' + name + '" actualizada.')
  }
)

// ═══════════════════════════════════════
// .scomprar <nombre> <num1,num2,...>
// AUTOSERVICIO: el que escribe el comando se asigna a sí mismo
// Users y admins
// ═══════════════════════════════════════
bot(
  {
    pattern: 'scomprar ?(.*)',
    desc: 'Comprar números (te asignas a ti mismo)',
    type: 'group',
    onlyGroup: true,
  },
  async (message, match) => {
    const name = match.split(' ')[0]
    if (!name) return await message.send('Uso: .scomprar <nombre> <num1,num2,...>')

    const r = getRaffle(message.jid, name)
    if (!r) return await message.send('❌ Sorteo "' + name + '" no encontrado.')

    const user = message.participant // Se auto-asigna

    // Extraer números solo antes de @ para evitar capturar el LID
    const textBeforeMention = match.slice(name.length).split('@')[0]
    const nums = extractNums(textBeforeMention)
    if (nums.length === 0) return await message.send('Indica los números que quieres comprar.')

    const ok = []
    const taken = []
    const bad = []

    for (const n of nums) {
      const ns = pad(parseInt(n), r.max)
      if (parseInt(ns) >= r.max) { bad.push(ns); continue }

      const existing = r.participants[ns]
      if (existing && existing.user !== user) {
        taken.push(ns + ' (@' + jidToNum(existing.user) + ')')
        continue
      }
      r.participants[ns] = { user: user, paid: false }
      ok.push(ns)
    }

    if (ok.length > 0) saveRaffle(message.jid, name, r)

    let msg = ''
    if (ok.length) msg += '✅ Números asignados: ' + ok.join(', ') + '\n'
    if (taken.length) msg += '⚠️ Ya ocupados: ' + taken.join(', ') + '\n'
    if (bad.length) msg += '❌ Fuera de rango: ' + bad.join(', ') + '\n'

    await message.send(msg.trim())
    if (ok.length) await printSorteo(message, name)
  }
)

// ═══════════════════════════════════════
// .sadd <nombre> <nums> @user
// Solo admins — asigna números a otro usuario
// ═══════════════════════════════════════
bot(
  {
    pattern: 'sadd ?(.*)',
    desc: 'Asignar números a un usuario (admin)',
    type: 'group',
    onlyGroup: true,
  },
  async (message, match) => {
    if (!(await checkIsAdmin(message)))
      return await message.send('❌ Solo los administradores pueden asignar números.')

    const name = match.split(' ')[0]
    if (!name) return await message.send('Uso: .sadd <nombre> <nums> @usuario')

    const r = getRaffle(message.jid, name)
    if (!r) return await message.send('❌ Sorteo "' + name + '" no encontrado.')

    const users = extractUsers(message, match)
    if (!users.length) return await message.send('Menciona al usuario al que quieres asignar números.')
    const user = users[0]

    // Extraer números solo ANTES de la mención @ para no capturar el LID
    const textBeforeMention = match.slice(name.length).split('@')[0]
    const nums = extractNums(textBeforeMention)
    if (nums.length === 0) return await message.send('Indica los números a asignar.')

    const ok = []
    const taken = []
    const bad = []

    for (const n of nums) {
      const ns = pad(parseInt(n), r.max)
      if (parseInt(ns) >= r.max) { bad.push(ns); continue }

      const existing = r.participants[ns]
      if (existing && existing.user !== user) {
        taken.push(ns + ' (@' + jidToNum(existing.user) + ')')
        continue
      }
      r.participants[ns] = { user: user, paid: false }
      ok.push(ns)
    }

    if (ok.length > 0) saveRaffle(message.jid, name, r)

    let msg = ''
    if (ok.length) msg += '✅ Números ' + ok.join(', ') + ' asignados a @' + jidToNum(user) + '\n'
    if (taken.length) msg += '⚠️ Ya ocupados: ' + taken.join(', ') + '\n'
    if (bad.length) msg += '❌ Fuera de rango: ' + bad.join(', ') + '\n'

    await message.send(msg.trim(), { contextInfo: { mentionedJid: [user] } })
    if (ok.length) await printSorteo(message, name)
  }
)

// ═══════════════════════════════════════
// .squitar <nombre> <num1,num2,...>
// AUTOSERVICIO: solo puedes liberar TUS números (admin puede liberar cualquiera)
// Users y admins
// ═══════════════════════════════════════
bot(
  {
    pattern: 'squitar ?(.*)',
    desc: 'Liberar tus números',
    type: 'group',
    onlyGroup: true,
  },
  async (message, match) => {
    const name = match.split(' ')[0]
    if (!name) return await message.send('Uso: .squitar <nombre> <num1,num2,...>')

    const r = getRaffle(message.jid, name)
    if (!r) return await message.send('❌ Sorteo "' + name + '" no encontrado.')

    const isAdm = await checkIsAdmin(message)
    const user = message.participant

    const textBeforeMention = match.slice(name.length).split('@')[0]
    const nums = extractNums(textBeforeMention)
    if (nums.length === 0) return await message.send('Indica los números que quieres liberar.')

    const freed = []
    const denied = []
    for (const n of nums) {
      const ns = pad(parseInt(n), r.max)
      const p = r.participants[ns]
      if (!p) continue
      if (p.user === user || isAdm) {
        delete r.participants[ns]
        freed.push(ns)
      } else {
        denied.push(ns)
      }
    }

    if (freed.length) {
      saveRaffle(message.jid, name, r)
      await message.send('✅ Números liberados: ' + freed.join(', '))
      await printSorteo(message, name)
    } else if (denied.length) {
      await message.send('❌ No puedes liberar números de otros usuarios.')
    } else {
      await message.send('Esos números ya estaban libres.')
    }
  }
)

// ═══════════════════════════════════════
// .spagado <nombre> @user1 @user2
// Solo admins — marca como pagado y reenvía el sorteo
// ═══════════════════════════════════════
bot(
  {
    pattern: 'spagado ?(.*)',
    desc: 'Marcar como pagado 💰',
    type: 'group',
    onlyGroup: true,
  },
  async (message, match) => {
    if (!(await checkIsAdmin(message)))
      return await message.send('❌ Solo los administradores pueden marcar pagos.')

    const name = match.split(' ')[0]
    if (!name) return await message.send('Uso: .spagado <nombre> @usuario')

    const r = getRaffle(message.jid, name)
    if (!r) return await message.send('❌ Sorteo "' + name + '" no encontrado.')

    const users = extractUsers(message, match)
    if (!users.length) return await message.send('Menciona a los usuarios.')

    let count = 0
    for (const ns in r.participants) {
      if (users.includes(r.participants[ns].user)) {
        r.participants[ns].paid = true
        count++
      }
    }

    if (count) {
      saveRaffle(message.jid, name, r)
      await printSorteo(message, name)
    } else {
      await message.send('No se encontraron números asignados a esos usuarios.')
    }
  }
)

// ═══════════════════════════════════════
// .snopagado <nombre> @user1 @user2
// Solo admins
// ═══════════════════════════════════════
bot(
  {
    pattern: 'snopagado ?(.*)',
    desc: 'Quitar estado de pagado',
    type: 'group',
    onlyGroup: true,
  },
  async (message, match) => {
    if (!(await checkIsAdmin(message)))
      return await message.send('❌ Solo los administradores pueden gestionar pagos.')

    const name = match.split(' ')[0]
    if (!name) return await message.send('Uso: .snopagado <nombre> @usuario')

    const r = getRaffle(message.jid, name)
    if (!r) return await message.send('❌ Sorteo "' + name + '" no encontrado.')

    const users = extractUsers(message, match)
    if (!users.length) return await message.send('Menciona a los usuarios.')

    let count = 0
    for (const ns in r.participants) {
      if (users.includes(r.participants[ns].user)) {
        r.participants[ns].paid = false
        count++
      }
    }

    if (count) {
      saveRaffle(message.jid, name, r)
      await printSorteo(message, name)
    } else {
      await message.send('No se encontraron números asignados a esos usuarios.')
    }
  }
)

// ═══════════════════════════════════════
// .sorteo <nombre> — ver el sorteo completo
// Users y admins
// ═══════════════════════════════════════
bot(
  {
    pattern: 'sorteo ?(.*)',
    desc: 'Ver sorteo completo',
    type: 'group',
    onlyGroup: true,
  },
  async (message, match) => {
    const name = match.split(' ')[0]
    if (!name) return await message.send('Uso: .sorteo <nombre>')
    await printSorteo(message, name)
  }
)

// ═══════════════════════════════════════
// .slista — ver sorteos activos del grupo
// Users y admins
// ═══════════════════════════════════════
bot(
  {
    pattern: 'slista',
    desc: 'Listar sorteos activos',
    type: 'group',
    onlyGroup: true,
  },
  async (message) => {
    const raffles = listRaffles(message.jid)
    const names = Object.keys(raffles)
    if (!names.length) return await message.send('No hay sorteos activos en este grupo.')

    let text = '🎰 *Sorteos activos:*\n\n'
    for (const n of names) {
      const r = raffles[n]
      const taken = Object.keys(r.participants).length
      const paid = Object.values(r.participants).filter(p => p.paid).length
      text += '▸ *' + n + '* — ' + taken + '/' + r.max + ' vendidos, ' + paid + ' pagados\n'
    }
    text += '\nUsa .sorteo <nombre> para ver detalles.'
    await message.send(text.trim())
  }
)

// ═══════════════════════════════════════
// .sdelete <nombre> — eliminar sorteo
// Solo admins
// ═══════════════════════════════════════
bot(
  {
    pattern: 'sdelete ?(.*)',
    desc: 'Eliminar un sorteo',
    type: 'group',
    onlyGroup: true,
  },
  async (message, match) => {
    if (!(await checkIsAdmin(message)))
      return await message.send('❌ Solo los administradores pueden eliminar sorteos.')

    const name = match.split(' ')[0]
    if (!name) return await message.send('Uso: .sdelete <nombre>')

    if (deleteRaffle(message.jid, name)) {
      await message.send('✅ Sorteo "' + name + '" eliminado.')
    } else {
      await message.send('❌ Sorteo "' + name + '" no encontrado.')
    }
  }
)

// ═══════════════════════════════════════
// .shelp — ayuda de sorteos
// ═══════════════════════════════════════
bot(
  {
    pattern: 'shelp',
    desc: 'Ayuda del sistema de sorteos',
    type: 'group',
    onlyGroup: true,
  },
  async (message) => {
    await message.send(
      '*🎰 Comandos de Sorteos*\n\n' +
      '*━━━ Solo admins ━━━*\n\n' +
      '▸ *.screar* <nombre del sorteo> <cantidad de números>\n' +
      '   Crear sorteo. Escribe después la descripción o responde a un mensaje.\n' +
      '   _Ej: .screar exotic_king 100_\n\n' +
      '▸ *.seditar* <nombre del sorteo>\n' +
      '   Editar la descripción. Escribe después el nuevo texto o responde a un mensaje.\n' +
      '   _Ej: .seditar exotic_king (texto nuevo...)_\n\n' +
      '▸ *.spagado* <nombre del sorteo> @usuario\n' +
      '   Marcar como pagado 💰 (menciona uno o varios)\n' +
      '   _Ej: .spagado exotic_king @José @David_\n\n' +
      '▸ *.snopagado* <nombre del sorteo> @usuario\n' +
      '   Quitar marca de pagado\n\n' +
      '▸ *.sdelete* <nombre del sorteo>\n' +
      '   Eliminar un sorteo definitivamente\n\n' +
      '▸ *.sadd* <nombre del sorteo> <números> @usuario\n' +
      '   Asignar números a otro usuario\n' +
      '   _Ej: .sadd exotic_king 10,12,16 @usuario_\n\n' +
      '*━━━ Todos ━━━*\n\n' +
      '▸ *.scomprar* <nombre del sorteo> <números separados por coma>\n' +
      '   Te asignas números a ti mismo\n' +
      '   _Ej: .scomprar exotic_king 10,12,16_\n\n' +
      '▸ *.squitar* <nombre del sorteo> <números separados por coma>\n' +
      '   Liberas tus propios números\n' +
      '   _Ej: .squitar exotic_king 10,16_\n\n' +
      '▸ *.sorteo* <nombre del sorteo> — Ver el sorteo completo\n' +
      '▸ *.slista* — Ver todos los sorteos activos\n' +
      '▸ *.shelp* — Esta ayuda'
    )
  }
)
