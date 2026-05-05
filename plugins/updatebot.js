const { bot } = require('../lib/')
const { exec } = require('child_process')

bot(
  {
    pattern: 'updatebot',
    fromMe: true,
    desc: 'Sincroniza y actualiza el bot con los últimos cambios de GitHub y se reinicia.',
    type: 'system',
  },
  async (message, match) => {
    await message.send('_⚙️ Iniciando proceso de actualización del bot..._\n_Esto fusionará los cambios del creador original, los subirá a tu GitHub y reiniciará._')

    const updateCommand = `
      git remote add upstream https://github.com/lyfe00011/levanter 2>/dev/null || true && 
      git fetch upstream && 
      git merge upstream/master --no-edit && 
      git push origin master && 
      yarn install && 
      pm2 restart levanter
    `.replace(/\n/g, ' ')

    exec(updateCommand, async (error, stdout, stderr) => {
      if (error) {
        return await message.send(`*❌ Error durante la actualización:*\n\`\`\`${error.message}\`\`\``)
      }
      // Si la actualización es exitosa, el proceso (pm2) se reiniciará a sí mismo, 
      // por lo que este código después del exec rara vez se ejecutará,
      // pero por si acaso, enviamos un aviso.
    })
  }
)
