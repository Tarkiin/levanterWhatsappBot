const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const envFile = path.join(os.tmpdir(), `levanter-exclude-${process.pid}-${Date.now()}.env`)
fs.writeFileSync(envFile, 'SESSION_ID="test"\nAE_PRIVATE_EXCLUDED_NUMBERS="655000000"\n')
process.env.AE_CONFIG_ENV_FILE = envFile
process.env.AE_PRIVATE_EXCLUDED_NUMBERS = '655000000'

const handlers = []
const savedVariables = []
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === '../lib' && /plugins[\\/]vars\.js$/.test(parent?.filename || '')) {
    const entry = () => ({ desc: '', usage: '', not_found: { format: () => '' }, success: { format: () => '' }, deleted: { format: () => '' } })
    return {
      bot: (options, callback) => handlers.push({ options, callback }),
      setVar: async (variables) => savedVariables.push(variables),
      getVars: async () => ({}),
      delVar: async () => {},
      sortObject: (value) => value,
      lang: { plugins: { getvar: entry(), delvar: entry(), setvar: entry(), allvar: entry() } },
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}

require('../../plugins/vars')
Module._load = originalLoad

const setvar = handlers.find(({ options }) => options.pattern.startsWith('setvar')).callback

test.after(() => {
  fs.rmSync(envFile, { force: true })
  delete process.env.AE_CONFIG_ENV_FILE
  delete process.env.AE_PRIVATE_EXCLUDED_NUMBERS
})

test('añade y elimina exclusiones persistentes mediante setvar', async () => {
  const sent = []
  const message = { id: 'instance', send: async (text) => sent.push(text) }

  await setvar(message, 'exclude +34655000000')
  assert.equal(process.env.AE_PRIVATE_EXCLUDED_NUMBERS, '655000000,34655000000')
  assert.match(fs.readFileSync(envFile, 'utf8'), /AE_PRIVATE_EXCLUDED_NUMBERS="655000000,34655000000"/)
  assert.deepEqual(savedVariables.at(-1), {
    AE_PRIVATE_EXCLUDED_NUMBERS: '655000000,34655000000',
  })
  assert.match(sent.at(-1), /ha sido excluido/i)

  await setvar(message, 'exclude remove +34655000000')
  assert.equal(process.env.AE_PRIVATE_EXCLUDED_NUMBERS, '655000000')
  assert.match(sent.at(-1), /ya no está excluido/i)
})
