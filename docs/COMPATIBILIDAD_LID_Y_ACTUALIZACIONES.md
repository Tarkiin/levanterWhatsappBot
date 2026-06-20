# Compatibilidad LID, comandos ignorados y actualizaciones seguras

## Objetivo

Este documento explica el problema que provocaba que Levanter iniciara y enviara
el mensaje de bienvenida, pero ignorara comandos como `.ping`, `.menu` o `.list`.
También documenta la solución integrada en este fork y el procedimiento recomendado
para instalar futuras versiones sin perder la corrección, la sesión, la configuración
ni los plugins personalizados.

La corrección quedó incorporada al repositorio en el commit `6ed77eb`.

## Síntomas observados

- PM2 mostraba el proceso `levanter` como `online`.
- La conexión con WhatsApp se completaba correctamente.
- El bot enviaba el mensaje de inicio y la lista de configuración.
- Los mensajes enviados desde WhatsApp tenían doble marca de entrega.
- Los comandos no generaban respuesta ni un error visible.
- Reiniciar PM2 no solucionaba el problema.
- En algunas ejecuciones una instalación limpia parecía funcionar, pero el
  comportamiento no era estable después de reiniciar o cambiar la sesión enlazada.

El mensaje de inicio no demostraba que el sistema de comandos funcionase. Ese mensaje
es saliente y se envía directamente durante el arranque; los comandos entrantes pasan
por otra ruta con filtros adicionales.

## Causa raíz

### Identificadores LID de WhatsApp

Las versiones nuevas de Baileys pueden entregar mensajes de dispositivos vinculados
con un identificador `@lid` en lugar del JID telefónico tradicional
`@s.whatsapp.net`.

Ejemplo simplificado y sin datos reales:

```js
{
  remoteJid: 'identificador@lid',
  remoteJidAlt: 'telefono@s.whatsapp.net',
  fromMe: false
}
```

Levanter 5.5.3 no interpreta de manera fiable este formato en todas las sesiones. El
mensaje puede pertenecer a un usuario configurado en `SUDO`, pero llegar con estas
características:

- `remoteJid` contiene un LID.
- `remoteJidAlt` contiene el número telefónico esperado.
- `fromMe` es `false`, aunque el propietario haya enviado el mensaje desde otro
  dispositivo vinculado.

### Filtro interno anterior a los plugins

Antes de buscar el patrón `.ping`, Levanter ejecuta un filtro interno denominado
`bloc`. En el estado problemático este filtro devolvía `false`, por lo que el mensaje
se descartaba antes de llegar al plugin correspondiente.

Durante el diagnóstico se comprobó lo siguiente:

1. Baileys recibía físicamente el mensaje.
2. El texto `.ping` estaba presente y era correcto.
3. El número alternativo coincidía con un usuario `SUDO`.
4. El objeto de mensaje resultante tenía `sudo: true` y `fromMe: false`.
5. El plugin `ping` estaba registrado.
6. La función del plugin no se ejecutaba porque el despachador lo filtraba antes.

### Contexto requerido por algunos comandos

`.ping` solo necesita el objeto `message`, pero `.menu`, `.help` y `.list` también
reciben un tercer argumento de contexto. Este contexto contiene, entre otros datos:

- `commands`
- `PREFIX`
- `VERSION`
- `pluginsCount`
- variables de configuración

Una primera prueba de compatibilidad hizo funcionar `.ping`, pero `.menu` y `.list`
fallaban con:

```text
Cannot read properties of undefined (reading 'commands')
```

La implementación definitiva reconstruye y entrega este contexto al ejecutar el
callback original.

## Por qué el fallo podía parecer intermitente

El formato exacto del mensaje depende de la sesión, el dispositivo desde el que se
envía, el tipo de chat y la información alternativa incluida por WhatsApp. Por eso una
ejecución limpia podía responder temporalmente y una ejecución posterior volver a
recibir `fromMe: false` o un JID LID.

No se debe considerar solucionado únicamente porque una prueba aislada funcione. La
compatibilidad debe normalizar ambos formatos de forma determinista.

## Solución integrada

### `lib/runtimeCompatibility.js`

Este módulo se carga antes que el cliente principal y realiza tres tareas.

#### 1. Normalización de JID

Intercepta los eventos `messages.upsert` de Baileys. Cuando encuentra un LID con un
JID telefónico alternativo válido, sustituye el identificador utilizado por Levanter:

```text
remoteJid @lid      -> remoteJidAlt @s.whatsapp.net
participant @lid    -> participantAlt @s.whatsapp.net
```

La normalización se realiza tanto en chats privados como en participantes de grupos.

#### 2. Autorización del remitente SUDO

Envuelve el filtro `bloc` de cada sesión. Si el comportamiento original acepta el
mensaje, no se cambia nada. Si lo rechaza, solo se permite continuar cuando el número
normalizado figura expresamente en `SUDO`.

Esto es importante por seguridad: la corrección no convierte los comandos privados
en comandos públicos.

#### 3. Registro de callbacks originales

Captura las llamadas de registro `bot({ pattern }, callback)` de los plugins. No copia
ni reimplementa cada comando; guarda su callback real para que el puente LID pueda
ejecutar exactamente la misma función.

También protege la instalación contra operaciones Git automáticas que puedan alterar
el código (`fetch`, `reset`, `pull`, `checkout`, etc.). Las consultas Git de solo lectura
siguen disponibles.

### `plugins/zzz_lidCompatibility.js`

Este plugin se carga al final de los plugins locales y escucha mensajes de texto que
no sean `fromMe`.

El flujo es el siguiente:

1. Exige que `message.sudo` sea verdadero.
2. Lee `PREFIX` como expresión regular. En esta instalación el prefijo puede aceptar
   más de un carácter, por ejemplo `^[.,]`.
3. Elimina el prefijo del texto.
4. Busca el patrón original registrado por el plugin.
5. Respeta restricciones básicas de grupo o chat privado.
6. Construye el contexto requerido por menús y comandos avanzados.
7. Ejecuta el callback original con `message`, `match` y `context`.

El prefijo `zzz_` es intencionado: hace que el puente se registre después de los
plugins normales y disponga de la lista completa de callbacks.

### `index.js`

El archivo principal contiene únicamente la integración mínima:

```js
const { enableSudoLidDispatch } = require('./lib/runtimeCompatibility')
```

Después de crear el cliente:

```js
const bot = new Client()
enableSudoLidDispatch(bot)
```

Mantener la mayor parte de la compatibilidad en un archivo independiente reduce los
conflictos al fusionar futuras versiones oficiales.

### `config.js`

`AUTO_UPDATE` está fijado a `false`. Las actualizaciones se realizan manualmente y se
validan antes de reiniciar producción.

## Desactivar la compatibilidad en el futuro

Si una versión oficial futura implementa soporte LID completo y provoca respuestas
duplicadas, se puede desactivar temporalmente esta capa añadiendo a `config.env`:

```env
LID_COMPATIBILITY="false"
```

Después se debe detener y volver a iniciar el bot. No se recomienda eliminar los
archivos hasta confirmar `.ping`, `.menu`, `.list` y comandos de grupo durante varios
reinicios.

## Procedimiento para futuras actualizaciones

### Actualizar el repositorio local

```bash
git fetch upstream --prune
git merge upstream/master
```

Resolver únicamente conflictos reales. Los archivos personalizados que deben
conservarse son:

```text
lib/runtimeCompatibility.js
plugins/zzz_lidCompatibility.js
plugins/lmstudio.js
plugins/sorteos.js
```

Y las modificaciones pequeñas de:

```text
index.js
config.js
```

Antes de publicar:

```bash
node --check index.js
node --check config.js
node --check lib/runtimeCompatibility.js
node --check plugins/zzz_lidCompatibility.js
node --check plugins/lmstudio.js
node --check plugins/sorteos.js
git diff --check
```

Publicar la rama actualizada:

```bash
git push origin master
```

### Actualizar producción

El bot debe estar detenido antes de modificar sus archivos:

```bash
pm2 stop levanter
cd /home/joel/levanterWhatsappBot
git fetch https://github.com/Tarkiin/levanterWhatsappBot.git master
git merge --ff-only FETCH_HEAD
yarn install --frozen-lockfile
pm2 start levanter
pm2 save
```

La instalación productiva utiliza un remoto Git local fijado. Tras una actualización
manual validada, ese remoto también debe avanzar al nuevo commit:

```bash
git push origin master
```

No se debe ejecutar `.update` ni reemplazar el directorio con un clon oficial puro,
porque eso eliminaría la compatibilidad y los plugins personalizados.

## Archivos que no deben publicarse

Los siguientes archivos contienen sesión, configuración o datos dinámicos y deben
permanecer ignorados por Git:

```text
config.env
database.db
messages.db
lib/db/sorteos.json
eplugins/
```

Nunca se deben incluir en capturas, commits o logs públicos:

- `SESSION_ID`
- claves de API
- cookies
- números privados de `SUDO`
- contenido de las bases de datos

## Comprobación después de iniciar

### Estado del proceso

```bash
pm2 status levanter
pm2 describe levanter
```

Debe mostrar:

```text
status: online
version: 5.5.3 o posterior
script path: /home/joel/levanterWhatsappBot
restarts: sin incrementos inesperados
```

### Pruebas funcionales mínimas

Realizar estas pruebas desde un usuario configurado en `SUDO`:

```text
.ping    -> valida recepción y respuesta básica
.menu    -> valida el contexto completo de comandos
.list    -> valida la lista de plugins
.shelp   -> valida el plugin personalizado de sorteos
.ia hola -> valida LM Studio, si su servidor está encendido
```

También se debe probar al menos un comando desde un grupo para verificar la
normalización de `participantAlt`.

### Confirmar el commit desplegado

```bash
cd /home/joel/levanterWhatsappBot
git rev-parse HEAD
git status --short --branch
```

Los únicos archivos sin seguimiento esperados en producción son datos dinámicos como
`eplugins/` y `lib/db/sorteos.json`.

## Diagnóstico rápido

### Inicia pero no responde a ningún comando

1. Confirmar que `LID_COMPATIBILITY` no está establecido en `false`.
2. Confirmar que el usuario aparece en `SUDO`.
3. Confirmar que existen `lib/runtimeCompatibility.js` y
   `plugins/zzz_lidCompatibility.js`.
4. Confirmar que PM2 apunta a `/home/joel/levanterWhatsappBot`.
5. Confirmar que producción está en el mismo commit que GitHub.
6. Revisar `pm2 logs levanter --lines 100 --nostream`.

### `.ping` funciona, pero `.menu` o `.list` fallan

Revisar que el puente pase el tercer argumento `context` al callback y que contenga
`commands`, `PREFIX`, `VERSION` y `pluginsCount`.

### Respuestas duplicadas

Una versión oficial podría haber añadido compatibilidad nativa. Establecer
temporalmente:

```env
LID_COMPATIBILITY="false"
```

Reiniciar y repetir todas las pruebas antes de retirar la capa versionada.

### LM Studio no responde

El plugin utiliza el servidor configurado en `plugins/lmstudio.js`. Comprobar:

- LM Studio está iniciado.
- El servidor API escucha en el puerto configurado.
- Está habilitado el acceso desde la red local, no solo desde `127.0.0.1`.
- El firewall de Windows permite la conexión desde Ubuntu.
- El modelo configurado está cargado.

Este problema no afecta a `.ping`, `.menu` ni al resto de Levanter.

### Un plugin externo no se instala

Los plugins externos dependen de la red y pueden fallar con `ETIMEDOUT`. Esperar y
reiniciar de forma controlada. Un fallo aislado de un plugin externo no debe
confundirse con el problema LID.

## Rollback

Existe una copia de la instalación anterior en:

```text
/home/joel/levanterWhatsappBot-backup-5.5.2
```

También existe un respaldo de configuración y bases creado durante la migración:

```text
/home/joel/levanter-migration-backup-20260620
```

Antes de cualquier rollback:

```bash
pm2 stop levanter
```

No se deben ejecutar simultáneamente dos instancias con la misma sesión de WhatsApp,
porque provocaría cierres forzados de sesión y resultados de diagnóstico engañosos.

## Resumen

El problema no era una desconexión de WhatsApp ni un fallo de PM2. Los mensajes sí
llegaban, pero el formato LID y el valor `fromMe: false` hacían que Levanter los
descartara antes de ejecutar los plugins. La solución normaliza los JID, autoriza
exclusivamente a los remitentes SUDO y reutiliza los callbacks originales con su
contexto completo.

Al estar integrada y versionada en el fork, la corrección puede conservarse mediante
fusiones Git normales y no necesita volver a aplicarse manualmente después de cada
actualización.
