const { bot } = require('../lib')
const axios = require('axios')

// Configuración de tu LM Studio
const LM_STUDIO_URL = 'http://192.168.1.33:1234/v1/chat/completions'
const MODEL_NAME = 'google/gemma-4-12b-qat'

bot(
  {
    pattern: 'ia ?(.*)',
    desc: 'Llama a la IA local (LM Studio)',
    type: 'ai',
  },
  async (message, match) => {
    // Extraer el prompt del comando o del mensaje al que se responde
    let prompt = match || ''
    if (!prompt && message.reply_message && message.reply_message.text) {
      prompt = message.reply_message.text
    }

    // Si no hay texto ni imagen, mostramos el ejemplo de uso
    if (!prompt && !(message.reply_message && message.reply_message.image)) {
      return await message.send('> 🤖 *Ejemplo :*\n- .ia Hola, ¿qué tal?\n- .ia ¿Qué hay en esta foto? (respondiendo a una imagen)')
    }

    let image = null

    // Si el usuario responde a una imagen, la descargamos y la pasamos a base64
    if (message.reply_message && message.reply_message.image) {
      try {
        const media = await message.reply_message.downloadMediaMessage()
        const mimetype = message.reply_message.mimetype
        const base64 = media.toString('base64')
        image = `data:${mimetype};base64,${base64}`
      } catch (error) {
        console.error("Error al descargar la imagen:", error)
        return await message.send('> ❌ *Error al procesar la imagen.*')
      }
    }

    // Construimos la petición para LM Studio
    const payload = {
      model: MODEL_NAME,
      messages: [
        {
          role: "system",
          content: "Eres un asistente virtual para WhatsApp, amigable y útil. Responde en español y usa emojis de vez en cuando.\n\nFormato OBLIGATORIO:\nNegrita: *texto*\nCursiva: _texto_\nTachado: ~texto~\nCódigo: ```texto```\nListas: - elemento"
        }
      ],
      temperature: 0.7,
      max_tokens: 1500
    }

    if (image) {
      payload.messages.push({
        role: "user",
        content: [
          { type: "text", text: prompt || "Describe esta imagen detalladamente." },
          { type: "image_url", image_url: { url: image } }
        ]
      })
    } else {
      payload.messages.push({
        role: "user",
        content: prompt
      })
    }

    try {
      // Hacemos la llamada al servidor local
      const response = await axios.post(LM_STUDIO_URL, payload, {
        headers: { 'Content-Type': 'application/json' }
      })

      let replyText = response.data.choices[0].message.content

      // Forzar formato WhatsApp por si la IA se equivoca e ignora el prompt
      replyText = replyText.replace(/\*\*(.*?)\*\*/g, '*$1*') // Convierte **negrita** a *negrita*
      replyText = replyText.replace(/^#+\s*(.*)$/gm, '*$1*') // Convierte # Titulos a *Titulos*

      await message.send(replyText, { quoted: message.data })

    } catch (error) {
      console.error("Error de conexión con LM Studio:", error.message)
      await message.send(`> ❌ *Error de conexión con la IA.*\n\nDetalles: ${error.message}\n\n*Recuerda:* Si el bot está en una máquina/VM distinta (ej. Ubuntu en WSL2), la IP '127.0.0.1' no funcionará. Debes poner la IP local (IPv4) de tu PC Windows en el archivo lmstudio.js.`)
    }
  }
)
