const test = require('node:test')
const assert = require('node:assert/strict')
const {
  analyzeRouteQuestion,
  extractClientSearch,
  extractPostalCodes,
  formatDestinationAnswer,
  formatRoutesForWhatsApp,
  getConfig,
  lmStudioUnavailableMessage,
  looksLikeAnimalDescription,
  matchesAnimalQuantity,
  normalize,
  sanitizeWhatsApp,
} = require('../animalesExpressService')

test('normaliza acentos y puntuación', () => {
  assert.equal(normalize('  José Luís / Málaga  '), 'jose luis malaga')
})

test('extrae códigos postales españoles conservando ceros iniciales', () => {
  assert.deepEqual(extractPostalCodes('Recogida 06400 y entrega 46001'), ['06400', '46001'])
})

test('extrae el nombre de una consulta interna natural', () => {
  assert.equal(
    extractClientSearch('dime el número de "Juan Rodríguez" y a dónde va'),
    'Juan Rodríguez'
  )
  assert.equal(extractClientSearch('cliente Ana Pérez'), 'Ana Pérez')
  assert.equal(
    extractClientSearch('a dónde va el pedido de +34 647 28 98 12'),
    '647289812'
  )
  assert.equal(
    extractClientSearch('dime a donde se envian los 3 agapornis Ave agapornis'),
    '3 agapornis Ave agapornis'
  )
})

test('reconoce descripciones habituales de animales', () => {
  assert.equal(looksLikeAnimalDescription('Necesito llevar 2 perros'), true)
  assert.equal(looksLikeAnimalDescription('1 chihuahua'), true)
  assert.equal(looksLikeAnimalDescription('Mañana por la tarde'), false)
})

test('exige que coincida la cantidad cuando se busca por animales', () => {
  assert.equal(matchesAnimalQuantity('3 agapornis', '3', 'Ave agapornis'), true)
  assert.equal(matchesAnimalQuantity('6 agapornis', '3', 'Son 3 agapornis'), false)
  assert.equal(matchesAnimalQuantity('agapornis', '3', 'Son 3 agapornis'), true)
})

test('responde directamente el destino de un envío encontrado por animales', () => {
  const output = formatDestinationAnswer(
    'dime a donde se envian los 3 agapornis Ave agapornis',
    [
      {
        pickup: {},
        delivery: {
          town: 'Cambado',
          province: 'Pontevedra',
          postalCode: '36630',
          name: 'José Luis',
          phone: '600000000',
          date: '13/07/2026',
        },
        animals: '3 agapornis Ave agapornis',
      },
    ]
  )
  assert.match(output, /Cambado \/ Pontevedra \/ 36630/)
  assert.match(output, /3 agapornis/)
})

test('convierte encabezados Markdown al formato de WhatsApp', () => {
  assert.equal(
    sanitizeWhatsApp('## Título\n**texto**\n* primer dato'),
    '*Título*\n*texto*\n- primer dato'
  )
})

test('informa claramente cuando falla la IA sin revelar el proveedor', () => {
  const message = lmStudioUnavailableMessage()
  assert.match(message, /La IA no responde o devolvió un error/)
  assert.doesNotMatch(message, /Z\.AI/i)
})

test('aplica temperatura baja, cola y exclusiones configurables', () => {
  const previous = {
    AE_AI_TEMPERATURE: process.env.AE_AI_TEMPERATURE,
    AE_AI_MIN_INTERVAL_MS: process.env.AE_AI_MIN_INTERVAL_MS,
    AE_PRIVATE_EXCLUDED_NUMBERS: process.env.AE_PRIVATE_EXCLUDED_NUMBERS,
  }
  process.env.AE_AI_TEMPERATURE = '0.1'
  process.env.AE_AI_MIN_INTERVAL_MS = '5000'
  process.env.AE_PRIVATE_EXCLUDED_NUMBERS = '655000000, 666000000'
  try {
    const config = getConfig()
    assert.equal(config.aiTemperature, 0.1)
    assert.equal(config.aiMinIntervalMs, 5000)
    assert.deepEqual(config.privateExcludedNumbers, ['655000000', '666000000'])
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

const routes = [
  {
    'ID ruta': 'R1',
    Fecha: '14/07/2026',
    'Paradas ordenadas': 'Madrid → Zaragoza → Valencia',
    'Condiciones / notas': '—',
    Estado: 'Publicada',
  },
]

test('formatea las rutas para WhatsApp con iconos y paradas', () => {
  const output = formatRoutesForWhatsApp(routes)
  assert.match(output, /🐶🐯🐹/)
  assert.match(output, /🚛 \*RUTA DÍA 14 JULIO\*/)
  assert.match(output, /MADRID - ZARAGOZA - VALENCIA/)
})

test('comprueba el sentido de una ruta de forma determinista', () => {
  assert.match(analyzeRouteQuestion('Busco Madrid a Valencia', routes), /Rutas compatibles/)
  assert.match(analyzeRouteQuestion('Busco Valencia a Madrid', routes), /No existe una ruta/)
})
