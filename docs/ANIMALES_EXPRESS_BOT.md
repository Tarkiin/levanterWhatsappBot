# Asistente de AnimalesExpress

El plugin `plugins/animalesExpress.js` atiende automáticamente todos los chats privados de texto, mantiene los comandos `.ae` en grupos, consulta datos autorizados de Google Sheets y utiliza la API cloud de Z.AI para redactar respuestas naturales.

## Arquitectura actual

- **WhatsApp privado:** todo mensaje de texto entrante recibe atención automática, salvo los números excluidos y los cinco minutos posteriores a una respuesta manual de Ulises.
- **WhatsApp grupos:** solo actúa con `.ae`, `.ae ai <pregunta>` o durante un registro iniciado expresamente.
- **Datos:** Google Sheets mantiene rutas, fichas de clientes y solicitudes nuevas.
- **IA:** `glm-4.7-flash` se consume mediante la API compatible con OpenAI de Z.AI.
- **Privacidad de contexto:** la conversación pública solo recibe rutas publicadas y la base empresarial. Las fichas, solicitudes y respuestas brutas del formulario nunca se incorporan al prompt público.
- **Memoria:** la información empresarial vive de forma permanente en `data/animalesexpress.md`; las conversaciones privadas se guardan 30 días en `data/animalesexpress-conversations.json`.
- **Multimedia:** no se procesa; este despliegue usa exclusivamente texto.
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
AE_NOTIFICATION_GROUP=120363410600147851@g.us
AE_ULISES_JID=34671982095@s.whatsapp.net
AE_DAYANA_JID=34617886170@s.whatsapp.net
AE_PRIVATE_EXCLUDED_NUMBERS=655000000
AE_AI_TEMPERATURE=0.1
AE_AI_MIN_INTERVAL_MS=5000
AE_AI_TIMEOUT_MS=20000
AE_AI_MAX_RETRIES=1
AE_WHATSAPP_SEND_DELAY_MS=5000
AE_CONVERSATION_RETENTION_DAYS=30
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

El servicio contiene una cola global que serializa las llamadas a Z.AI y deja al menos cinco segundos entre ellas. Cada chat privado también mantiene su propia cola para conservar el orden de los mensajes. Esto evita concurrencia descontrolada y reduce errores HTTP `429`.

Cada intento contra Z.AI tiene un máximo predeterminado de veinte segundos (`AE_AI_TIMEOUT_MS=20000`) y solo se reintenta una vez (`AE_AI_MAX_RETRIES=1`). El reintento se programa rápidamente, pero vuelve a pasar por la cola global y respeta su separación mínima antes de llamar al proveedor. Si Z.AI devuelve `429`, `5xx` o deja una conexión colgada, la petición se abandona en un tiempo acotado, se libera la cola privada y el cliente recibe el aviso seguro en vez de quedarse sin respuesta durante varios minutos.

Los envíos de WhatsApp generados por AnimalesExpress desactivan la vista previa de enlaces y separan los avisos internos al menos `AE_WHATSAPP_SEND_DELAY_MS` milisegundos. Esto reduce picos al terminar una solicitud y evita mandar el mensaje al cliente, el aviso al grupo y el aviso privado a la vez.

El razonamiento de GLM se envía desactivado porque las comprobaciones operativas ya se realizan mediante código y se priorizan respuestas rápidas.

## Comandos

```text
.ae ayuda
.ae id
.ae rutas
.ae formulario
.ae registrar
.ae ai ¿Qué ruta hay de Madrid a Valencia?
.ae Busco transporte de Madrid a Valencia para 2 pájaros
.ae cliente Juan Rodríguez
.ae dime el número de "Juan Rodríguez" y a dónde va
.ae estado
```

Las búsquedas internas solo funcionan en los grupos incluidos en `AE_STAFF_GROUPS`. `.ae cliente ...` devuelve la ficha completa directamente; las preguntas naturales utilizan la ficha encontrada y la IA para responder exactamente a lo solicitado.

## Flujo de clientes

En privado, expresiones como `quiero contratar`, `necesito transporte` o `quiero presupuesto` inician el registro. También puede iniciarse con `.ae registrar`. El flujo solicita:

1. Nombre.
2. Código postal y población de recogida.
3. Código postal y población de entrega.
4. Cantidad y especie de animales.
5. Fecha aproximada.
6. Observaciones.

Al completar los datos crea una fila en `Solicitudes bot`, envía el formulario oficial al cliente con vista previa y avisa en el grupo interno para que Ulises y Dayana lo revisen. No envía aviso privado separado a Dayana ni menciones reales de WhatsApp. El personal continúa confirmando viabilidad, fecha y precio manualmente.

Durante el registro, una respuesta inválida muestra una sola indicación con el formato esperado. El cliente puede abandonar el flujo escribiendo expresiones como `cancelar`, `ya no quiero`, `no lo quiero` o `déjalo`; el bot elimina inmediatamente la solicitud pendiente y confirma la cancelación.

Los avisos internos y la columna de contacto de `Solicitudes bot` utilizan el JID telefónico alternativo de WhatsApp cuando el chat llega identificado mediante `@lid`. Un LID nunca se presenta como si fuera un número de teléfono; si WhatsApp no entrega el JID telefónico, aparece `Número no disponible`.

## Intervención humana

- Los mensajes enviados manualmente por Ulises se distinguen de las respuestas generadas por el plugin.
- Una respuesta manual pausa el asistente cinco minutos en ese chat.
- Las respuestas humanas se conservan dentro del contexto para que la IA no repita ni contradiga al operador.
- Si falta información comprobable, el proveedor falla, el cliente pide una persona o comunica una incidencia, el bot da una respuesta segura y avisa al equipo.
- Los avisos se agrupan con un enfriamiento de quince minutos por chat para evitar spam interno.
- En chats privados nunca se muestran estados, direcciones, DNI, teléfonos ni datos de reservas. `.ae cliente ...` continúa limitado a los grupos incluidos en `AE_STAFF_GROUPS`.

## Estado y errores

- Al comenzar cualquier comando `.ae`, el bot reacciona con `⏳` y retira la reacción al responder.
- Si el proveedor no responde, la clave es inválida, se supera un límite o la API devuelve otro error, WhatsApp muestra un aviso genérico: `La IA no responde o devolvió un error`. El proveedor no se revela al usuario.
- `.ae estado` comprueba Google Sheets, conectividad con Z.AI y disponibilidad del modelo.
- La temperatura predeterminada es `0.1`; rutas, búsquedas y decisiones de acceso se validan mediante código y no se dejan a la creatividad del modelo.
- Los detalles técnicos se registran en PM2 sin imprimir la clave:
- El último plugin/comando ejecutado queda guardado en `data/last-command.json` y también aparece como `[CommandAudit]` en los logs. Si WhatsApp vuelve a expulsar la sesión, ese archivo indica qué handler se ejecutó justo antes.

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
