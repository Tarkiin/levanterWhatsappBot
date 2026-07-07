const { enableSudoLidDispatch } = require('./lib/runtimeCompatibility')
const { Client, logger } = require('./lib/client')
const { DATABASE, VERSION } = require('./config')
const { stopInstance } = require('./lib/pm2')

// Parche de seguridad para evitar logout inesperado por addAudioMetaData.
// No desactiva plugins de audio; solo hace segura la función de metadatos.
try {
  const lib = require('./lib')
  lib.addAudioMetaData = async (buffer) => buffer
} catch (error) {
  console.error('Error al aplicar parche addAudioMetaData:', error)
}

const start = async () => {
  logger.info(`levanter ${VERSION}`)

  try {
    await DATABASE.authenticate({ retry: { max: 3 } })
  } catch (error) {
    logger.error({
      msg: 'Database connection failed',
      error: error.message,
      url: process.env.DATABASE_URL,
    })
    return stopInstance()
  }

  const bot = new Client()
  enableSudoLidDispatch(bot)

  try {
    await bot.connect()
  } catch (error) {
    logger.error({ msg: 'Bot client failed to start', error: error.message })
  }

  return bot
}

const shutdown = async (bot) => {
  try {
    if (bot) await bot.close()
    await DATABASE.close()
    process.exit(0)
  } catch (error) {
    logger.error({ msg: 'Error during shutdown', error: error.message })
    process.exit(1)
  }
}

const init = async () => {
  const bot = await start()

  process.on('SIGINT', () => shutdown(bot))
  process.on('SIGTERM', () => shutdown(bot))
}

init()
