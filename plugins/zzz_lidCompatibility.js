const { bot } = require('../lib/')
const config = require('../config')

bot(
  {
    on: 'text',
    fromMe: false,
    type: 'compatibility',
    dontAddCommandList: true,
  },
  async (message) => {
    if (
      process.env.LID_COMPATIBILITY === 'false' ||
      !message?.sudo ||
      message.fromMe
    ) {
      return
    }

    const text = message.text || ''
    let prefixMatch
    try {
      prefixMatch = new RegExp(process.env.PREFIX || '^[.]').exec(text)
    } catch {
      return
    }
    if (!prefixMatch || prefixMatch.index !== 0) return

    const commandText = text.slice(prefixMatch[0].length)
    const handlers = global.__sudoCommandCompatHandlers || []

    for (const entry of handlers) {
      let match
      try {
        match = new RegExp(`^(?:${entry.options.pattern})$`, 'is').exec(
          commandText
        )
      } catch {
        continue
      }
      if (!match) continue
      if ((entry.options.group || entry.options.onlyGroup) && !message.isGroup) return
      if ((entry.options.private || entry.options.onlyPm) && message.isGroup) return

      const commands = handlers.map(({ options }) => ({
        ...options,
        name:
          options.name ||
          String(options.pattern).match(/^[a-z0-9_-]+/i)?.[0] ||
          String(options.pattern),
        type: options.type || 'misc',
        active: options.active !== false,
      }))
      const context = Object.assign(
        (global.__sudoCommandCompatContext ||= {}),
        config,
        {
          commands,
          pluginsCount: commands.length,
          PREFIX: prefixMatch[0],
        }
      )
      return entry.callback(message, match[1] || '', context)
    }
  }
)
