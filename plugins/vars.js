const fs = require('fs')
const path = require('path')
const { bot, setVar, getVars, delVar, sortObject, lang } = require('../lib')

const EXCLUDED_NUMBERS_KEY = 'AE_PRIVATE_EXCLUDED_NUMBERS'
const configEnvFile =
  process.env.AE_CONFIG_ENV_FILE || path.join(__dirname, '..', 'config.env')

const normalizeExcludedNumber = (value = '') => String(value).replace(/\D/g, '')

const getExcludedNumbers = () =>
  [...new Set(String(process.env[EXCLUDED_NUMBERS_KEY] || '')
    .split(',')
    .map(normalizeExcludedNumber)
    .filter(Boolean))]

const persistExcludedNumbers = async (numbers, instanceId) => {
  const value = [...new Set(numbers.map(normalizeExcludedNumber).filter(Boolean))].join(',')
  process.env[EXCLUDED_NUMBERS_KEY] = value

  let existing = ''
  try {
    existing = await fs.promises.readFile(configEnvFile, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const lines = existing.split(/\r?\n/)
  const replacement = `${EXCLUDED_NUMBERS_KEY}="${value}"`
  let replaced = false
  const updated = lines.map((line) => {
    if (!new RegExp(`^\\s*${EXCLUDED_NUMBERS_KEY}\\s*=`).test(line)) return line
    if (replaced) return ''
    replaced = true
    return replacement
  })
  if (!replaced) updated.push(replacement)

  const temporaryFile = `${configEnvFile}.${process.pid}.${Date.now()}.tmp`
  await fs.promises.writeFile(temporaryFile, updated.join('\n'), { mode: 0o600 })
  await fs.promises.rename(temporaryFile, configEnvFile)
  await fs.promises.chmod(configEnvFile, 0o600)
  await setVar({ [EXCLUDED_NUMBERS_KEY]: value }, instanceId)
  return value
}

bot(
  {
    pattern: 'getvar ?(.*)',
    desc: lang.plugins.getvar.desc,
    type: 'vars',
  },
  async (message, match) => {
    if (!match) return await message.send(lang.plugins.getvar.usage)
    const vars = await getVars(message.id)
    match = match.toUpperCase()
    if (vars[match]) return await message.send(`${match} = ${vars[match]}`)
    return await message.send(lang.plugins.getvar.not_found.format(match))
  }
)

bot(
  {
    pattern: 'delvar ?(.*)',
    desc: lang.plugins.delvar.desc,
    type: 'vars',
  },
  async (message, match) => {
    if (!match) return await message.send(lang.plugins.delvar.usage)
    const vars = await getVars(message.id)
    match = match.toUpperCase()
    if (!vars[match]) return await message.send(lang.plugins.delvar.not_found.format(match))
    await delVar(match, message.id)
    await message.send(lang.plugins.delvar.deleted.format(match))
  }
)

bot(
  {
    pattern: 'setvar ?(.*)',
    desc: lang.plugins.setvar.desc,
    type: 'vars',
  },
  async (message, match) => {
    const exclusion = String(match || '').trim().match(/^exclude(?:\s+|\s*=\s*)(.+)$/i)
    if (exclusion) {
      const argument = exclusion[1].trim()
      const current = getExcludedNumbers()

      if (/^list$/i.test(argument)) {
        const list = current.length
          ? current.map((number) => `- +${number}`).join('\n')
          : 'No hay números excluidos.'
        return message.send(`*Números excluidos de AnimalesExpress*\n${list}`)
      }

      const remove = argument.match(/^remove\s+(.+)$/i)
      const number = normalizeExcludedNumber(remove ? remove[1] : argument)
      if (number.length < 8 || number.length > 15) {
        return message.send(
          'Indica un número válido.\nEjemplo: *.setvar exclude +34655000000*'
        )
      }

      const updated = remove
        ? current.filter((item) => item !== number)
        : [...current, number]
      await persistExcludedNumbers(updated, message.id)
      return message.send(
        remove
          ? `✅ El número +${number} ya no está excluido.`
          : `✅ El número +${number} ha sido excluido del asistente de AnimalesExpress.`
      )
    }

    const [key, ...values] = match.split('=')
    if (!match || values.length === 0) return await message.send(lang.plugins.setvar.usage)
    const value = values.join('=').trim()
    const keyValue = key.trim().toUpperCase()
    await setVar({ [keyValue]: value }, message.id)
    await message.send(lang.plugins.setvar.success.format(keyValue, value))
  }
)

module.exports = {
  getExcludedNumbers,
  normalizeExcludedNumber,
  persistExcludedNumbers,
}

bot(
  {
    pattern: 'allvar ?(.*)',
    desc: lang.plugins.allvar.desc,
    type: 'vars',
  },
  async (message, match) => {
    const vars = await getVars(message.id)
    const sortedVars = sortObject(vars)
    const allVars = Object.entries(sortedVars)
      .map(([key, value]) => `${key} = ${value}`)
      .join('\n\n')

    await message.send(allVars)
  }
)
