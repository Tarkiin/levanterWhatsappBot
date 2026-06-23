const fs = require('fs')
const path = require('path')

const envPath = path.resolve(process.cwd(), 'config.env')
const updates = {
  AE_ENABLED: process.env.AE_SETUP_ENABLED || 'false',
  AE_LM_STUDIO_URL:
    process.env.AE_SETUP_LM_STUDIO_URL || 'http://192.168.1.33:1234/v1/chat/completions',
  AE_LM_STUDIO_MODEL: process.env.AE_SETUP_LM_STUDIO_MODEL || 'google/gemma-4-12b-qat',
  AE_GOOGLE_SHEET_ID:
    process.env.AE_SETUP_GOOGLE_SHEET_ID || '1CuanjkCBm1BVfiNch3Y8f-rzXMuncF4Kz26kvRg06OM',
  AE_GOOGLE_SERVICE_ACCOUNT_FILE: process.env.AE_SETUP_SERVICE_ACCOUNT_FILE || '',
  AE_STAFF_GROUPS: process.env.AE_SETUP_STAFF_GROUPS || '',
}

const existing = fs.readFileSync(envPath, 'utf8')
const keys = new Set(Object.keys(updates))
const keptLines = existing
  .split(/\r?\n/)
  .filter((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/)
    return !match || !keys.has(match[1])
  })

const quote = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const block = [
  '',
  '# AnimalesExpress',
  ...Object.entries(updates).map(([key, value]) => `${key}=${quote(value)}`),
  '',
]

fs.writeFileSync(envPath, [...keptLines, ...block].join('\n'), 'utf8')
console.log('Configuración de AnimalesExpress actualizada; AE_ENABLED=' + updates.AE_ENABLED)
