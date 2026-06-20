const EventEmitter = require('events')
const Module = require('module')

const blockedGitOperations = new Set([
  'addRemote',
  'checkout',
  'checkoutBranch',
  'checkoutLocalBranch',
  'clean',
  'fetch',
  'merge',
  'pull',
  'push',
  'rebase',
  'reset',
  'stash',
])

const safeGitInstance = (instance) =>
  new Proxy(instance, {
    get(target, property, receiver) {
      if (blockedGitOperations.has(property)) return async () => undefined
      if (property === 'raw') {
        return (...args) => {
          const command = (Array.isArray(args[0]) ? args[0] : args)
            .flat()
            .map(String)
          if (command.some((part) => blockedGitOperations.has(part))) {
            return Promise.resolve(undefined)
          }
          return target.raw(...args)
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })

const safeGitModule = (actual) => {
  if (global.__safeGitModule) return global.__safeGitModule
  const safe = (...args) => safeGitInstance(actual(...args))
  Object.assign(safe, actual)
  safe.simpleGit = (...args) => safeGitInstance(actual.simpleGit(...args))
  safe.default = safe
  safe.gitP = safe
  global.__safeGitModule = safe
  return safe
}

const installRuntimeCompatibility = () => {
  if (global.__levanterRuntimeCompatibility) return
  global.__levanterRuntimeCompatibility = true

  const originalEmit = EventEmitter.prototype.emit
  EventEmitter.prototype.emit = function (event, ...args) {
    if (process.env.LID_COMPATIBILITY !== 'false') {
      const upsert = event === 'event' && args[0]?.['messages.upsert']
      for (const item of upsert?.messages || []) {
        const key = item.key || {}
        if (
          key.remoteJid?.endsWith('@lid') &&
          key.remoteJidAlt?.endsWith('@s.whatsapp.net')
        ) {
          key.remoteJid = key.remoteJidAlt
        }
        if (
          key.participant?.endsWith('@lid') &&
          key.participantAlt?.endsWith('@s.whatsapp.net')
        ) {
          key.participant = key.participantAlt
        }
      }
    }
    return originalEmit.call(this, event, ...args)
  }

  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    const result = originalLoad.call(this, request, parent, isMain)
    if (request === 'simple-git') return safeGitModule(result)

    const isPluginLibImport =
      /[\\/]plugins[\\/]/.test(parent?.filename || '') &&
      /^\.\.\/lib\/?$/.test(request)
    if (
      isPluginLibImport &&
      typeof result?.bot === 'function' &&
      !result.__lidCommandCompatibility
    ) {
      const originalBot = result.bot
      Object.defineProperty(result, '__lidCommandCompatibility', { value: true })
      result.bot = (options, callback) => {
        if (typeof options?.pattern === 'string') {
          global.__sudoCommandCompatHandlers ||= []
          global.__sudoCommandCompatHandlers.push({ options, callback })
        }
        return originalBot(options, callback)
      }
    }
    return result
  }
}

const getSudoIds = () =>
  new Set(
    (process.env.SUDO || '')
      .split(/[\s,]+/)
      .map((value) => value.replace(/\D/g, ''))
      .filter(Boolean)
  )

const enableSudoLidDispatch = (client) => {
  if (process.env.LID_COMPATIBILITY === 'false') return

  const probe = setInterval(() => {
    const sessions =
      client.sessions instanceof Map
        ? [...client.sessions.values()]
        : Object.values(client.sessions || {})
    let wrapped = false

    for (const session of sessions) {
      if (session.__sudoLidDispatch || typeof session.bloc !== 'function') continue
      const originalBloc = session.bloc
      Object.defineProperty(session, '__sudoLidDispatch', { value: true })
      session.bloc = function (sender, ...args) {
        const allowed = originalBloc.call(this, sender, ...args)
        const senderId = String(sender || '')
          .split('@')[0]
          .split(':')[0]
          .replace(/\D/g, '')
        return allowed || getSudoIds().has(senderId)
      }
      wrapped = true
    }

    if (wrapped) clearInterval(probe)
  }, 100)
  probe.unref?.()
}

installRuntimeCompatibility()

module.exports = { enableSudoLidDispatch }
