require('dotenv').config()
const path = require('path')
const express = require('express')
const cors = require('cors')
const mysql = require('mysql2/promise')
const crypto = require('crypto')
const bcrypt = require('bcryptjs')
const fs = require('fs')

const app = express()
app.set('trust proxy', 1)
const USER_ACCESS_LOG_PATH = path.resolve(__dirname, 'lista de usuarios.json')

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || '',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || '',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
}

const CAJA_BASE_INICIAL = 100000

async function ensureSchema() {
  const createVentas = `
    CREATE TABLE IF NOT EXISTS web_ventas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cliente_nombre VARCHAR(255),
      metodo_pago VARCHAR(32),
      total INT,
      fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;
  `
  const createItems = `
    CREATE TABLE IF NOT EXISTS web_venta_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      venta_id INT,
      descripcion VARCHAR(255),
      cantidad INT,
      valor_unitario INT,
      valor_total INT
    ) ENGINE=InnoDB;
  `
  const createProgramados = `
    CREATE TABLE IF NOT EXISTS pedidos_programados (
      id VARCHAR(50) PRIMARY KEY,
      consecutivo VARCHAR(50),
      cliente_nombre VARCHAR(255),
      cliente_data TEXT,
      items TEXT,
      total INT,
      fecha VARCHAR(20),
      hora VARCHAR(20),
      estado VARCHAR(50),
      transporte TEXT,
      tipo_pago VARCHAR(50),
      metodo_pago VARCHAR(50),
      punto_venta VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;
  `
  const createCajaEgresos = `
    CREATE TABLE IF NOT EXISTS caja_egresos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      usuario_id INT NOT NULL,
      valor INT NOT NULL,
      justificacion VARCHAR(255) NOT NULL,
      eliminado TINYINT(1) NOT NULL DEFAULT 0,
      eliminado_por INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      eliminado_at TIMESTAMP NULL DEFAULT NULL
    ) ENGINE=InnoDB;
  `
  const createVentasDetalle = `
    CREATE TABLE IF NOT EXISTS ventas_detalle (
      id INT AUTO_INCREMENT PRIMARY KEY,
      venta_id BIGINT NOT NULL,
      producto_id INT NULL,
      descripcion VARCHAR(255) NOT NULL,
      cantidad DECIMAL(14,2) NOT NULL DEFAULT 0,
      precio_unitario DECIMAL(14,2) NOT NULL DEFAULT 0,
      discount_rate DECIMAL(10,2) NOT NULL DEFAULT 0,
      subtotal DECIMAL(14,2) NOT NULL DEFAULT 0,
      valor_total DECIMAL(14,2) NOT NULL DEFAULT 0,
      factus_code_reference VARCHAR(120) NULL,
      factus_unit_measure_code VARCHAR(32) NULL,
      factus_standard_code VARCHAR(64) NULL,
      factus_tax_code VARCHAR(32) NULL,
      factus_tax_rate DECIMAL(10,2) NULL,
      factus_is_excluded TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ventas_detalle_venta_id (venta_id),
      INDEX idx_ventas_detalle_producto_id (producto_id)
    ) ENGINE=InnoDB;
  `
  const createVentasPaymentDetails = `
    CREATE TABLE IF NOT EXISTS ventas_payment_details (
      id INT AUTO_INCREMENT PRIMARY KEY,
      venta_id BIGINT NOT NULL,
      payment_form VARCHAR(32) NOT NULL,
      payment_method_code VARCHAR(32) NOT NULL,
      amount DECIMAL(14,2) NOT NULL DEFAULT 0,
      due_date DATE NULL,
      reference_code VARCHAR(120) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ventas_payment_details_venta_id (venta_id)
    ) ENGINE=InnoDB;
  `
  const createFactusDocumentos = `
    CREATE TABLE IF NOT EXISTS factus_documentos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      venta_id BIGINT NOT NULL,
      environment VARCHAR(32) NOT NULL DEFAULT 'sandbox',
      reference_code VARCHAR(120) NOT NULL,
      factus_bill_id BIGINT NULL,
      number VARCHAR(64) NULL,
      prefix VARCHAR(16) NULL,
      cufe VARCHAR(255) NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      is_validated TINYINT(1) NOT NULL DEFAULT 0,
      request_payload_json LONGTEXT NULL,
      response_json LONGTEXT NULL,
      error_message TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      validated_at TIMESTAMP NULL DEFAULT NULL,
      last_sync_at TIMESTAMP NULL DEFAULT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_factus_documentos_venta_id (venta_id),
      UNIQUE KEY uq_factus_documentos_reference_code (reference_code)
    ) ENGINE=InnoDB;
  `
  await pool.query(createVentas)
  await pool.query(createItems)
  await pool.query(createProgramados)
  await pool.query(createCajaEgresos)
  await pool.query(createVentasDetalle)
  await pool.query(createVentasPaymentDetails)
  await pool.query(createFactusDocumentos)

  const ventasColumns = await getTableColumns('ventas')
  const ventasColumnSet = new Set(ventasColumns.map((column) => String(column || '').toLowerCase()))
  const missingVentasColumns = [
    {
      name: 'subtotal',
      sql: 'ALTER TABLE ventas ADD COLUMN subtotal DECIMAL(14,2) NULL DEFAULT NULL'
    },
    {
      name: 'total_discount',
      sql: 'ALTER TABLE ventas ADD COLUMN total_discount DECIMAL(14,2) NOT NULL DEFAULT 0'
    },
    {
      name: 'total_tax',
      sql: 'ALTER TABLE ventas ADD COLUMN total_tax DECIMAL(14,2) NOT NULL DEFAULT 0'
    },
    {
      name: 'observation',
      sql: 'ALTER TABLE ventas ADD COLUMN observation TEXT NULL'
    },
    {
      name: 'factura_electronica',
      sql: 'ALTER TABLE ventas ADD COLUMN factura_electronica TINYINT(1) NOT NULL DEFAULT 0'
    },
    {
      name: 'electronic_status',
      sql: "ALTER TABLE ventas ADD COLUMN electronic_status VARCHAR(32) NULL DEFAULT NULL"
    },
    {
      name: 'factus_number',
      sql: "ALTER TABLE ventas ADD COLUMN factus_number VARCHAR(64) NULL DEFAULT NULL"
    }
  ]

  for (const column of missingVentasColumns) {
    if (!ventasColumnSet.has(column.name.toLowerCase())) {
      await pool.query(column.sql)
    }
  }

  const factusColumns = await getTableColumns('factus_documentos')
  const factusColumnSet = new Set(factusColumns.map((column) => String(column || '').toLowerCase()))
  const missingFactusColumns = [
    {
      name: 'factus_bill_id',
      sql: 'ALTER TABLE factus_documentos ADD COLUMN factus_bill_id BIGINT NULL DEFAULT NULL'
    },
    {
      name: 'number',
      sql: 'ALTER TABLE factus_documentos ADD COLUMN number VARCHAR(64) NULL DEFAULT NULL'
    },
    {
      name: 'prefix',
      sql: 'ALTER TABLE factus_documentos ADD COLUMN prefix VARCHAR(16) NULL DEFAULT NULL'
    },
    {
      name: 'cufe',
      sql: 'ALTER TABLE factus_documentos ADD COLUMN cufe VARCHAR(255) NULL DEFAULT NULL'
    },
    {
      name: 'validated_at',
      sql: 'ALTER TABLE factus_documentos ADD COLUMN validated_at TIMESTAMP NULL DEFAULT NULL'
    },
    {
      name: 'last_sync_at',
      sql: 'ALTER TABLE factus_documentos ADD COLUMN last_sync_at TIMESTAMP NULL DEFAULT NULL'
    },
    {
      name: 'response_json',
      sql: 'ALTER TABLE factus_documentos ADD COLUMN response_json LONGTEXT NULL DEFAULT NULL'
    }
  ]

  for (const column of missingFactusColumns) {
    if (!factusColumnSet.has(column.name.toLowerCase())) {
      await pool.query(column.sql)
    }
  }
}

let pool
async function createAndTestPool(config, label) {
  const testPool = mysql.createPool(config)
  try {
    const conn = await testPool.getConnection()
    await conn.ping()
    conn.release()
    console.log(`Conexión a MySQL inicializada correctamente (${label})`)
    pool = testPool
    await ensureSchema()
    return true
  } catch (err) {
    console.error(`Error inicializando conexión MySQL (${label}):`, err.message)
    try {
      await testPool.end()
    } catch {}
    return false
  }
}

async function initPool() {
  const okPrimary = await createAndTestPool(DB_CONFIG, 'config principal')
  if (okPrimary) return
  if (DB_CONFIG.host !== 'localhost' && DB_CONFIG.host !== '127.0.0.1') {
    const fallbackConfig = { ...DB_CONFIG, host: 'localhost' }
    await createAndTestPool(fallbackConfig, 'fallback localhost')
  }
}

function getStoredPassword(user) {
  return String(
    user?.contrasena ||
    user?.clave ||
    user?.password ||
    user?.pass ||
    ''
  ).trim()
}

async function passwordMatchesUser(user, contrasena) {
  const storedPass = getStoredPassword(user)
  const inputPass = String(contrasena || '').trim()
  let okPass = storedPass === inputPass

  if (!okPass) {
    if (storedPass.startsWith('$2a$') || storedPass.startsWith('$2b$') || storedPass.startsWith('$2y$')) {
      try {
        okPass = await bcrypt.compare(inputPass, storedPass)
      } catch {}
    }
  }

  if (!okPass) {
    const hex = storedPass.toLowerCase()
    const onlyHex = /^[a-f0-9]+$/.test(hex)
    if (onlyHex) {
      const len = hex.length
      if (len === 32) {
        const md5 = crypto.createHash('md5').update(inputPass).digest('hex')
        okPass = md5 === hex
      } else if (len === 40) {
        const sha1 = crypto.createHash('sha1').update(inputPass).digest('hex')
        okPass = sha1 === hex
      } else if (len === 64) {
        const sha256 = crypto.createHash('sha256').update(inputPass).digest('hex')
        okPass = sha256 === hex
      }
    }
  }

  return !!storedPass && !!okPass
}

async function getUsuarioById(usuarioId, conn = pool) {
  const [rows] = await conn.query(
    'SELECT * FROM usuarios WHERE id_usuario = ? LIMIT 1',
    [Number(usuarioId)]
  )
  return rows && rows.length ? rows[0] : null
}

async function isAdminUser(usuarioId, conn = pool) {
  const user = await getUsuarioById(usuarioId, conn)
  return String(user?.rol || '').toLowerCase() === 'admin'
}

async function getTableColumns(tableName, conn = pool) {
  const [rows] = await conn.query(`SHOW COLUMNS FROM \`${tableName}\``)
  return (rows || []).map((row) => String(row.Field || '').trim()).filter(Boolean)
}

function pickFirstExistingColumn(columns, candidates) {
  const columnSet = new Set((columns || []).map((column) => String(column || '').toLowerCase()))
  for (const candidate of candidates) {
    if (columnSet.has(String(candidate).toLowerCase())) {
      return candidate
    }
  }
  return null
}

function parseBooleanLike(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'si' || normalized === 'sí'
}

function normalizeVentaDetalleItems(body) {
  if (Array.isArray(body?.items) && body.items.length) {
    return body.items
  }
  if (Array.isArray(body?.venta_detalle) && body.venta_detalle.length) {
    return body.venta_detalle
  }
  return []
}

function normalizeVentaPaymentDetails(body) {
  if (Array.isArray(body?.payment_details) && body.payment_details.length) {
    return body.payment_details
  }
  if (Array.isArray(body?.facturacion?.pagos) && body.facturacion.pagos.length) {
    return body.facturacion.pagos
  }
  return []
}

function toSafeJson(value) {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return JSON.stringify({ serialization_error: true })
  }
}

function normalizeVentaNumeric(value, fallback = 0) {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : fallback
}

function normalizeVentaDate(value) {
  const text = String(value || '').trim()
  if (!text) return null
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : null
}

function normalizeVentaTime(value) {
  const text = String(value || '').trim()
  if (!text) return null
  const match = text.match(/(\d{2}:\d{2}:\d{2})$/)
  return match ? match[1] : null
}

function formatFactusDecimal(value, decimals = 2) {
  return normalizeVentaNumeric(value, 0).toFixed(decimals)
}

function removeEmptyObjectFields(input) {
  const output = {}
  Object.entries(input || {}).forEach(([key, value]) => {
    if (value === null || value === undefined) return
    if (typeof value === 'string' && value.trim() === '') return
    if (Array.isArray(value) && value.length === 0) return
    output[key] = value
  })
  return output
}

function getFactusEnvironmentName() {
  const raw = String(process.env.FACTUS_ENVIRONMENT || process.env.FACTUS_API_ENVIRONMENT || 'sandbox').trim().toLowerCase()
  return raw === 'production' ? 'production' : 'sandbox'
}

function getFactusApiBase() {
  return getFactusEnvironmentName() === 'production'
    ? 'https://api.factus.com.co'
    : 'https://api-sandbox.factus.com.co'
}

function ensureFactusConfigured() {
  const required = [
    ['FACTUS_CLIENT_ID', process.env.FACTUS_CLIENT_ID],
    ['FACTUS_CLIENT_SECRET', process.env.FACTUS_CLIENT_SECRET],
    ['FACTUS_USERNAME', process.env.FACTUS_USERNAME],
    ['FACTUS_PASSWORD', process.env.FACTUS_PASSWORD]
  ]
  const missing = required
    .filter(([, value]) => String(value || '').trim() === '')
    .map(([name]) => name)

  if (missing.length > 0) {
    throw new Error(`Factus no está configurado. Faltan variables: ${missing.join(', ')}`)
  }
}

let factusTokenCache = {
  accessToken: null,
  expiresAt: 0
}

function extractFactusErrorMessage(payload, fallback = 'No se pudo procesar la solicitud en Factus.') {
  if (!payload) return fallback
  if (typeof payload === 'string' && payload.trim()) return payload.trim()
  if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message.trim()
  if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error.trim()
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    return payload.errors.map((item) => {
      if (typeof item === 'string') return item
      if (typeof item?.message === 'string') return item.message
      return JSON.stringify(item)
    }).join(' | ')
  }
  return fallback
}

async function getFactusAccessToken(forceRefresh = false) {
  ensureFactusConfigured()
  if (!forceRefresh && factusTokenCache.accessToken && Date.now() < factusTokenCache.expiresAt - 60000) {
    return factusTokenCache.accessToken
  }

  const form = new URLSearchParams()
  form.set('grant_type', 'password')
  form.set('client_id', String(process.env.FACTUS_CLIENT_ID || '').trim())
  form.set('client_secret', String(process.env.FACTUS_CLIENT_SECRET || '').trim())
  form.set('username', String(process.env.FACTUS_USERNAME || '').trim())
  form.set('password', String(process.env.FACTUS_PASSWORD || '').trim())

  const response = await fetch(`${getFactusApiBase()}/oauth/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || !data?.access_token) {
    throw new Error(extractFactusErrorMessage(data, 'No se pudo autenticar contra Factus.'))
  }

  const expiresIn = Number(data.expires_in || 3600)
  factusTokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn * 1000 : 3600000)
  }
  return factusTokenCache.accessToken
}

async function factusApiRequest(pathname, options = {}) {
  const {
    method = 'GET',
    body,
    headers = {},
    retryAuth = true
  } = options

  const token = await getFactusAccessToken(false)
  const response = await fetch(`${getFactusApiBase()}${pathname}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })

  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '')

  if (response.status === 401 && retryAuth) {
    await getFactusAccessToken(true)
    return factusApiRequest(pathname, { method, body, headers, retryAuth: false })
  }

  if (!response.ok) {
    const error = new Error(extractFactusErrorMessage(payload))
    error.statusCode = response.status
    error.payload = payload
    throw error
  }

  return payload
}

function parseFactusNumberingResponse(payload) {
  if (Array.isArray(payload?.data)) return payload.data
  if (Array.isArray(payload?.data?.data)) return payload.data.data
  if (Array.isArray(payload)) return payload
  return []
}

async function getFactusActiveNumberingRange() {
  ensureFactusConfigured()
  const configuredId = Number(process.env.FACTUS_NUMBERING_RANGE_ID || 0)
  const params = new URLSearchParams()
  params.set('filter[document]', '01')
  params.set('filter[is_active]', '1')
  if (configuredId > 0) {
    params.set('filter[id]', String(configuredId))
  }

  const payload = await factusApiRequest(`/v2/numbering-ranges?${params.toString()}`)
  const ranges = parseFactusNumberingResponse(payload)
  const activeRange = ranges.find((range) => Number(range?.is_active || 0) === 1 && Number(range?.is_expired || 0) === 0)
    || ranges[0]

  if (!activeRange?.id) {
    throw new Error('Factus no devolvió un rango de numeración activo para factura electrónica.')
  }

  return {
    id: Number(activeRange.id),
    prefix: String(activeRange.prefix || '').trim(),
    current: String(activeRange.current || '').trim(),
    preview_number: `${String(activeRange.prefix || '').trim()}${String(activeRange.current || '').trim()}`,
    raw: activeRange
  }
}

function buildFactusReferenceCode(body, ventaId) {
  const candidate = String(
    body?.facturacion?.reference_code
    || body?.reference_code
    || `VENTA-${ventaId}`
  ).trim()
  return candidate || `VENTA-${ventaId}`
}

async function getClienteForFactus(clienteId, conn = pool) {
  const columns = await getTableColumns('clientes', conn)
  const columnSet = new Set(columns.map((column) => String(column || '').toLowerCase()))
  const selectField = (field, alias = field) => {
    if (columnSet.has(field.toLowerCase())) {
      return field === alias ? `\`${field}\`` : `\`${field}\` AS \`${alias}\``
    }
    return `NULL AS \`${alias}\``
  }

  const [rows] = await conn.query(
    `SELECT
       \`id_cliente\` AS id,
       \`nombre\`,
       \`nit_cc\`,
       \`telefono\`,
       \`direccion\`,
       ${selectField('identification')}
       , ${selectField('identification_document_code')}
       , ${selectField('legal_organization_code')}
       , ${selectField('tribute_code')}
       , ${selectField('email')}
       , ${selectField('company')}
       , ${selectField('trade_name')}
       , ${selectField('names')}
       , ${selectField('dv')}
       , ${selectField('municipality_code')}
       , ${selectField('country_code')}
     FROM clientes
     WHERE id_cliente = ?
     LIMIT 1`,
    [Number(clienteId)]
  )

  return rows && rows.length ? rows[0] : null
}

function mapFactusPaymentForm(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === '2' || normalized === 'credito' || normalized === 'crédito') return '2'
  return '1'
}

function mapFactusPaymentMethodCode(value, paymentForm) {
  const normalized = String(value || '').trim().toLowerCase()
  if (/^\d+$/.test(normalized)) return normalized
  if (normalized === 'cash' || normalized === 'efectivo') return '10'
  if (normalized === 'card' || normalized === 'tarjeta') return '48'
  if (normalized === 'qr') return '42'
  if (normalized === 'credit' || paymentForm === '2') return '1'
  return '10'
}

function buildFactusCustomerPayload(cliente) {
  if (!cliente) {
    throw new Error('No se encontró el cliente a facturar en la base de datos.')
  }

  const legalOrganizationCode = String(cliente.legal_organization_code || '').trim()
  const identification = String(cliente.identification || cliente.nit_cc || '').trim()
  const company = String(cliente.company || cliente.trade_name || '').trim()
  const names = String(cliente.names || cliente.nombre || '').trim()
  const payload = removeEmptyObjectFields({
    identification_document_code: String(cliente.identification_document_code || '').trim(),
    identification,
    dv: String(cliente.dv || '').trim() || undefined,
    legal_organization_code: legalOrganizationCode,
    tribute_code: String(cliente.tribute_code || 'ZZ').trim() || 'ZZ',
    company: legalOrganizationCode === '1' ? (company || names) : company,
    trade_name: String(cliente.trade_name || '').trim(),
    names: legalOrganizationCode === '1' ? (names || company) : (names || company),
    address: String(cliente.direccion || '').trim(),
    email: String(cliente.email || '').trim(),
    phone: String(cliente.telefono || '').trim(),
    country_code: String(cliente.country_code || '').trim() || undefined,
    municipality_code: String(cliente.municipality_code || '').trim() || undefined
  })

  if (!payload.identification_document_code || !payload.identification || !payload.legal_organization_code || !payload.address || !payload.email) {
    throw new Error('El cliente no tiene todos los datos requeridos para construir la factura electrónica en Factus.')
  }

  if (payload.legal_organization_code === '1' && !payload.company) {
    payload.company = names || identification
  }
  if (payload.legal_organization_code !== '1' && !payload.names) {
    payload.names = company || identification
  }

  return payload
}

function buildFactusItemsPayload(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('No hay items válidos para enviar a Factus.')
  }

  return items.map((item) => {
    const quantity = normalizeVentaNumeric(item.cantidad, 0)
    const subtotal = normalizeVentaNumeric(item.subtotal, 0)
    const rawUnitPrice = normalizeVentaNumeric(item.precio_unitario ?? item.valor_unitario, 0)
    const unitPrice = quantity > 0 && subtotal > 0 ? subtotal / quantity : rawUnitPrice
    const factusIsExcluded = parseBooleanLike(item.factus_is_excluded)
    const taxes = factusIsExcluded
      ? []
      : [{
          code: String(item.factus_tax_code || '').trim(),
          rate: formatFactusDecimal(item.factus_tax_rate ?? 0)
        }]

    if (!String(item.factus_code_reference || '').trim() || !String(item.descripcion || '').trim() || !String(item.factus_unit_measure_code || '').trim() || !String(item.factus_standard_code || '').trim()) {
      throw new Error('Hay productos sin metadatos Factus completos para emitir la factura electrónica.')
    }

    if (!factusIsExcluded && (!taxes[0]?.code || normalizeVentaNumeric(item.factus_tax_rate, -1) < 0)) {
      throw new Error('Hay productos gravados sin impuesto o tarifa válida para Factus.')
    }

    return removeEmptyObjectFields({
      code_reference: String(item.factus_code_reference || '').trim(),
      name: String(item.descripcion || '').trim(),
      quantity: formatFactusDecimal(quantity),
      discount_rate: formatFactusDecimal(item.discount_rate ?? 0),
      price: formatFactusDecimal(unitPrice),
      unit_measure_code: String(item.factus_unit_measure_code || '').trim(),
      standard_code: String(item.factus_standard_code || '').trim(),
      taxes,
      withholding_taxes: []
    })
  })
}

function buildFactusBillPayload({ body, ventaId, cliente, items, paymentDetails, numberingRange, referenceCode }) {
  const paymentForm = mapFactusPaymentForm(paymentDetails[0]?.payment_form || body?.tipo_pago)
  const factusPaymentDetails = paymentDetails.map((pago) => removeEmptyObjectFields({
    payment_form: mapFactusPaymentForm(pago.payment_form || body?.tipo_pago),
    payment_method_code: mapFactusPaymentMethodCode(pago.payment_method_code || body?.forma_pago, paymentForm),
    amount: formatFactusDecimal(pago.amount ?? body?.total ?? 0),
    due_date: mapFactusPaymentForm(pago.payment_form || body?.tipo_pago) === '2'
      ? (normalizeVentaDate(pago.due_date || body?.fecha) || normalizeVentaDate(body?.fecha))
      : undefined,
    reference_code: pago.reference_code ? String(pago.reference_code).trim() : undefined
  }))

  const payload = removeEmptyObjectFields({
    reference_code: referenceCode,
    document: '01',
    numbering_range_id: numberingRange?.id || undefined,
    operation_type: String(body?.operation_type || '10'),
    send_email: parseBooleanLike(process.env.FACTUS_SEND_EMAIL || 'false'),
    observation: String(body?.observation || '').trim() || undefined,
    created_time: normalizeVentaTime(body?.fecha) || undefined,
    customer: buildFactusCustomerPayload(cliente),
    payment_details: factusPaymentDetails,
    items: buildFactusItemsPayload(items)
  })

  if (!Array.isArray(payload.payment_details) || payload.payment_details.length === 0) {
    throw new Error('La venta no tiene métodos de pago válidos para Factus.')
  }

  return payload
}

function parseFactusInvoiceResult(payload) {
  const data = payload?.data || payload
  const bill = data?.bill || data
  const number = String(data?.number || bill?.number || '').trim()
  const prefix = String(data?.prefix || bill?.prefix || '').trim()
  const cufe = String(data?.cufe || bill?.cufe || '').trim()
  const qr = String(data?.qr || bill?.qr || data?.qr_url || '').trim()
  const documentUrl = String(
    data?.document_url
    || bill?.document_url
    || data?.pdf_url
    || bill?.pdf_url
    || ''
  ).trim()
  const urls = removeEmptyObjectFields({
    document_url: documentUrl || undefined,
    pdf_url: String(data?.pdf_url || bill?.pdf_url || '').trim() || undefined,
    xml_url: String(data?.xml_url || bill?.xml_url || '').trim() || undefined,
    zip_url: String(data?.zip_url || bill?.zip_url || '').trim() || undefined,
    qr_url: qr || undefined
  })
  const referenceCode = String(data?.reference_code || bill?.reference_code || '').trim()
  const validated = (
    typeof data?.is_validated === 'boolean' ? data.is_validated
      : typeof bill?.is_validated === 'boolean' ? bill.is_validated
        : parseBooleanLike(data?.is_validated ?? bill?.is_validated)
  )
  const status = String(data?.status_name || bill?.status_name || data?.status || bill?.status || '').trim() || 'validated'
  const billId = Number(data?.id || bill?.id || 0) || null

  return {
    bill_id: billId,
    number,
    prefix: prefix || (number ? number.replace(/\d+$/, '') : ''),
    cufe,
    qr,
    document_url: documentUrl,
    urls,
    reference_code: referenceCode,
    status,
    is_validated: validated,
    raw: payload
  }
}

async function updateFactusPersistedData(conn, ventaId, referenceCode, factusPayload, factusResponse) {
  const factus = parseFactusInvoiceResult(factusResponse)
  const statusText = String(factus.status || '').trim() || (factus.is_validated ? 'validated' : 'created')
  const responseWithDerivedUrls = {
    ...(factusResponse || {}),
    derived_urls: factus.urls || {}
  }

  await conn.query(
    `UPDATE ventas
     SET factus_number = ?, electronic_status = ?
     WHERE id_consecutivo = ?`,
    [
      factus.number || null,
      statusText,
      Number(ventaId)
    ]
  )

  await conn.query(
    `UPDATE factus_documentos
     SET
       factus_bill_id = ?,
       number = ?,
       prefix = ?,
       cufe = ?,
       status = ?,
       is_validated = ?,
       request_payload_json = ?,
       response_json = ?,
       error_message = NULL,
       validated_at = ?,
       last_sync_at = NOW()
     WHERE venta_id = ? AND reference_code = ?`,
    [
      factus.bill_id,
      factus.number || null,
      factus.prefix || null,
      factus.cufe || null,
      statusText,
      factus.is_validated ? 1 : 0,
      toSafeJson(factusPayload),
      toSafeJson(responseWithDerivedUrls),
      factus.is_validated ? new Date() : null,
      Number(ventaId),
      referenceCode
    ]
  )

  return factus
}

async function insertVentaCabecera(conn, payload) {
  const ventasColumns = await getTableColumns('ventas', conn)
  const columnSet = new Set(ventasColumns.map((column) => String(column || '').toLowerCase()))
  const insertColumns = [
    'id_consecutivo',
    'usuario_id',
    'cliente_id',
    'total',
    'tipo_pago',
    'forma_pago',
    'punto_venta'
  ]
  const insertValues = [
    Number(payload.id_consecutivo),
    Number(payload.usuario_id),
    Number(payload.cliente_id),
    normalizeVentaNumeric(payload.total, 0),
    String(payload.tipo_pago || 'CONTADO'),
    String(payload.forma_pago || ''),
    String(payload.punto_venta || 'ferreteria')
  ]

  const optionalColumns = [
    ['subtotal', payload.subtotal ?? null],
    ['total_discount', payload.total_discount ?? 0],
    ['total_tax', payload.total_tax ?? 0],
    ['observation', payload.observation || null],
    ['factura_electronica', payload.factura_electronica ? 1 : 0],
    ['electronic_status', payload.electronic_status || null],
    ['factus_number', payload.factus_number || null]
  ]

  for (const [column, value] of optionalColumns) {
    if (columnSet.has(column.toLowerCase())) {
      insertColumns.push(column)
      insertValues.push(value)
    }
  }

  const placeholders = insertColumns.map(() => '?').join(', ')
  await conn.query(
    `INSERT INTO ventas (${insertColumns.join(', ')}) VALUES (${placeholders})`,
    insertValues
  )
}

async function persistVentaElectronicaData(conn, body, ventaId, items, paymentDetails, options = {}) {
  const environment = String(process.env.FACTUS_ENVIRONMENT || process.env.FACTUS_API_ENVIRONMENT || 'sandbox').trim() || 'sandbox'
  const referenceCode = String(
    options.referenceCode
    || body?.facturacion?.reference_code
    || paymentDetails.find((pago) => String(pago?.reference_code || '').trim())?.reference_code
    || `VENTA-${ventaId}`
  ).trim()

  for (const rawItem of items) {
    const item = rawItem || {}
    await conn.query(
      `INSERT INTO ventas_detalle (
        venta_id,
        producto_id,
        descripcion,
        cantidad,
        precio_unitario,
        discount_rate,
        subtotal,
        valor_total,
        factus_code_reference,
        factus_unit_measure_code,
        factus_standard_code,
        factus_tax_code,
        factus_tax_rate,
        factus_is_excluded
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(ventaId),
        item.producto_id || item.id_producto ? Number(item.producto_id || item.id_producto) : null,
        String(item.descripcion || ''),
        normalizeVentaNumeric(item.cantidad, 0),
        normalizeVentaNumeric(item.precio_unitario ?? item.valor_unitario, 0),
        normalizeVentaNumeric(item.discount_rate, 0),
        normalizeVentaNumeric(item.subtotal, 0),
        normalizeVentaNumeric(item.valor_total ?? item.subtotal, 0),
        item.factus_code_reference ? String(item.factus_code_reference) : null,
        item.factus_unit_measure_code ? String(item.factus_unit_measure_code) : null,
        item.factus_standard_code ? String(item.factus_standard_code) : null,
        item.factus_tax_code ? String(item.factus_tax_code) : null,
        item.factus_tax_rate === null || item.factus_tax_rate === undefined ? null : normalizeVentaNumeric(item.factus_tax_rate, 0),
        parseBooleanLike(item.factus_is_excluded) ? 1 : 0
      ]
    )
  }

  for (const rawPago of paymentDetails) {
    const pago = rawPago || {}
    await conn.query(
      `INSERT INTO ventas_payment_details (
        venta_id,
        payment_form,
        payment_method_code,
        amount,
        due_date,
        reference_code
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        Number(ventaId),
        String(pago.payment_form || 'contado'),
        String(pago.payment_method_code || 'cash'),
        normalizeVentaNumeric(pago.amount ?? body.total, 0),
        normalizeVentaDate(pago.due_date),
        pago.reference_code ? String(pago.reference_code) : null
      ]
    )
  }

  await conn.query(
    `INSERT INTO factus_documentos (
      venta_id,
      environment,
      reference_code,
      status,
      is_validated,
      request_payload_json
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      Number(ventaId),
      environment,
      referenceCode,
      'pending',
      0,
      toSafeJson(body.facturacion || body)
    ]
  )

  return referenceCode
}

function buildClienteFacturacionStatus(cliente) {
  const displayName = String(
    cliente?.company ||
    cliente?.trade_name ||
    cliente?.names ||
    cliente?.nombre ||
    ''
  ).trim()

  const identification = String(
    cliente?.identification ||
    cliente?.nit_cc ||
    ''
  ).trim()

  const requiredFields = [
    { key: 'identification', label: 'Identificacion', value: identification },
    {
      key: 'identification_document_code',
      label: 'Tipo de documento',
      value: String(cliente?.identification_document_code || '').trim()
    },
    {
      key: 'legal_organization_code',
      label: 'Organizacion legal',
      value: String(cliente?.legal_organization_code || '').trim()
    },
    {
      key: 'tribute_code',
      label: 'Tributo',
      value: String(cliente?.tribute_code || '').trim()
    },
    {
      key: 'direccion',
      label: 'Direccion',
      value: String(cliente?.direccion || '').trim()
    },
    {
      key: 'email',
      label: 'Correo electronico',
      value: String(cliente?.email || '').trim()
    },
    {
      key: 'display_name',
      label: 'Nombre para facturacion',
      value: displayName
    }
  ]

  const missing_fields = requiredFields.filter((field) => !field.value).map((field) => field.key)
  const missing_labels = requiredFields.filter((field) => !field.value).map((field) => field.label)

  if (missing_fields.length === 0) {
    return {
      ready: true,
      missing_fields: [],
      missing_labels: [],
      message: 'Cliente apto para facturacion electronica.'
    }
  }

  return {
    ready: false,
    missing_fields,
    missing_labels,
    message: `Esta factura electronica no se puede realizar porque al cliente le faltan estos datos: ${missing_labels.join(', ')}`
  }
}

function enrichClienteWithFacturacion(cliente) {
  const facturacion = buildClienteFacturacionStatus(cliente)
  return {
    ...cliente,
    facturacion_electronica_completa: facturacion.ready,
    facturacion_campos_faltantes: facturacion.missing_fields,
    facturacion_mensaje: facturacion.message
  }
}

function hasProductoFacturacionValue(value) {
  if (value === null || value === undefined) return false
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return true
  return String(value).trim() !== ''
}

function normalizeProductoFactusExcluded(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'si' || normalized === 'sí'
}

function buildProductoFacturacionStatus(producto) {
  const factusIsExcluded = normalizeProductoFactusExcluded(producto?.factus_is_excluded)
  const requiredFields = [
    {
      key: 'factus_code_reference',
      label: 'Codigo de referencia del producto',
      value: producto?.factus_code_reference
    },
    {
      key: 'nombre',
      label: 'Nombre del producto',
      value: producto?.nombre
    },
    {
      key: 'precio_final',
      label: 'Precio del producto',
      value: producto?.precio_final
    },
    {
      key: 'factus_unit_measure_code',
      label: 'Unidad de medida Factus',
      value: producto?.factus_unit_measure_code
    },
    {
      key: 'factus_standard_code',
      label: 'Codigo estandar del producto',
      value: producto?.factus_standard_code
    },
    {
      key: 'factus_is_excluded',
      label: 'Configuracion fiscal del producto',
      value: producto?.factus_is_excluded
    }
  ]

  if (!factusIsExcluded) {
    requiredFields.push(
      {
        key: 'factus_tax_code',
        label: 'Impuesto del producto',
        value: producto?.factus_tax_code
      },
      {
        key: 'factus_tax_rate',
        label: 'Tarifa de impuesto del producto',
        value: producto?.factus_tax_rate
      }
    )
  }

  const missing_fields = requiredFields
    .filter((field) => !hasProductoFacturacionValue(field.value))
    .map((field) => field.key)
  const missing_labels = requiredFields
    .filter((field) => !hasProductoFacturacionValue(field.value))
    .map((field) => field.label)

  if (missing_fields.length === 0) {
    return {
      ready: true,
      missing_fields: [],
      missing_labels: [],
      message: 'Producto apto para facturacion electronica.'
    }
  }

  return {
    ready: false,
    missing_fields,
    missing_labels,
    message: `Esta factura electronica no se puede realizar porque al producto le faltan estos datos: ${missing_labels.join(', ')}`
  }
}

function enrichProductoWithFacturacion(producto) {
  const facturacion = buildProductoFacturacionStatus(producto)
  return {
    ...producto,
    facturacion_electronica_completa: facturacion.ready,
    facturacion_campos_faltantes: facturacion.missing_fields,
    facturacion_etiquetas_faltantes: facturacion.missing_labels,
    facturacion_mensaje: facturacion.message
  }
}

function buildProductoSelectFields(columns) {
  const columnSet = new Set((columns || []).map((column) => String(column || '').toLowerCase()))
  const baseFields = [
    '`id_producto` AS id',
    '`codigo_barras`',
    '`nombre`',
    '`stock`',
    '`precio_final`',
    '`precio_mayorista`',
    '`precio_3`',
    '`cantidad_precio_3`'
  ]
  const facturacionFields = [
    'factus_code_reference',
    'factus_unit_measure_code',
    'factus_standard_code',
    'factus_tax_code',
    'factus_tax_rate',
    'factus_is_excluded'
  ]

  for (const field of facturacionFields) {
    if (columnSet.has(field.toLowerCase())) {
      baseFields.push(`\`${field}\``)
    } else {
      baseFields.push(`NULL AS \`${field}\``)
    }
  }

  return baseFields.join(',\n         ')
}

async function appendUserAccessLog(entry) {
  let currentEntries = []

  try {
    const fileContent = await fs.promises.readFile(USER_ACCESS_LOG_PATH, 'utf8')
    const parsed = JSON.parse(fileContent)
    if (Array.isArray(parsed)) {
      currentEntries = parsed
    }
  } catch (err) {
    const missingFile = err?.code === 'ENOENT'
    if (!missingFile) {
      throw err
    }
  }

  currentEntries.push(entry)
  await fs.promises.writeFile(
    USER_ACCESS_LOG_PATH,
    JSON.stringify(currentEntries, null, 2),
    'utf8'
  )
}

async function getCajaResumen(conn = pool) {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const startStr = `${y}-${m}-${d} 00:00:00`
  const endStr = `${y}-${m}-${d} 23:59:59`

  const [[ventaRow]] = await conn.query(
    `SELECT COALESCE(SUM(total), 0) AS total_efectivo
     FROM ventas
     WHERE fecha >= ? AND fecha <= ?
       AND UPPER(TRIM(COALESCE(forma_pago, ''))) = 'EFECTIVO'
       AND LOWER(TRIM(COALESCE(punto_venta, 'ferreteria'))) = 'ferreteria'`,
    [startStr, endStr]
  )
  let egresoRow = { total_egresos: 0 }
  let egresos = []
  try {
    const [sumRows] = await conn.query(
      `SELECT COALESCE(SUM(valor), 0) AS total_egresos
       FROM caja_egresos
       WHERE eliminado = 0
         AND created_at >= ? AND created_at <= ?`,
      [startStr, endStr]
    )
    egresoRow = (sumRows && sumRows[0]) || egresoRow

    const [egresoRows] = await conn.query(
      `SELECT
          ce.id,
          ce.usuario_id,
          ce.valor,
          ce.justificacion,
          ce.created_at
        FROM caja_egresos ce
        WHERE ce.eliminado = 0
          AND ce.created_at >= ? AND ce.created_at <= ?
        ORDER BY ce.created_at DESC, ce.id DESC
        LIMIT 50`,
      [startStr, endStr]
    )

    egresos = (egresoRows || []).map(row => ({
      ...row,
      usuario_nombre: `Usuario ${row.usuario_id}`
    }))
  } catch (err) {
    const recoverable = ['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(err?.code)
    if (recoverable) {
      try {
        await conn.query(`
          CREATE TABLE IF NOT EXISTS caja_egresos (
            id INT AUTO_INCREMENT PRIMARY KEY,
            usuario_id INT NOT NULL,
            valor INT NOT NULL,
            justificacion VARCHAR(255) NOT NULL,
            eliminado TINYINT(1) NOT NULL DEFAULT 0,
            eliminado_por INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            eliminado_at TIMESTAMP NULL DEFAULT NULL
          ) ENGINE=InnoDB;
        `)
      } catch {}
    } else {
      throw err
    }
  }

  const totalEfectivo = Number(ventaRow?.total_efectivo || 0)
  const totalEgresos = Number(egresoRow?.total_egresos || 0)
  const baseInicial = CAJA_BASE_INICIAL

  return {
    fecha_caja: `${y}-${m}-${d}`,
    base_inicial: baseInicial,
    total_efectivo: totalEfectivo,
    total_egresos: totalEgresos,
    saldo_actual: baseInicial + totalEfectivo - totalEgresos,
    egresos: egresos || []
  }
}

app.use(cors())
// Aumenta límite para admitir PDFs en base64
app.use(express.json({ limit: '20mb' }))

// Endpoints API
app.get('/api/db-ping', async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ ok: false, error: 'pool_no_inicializado' })
    }
    const conn = await pool.getConnection()
    await conn.ping()
    conn.release()
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/api/version', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT VERSION() AS version')
    res.json({ version: rows[0]?.version || null })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/db-info', (req, res) => {
  res.json({ host: process.env.DB_HOST || null, port: Number(process.env.DB_PORT || 3306) })
})

app.post('/api/usuarios/registro', async (req, res) => {
  try {
    const { nombre, usuario, contrasena } = req.body || {}
    const nombreLimpio = String(nombre || '').trim()
    const usuarioLimpio = String(usuario || '').trim()
    const contrasenaLimpia = String(contrasena || '').trim()

    if (!usuarioLimpio || !contrasenaLimpia) {
      return res.status(400).json({ ok: false, error: 'datos_invalidos' })
    }

    if (usuarioLimpio.length < 4) {
      return res.status(400).json({ ok: false, error: 'usuario_muy_corto' })
    }

    if (contrasenaLimpia.length < 6) {
      return res.status(400).json({ ok: false, error: 'contrasena_muy_corta' })
    }

    const columns = await getTableColumns('usuarios')
    if (!columns.length) {
      return res.status(500).json({ ok: false, error: 'tabla_usuarios_no_disponible' })
    }

    const usernameColumn = pickFirstExistingColumn(columns, ['usuario', 'nombre_usuario', 'username', 'user'])
    const passwordColumn = pickFirstExistingColumn(columns, ['contrasena', 'clave', 'password', 'pass'])
    const nameColumn = pickFirstExistingColumn(columns, ['nombre', 'nombres', 'nombre_completo', 'nombre_usuario'])
    const roleColumn = pickFirstExistingColumn(columns, ['rol', 'perfil', 'tipo'])

    if (!usernameColumn || !passwordColumn) {
      return res.status(500).json({ ok: false, error: 'estructura_usuarios_incompatible' })
    }

    const [existingRows] = await pool.query(
      `SELECT * FROM usuarios WHERE \`${usernameColumn}\` = ? LIMIT 1`,
      [usuarioLimpio]
    )
    if (existingRows && existingRows.length) {
      return res.status(409).json({ ok: false, error: 'usuario_existente' })
    }

    const hashedPassword = await bcrypt.hash(contrasenaLimpia, 10)
    const insertColumns = [usernameColumn, passwordColumn]
    const insertValues = [usuarioLimpio, hashedPassword]

    if (nameColumn) {
      insertColumns.push(nameColumn)
      insertValues.push(nombreLimpio || usuarioLimpio)
    }

    if (roleColumn) {
      insertColumns.push(roleColumn)
      insertValues.push('usuario')
    }

    const columnSql = insertColumns.map((column) => `\`${column}\``).join(', ')
    const placeholderSql = insertColumns.map(() => '?').join(', ')

    const [result] = await pool.query(
      `INSERT INTO usuarios (${columnSql}) VALUES (${placeholderSql})`,
      insertValues
    )

    res.status(201).json({
      ok: true,
      id: result.insertId || null,
      usuario: usuarioLimpio,
      nombre: nombreLimpio || usuarioLimpio,
    })
  } catch (err) {
    const duplicateEntry = err?.code === 'ER_DUP_ENTRY'
    if (duplicateEntry) {
      return res.status(409).json({ ok: false, error: 'usuario_existente' })
    }
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/api/clientes', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim()
    if (!q) return res.json({ ok: true, clientes: [] })
    const like = `%${q}%`
    const [rows] = await pool.query(
      `SELECT
         id_cliente AS id,
         nombre,
         nit_cc,
         telefono,
         direccion,
         tipo_cliente,
         identification,
         identification_document_code,
         legal_organization_code,
         tribute_code,
         email,
         company,
         trade_name,
         names
       FROM clientes
       WHERE nombre LIKE ?
          OR nit_cc LIKE ?
          OR identification LIKE ?
       ORDER BY nombre
       LIMIT 20`,
      [like, like, like]
    )
    res.json({ ok: true, clientes: (rows || []).map(enrichClienteWithFacturacion) })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/api/clientes/:id/facturacion-status', async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({
        ready: false,
        missing_fields: ['cliente'],
        missing_labels: ['Cliente'],
        message: 'Cliente invalido.'
      })
    }

    const [rows] = await pool.query(
      `SELECT
         id_cliente AS id,
         nombre,
         nit_cc,
         telefono,
         direccion,
         tipo_cliente,
         identification,
         identification_document_code,
         legal_organization_code,
         tribute_code,
         email,
         company,
         trade_name,
         names
       FROM clientes
       WHERE id_cliente = ?
       LIMIT 1`,
      [id]
    )

    const cliente = rows && rows.length ? rows[0] : null
    if (!cliente) {
      return res.status(404).json({
        ready: false,
        missing_fields: ['cliente'],
        missing_labels: ['Cliente'],
        message: 'Cliente no encontrado.'
      })
    }

    return res.json(buildClienteFacturacionStatus(cliente))
  } catch (err) {
    res.status(500).json({
      ready: false,
      missing_fields: [],
      missing_labels: [],
      message: err.message
    })
  }
})

app.get('/api/clientes-mayoristas-contactos', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id_cliente AS id, nombre, telefono, tipo_cliente
       FROM clientes
       WHERE LOWER(COALESCE(tipo_cliente, '')) LIKE '%mayor%'
         AND TRIM(COALESCE(telefono, '')) <> ''
       ORDER BY nombre`
    )
    res.json({ ok: true, clientes: rows || [] })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/api/productos', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim()
    if (!q) return res.json({ ok: true, productos: [] })

    const productColumns = await getTableColumns('productos')
    const productoSelectFields = buildProductoSelectFields(productColumns)

    // Mejora: Búsqueda por palabras múltiples
    const words = q.split(/\s+/).filter(w => w.length > 0)
    
    if (words.length === 0) {
      return res.json({ ok: true, productos: [] })
    }

    const whereParts = []
    const params = []

    for (const w of words) {
      whereParts.push('(nombre LIKE ? OR codigo_barras LIKE ?)')
      const like = `%${w}%`
      params.push(like, like)
    }

    const whereClause = whereParts.join(' AND ')
    const sql = `SELECT ${productoSelectFields}
                 FROM productos 
                 WHERE ${whereClause} 
                 ORDER BY nombre LIMIT 50`

    const [rows] = await pool.query(sql, params)
    res.json({ ok: true, productos: (rows || []).map(enrichProductoWithFacturacion) })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/api/productos/:id/facturacion-status', async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({
        ready: false,
        missing_fields: ['producto'],
        missing_labels: ['Producto'],
        message: 'Producto invalido.'
      })
    }

    const productColumns = await getTableColumns('productos')
    const productoSelectFields = buildProductoSelectFields(productColumns)
    const [rows] = await pool.query(
      `SELECT ${productoSelectFields}
       FROM productos
       WHERE id_producto = ?
       LIMIT 1`,
      [id]
    )

    const producto = rows && rows.length ? rows[0] : null
    if (!producto) {
      return res.status(404).json({
        ready: false,
        missing_fields: ['producto'],
        missing_labels: ['Producto'],
        message: 'Producto no encontrado.'
      })
    }

    return res.json(buildProductoFacturacionStatus(producto))
  } catch (err) {
    res.status(500).json({
      ready: false,
      missing_fields: [],
      missing_labels: [],
      message: err.message
    })
  }
})

app.post('/api/login', async (req, res) => {
  try {
    const { usuario, contrasena } = req.body || {}

    const usuarioLimpio = String(usuario || '').trim()

    const accessBaseLog = {
      fecha: new Date().toISOString(),
      usuario: usuarioLimpio,
      ip: req.ip || req.socket?.remoteAddress || '',
      user_agent: req.get('user-agent') || '',
      origen: 'web-login'
    }

    if (!usuario || !contrasena) {
      await appendUserAccessLog({
        ...accessBaseLog,
        estado: 'rechazado',
        motivo: 'datos_invalidos'
      })
      return res.status(400).json({ ok: false, error: 'datos_invalidos' })
    }
    const [rows] = await pool.query(
      'SELECT * FROM usuarios WHERE usuario = ? LIMIT 1',
      [usuarioLimpio]
    )
    if (!rows || rows.length === 0) {
      await appendUserAccessLog({
        ...accessBaseLog,
        estado: 'rechazado',
        motivo: 'usuario_no_encontrado'
      })
      return res.status(401).json({ ok: false, error: 'usuario_no_encontrado' })
    }
    const user = rows[0]
    const okPass = await passwordMatchesUser(user, contrasena)
    if (!okPass) {
      await appendUserAccessLog({
        ...accessBaseLog,
        estado: 'rechazado',
        motivo: 'contrasena_invalida'
      })
      return res.status(401).json({ ok: false, error: 'credenciales_invalidas' })
    }
    const idUsuario = user.id_usuario || user.id || user.usuario_id
    const nombreUsuario = user.nombre || user.usuario || user.nombre_usuario || usuario
    if (!idUsuario) {
      await appendUserAccessLog({
        ...accessBaseLog,
        estado: 'error',
        motivo: 'id_usuario_invalido'
      })
      return res.status(500).json({ ok: false, error: 'id_usuario_invalido' })
    }
    const rol = user.rol || 'vendedor'
    await appendUserAccessLog({
      ...accessBaseLog,
      estado: 'exitoso',
      motivo: 'login_ok',
      usuario_id: idUsuario,
      rol
    })
    res.json({
      ok: true,
      usuario_id: idUsuario,
      usuario: nombreUsuario,
      rol
    })
  } catch (err) {
    try {
      await appendUserAccessLog({
        fecha: new Date().toISOString(),
        usuario: String(req.body?.usuario || '').trim(),
        ip: req.ip || req.socket?.remoteAddress || '',
        user_agent: req.get('user-agent') || '',
        origen: 'web-login',
        estado: 'error',
        motivo: err.message
      })
    } catch {}
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/confirmar-pass', async (req, res) => {
  try {
    const { usuario_id, contrasena } = req.body || {}
    if (!usuario_id || !contrasena) {
      return res.status(400).json({ ok: false, error: 'datos_invalidos' })
    }
    const [rows] = await pool.query(
      'SELECT * FROM usuarios WHERE id_usuario = ? LIMIT 1',
      [Number(usuario_id)]
    )
    if (!rows || rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'usuario_no_encontrado' })
    }
    const user = rows[0]
    const okPass = await passwordMatchesUser(user, contrasena)
    if (!okPass) {
      return res.status(401).json({ ok: false, error: 'credenciales_invalidas' })
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/api/caja/resumen', async (req, res) => {
  try {
    const usuarioId = Number(req.query.usuario_id || 0)
    if (!usuarioId) {
      return res.status(400).json({ ok: false, error: 'usuario_id_requerido' })
    }
    if (!(await isAdminUser(usuarioId))) {
      return res.status(403).json({ ok: false, error: 'solo_admin' })
    }

    const resumen = await getCajaResumen()
    res.json({ ok: true, ...resumen })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/caja/egresos', async (req, res) => {
  try {
    const { usuario_id, valor, justificacion } = req.body || {}
    const usuarioId = Number(usuario_id || 0)
    const valorNum = Math.round(Number(valor || 0))
    const motivo = String(justificacion || '').trim()

    if (!usuarioId) {
      return res.status(400).json({ ok: false, error: 'usuario_id_requerido' })
    }
    if (!(await isAdminUser(usuarioId))) {
      return res.status(403).json({ ok: false, error: 'solo_admin' })
    }
    if (!valorNum || valorNum <= 0) {
      return res.status(400).json({ ok: false, error: 'valor_invalido' })
    }
    if (!motivo) {
      return res.status(400).json({ ok: false, error: 'justificacion_requerida' })
    }

    const [result] = await pool.query(
      'INSERT INTO caja_egresos (usuario_id, valor, justificacion) VALUES (?, ?, ?)',
      [usuarioId, valorNum, motivo]
    )
    const resumen = await getCajaResumen()
    res.json({ ok: true, id: result.insertId, ...resumen })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.delete('/api/caja/egresos/:id', async (req, res) => {
  try {
    const egresoId = Number(req.params.id || 0)
    const { usuario_id, contrasena } = req.body || {}
    const usuarioId = Number(usuario_id || 0)

    if (!egresoId) {
      return res.status(400).json({ ok: false, error: 'egreso_id_invalido' })
    }
    if (!usuarioId || !contrasena) {
      return res.status(400).json({ ok: false, error: 'datos_invalidos' })
    }

    const user = await getUsuarioById(usuarioId)
    if (!user || String(user.rol || '').toLowerCase() !== 'admin') {
      return res.status(403).json({ ok: false, error: 'solo_admin' })
    }

    const okPass = await passwordMatchesUser(user, contrasena)
    if (!okPass) {
      return res.status(401).json({ ok: false, error: 'credenciales_invalidas' })
    }

    const [[egreso]] = await pool.query(
      'SELECT id FROM caja_egresos WHERE id = ? AND eliminado = 0 LIMIT 1',
      [egresoId]
    )
    if (!egreso) {
      return res.status(404).json({ ok: false, error: 'egreso_no_encontrado' })
    }

    await pool.query(
      'UPDATE caja_egresos SET eliminado = 1, eliminado_por = ?, eliminado_at = NOW() WHERE id = ?',
      [usuarioId, egresoId]
    )

    const resumen = await getCajaResumen()
    res.json({ ok: true, ...resumen })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/confirmar-pass', async (req, res) => {
  try {
    const { usuario_id, contrasena } = req.body || {}
    if (!usuario_id || !contrasena) {
      return res.status(400).json({ ok: false, error: 'datos_invalidos' })
    }
    const [rows] = await pool.query(
      'SELECT * FROM usuarios WHERE id_usuario = ? LIMIT 1',
      [Number(usuario_id)]
    )
    if (!rows || rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'usuario_no_encontrado' })
    }
    const user = rows[0]
    const rawStored = String(
      user.contrasena ||
      user.clave ||
      user.password ||
      user.pass ||
      ''
    )
    const storedPass = rawStored.trim()
    const inputPass = String(contrasena).trim()
    let okPass = storedPass === inputPass
    if (!okPass) {
      if (storedPass.startsWith('$2a$') || storedPass.startsWith('$2b$') || storedPass.startsWith('$2y$')) {
        try {
          okPass = await bcrypt.compare(inputPass, storedPass)
        } catch {}
      }
    }
    if (!okPass) {
      const hex = storedPass.toLowerCase()
      const onlyHex = /^[a-f0-9]+$/.test(hex)
      if (onlyHex) {
        const len = hex.length
        if (len === 32) {
          const md5 = crypto.createHash('md5').update(inputPass).digest('hex')
          okPass = md5 === hex
        } else if (len === 40) {
          const sha1 = crypto.createHash('sha1').update(inputPass).digest('hex')
          okPass = sha1 === hex
        } else if (len === 64) {
          const sha256 = crypto.createHash('sha256').update(inputPass).digest('hex')
          okPass = sha256 === hex
        }
      }
    }
    if (!storedPass || !okPass) {
      return res.status(401).json({ ok: false, error: 'credenciales_invalidas' })
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Generar consecutivo único de 4 dígitos validando en tabla ventas
app.post('/api/consecutivo', async (req, res) => {
  try {
    let intentos = 0
    let numero = null
    while (intentos < 100) {
      const n = Math.floor(1000 + Math.random() * 9000)
      const [[row]] = await pool.query('SELECT 1 AS ex FROM ventas WHERE id_consecutivo = ? LIMIT 1', [n])
      if (!row || !row.ex) {
        numero = n
        break
      }
      intentos++
    }
    if (!numero) return res.status(409).json({ ok: false, error: 'no_consecutivo', msg: 'No se pudo generar un consecutivo único' })
    res.json({ ok: true, id_consecutivo: numero })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/api/factus/numbering-preview', async (req, res) => {
  try {
    const numberingRange = await getFactusActiveNumberingRange()
    res.json({
      ok: true,
      numbering_range_id: numberingRange.id,
      prefix: numberingRange.prefix,
      current: numberingRange.current,
      preview_number: numberingRange.preview_number
    })
  } catch (err) {
    res.status(503).json({
      ok: false,
      error: err.message
    })
  }
})

app.get('/api/check-consecutivo/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) return res.json({ exists: false });
    
    const [[row]] = await pool.query('SELECT 1 FROM ventas WHERE id_consecutivo = ?', [id]);
    res.json({ exists: !!row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Guardar encabezado de venta en tabla ventas y descontar stock en productos
app.post('/api/venta', async (req, res) => {
  const conn = await pool.getConnection()
  try {
    const {
      id_consecutivo,
      usuario_id,
      cliente_id,
      total,
      tipo_pago, // 'CREDITO' | 'CONTADO'
      forma_pago, // 'EFECTIVO' | 'QR' | 'TARJETA' | etc
      punto_venta, // 'ferreteria' | 'bodega'
    } = req.body || {}
    const esFacturaElectronica = req.body?.factura_electronica === true
    const items = normalizeVentaDetalleItems(req.body)
    const paymentDetails = normalizeVentaPaymentDetails(req.body)
    let factusPayload = null
    let factusResult = null
    let factusReferenceCode = null

    if (!id_consecutivo || !usuario_id || !cliente_id) {
      return res.status(400).json({ ok: false, error: 'faltan_campos' })
    }

    if (esFacturaElectronica && !Array.isArray(items) || (esFacturaElectronica && items.length === 0)) {
      return res.status(400).json({
        ok: false,
        error: 'items_factura_electronica_requeridos',
        message: 'La venta electrónica requiere items persistibles.'
      })
    }

    if (esFacturaElectronica && (!Number.isFinite(Number(cliente_id)) || Number(cliente_id) <= 0)) {
      return res.status(400).json({
        ok: false,
        error: 'cliente_invalido',
        message: 'La venta electrónica requiere un cliente válido.'
      })
    }

    if (esFacturaElectronica) {
      const clienteFactus = await getClienteForFactus(Number(cliente_id), conn)
      const numberingRange = await getFactusActiveNumberingRange()
      factusReferenceCode = buildFactusReferenceCode(req.body, id_consecutivo)
      factusPayload = buildFactusBillPayload({
        body: req.body,
        ventaId: id_consecutivo,
        cliente: clienteFactus,
        items,
        paymentDetails,
        numberingRange,
        referenceCode: factusReferenceCode
      })
      console.log('[Factus] Payload a enviar:', JSON.stringify({
        venta_id: Number(id_consecutivo),
        reference_code: factusReferenceCode,
        payload: factusPayload
      }))
    }

    // Doble validación en backend antes de insertar
    const [[existente]] = await conn.query('SELECT 1 FROM ventas WHERE id_consecutivo = ?', [Number(id_consecutivo)]);
    if (existente) {
        return res.status(409).json({ ok: false, error: 'consecutivo_duplicado', msg: 'El consecutivo ya existe' });
    }

    const t = Number(total || 0)
    await conn.beginTransaction()
    await insertVentaCabecera(conn, {
      id_consecutivo,
      usuario_id,
      cliente_id,
      total: t,
      tipo_pago,
      forma_pago,
      punto_venta,
      subtotal: req.body?.subtotal ?? null,
      total_discount: req.body?.total_discount ?? 0,
      total_tax: req.body?.total_tax ?? 0,
      observation: req.body?.observation || null,
      factura_electronica: esFacturaElectronica,
      electronic_status: esFacturaElectronica ? 'pending' : null,
      factus_number: null
    })

    if (esFacturaElectronica) {
      await persistVentaElectronicaData(conn, req.body, id_consecutivo, items, paymentDetails, {
        referenceCode: factusReferenceCode
      })
    }

    // Descontar stock
    for (const it of items) {
      const cantidad = Number(it.cantidad || 0)
      const descripcion = String(it.descripcion || '')
      const idProducto = it.id_producto || it.producto_id ? Number(it.id_producto || it.producto_id) : null
      
      if (!cantidad) continue

      let updated = false;

      // 1. Try by ID if available
      if (idProducto) {
         const [res] = await conn.query('UPDATE productos SET stock = GREATEST(0, stock - ?) WHERE id_producto = ?', [cantidad, idProducto])
         if (res.affectedRows > 0) updated = true;
      }

      // 2. Try by exact name
      if (!updated && descripcion) {
          const [res] = await conn.query('UPDATE productos SET stock = GREATEST(0, stock - ?) WHERE nombre = ? LIMIT 1', [cantidad, descripcion])
          if (res.affectedRows > 0) updated = true;
      }

      // 3. Try by LIKE name
      if (!updated && descripcion) {
          await conn.query('UPDATE productos SET stock = GREATEST(0, stock - ?) WHERE nombre LIKE ? LIMIT 1', [cantidad, `%${descripcion}%`])
      }
    }

    if (esFacturaElectronica) {
      const factusResponse = await factusApiRequest('/v2/bills/validate', {
        method: 'POST',
        body: factusPayload
      })
      console.log('[Factus] Respuesta recibida:', JSON.stringify({
        venta_id: Number(id_consecutivo),
        reference_code: factusReferenceCode,
        response: factusResponse
      }))
      factusResult = await updateFactusPersistedData(conn, id_consecutivo, factusReferenceCode, factusPayload, factusResponse)
    }

    await conn.commit()
    res.json({
      ok: true,
      id_consecutivo,
      venta_id: Number(id_consecutivo),
      factura_electronica: esFacturaElectronica,
      factus_number: factusResult?.number || null,
      prefix: factusResult?.prefix || null,
      number: factusResult?.number || null,
      cufe: factusResult?.cufe || null,
      status: factusResult?.status || null,
      is_validated: typeof factusResult?.is_validated === 'boolean' ? factusResult.is_validated : null,
      document_url: factusResult?.document_url || null,
      urls: factusResult?.urls || null,
      factus: factusResult
    })
  } catch (err) {
    try { await conn.rollback() } catch {}
    res.status(500).json({ ok: false, error: err.message })
  } finally {
    conn.release()
  }
})

app.post('/api/ventas', async (req, res) => {
  try {
    const { cliente_nombre, metodo_pago, total, items } = req.body || {}
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'items vacíos' })
    }
    const t = Number(total || 0)
    const [ventaRes] = await pool.query(
      'INSERT INTO web_ventas (cliente_nombre, metodo_pago, total) VALUES (?, ?, ?)',
      [String(cliente_nombre || ''), String(metodo_pago || ''), t]
    )
    const ventaId = ventaRes.insertId
    const values = items.map(it => [
      ventaId,
      String(it.descripcion || ''),
      Number(it.cantidad || 0),
      Number(it.valor_unitario || 0),
      Number(it.valor_total || 0),
    ])
    await pool.query(
      'INSERT INTO web_venta_items (venta_id, descripcion, cantidad, valor_unitario, valor_total) VALUES ?',
      [values]
    )
    res.json({ ok: true, id: ventaId })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/api/ventas/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)
    const [[venta]] = await pool.query('SELECT * FROM web_ventas WHERE id = ?', [id])
    if (!venta) return res.status(404).json({ ok: false, error: 'no encontrada' })
    const [items] = await pool.query('SELECT * FROM web_venta_items WHERE venta_id = ?', [id])
    res.json({ ok: true, venta, items })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Reporte de ventas del día (o recientes)
app.get('/api/reporte-ventas', async (req, res) => {
  try {
    // Generamos rango de fecha desde JS (hora local del sistema)
    // para evitar discrepancias de zona horaria con MySQL
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    const startStr = `${y}-${m}-${d} 00:00:00`
    const endStr = `${y}-${m}-${d} 23:59:59`

    console.log(`[Reporte] Solicitado para rango: ${startStr} - ${endStr}`)

    const [rows] = await pool.query(
      'SELECT id_consecutivo, total, forma_pago, tipo_pago, fecha, punto_venta FROM ventas WHERE fecha >= ? AND fecha <= ? ORDER BY id_consecutivo DESC',
      [startStr, endStr]
    )
    res.json({ ok: true, ventas: rows })
  } catch (err) {
    console.error('[Reporte] Error:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Eliminar venta (solo admin validado en front, pero idealmente aquí también si tuviéramos middleware)
app.delete('/api/venta/:id', async (req, res) => {
  try {
    const id = req.params.id
    if (!id) return res.status(400).json({ ok: false, error: 'id requerido' })
    
    // Validamos que exista
    const [[venta]] = await pool.query('SELECT 1 FROM ventas WHERE id_consecutivo = ?', [id])
    if (!venta) return res.status(404).json({ ok: false, error: 'venta no encontrada' })

    // Eliminamos (asumiendo que no hay FKs restrictivas o que queremos borrar todo)
    // Si hay items vinculados en otra tabla relacionada a 'ventas' por 'id_consecutivo', habría que borrarlos.
    // La tabla ventas usa id_consecutivo como PK.
    // Revisando el código, no parece haber tabla de items linkeada a id_consecutivo en SQL, 
    // sino que se descuenta stock de productos. 
    // Si borramos la venta, ¿devolvemos el stock? El usuario no lo pidió explícitamente, pero sería lo correcto.
    // Por simplicidad y siguiendo "do nothing more", solo borramos el registro.
    
    await pool.query('DELETE FROM ventas WHERE id_consecutivo = ?', [id])
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// --- API PEDIDOS PROGRAMADOS ---

app.get('/api/programados', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM pedidos_programados ORDER BY fecha ASC, hora ASC');
    // Parsear campos JSON/TEXT
    const pedidos = rows.map(r => ({
      ...r,
      cliente_data: r.cliente_data ? JSON.parse(r.cliente_data) : null,
      items: r.items ? JSON.parse(r.items) : [],
      transporte: r.transporte ? JSON.parse(r.transporte) : null
    }));
    res.json({ ok: true, pedidos });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/programados', async (req, res) => {
  try {
    const p = req.body;
    if (!p.id) return res.status(400).json({ error: 'id_requerido' });

    // Verificar si existe para actualizar o insertar (Upsert simplificado: DELETE + INSERT o INSERT ON DUPLICATE)
    // Dado que el ID lo genera el front, usaremos INSERT ON DUPLICATE KEY UPDATE
    const sql = `
      INSERT INTO pedidos_programados 
      (id, consecutivo, cliente_nombre, cliente_data, items, total, fecha, hora, estado, transporte, tipo_pago, metodo_pago, punto_venta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
      consecutivo=VALUES(consecutivo), cliente_nombre=VALUES(cliente_nombre), cliente_data=VALUES(cliente_data),
      items=VALUES(items), total=VALUES(total), fecha=VALUES(fecha), hora=VALUES(hora), estado=VALUES(estado),
      transporte=VALUES(transporte), tipo_pago=VALUES(tipo_pago), metodo_pago=VALUES(metodo_pago), punto_venta=VALUES(punto_venta)
    `;
    
    const params = [
      p.id,
      p.consecutivo || null,
      p.cliente_nombre || '',
      JSON.stringify(p.cliente_data || {}),
      JSON.stringify(p.items || []),
      Number(p.total || 0),
      p.fecha,
      p.hora,
      p.estado || 'PROGRAMADO',
      JSON.stringify(p.transporte || {}),
      p.tipo_pago || '',
      p.metodo_pago || '',
      p.punto_venta || ''
    ];

    await pool.query(sql, params);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error guardando programado:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/programados/:id', async (req, res) => {
  try {
    const id = req.params.id;
    await pool.query('DELETE FROM pedidos_programados WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Servir estáticos del proyecto actual
app.use(express.static(path.resolve(__dirname)))

const PORT = Number(process.env.PORT || 8080)

initPool().then(() => {
  app.listen(PORT, () => {
    console.log(`Servidor web en http://localhost:${PORT}`)
  })
})

const PDF_BODEGA_PATH = 'G:\\Mi unidad\\FERREDISTRIBUCIONES ALUMAS SAS\\bodega';

app.post('/api/save-pdf', async (req, res) => {
  try {
    const { filename, data } = req.body;
    if (!filename || !data) {
        return res.status(400).json({ error: 'missing_fields' });
    }

    // Verificar si el directorio existe, si no, crearlo
    try {
        await fs.promises.access(PDF_BODEGA_PATH);
    } catch {
        console.log("Directorio no existe, intentando crear:", PDF_BODEGA_PATH);
        await fs.promises.mkdir(PDF_BODEGA_PATH, { recursive: true });
    }

    const filePath = path.join(PDF_BODEGA_PATH, filename);
    const buffer = Buffer.from(data, 'base64');
    
    console.log("Intentando guardar PDF en:", filePath); // Log para debug

    await fs.promises.writeFile(filePath, buffer);
    console.log("PDF guardado exitosamente");
    
    res.json({ ok: true, path: filePath });
  } catch (e) {
    console.error("Error guardando PDF:", e);
    res.status(500).json({ error: e.message });
  }
});
