# Asistente de AnimalesExpress

El plugin `plugins/animalesExpress.js` atiende consultas con el prefijo `.ae`, consulta rutas y clientes en Google Sheets y utiliza la API cloud de Z.AI para redactar respuestas naturales.

## Arquitectura actual

- **WhatsApp:** Levanter recibe exclusivamente los mensajes que empiezan por `.ae`, salvo las respuestas a un registro ya iniciado.
- **Datos:** Google Sheets mantiene rutas, fichas de clientes y solicitudes nuevas.
- **IA:** `glm-4.7-flash` se consume mediante la API compatible con OpenAI de Z.AI.
- **Servidor:** no necesita Ollama, llama.cpp, LM Studio ni modelos GGUF locales.
- **Exactitud:** la búsqueda de clientes y la comprobación del sentido de las rutas se hacen mediante código antes de invocar la IA.

Las consultas internas pueden enviar a Z.AI los datos de la ficha encontrada, incluidos teléfono, DNI/NIE, direcciones, ubicaciones, precio, pago y correo. Solo deben utilizarse en los grupos internos autorizados y de acuerdo con las obligaciones aplicables de protección de datos.

## Cuenta de servicio de Google

1. Crea o elige un proyecto en Google Cloud.
2. Activa Google Sheets API.
3. Crea una cuenta de servicio y descarga su clave JSON.
4. Guarda la clave fuera del repositorio, por ejemplo:

   `/home/joel/.config/levanter/credentials/animalesexpress.json`

5. Comparte el spreadsheet `[AnimalesExpress] Rutas y Operativa` con el correo de la cuenta de servicio como editor.

No guardes ni publiques la clave JSON en Git.

## Configuración

Variables necesarias en `config.env`:

```env
AE_ENABLED=true
AE_LM_STUDIO_URL=https://api.z.ai/api/paas/v4/chat/completions
AE_LM_STUDIO_MODEL=glm-4.7-flash
AE_LM_STUDIO_API_KEY=CLAVE_PRIVADA_DE_ZAI
AE_GOOGLE_SHEET_ID=ID_DEL_SPREADSHEET
AE_GOOGLE_SERVICE_ACCOUNT_FILE=/home/joel/.config/levanter/credentials/animalesexpress.json
AE_STAFF_GROUPS=120000000000000000@g.us,120000000000000001@g.us
```

Los nombres `AE_LM_STUDIO_*` se conservan por compatibilidad histórica, aunque el proveedor activo sea Z.AI. Protege el archivo:

```sh
chmod 600 config.env
pm2 restart levanter --update-env
pm2 save
```

Para obtener el ID de un grupo, escribe `.ae id` dentro del grupo. Se pueden autorizar varios IDs separados por comas.

## Límites de GLM-4.7-Flash

Z.AI publica `glm-4.7-flash` con coste cero para tokens de entrada, caché y salida. Los límites concretos de cada API key se consultan en el panel de *Rate Limits* de Z.AI.

La cuenta probada admite una sola petición simultánea. El servicio contiene una cola en memoria que serializa las llamadas a Z.AI: si llegan varios comandos, el segundo conserva la reacción `⏳` y espera a que termine el anterior. Esto evita errores HTTP `429` por concurrencia.

El razonamiento de GLM se envía desactivado porque las comprobaciones operativas ya se realizan mediante código y se priorizan respuestas rápidas.

## Comandos

```text
.ae ayuda
.ae id
.ae rutas
.ae formulario
.ae registrar
.ae Busco transporte de Madrid a Valencia para 2 pájaros
.ae cliente Juan Rodríguez
.ae dime el número de "Juan Rodríguez" y a dónde va
.ae estado
```

Las búsquedas internas solo funcionan en los grupos incluidos en `AE_STAFF_GROUPS`. `.ae cliente ...` devuelve la ficha completa directamente; las preguntas naturales utilizan la ficha encontrada y la IA para responder exactamente a lo solicitado.

## Flujo de clientes

El registro solicita:

1. Código postal de recogida.
2. Código postal de entrega.
3. Cantidad y especie de animales.

Al completar los tres datos crea una fila en `Solicitudes bot`. El personal continúa confirmando fecha y precio manualmente.

## Estado y errores

- Al comenzar cualquier comando `.ae`, el bot reacciona con `⏳` y retira la reacción al responder.
- Si el proveedor no responde, la clave es inválida, se supera un límite o la API devuelve otro error, WhatsApp muestra un aviso genérico: `La IA no responde o devolvió un error`. El proveedor no se revela al usuario.
- `.ae estado` comprueba Google Sheets, conectividad con Z.AI y disponibilidad del modelo.
- Los detalles técnicos se registran en PM2 sin imprimir la clave:

```sh
pm2 logs levanter --lines 100
```

## Mantenimiento

El servidor Ubuntu no ejecuta una IA local. El único proceso de aplicación requerido para este asistente es `levanter`.

Después de modificar el plugin o su configuración:

```sh
node --check plugins/animalesExpress.js
node --check lib/animalesExpressService.js
pm2 restart levanter --update-env
pm2 save
```
