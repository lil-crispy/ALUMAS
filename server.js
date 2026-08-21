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
  const createMercadoLibreCuentas = `
    CREATE TABLE IF NOT EXISTS mercadolibre_cuentas (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      meli_user_id BIGINT NOT NULL,
      nickname VARCHAR(120) NULL,
      site_id VARCHAR(16) NULL,
      scope VARCHAR(255) NULL,
      access_token_encrypted TEXT NOT NULL,
      refresh_token_encrypted TEXT NOT NULL,
      token_expires_at DATETIME NULL,
      connected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_refresh_at DATETIME NULL DEFAULT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'connected',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mercadolibre_cuentas_meli_user_id (meli_user_id)
    ) ENGINE=InnoDB;
  `
  const createMercadoLibreOauthStates = `
    CREATE TABLE IF NOT EXISTS mercadolibre_oauth_states (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      state_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mercadolibre_oauth_states_state_hash (state_hash),
      KEY idx_mercadolibre_oauth_states_expires_at (expires_at)
    ) ENGINE=InnoDB;
  `
  const createMercadoLibrePublicaciones = `
    CREATE TABLE IF NOT EXISTS mercadolibre_publicaciones (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      meli_user_id BIGINT NOT NULL,
      item_id VARCHAR(32) NOT NULL,
      producto_id INT NULL,
      seller_sku VARCHAR(120) NULL,
      category_id VARCHAR(64) NULL,
      title VARCHAR(255) NULL,
      status VARCHAR(32) NULL,
      price DECIMAL(14,2) NULL,
      available_quantity INT NULL,
      permalink TEXT NULL,
      last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_stock_sync_at DATETIME NULL DEFAULT NULL,
      last_stock_sync_status VARCHAR(32) NULL DEFAULT NULL,
      last_stock_sync_message VARCHAR(255) NULL DEFAULT NULL,
      raw_json LONGTEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mercadolibre_publicaciones_item_id (item_id),
      KEY idx_mercadolibre_publicaciones_producto_id (producto_id),
      KEY idx_mercadolibre_publicaciones_meli_user_id (meli_user_id)
    ) ENGINE=InnoDB;
  `
  const createMercadoLibreOrdenes = `
    CREATE TABLE IF NOT EXISTS mercadolibre_ordenes (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      order_id BIGINT NOT NULL,
      meli_user_id BIGINT NOT NULL,
      venta_id BIGINT NULL,
      status VARCHAR(32) NULL,
      status_detail VARCHAR(64) NULL,
      date_created DATETIME NULL,
      date_closed DATETIME NULL,
      date_last_updated DATETIME NULL,
      paid_at DATETIME NULL,
      total_amount DECIMAL(14,2) NULL,
      currency_id VARCHAR(16) NULL,
      buyer_nickname VARCHAR(120) NULL,
      buyer_first_name VARCHAR(120) NULL,
      buyer_last_name VARCHAR(120) NULL,
      processing_status VARCHAR(32) NOT NULL DEFAULT 'pending',
      processing_message TEXT NULL,
      raw_json LONGTEXT NULL,
      last_processed_at DATETIME NULL DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mercadolibre_ordenes_order_id (order_id),
      KEY idx_mercadolibre_ordenes_venta_id (venta_id),
      KEY idx_mercadolibre_ordenes_processing_status (processing_status),
      KEY idx_mercadolibre_ordenes_meli_user_id (meli_user_id)
    ) ENGINE=InnoDB;
  `
  await pool.query(createVentas)
  await pool.query(createItems)
  await pool.query(createProgramados)
  await pool.query(createCajaEgresos)
  await pool.query(createVentasDetalle)
  await pool.query(createVentasPaymentDetails)
  await pool.query(createFactusDocumentos)
  await pool.query(createMercadoLibreCuentas)
  await pool.query(createMercadoLibreOauthStates)
  await pool.query(createMercadoLibrePublicaciones)
  await pool.query(createMercadoLibreOrdenes)

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

  const mercadolibrePublicacionesColumns = await getTableColumns('mercadolibre_publicaciones')
  const mercadolibrePublicacionesColumnSet = new Set(mercadolibrePublicacionesColumns.map((column) => String(column || '').toLowerCase()))
  const missingMercadoLibrePublicacionesColumns = [
    {
      name: 'category_id',
      sql: 'ALTER TABLE mercadolibre_publicaciones ADD COLUMN category_id VARCHAR(64) NULL DEFAULT NULL AFTER seller_sku'
    }
  ]

  for (const column of missingMercadoLibrePublicacionesColumns) {
    if (!mercadolibrePublicacionesColumnSet.has(column.name.toLowerCase())) {
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

function roundFactusMoney(value) {
  const numericValue = normalizeVentaNumeric(value, 0)
  return Number(numericValue.toFixed(2))
}

function calculateFactusItemsTotal(items) {
  return (Array.isArray(items) ? items : []).reduce((acc, item) => {
    const quantity = roundFactusMoney(item?.quantity)
    const price = roundFactusMoney(item?.price)
    const discountRate = roundFactusMoney(item?.discount_rate)
    const lineBase = roundFactusMoney(quantity * price)
    const discountValue = roundFactusMoney(lineBase * (discountRate / 100))
    const taxableBase = roundFactusMoney(lineBase - discountValue)
    const taxes = Array.isArray(item?.taxes) ? item.taxes : []
    const lineTaxes = taxes.reduce((taxAcc, tax) => {
      const rate = roundFactusMoney(tax?.rate)
      return roundFactusMoney(taxAcc + roundFactusMoney(taxableBase * (rate / 100)))
    }, 0)
    return roundFactusMoney(acc + taxableBase + lineTaxes)
  }, 0)
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

const MERCADOLIBRE_AUTH_BASE = 'https://auth.mercadolibre.com.co'
const MERCADOLIBRE_API_BASE = 'https://api.mercadolibre.com'
const MERCADOLIBRE_OAUTH_STATE_COOKIE = 'alumas_meli_oauth_state'
const MERCADOLIBRE_OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000
const MERCADOLIBRE_HTTP_TIMEOUT_MS = 15000
const MERCADOLIBRE_REQUIRED_SCOPES = ['offline_access', 'read', 'write']
const MERCADOLIBRE_AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const MERCADOLIBRE_AUTH_RATE_LIMIT_MAX_ATTEMPTS = 5
const MERCADOLIBRE_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000
const MERCADOLIBRE_DEFAULT_REMOTE_PAGE_SIZE = 50
const MERCADOLIBRE_DEFAULT_SYNC_LIMIT = 20
const MERCADOLIBRE_ORDER_PROCESSABLE_STATUSES = new Set(['paid'])
const MERCADOLIBRE_EXISTING_PUBLICATION_STATUSES = new Set(['active', 'paused', 'under_review', 'inactive'])
const MERCADOLIBRE_INTERNAL_AUTH_MAX_AGE_MS = 5 * 60 * 1000
const MERCADOLIBRE_INTERNAL_AUTH_CLIENT_HEADER = 'x-alumas-client-id'
const MERCADOLIBRE_INTERNAL_AUTH_TIMESTAMP_HEADER = 'x-alumas-timestamp'
const MERCADOLIBRE_INTERNAL_AUTH_SIGNATURE_HEADER = 'x-alumas-signature'

let mercadolibreEncryptionKeyCache = null
const mercadolibreAuthRateLimitStore = new Map()
let mercadolibreAuthRateLimitLastCleanupAt = 0

function getMercadoLibreConfig() {
  return {
    clientId: String(process.env.MERCADOLIBRE_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.MERCADOLIBRE_CLIENT_SECRET || '').trim(),
    redirectUri: String(process.env.MERCADOLIBRE_REDIRECT_URI || '').trim(),
    stateSecret: String(process.env.MERCADOLIBRE_OAUTH_STATE_SECRET || '').trim(),
    encryptionSecret: String(process.env.MERCADOLIBRE_TOKEN_ENCRYPTION_KEY || '').trim(),
    adminAuthUser: String(process.env.MERCADOLIBRE_ADMIN_AUTH_USER || '').trim(),
    adminAuthPassword: String(process.env.MERCADOLIBRE_ADMIN_AUTH_PASSWORD || '').trim(),
    allowedUserId: String(process.env.MERCADOLIBRE_ALLOWED_USER_ID || '').trim(),
    internalClientId: String(process.env.MERCADOLIBRE_INTERNAL_CLIENT_ID || '').trim(),
    internalSharedSecret: String(process.env.MERCADOLIBRE_INTERNAL_SHARED_SECRET || '').trim()
  }
}

function ensureMercadoLibreConfigured() {
  const config = getMercadoLibreConfig()
  const required = [
    ['MERCADOLIBRE_CLIENT_ID', config.clientId],
    ['MERCADOLIBRE_CLIENT_SECRET', config.clientSecret],
    ['MERCADOLIBRE_REDIRECT_URI', config.redirectUri],
    ['MERCADOLIBRE_OAUTH_STATE_SECRET', config.stateSecret],
    ['MERCADOLIBRE_TOKEN_ENCRYPTION_KEY', config.encryptionSecret]
  ]
  const missing = required
    .filter(([, value]) => !value)
    .map(([name]) => name)

  if (missing.length > 0) {
    throw new Error(`Mercado Libre no está configurado. Faltan variables: ${missing.join(', ')}`)
  }

  return config
}

function getMercadoLibreEncryptionKey() {
  if (mercadolibreEncryptionKeyCache) return mercadolibreEncryptionKeyCache
  const { encryptionSecret } = ensureMercadoLibreConfigured()
  mercadolibreEncryptionKeyCache = crypto
    .createHash('sha256')
    .update(encryptionSecret, 'utf8')
    .digest()
  return mercadolibreEncryptionKeyCache
}

function ensureMercadoLibreAdminConfigured() {
  const { adminAuthUser, adminAuthPassword } = getMercadoLibreConfig()
  const missing = []
  if (!adminAuthUser) missing.push('MERCADOLIBRE_ADMIN_AUTH_USER')
  if (!adminAuthPassword) missing.push('MERCADOLIBRE_ADMIN_AUTH_PASSWORD')
  if (missing.length > 0) {
    throw new Error(`Mercado Libre admin auth no está configurado. Faltan variables: ${missing.join(', ')}`)
  }
  return {
    adminAuthUser,
    adminAuthPassword
  }
}

function ensureMercadoLibreInternalAuthConfigured() {
  const { internalClientId, internalSharedSecret } = getMercadoLibreConfig()
  const missing = []
  if (!internalClientId) missing.push('MERCADOLIBRE_INTERNAL_CLIENT_ID')
  if (!internalSharedSecret) missing.push('MERCADOLIBRE_INTERNAL_SHARED_SECRET')
  if (missing.length > 0) {
    throw new Error(`Mercado Libre internal auth no está configurado. Faltan variables: ${missing.join(', ')}`)
  }
  return {
    internalClientId,
    internalSharedSecret
  }
}

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url')
}

function fromBase64Url(value) {
  return Buffer.from(String(value || ''), 'base64url')
}

function createSignedValue(payload, secret) {
  const payloadBase64 = toBase64Url(JSON.stringify(payload))
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payloadBase64)
    .digest('base64url')
  return `${payloadBase64}.${signature}`
}

function readSignedValue(value, secret) {
  const text = String(value || '').trim()
  const separatorIndex = text.lastIndexOf('.')
  if (separatorIndex <= 0) return null

  const payloadBase64 = text.slice(0, separatorIndex)
  const receivedSignature = text.slice(separatorIndex + 1)
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payloadBase64)
    .digest('base64url')

  const receivedBuffer = Buffer.from(receivedSignature, 'utf8')
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8')
  if (receivedBuffer.length !== expectedBuffer.length) return null
  if (!crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) return null

  try {
    return JSON.parse(fromBase64Url(payloadBase64).toString('utf8'))
  } catch {
    return null
  }
}

function parseCookies(req) {
  const header = String(req.headers?.cookie || '')
  const cookies = {}
  header.split(';').forEach((part) => {
    const trimmed = part.trim()
    if (!trimmed) return
    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex <= 0) return
    const name = trimmed.slice(0, separatorIndex).trim()
    const value = trimmed.slice(separatorIndex + 1).trim()
    cookies[name] = decodeURIComponent(value)
  })
  return cookies
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge / 1000))}`)
  if (options.path) parts.push(`Path=${options.path}`)
  if (options.httpOnly) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`)
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`)
  return parts.join('; ')
}

function appendSetCookie(res, cookieValue) {
  const current = res.getHeader('Set-Cookie')
  if (!current) {
    res.setHeader('Set-Cookie', cookieValue)
    return
  }
  if (Array.isArray(current)) {
    res.setHeader('Set-Cookie', [...current, cookieValue])
    return
  }
  res.setHeader('Set-Cookie', [current, cookieValue])
}

function setMercadoLibreStateCookie(res, state) {
  const { stateSecret } = ensureMercadoLibreConfigured()
  const issuedAt = Date.now()
  const signedValue = createSignedValue({ state, issuedAt }, stateSecret)
  appendSetCookie(res, serializeCookie(MERCADOLIBRE_OAUTH_STATE_COOKIE, signedValue, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/api/mercadolibre',
    maxAge: MERCADOLIBRE_OAUTH_STATE_MAX_AGE_MS,
    expires: new Date(issuedAt + MERCADOLIBRE_OAUTH_STATE_MAX_AGE_MS)
  }))
}

function clearMercadoLibreStateCookie(res) {
  appendSetCookie(res, serializeCookie(MERCADOLIBRE_OAUTH_STATE_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/api/mercadolibre',
    maxAge: 0,
    expires: new Date(0)
  }))
}

function validateMercadoLibreState(req, state) {
  const { stateSecret } = ensureMercadoLibreConfigured()
  const cookies = parseCookies(req)
  const signedValue = cookies[MERCADOLIBRE_OAUTH_STATE_COOKIE]
  if (!signedValue) {
    return { ok: false, reason: 'state_cookie_missing' }
  }

  const payload = readSignedValue(signedValue, stateSecret)
  if (!payload?.state || !payload?.issuedAt) {
    return { ok: false, reason: 'state_cookie_invalid' }
  }

  if (String(payload.state) !== String(state || '')) {
    return { ok: false, reason: 'state_mismatch' }
  }

  if ((Date.now() - Number(payload.issuedAt || 0)) > MERCADOLIBRE_OAUTH_STATE_MAX_AGE_MS) {
    return { ok: false, reason: 'state_expired' }
  }

  return { ok: true }
}

function hashMercadoLibreState(state) {
  return crypto
    .createHash('sha256')
    .update(String(state || ''), 'utf8')
    .digest('hex')
}

function createMercadoLibreState() {
  return crypto.randomBytes(32).toString('base64url')
}

function buildMercadoLibreAuthorizationUrl(state) {
  const { clientId, redirectUri } = ensureMercadoLibreConfigured()
  const authUrl = new URL('/authorization', MERCADOLIBRE_AUTH_BASE)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('state', state)
  return authUrl.toString()
}

function sanitizeMercadoLibreTokenResponse(data) {
  return removeEmptyObjectFields({
    token_type: data?.token_type,
    expires_in: data?.expires_in,
    scope: data?.scope,
    user_id: data?.user_id
  })
}

function sanitizeMercadoLibreError(data) {
  return removeEmptyObjectFields({
    message: data?.message,
    error: data?.error,
    status: data?.status,
    cause: Array.isArray(data?.cause)
      ? data.cause.slice(0, 10).map((item) => removeEmptyObjectFields({
        code: item?.code,
        type: item?.type,
        department: item?.department,
        references: item?.references,
        message: item?.message
      }))
      : undefined
  })
}

function sanitizeMercadoLibreUser(data) {
  return removeEmptyObjectFields({
    id: data?.id,
    nickname: data?.nickname,
    site_id: data?.site_id,
    status: data?.status,
    tags: Array.isArray(data?.tags) ? data.tags.slice(0, 20) : undefined
  })
}

function encryptMercadoLibreToken(value) {
  const plainText = String(value || '')
  const key = getMercadoLibreEncryptionKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `v1:${iv.toString('base64url')}:${authTag.toString('base64url')}:${encrypted.toString('base64url')}`
}

function decryptMercadoLibreToken(value) {
  const text = String(value || '').trim()
  const [version, ivBase64, authTagBase64, encryptedBase64] = text.split(':')
  if (version !== 'v1' || !ivBase64 || !authTagBase64 || !encryptedBase64) {
    throw new Error('Formato de token cifrado de Mercado Libre inválido.')
  }

  const key = getMercadoLibreEncryptionKey()
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivBase64, 'base64url')
  )
  decipher.setAuthTag(Buffer.from(authTagBase64, 'base64url'))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, 'base64url')),
    decipher.final()
  ])
  return decrypted.toString('utf8')
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildMercadoLibreOAuthHtml({ title, message, success = false }) {
  const safeTitle = escapeHtml(title || (success ? 'Mercado Libre conectado' : 'Mercado Libre OAuth'))
  const safeMessage = escapeHtml(String(message || '').trim() || 'Proceso finalizado.')
  const color = success ? '#0f7b0f' : '#b42318'
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
</head>
<body style="font-family: Arial, sans-serif; margin: 0; background: #f6f8fb; color: #111827;">
  <div style="max-width: 680px; margin: 48px auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px;">
    <h1 style="margin: 0 0 12px; font-size: 24px; color: ${color};">${safeTitle}</h1>
    <p style="margin: 0; font-size: 16px; line-height: 1.5;">${safeMessage}</p>
  </div>
</body>
</html>`
}

function sendMercadoLibreOAuthPage(res, statusCode, options) {
  res.status(statusCode).type('html').send(buildMercadoLibreOAuthHtml(options))
}

function parseBasicAuthCredentials(req) {
  const authorization = String(req.headers?.authorization || '').trim()
  if (!authorization.toLowerCase().startsWith('basic ')) return null

  try {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8')
    const separatorIndex = decoded.indexOf(':')
    if (separatorIndex < 0) return null
    return {
      user: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1)
    }
  } catch {
    return null
  }
}

function validateMercadoLibreBasicAuthorization(req) {
  let config
  try {
    config = ensureMercadoLibreAdminConfigured()
  } catch (err) {
    return {
      ok: false,
      reason: 'config_missing',
      message: err?.message || 'meli_admin_auth_missing'
    }
  }

  const credentials = parseBasicAuthCredentials(req)
  if (!credentials) {
    return {
      ok: false,
      reason: 'missing_credentials'
    }
  }

  const userBuffer = Buffer.from(String(credentials.user || ''), 'utf8')
  const expectedUserBuffer = Buffer.from(config.adminAuthUser, 'utf8')
  const passwordBuffer = Buffer.from(String(credentials.password || ''), 'utf8')
  const expectedPasswordBuffer = Buffer.from(config.adminAuthPassword, 'utf8')

  const userMatches = userBuffer.length === expectedUserBuffer.length
    && crypto.timingSafeEqual(userBuffer, expectedUserBuffer)
  const passwordMatches = passwordBuffer.length === expectedPasswordBuffer.length
    && crypto.timingSafeEqual(passwordBuffer, expectedPasswordBuffer)

  if (!userMatches || !passwordMatches) {
    return {
      ok: false,
      reason: 'invalid_credentials'
    }
  }

  return {
    ok: true,
    mode: 'basic'
  }
}

function getMercadoLibreRequestIp(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown').trim() || 'unknown'
}

function hasMercadoLibreInternalAuthHeaders(req) {
  return Boolean(
    req.get(MERCADOLIBRE_INTERNAL_AUTH_CLIENT_HEADER)
    || req.get(MERCADOLIBRE_INTERNAL_AUTH_TIMESTAMP_HEADER)
    || req.get(MERCADOLIBRE_INTERNAL_AUTH_SIGNATURE_HEADER)
  )
}

function buildMercadoLibreInternalSignature({ clientId, timestamp, method, pathname }, secret) {
  const payload = [
    String(clientId || '').trim(),
    String(timestamp || '').trim(),
    String(method || '').trim().toUpperCase(),
    String(pathname || '').trim()
  ].join('\n')

  return crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('base64url')
}

function validateMercadoLibreInternalAuthorization(req) {
  if (!hasMercadoLibreInternalAuthHeaders(req)) {
    return {
      ok: false,
      reason: 'not_present'
    }
  }

  let config
  try {
    config = ensureMercadoLibreInternalAuthConfigured()
  } catch (err) {
    return {
      ok: false,
      reason: 'config_missing',
      message: err?.message || 'meli_internal_auth_missing'
    }
  }

  const clientId = String(req.get(MERCADOLIBRE_INTERNAL_AUTH_CLIENT_HEADER) || '').trim()
  const timestampText = String(req.get(MERCADOLIBRE_INTERNAL_AUTH_TIMESTAMP_HEADER) || '').trim()
  const signature = String(req.get(MERCADOLIBRE_INTERNAL_AUTH_SIGNATURE_HEADER) || '').trim()

  if (!clientId || !timestampText || !signature) {
    return {
      ok: false,
      reason: 'missing_headers'
    }
  }

  const timestamp = Number(timestampText)
  if (!Number.isFinite(timestamp)) {
    return {
      ok: false,
      reason: 'invalid_timestamp'
    }
  }

  if (Math.abs(Date.now() - timestamp) > MERCADOLIBRE_INTERNAL_AUTH_MAX_AGE_MS) {
    return {
      ok: false,
      reason: 'expired'
    }
  }

  const receivedClientId = Buffer.from(clientId, 'utf8')
  const expectedClientId = Buffer.from(config.internalClientId, 'utf8')
  const clientMatches = receivedClientId.length === expectedClientId.length
    && crypto.timingSafeEqual(receivedClientId, expectedClientId)

  if (!clientMatches) {
    return {
      ok: false,
      reason: 'invalid_client'
    }
  }

  const pathname = String(req.originalUrl || req.path || '').split('?')[0]
  const expectedSignature = buildMercadoLibreInternalSignature({
    clientId,
    timestamp: timestampText,
    method: req.method,
    pathname
  }, config.internalSharedSecret)

  const receivedSignature = Buffer.from(signature, 'utf8')
  const expectedSignatureBuffer = Buffer.from(expectedSignature, 'utf8')
  const signatureMatches = receivedSignature.length === expectedSignatureBuffer.length
    && crypto.timingSafeEqual(receivedSignature, expectedSignatureBuffer)

  if (!signatureMatches) {
    return {
      ok: false,
      reason: 'invalid_signature'
    }
  }

  return {
    ok: true,
    mode: 'internal',
    clientId
  }
}

function sendMercadoLibreApiAuthError(res, statusCode, message, extra = {}) {
  return res.status(statusCode).json({
    ok: false,
    error: message,
    ...extra
  })
}

function cleanupMercadoLibreAuthRateLimitStore(now = Date.now()) {
  if ((now - mercadolibreAuthRateLimitLastCleanupAt) < MERCADOLIBRE_AUTH_RATE_LIMIT_WINDOW_MS) {
    return
  }

  for (const [ip, entry] of mercadolibreAuthRateLimitStore.entries()) {
    if (!entry || (now - Number(entry.windowStartedAt || 0)) > MERCADOLIBRE_AUTH_RATE_LIMIT_WINDOW_MS) {
      mercadolibreAuthRateLimitStore.delete(ip)
    }
  }

  mercadolibreAuthRateLimitLastCleanupAt = now
}

function checkMercadoLibreAuthRateLimit(req) {
  const now = Date.now()
  cleanupMercadoLibreAuthRateLimitStore(now)

  const ip = getMercadoLibreRequestIp(req)
  const current = mercadolibreAuthRateLimitStore.get(ip)

  if (!current || (now - current.windowStartedAt) >= MERCADOLIBRE_AUTH_RATE_LIMIT_WINDOW_MS) {
    mercadolibreAuthRateLimitStore.set(ip, {
      attempts: 1,
      windowStartedAt: now
    })
    return {
      allowed: true,
      ip,
      attempts: 1,
      attemptsRemaining: MERCADOLIBRE_AUTH_RATE_LIMIT_MAX_ATTEMPTS - 1,
      retryAfterSeconds: 0
    }
  }

  current.attempts += 1
  mercadolibreAuthRateLimitStore.set(ip, current)

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((MERCADOLIBRE_AUTH_RATE_LIMIT_WINDOW_MS - (now - current.windowStartedAt)) / 1000)
  )

  if (current.attempts > MERCADOLIBRE_AUTH_RATE_LIMIT_MAX_ATTEMPTS) {
    return {
      allowed: false,
      ip,
      attempts: current.attempts,
      attemptsRemaining: 0,
      retryAfterSeconds
    }
  }

  return {
    allowed: true,
    ip,
    attempts: current.attempts,
    attemptsRemaining: Math.max(0, MERCADOLIBRE_AUTH_RATE_LIMIT_MAX_ATTEMPTS - current.attempts),
    retryAfterSeconds
  }
}

function requireMercadoLibreAdminAuthorization(req, res) {
  const realm = 'ALUMAS Mercado Libre OAuth'
  const validation = validateMercadoLibreBasicAuthorization(req)

  if (validation.ok) {
    req.mercadolibreAuthContext = validation
    return true
  }

  if (validation.reason === 'config_missing') {
    console.error('[MercadoLibre][OAuth] Proteccion admin no configurada:', JSON.stringify({
      error: validation.message || 'meli_admin_auth_missing'
    }))
    sendMercadoLibreOAuthPage(res, 503, {
      title: 'Proteccion administrativa no configurada',
      message: 'La autorizacion administrativa temporal de Mercado Libre no está configurada en el servidor.'
    })
    return false
  }

  if (validation.reason === 'missing_credentials') {
    res.setHeader('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`)
    sendMercadoLibreOAuthPage(res, 401, {
      title: 'Autorizacion requerida',
      message: 'Debes autenticarte como administrador para iniciar la conexion OAuth de Mercado Libre.'
    })
    return false
  }

  console.warn('[MercadoLibre][OAuth] Intento de acceso admin rechazado:', JSON.stringify({
    ip: getMercadoLibreRequestIp(req),
    user_agent: req.get('user-agent') || ''
  }))
  res.setHeader('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`)
  sendMercadoLibreOAuthPage(res, 401, {
    title: 'Autorizacion invalida',
    message: 'La autorizacion administrativa para iniciar OAuth de Mercado Libre es inválida.'
  })
  return false
}

function requireMercadoLibreApiAuthorization(req, res) {
  const internalValidation = validateMercadoLibreInternalAuthorization(req)
  if (internalValidation.ok) {
    req.mercadolibreAuthContext = internalValidation
    return true
  }

  if (hasMercadoLibreInternalAuthHeaders(req)) {
    console.warn('[MercadoLibre][API] Solicitud interna rechazada:', JSON.stringify({
      ip: getMercadoLibreRequestIp(req),
      reason: internalValidation.reason || 'invalid_internal_auth'
    }))
    return sendMercadoLibreApiAuthError(res, 401, 'La autorizacion interna de Mercado Libre es invalida o expiro.')
  }

  const basicValidation = validateMercadoLibreBasicAuthorization(req)
  if (basicValidation.ok) {
    req.mercadolibreAuthContext = basicValidation
    return true
  }

  if (basicValidation.reason === 'config_missing') {
    console.error('[MercadoLibre][API] Proteccion admin no configurada:', JSON.stringify({
      error: basicValidation.message || 'meli_admin_auth_missing'
    }))
    return sendMercadoLibreApiAuthError(res, 503, 'La autorizacion administrativa de Mercado Libre no esta configurada en el servidor.')
  }

  return sendMercadoLibreApiAuthError(res, 401, 'Debes autenticarte para usar esta operacion de Mercado Libre.')
}

async function createMercadoLibreOauthStateRecord(state, conn = pool) {
  const expiresAt = new Date(Date.now() + MERCADOLIBRE_OAUTH_STATE_MAX_AGE_MS)
  await conn.query(
    `INSERT INTO mercadolibre_oauth_states (state_hash, expires_at)
     VALUES (?, ?)`,
    [hashMercadoLibreState(state), expiresAt]
  )
  return { expiresAt }
}

async function consumeMercadoLibreOauthState(state, conn = pool) {
  const stateHash = hashMercadoLibreState(state)
  const [updateResult] = await conn.query(
    `UPDATE mercadolibre_oauth_states
     SET used_at = NOW()
     WHERE state_hash = ?
       AND used_at IS NULL
       AND expires_at >= NOW()`,
    [stateHash]
  )

  if (updateResult?.affectedRows === 1) {
    return { ok: true }
  }

  const [rows] = await conn.query(
    `SELECT used_at, expires_at
     FROM mercadolibre_oauth_states
     WHERE state_hash = ?
     LIMIT 1`,
    [stateHash]
  )

  if (!rows || rows.length === 0) {
    return { ok: false, reason: 'state_not_found' }
  }

  const row = rows[0]
  if (row.used_at) {
    return { ok: false, reason: 'state_already_used' }
  }

  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0
  if (!expiresAt || expiresAt < Date.now()) {
    return { ok: false, reason: 'state_expired' }
  }

  return { ok: false, reason: 'state_invalid' }
}

function getMercadoLibreAllowedUserId() {
  const { allowedUserId } = getMercadoLibreConfig()
  if (!allowedUserId) return null

  const normalized = String(allowedUserId).trim()
  if (!/^\d+$/.test(normalized)) {
    throw new Error('MERCADOLIBRE_ALLOWED_USER_ID debe contener solo digitos.')
  }

  return normalized
}

function buildMercadoLibreMissingScopes(scopeValue) {
  const scopeSet = new Set(
    String(scopeValue || '')
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean)
  )
  return MERCADOLIBRE_REQUIRED_SCOPES.filter((scope) => !scopeSet.has(scope))
}

async function mercadolibreApiRequest(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = MERCADOLIBRE_HTTP_TIMEOUT_MS,
    operation = 'request'
  } = options

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal
    })

    const contentType = response.headers.get('content-type') || ''
    const data = contentType.includes('application/json')
      ? await response.json().catch(() => null)
      : await response.text().catch(() => '')

    if (!response.ok) {
      const error = new Error(`Mercado Libre respondió con error en ${operation}.`)
      error.statusCode = response.status
      error.payload = sanitizeMercadoLibreError(data)
      throw error
    }

    return data
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeoutError = new Error(`Tiempo de espera agotado en ${operation} de Mercado Libre.`)
      timeoutError.statusCode = 504
      timeoutError.payload = { error: 'timeout', operation }
      throw timeoutError
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function exchangeMercadoLibreAuthorizationCode(code) {
  const { clientId, clientSecret, redirectUri } = ensureMercadoLibreConfigured()
  const form = new URLSearchParams()
  form.set('grant_type', 'authorization_code')
  form.set('client_id', clientId)
  form.set('client_secret', clientSecret)
  form.set('code', String(code || '').trim())
  form.set('redirect_uri', redirectUri)

  const data = await mercadolibreApiRequest(`${MERCADOLIBRE_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString(),
    operation: 'oauth_token'
  })

  if (!data?.access_token || !data?.refresh_token) {
    const error = new Error('No se pudo obtener el token de Mercado Libre.')
    error.statusCode = 502
    error.payload = sanitizeMercadoLibreError(data)
    throw error
  }

  return data
}

async function getMercadoLibreAuthenticatedUser(accessToken) {
  const data = await mercadolibreApiRequest(`${MERCADOLIBRE_API_BASE}/users/me`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    operation: 'users_me'
  })

  if (!data?.id) {
    const error = new Error('No se pudo consultar la cuenta de Mercado Libre.')
    error.statusCode = 502
    error.payload = sanitizeMercadoLibreError(data)
    throw error
  }

  return data
}

function isMercadoLibreUserProductSeller(userData) {
  const tags = Array.isArray(userData?.tags) ? userData.tags : []
  return tags.some((tag) => String(tag || '').trim().toLowerCase() === 'user_product_seller')
}

async function getMercadoLibreAccountByUserId(meliUserId, conn = pool) {
  const [rows] = await conn.query(
    'SELECT * FROM mercadolibre_cuentas WHERE meli_user_id = ? LIMIT 1',
    [String(meliUserId || '').trim()]
  )
  return rows && rows.length ? rows[0] : null
}

async function getMercadoLibrePrimaryAccount(conn = pool) {
  const [rows] = await conn.query(
    `SELECT *
     FROM mercadolibre_cuentas
     ORDER BY
       CASE WHEN LOWER(COALESCE(status, '')) = 'connected' THEN 0 ELSE 1 END,
       connected_at DESC,
       id DESC
     LIMIT 1`
  )
  return rows && rows.length ? rows[0] : null
}

async function upsertMercadoLibreAccount(data, conn = pool) {
  const sql = `
    INSERT INTO mercadolibre_cuentas (
      meli_user_id,
      nickname,
      site_id,
      scope,
      access_token_encrypted,
      refresh_token_encrypted,
      token_expires_at,
      connected_at,
      last_refresh_at,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NULL, ?)
    ON DUPLICATE KEY UPDATE
      nickname = VALUES(nickname),
      site_id = VALUES(site_id),
      scope = VALUES(scope),
      access_token_encrypted = VALUES(access_token_encrypted),
      refresh_token_encrypted = VALUES(refresh_token_encrypted),
      token_expires_at = VALUES(token_expires_at),
      status = VALUES(status),
      connected_at = VALUES(connected_at)
  `

  await conn.query(sql, [
    String(data.meliUserId || '').trim(),
    String(data.nickname || '').trim() || null,
    String(data.siteId || '').trim() || null,
    String(data.scope || '').trim() || null,
    String(data.accessTokenEncrypted || '').trim(),
    String(data.refreshTokenEncrypted || '').trim(),
    data.tokenExpiresAt || null,
    String(data.status || 'connected').trim() || 'connected'
  ])
}

async function updateMercadoLibreAccountTokens(data, conn = pool) {
  await conn.query(
    `UPDATE mercadolibre_cuentas
     SET
       access_token_encrypted = ?,
       refresh_token_encrypted = ?,
       token_expires_at = ?,
       scope = ?,
       last_refresh_at = NOW(),
       status = ?
     WHERE meli_user_id = ?`,
    [
      String(data.accessTokenEncrypted || '').trim(),
      String(data.refreshTokenEncrypted || '').trim(),
      data.tokenExpiresAt || null,
      String(data.scope || '').trim() || null,
      String(data.status || 'connected').trim() || 'connected',
      String(data.meliUserId || '').trim()
    ]
  )
}

function normalizeMercadoLibreDateTime(value) {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function normalizeMercadoLibreInteger(value, fallback = 0) {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) return fallback
  return Math.max(0, Math.trunc(numericValue))
}

function getMercadoLibreScopeValue(tokenData, fallback = '') {
  return String(tokenData?.scope || fallback || '').trim()
}

async function refreshMercadoLibreAccessToken(account, conn = pool) {
  if (!account?.meli_user_id) {
    const error = new Error('No existe una cuenta de Mercado Libre para renovar el token.')
    error.statusCode = 404
    throw error
  }

  const { clientId, clientSecret } = ensureMercadoLibreConfigured()
  const refreshToken = decryptMercadoLibreToken(account.refresh_token_encrypted)
  const form = new URLSearchParams()
  form.set('grant_type', 'refresh_token')
  form.set('client_id', clientId)
  form.set('client_secret', clientSecret)
  form.set('refresh_token', refreshToken)

  const tokenData = await mercadolibreApiRequest(`${MERCADOLIBRE_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString(),
    operation: 'oauth_refresh_token'
  })

  if (!tokenData?.access_token) {
    const error = new Error('Mercado Libre no devolvió un access token al renovar la cuenta.')
    error.statusCode = 502
    error.payload = sanitizeMercadoLibreError(tokenData)
    throw error
  }

  const scopeValue = getMercadoLibreScopeValue(tokenData, account.scope)
  const missingScopes = buildMercadoLibreMissingScopes(scopeValue)
  if (missingScopes.length > 0) {
    const error = new Error(`La renovación OAuth no devolvió todos los permisos requeridos: ${missingScopes.join(', ')}`)
    error.statusCode = 403
    error.payload = { missing_scopes: missingScopes }
    throw error
  }

  if (tokenData?.user_id && String(tokenData.user_id) !== String(account.meli_user_id)) {
    const error = new Error('La renovación OAuth devolvió una cuenta distinta a la registrada.')
    error.statusCode = 403
    error.payload = {
      expected_user_id: String(account.meli_user_id),
      received_user_id: String(tokenData.user_id)
    }
    throw error
  }

  const expiresInSeconds = Number(tokenData.expires_in || 0)
  const tokenExpiresAt = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
    ? new Date(Date.now() + (expiresInSeconds * 1000))
    : null

  await updateMercadoLibreAccountTokens({
    meliUserId: account.meli_user_id,
    accessTokenEncrypted: encryptMercadoLibreToken(tokenData.access_token),
    refreshTokenEncrypted: encryptMercadoLibreToken(tokenData.refresh_token || refreshToken),
    tokenExpiresAt,
    scope: scopeValue,
    status: 'connected'
  }, conn)

  const updatedAccount = await getMercadoLibreAccountByUserId(account.meli_user_id, conn)
  console.log('[MercadoLibre][OAuth] Token renovado correctamente:', JSON.stringify({
    user_id: String(account.meli_user_id),
    token: sanitizeMercadoLibreTokenResponse(tokenData)
  }))

  return {
    account: updatedAccount || account,
    accessToken: String(tokenData.access_token)
  }
}

async function getValidMercadoLibreAccessToken(conn = pool, options = {}) {
  const {
    forceRefresh = false
  } = options

  const account = await getMercadoLibrePrimaryAccount(conn)
  if (!account) {
    const error = new Error('No hay una cuenta de Mercado Libre conectada en ALUMAS.')
    error.statusCode = 404
    throw error
  }

  const tokenExpiresAtMs = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0
  const shouldRefresh = forceRefresh || (
    tokenExpiresAtMs
    && tokenExpiresAtMs <= (Date.now() + MERCADOLIBRE_TOKEN_REFRESH_BUFFER_MS)
  )

  if (!shouldRefresh) {
    return {
      account,
      accessToken: decryptMercadoLibreToken(account.access_token_encrypted)
    }
  }

  return refreshMercadoLibreAccessToken(account, conn)
}

function buildMercadoLibreApiUrl(pathname, searchParams = {}) {
  const url = new URL(pathname, `${MERCADOLIBRE_API_BASE}/`)
  for (const [key, value] of Object.entries(searchParams || {})) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

async function mercadolibreAuthenticatedRequest(accessToken, pathname, options = {}) {
  const {
    headers = {},
    ...rest
  } = options

  return mercadolibreApiRequest(pathname.startsWith('http') ? pathname : buildMercadoLibreApiUrl(pathname), {
    ...rest,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...headers
    }
  })
}

function chunkArray(items, size) {
  const output = []
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size))
  }
  return output
}

function extractMercadoLibreAttributeValue(item, attributeIds = []) {
  const normalizedIds = new Set(attributeIds.map((value) => String(value || '').trim().toUpperCase()))
  const attributes = Array.isArray(item?.attributes) ? item.attributes : []
  for (const attribute of attributes) {
    const attributeId = String(attribute?.id || attribute?.name || '').trim().toUpperCase()
    if (!normalizedIds.has(attributeId)) continue
    const value = attribute?.value_name ?? attribute?.value_id ?? attribute?.value_struct?.number
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim()
    }
  }
  return ''
}

function extractMercadoLibreSellerSku(item) {
  return String(
    item?.seller_custom_field
    || extractMercadoLibreAttributeValue(item, ['SELLER_SKU', 'SELLER_CUSTOM_FIELD'])
    || ''
  ).trim()
}

function extractMercadoLibreGtin(item) {
  return String(
    item?.gtin
    || extractMercadoLibreAttributeValue(item, ['GTIN', 'EAN'])
    || ''
  ).trim()
}

function isValidMercadoLibreGtin(value) {
  const normalized = String(value || '').trim()
  return /^\d{8,14}$/.test(normalized)
}

async function buildMercadoLibreProductoSelectFields(conn = pool) {
  const columns = await getTableColumns('productos', conn)
  const columnSet = new Set((columns || []).map((column) => String(column || '').toLowerCase()))
  const baseFields = [
    'id_producto',
    'codigo_barras',
    'nombre',
    'descripcion',
    'stock',
    'precio_final',
    'precio_mayorista',
    'imagen',
    'categoria_id'
  ]
  const mlFields = [
    'ml_enabled',
    'ml_brand',
    'ml_model',
    'ml_marketplace_description',
    'ml_publication_title',
    'ml_publication_price',
    'ml_gtin',
    'ml_weight_kg',
    'ml_package_length_cm',
    'ml_package_width_cm',
    'ml_package_height_cm',
    'ml_category_id',
    'ml_category_hint',
    'ml_listing_type',
    'ml_condition',
    'ml_published'
  ]

  const selectFields = [...baseFields.map((field) => `\`${field}\``)]
  for (const field of mlFields) {
    if (columnSet.has(field.toLowerCase())) {
      selectFields.push(`\`${field}\``)
    } else {
      selectFields.push(`NULL AS \`${field}\``)
    }
  }

  return selectFields.join(',\n       ')
}

async function getMercadoLibreStoredProductAttributes(idProducto, categoryId = null, conn = pool) {
  let columns = []
  try {
    columns = await getTableColumns('productos_mercadolibre_atributos', conn)
  } catch {
    return []
  }

  if (!Array.isArray(columns) || columns.length === 0) {
    return []
  }

  const productColumn = pickFirstExistingColumn(columns, ['producto_id', 'id_producto'])
  const attributeIdColumn = pickFirstExistingColumn(columns, ['attribute_id'])
  const valueIdColumn = pickFirstExistingColumn(columns, ['value_id'])
  const valueNameColumn = pickFirstExistingColumn(columns, ['value_name'])
  const categoryColumn = pickFirstExistingColumn(columns, ['category_id', 'ml_category_id'])
  const confirmedColumn = pickFirstExistingColumn(columns, ['is_confirmed'])

  if (!productColumn || !attributeIdColumn || (!valueIdColumn && !valueNameColumn)) {
    return []
  }

  const selectParts = [
    `\`${attributeIdColumn}\` AS attribute_id`
  ]
  if (valueIdColumn) selectParts.push(`\`${valueIdColumn}\` AS value_id`)
  if (valueNameColumn) selectParts.push(`\`${valueNameColumn}\` AS value_name`)
  if (categoryColumn) selectParts.push(`\`${categoryColumn}\` AS category_id`)
  if (confirmedColumn) selectParts.push(`\`${confirmedColumn}\` AS is_confirmed`)

  const [rows] = await conn.query(
    `SELECT
       ${selectParts.join(',\n       ')}
     FROM productos_mercadolibre_atributos
     WHERE \`${productColumn}\` = ?`,
    [Number(idProducto)]
  )

  const normalizedCategoryId = normalizeMercadoLibreStringValue(categoryId, 64)
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => {
      if (!confirmedColumn) return true
      return parseBooleanLike(row?.is_confirmed ?? false)
    })
    .filter((row) => {
      if (!categoryColumn) return true
      const rowCategoryId = normalizeMercadoLibreStringValue(row?.category_id, 64)
      return !normalizedCategoryId || !rowCategoryId || rowCategoryId === normalizedCategoryId
    })
    .map((row) => ({
      id: normalizeMercadoLibreStringValue(row?.attribute_id, 80).toUpperCase(),
      value_id: normalizeMercadoLibreStringValue(row?.value_id, 120) || undefined,
      value_name: normalizeMercadoLibreStringValue(row?.value_name, 255) || undefined
    }))
    .filter((attribute) => attribute.id && (attribute.value_id || attribute.value_name))
}

async function getProductoByIdProducto(idProducto, conn = pool) {
  const id = Number(idProducto)
  if (!Number.isFinite(id) || id <= 0) return null

  const selectFields = await buildMercadoLibreProductoSelectFields(conn)
  const [rows] = await conn.query(
    `SELECT
       ${selectFields}
     FROM productos
     WHERE id_producto = ?
     LIMIT 1`,
    [id]
  )
  return rows && rows.length ? rows[0] : null
}

async function getProductoByCodigoBarras(codigoBarras, conn = pool) {
  const codigo = String(codigoBarras || '').trim()
  if (!codigo) return null

  const selectFields = await buildMercadoLibreProductoSelectFields(conn)
  const [rows] = await conn.query(
    `SELECT
       ${selectFields}
     FROM productos
     WHERE codigo_barras = ?
     LIMIT 1`,
    [codigo]
  )
  return rows && rows.length ? rows[0] : null
}

async function resolveMercadoLibreProductoForItem(item, conn = pool) {
  const itemId = String(item?.id || '').trim()
  if (itemId) {
    const [mappedRows] = await conn.query(
      `SELECT producto_id
       FROM mercadolibre_publicaciones
       WHERE item_id = ?
         AND producto_id IS NOT NULL
       LIMIT 1`,
      [itemId]
    )
    if (mappedRows && mappedRows.length && mappedRows[0].producto_id) {
      const mappedProducto = await getProductoByIdProducto(mappedRows[0].producto_id, conn)
      if (mappedProducto) return mappedProducto
    }
  }

  const sellerSku = extractMercadoLibreSellerSku(item)
  if (/^\d+$/.test(sellerSku)) {
    const productoById = await getProductoByIdProducto(sellerSku, conn)
    if (productoById) return productoById
  }

  const gtin = extractMercadoLibreGtin(item)
  if (isValidMercadoLibreGtin(gtin)) {
    const productoByBarcode = await getProductoByCodigoBarras(gtin, conn)
    if (productoByBarcode) return productoByBarcode
  }

  return null
}

async function upsertMercadoLibrePublication(data, conn = pool) {
  await conn.query(
    `INSERT INTO mercadolibre_publicaciones (
       meli_user_id,
       item_id,
       producto_id,
       seller_sku,
       category_id,
       title,
       status,
       price,
       available_quantity,
       permalink,
       last_seen_at,
       raw_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE
       meli_user_id = VALUES(meli_user_id),
       producto_id = VALUES(producto_id),
       seller_sku = VALUES(seller_sku),
       category_id = VALUES(category_id),
       title = VALUES(title),
       status = VALUES(status),
       price = VALUES(price),
       available_quantity = VALUES(available_quantity),
       permalink = VALUES(permalink),
       last_seen_at = NOW(),
       raw_json = VALUES(raw_json)`,
    [
      String(data.meliUserId || '').trim(),
      String(data.itemId || '').trim(),
      data.productoId ? Number(data.productoId) : null,
      String(data.sellerSku || '').trim() || null,
      String(data.categoryId || '').trim() || null,
      String(data.title || '').trim() || null,
      String(data.status || '').trim() || null,
      data.price === null || data.price === undefined ? null : normalizeVentaNumeric(data.price, 0),
      data.availableQuantity === null || data.availableQuantity === undefined ? null : normalizeMercadoLibreInteger(data.availableQuantity, 0),
      String(data.permalink || '').trim() || null,
      toSafeJson(data.rawJson || null)
    ]
  )
}

async function getMercadoLibreExistingPublicationForProduct(productoId, conn = pool) {
  const normalizedProductoId = Number(productoId)
  if (!Number.isFinite(normalizedProductoId) || normalizedProductoId <= 0) {
    return null
  }

  const [rows] = await conn.query(
    `SELECT
       id,
       item_id,
       producto_id,
       seller_sku,
       category_id,
       title,
       status,
       price,
       available_quantity,
       permalink,
       created_at,
       updated_at
     FROM mercadolibre_publicaciones
     WHERE producto_id = ?
       AND item_id IS NOT NULL
       AND item_id <> ''
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`,
    [normalizedProductoId]
  )

  return rows && rows.length ? rows[0] : null
}

function isMercadoLibrePublicationAlreadyActive(publicacion) {
  const itemId = String(publicacion?.item_id || '').trim()
  const status = String(publicacion?.status || '').trim().toLowerCase()
  if (!itemId) return false
  if (!status) return true
  return MERCADOLIBRE_EXISTING_PUBLICATION_STATUSES.has(status)
}

async function updateMercadoLibreProductPublishedState(productoId, isPublished, conn = pool) {
  const columns = await getTableColumns('productos', conn)
  const columnSet = new Set((columns || []).map((column) => String(column || '').toLowerCase()))
  if (!columnSet.has('ml_published')) {
    return false
  }

  await conn.query(
    'UPDATE productos SET ml_published = ? WHERE id_producto = ? LIMIT 1',
    [isPublished ? 1 : 0, Number(productoId)]
  )
  return true
}

async function fetchMercadoLibreItemDetailsByIds(accessToken, itemIds) {
  const normalizedIds = [...new Set((Array.isArray(itemIds) ? itemIds : []).map((itemId) => String(itemId || '').trim()).filter(Boolean))]
  if (normalizedIds.length === 0) return []

  const items = []
  for (const chunk of chunkArray(normalizedIds, 20)) {
    const url = buildMercadoLibreApiUrl('/items', { ids: chunk.join(',') })
    const response = await mercadolibreAuthenticatedRequest(accessToken, url, {
      operation: 'items_batch'
    })
    const batchItems = Array.isArray(response) ? response : []
    for (const entry of batchItems) {
      if (Number(entry?.code) >= 200 && Number(entry?.code) < 300 && entry?.body) {
        items.push(entry.body)
      }
    }
  }
  return items
}

async function syncMercadoLibrePublicationsFromRemote(options = {}, conn = pool) {
  const limit = Math.max(1, Math.min(200, normalizeMercadoLibreInteger(options.limit, MERCADOLIBRE_DEFAULT_REMOTE_PAGE_SIZE)))
  const { account, accessToken } = await getValidMercadoLibreAccessToken(conn)
  const itemIds = []
  let offset = 0

  while (itemIds.length < limit) {
    const remaining = Math.min(MERCADOLIBRE_DEFAULT_REMOTE_PAGE_SIZE, limit - itemIds.length)
    const searchResponse = await mercadolibreAuthenticatedRequest(
      accessToken,
      buildMercadoLibreApiUrl(`/users/${account.meli_user_id}/items/search`, {
        limit: remaining,
        offset
      }),
      { operation: 'items_search' }
    )

    const results = Array.isArray(searchResponse?.results) ? searchResponse.results : []
    if (results.length === 0) break
    itemIds.push(...results.map((value) => String(value || '').trim()).filter(Boolean))

    const pagingTotal = normalizeMercadoLibreInteger(searchResponse?.paging?.total, 0)
    offset += results.length
    if (results.length < remaining || (pagingTotal > 0 && offset >= pagingTotal)) {
      break
    }
  }

  const items = await fetchMercadoLibreItemDetailsByIds(accessToken, itemIds.slice(0, limit))
  for (const item of items) {
    const producto = await resolveMercadoLibreProductoForItem(item, conn)
    await upsertMercadoLibrePublication({
      meliUserId: account.meli_user_id,
      itemId: item.id,
      productoId: producto?.id_producto || null,
      sellerSku: extractMercadoLibreSellerSku(item),
      categoryId: item.category_id || null,
      title: item.title,
      status: item.status,
      price: item.price,
      availableQuantity: item.available_quantity,
      permalink: item.permalink,
      rawJson: item
    }, conn)
  }

  return getMercadoLibrePublicationMappings({
    meliUserId: account.meli_user_id,
    limit
  }, conn)
}

async function getMercadoLibrePublicationMappings(filters = {}, conn = pool) {
  const limit = Math.max(1, Math.min(500, normalizeMercadoLibreInteger(filters.limit, 100)))
  const whereParts = ['1 = 1']
  const params = []

  if (filters.meliUserId) {
    whereParts.push('mp.meli_user_id = ?')
    params.push(String(filters.meliUserId))
  }

  if (filters.onlyMapped === true) {
    whereParts.push('mp.producto_id IS NOT NULL')
  }

  if (Array.isArray(filters.itemIds) && filters.itemIds.length > 0) {
    const itemIds = filters.itemIds.map((itemId) => String(itemId || '').trim()).filter(Boolean)
    if (itemIds.length > 0) {
      whereParts.push(`mp.item_id IN (${itemIds.map(() => '?').join(', ')})`)
      params.push(...itemIds)
    }
  }

  const [rows] = await conn.query(
    `SELECT
       mp.id,
       mp.meli_user_id,
       mp.item_id,
       mp.producto_id,
       mp.seller_sku,
       mp.category_id,
       mp.title,
       mp.status,
       mp.price,
       mp.available_quantity,
       mp.permalink,
       mp.last_seen_at,
       mp.last_stock_sync_at,
       mp.last_stock_sync_status,
       mp.last_stock_sync_message,
       p.id_producto AS producto_db_id,
       p.codigo_barras,
       p.nombre AS producto_nombre,
       p.stock AS producto_stock,
       p.precio_final AS producto_precio_final
     FROM mercadolibre_publicaciones mp
     LEFT JOIN productos p ON p.id_producto = mp.producto_id
     WHERE ${whereParts.join(' AND ')}
     ORDER BY mp.updated_at DESC
     LIMIT ?`,
    [...params, limit]
  )

  return rows || []
}

async function ensureMercadoLibrePublicationMapping(itemId, conn = pool) {
  const normalizedItemId = String(itemId || '').trim()
  if (!normalizedItemId) return null

  const [existingRows] = await conn.query(
    `SELECT *
     FROM mercadolibre_publicaciones
     WHERE item_id = ?
     LIMIT 1`,
    [normalizedItemId]
  )
  if (existingRows && existingRows.length) {
    return existingRows[0]
  }

  const { account, accessToken } = await getValidMercadoLibreAccessToken(conn)
  const items = await fetchMercadoLibreItemDetailsByIds(accessToken, [normalizedItemId])
  if (!items.length) return null

  const item = items[0]
  const producto = await resolveMercadoLibreProductoForItem(item, conn)
  await upsertMercadoLibrePublication({
    meliUserId: account.meli_user_id,
    itemId: item.id,
    productoId: producto?.id_producto || null,
    sellerSku: extractMercadoLibreSellerSku(item),
    categoryId: item.category_id || null,
    title: item.title,
    status: item.status,
    price: item.price,
    availableQuantity: item.available_quantity,
    permalink: item.permalink,
    rawJson: item
  }, conn)

  const [rows] = await conn.query(
    `SELECT *
     FROM mercadolibre_publicaciones
     WHERE item_id = ?
     LIMIT 1`,
    [normalizedItemId]
  )
  return rows && rows.length ? rows[0] : null
}

async function upsertMercadoLibreOrderSnapshot(order, account, conn = pool) {
  await conn.query(
    `INSERT INTO mercadolibre_ordenes (
       order_id,
       meli_user_id,
       status,
       status_detail,
       date_created,
       date_closed,
       date_last_updated,
       paid_at,
       total_amount,
       currency_id,
       buyer_nickname,
       buyer_first_name,
       buyer_last_name,
       processing_status,
       raw_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       meli_user_id = VALUES(meli_user_id),
       status = VALUES(status),
       status_detail = VALUES(status_detail),
       date_created = VALUES(date_created),
       date_closed = VALUES(date_closed),
       date_last_updated = VALUES(date_last_updated),
       paid_at = VALUES(paid_at),
       total_amount = VALUES(total_amount),
       currency_id = VALUES(currency_id),
       buyer_nickname = VALUES(buyer_nickname),
       buyer_first_name = VALUES(buyer_first_name),
       buyer_last_name = VALUES(buyer_last_name),
       raw_json = VALUES(raw_json)`,
    [
      Number(order?.id),
      String(account?.meli_user_id || '').trim(),
      String(order?.status || '').trim() || null,
      String(order?.status_detail || '').trim() || null,
      normalizeMercadoLibreDateTime(order?.date_created),
      normalizeMercadoLibreDateTime(order?.date_closed),
      normalizeMercadoLibreDateTime(order?.date_last_updated || order?.last_updated),
      normalizeMercadoLibreDateTime(order?.paid_at),
      order?.total_amount === null || order?.total_amount === undefined ? null : normalizeVentaNumeric(order.total_amount, 0),
      String(order?.currency_id || '').trim() || null,
      String(order?.buyer?.nickname || '').trim() || null,
      String(order?.buyer?.first_name || '').trim() || null,
      String(order?.buyer?.last_name || '').trim() || null,
      'pending',
      toSafeJson(order)
    ]
  )
}

async function getMercadoLibreOrderRowForUpdate(orderId, conn) {
  const [rows] = await conn.query(
    `SELECT *
     FROM mercadolibre_ordenes
     WHERE order_id = ?
     LIMIT 1
     FOR UPDATE`,
    [Number(orderId)]
  )
  return rows && rows.length ? rows[0] : null
}

async function updateMercadoLibreOrderProcessing(orderId, data, conn = pool) {
  await conn.query(
    `UPDATE mercadolibre_ordenes
     SET
       venta_id = ?,
       processing_status = ?,
       processing_message = ?,
       last_processed_at = ?,
       status = ?,
       status_detail = ?,
       paid_at = ?,
       date_closed = ?,
       date_last_updated = ?,
       raw_json = ?
     WHERE order_id = ?`,
    [
      data.ventaId ? Number(data.ventaId) : null,
      String(data.processingStatus || 'pending').trim() || 'pending',
      String(data.processingMessage || '').trim() || null,
      data.lastProcessedAt || null,
      String(data.status || '').trim() || null,
      String(data.statusDetail || '').trim() || null,
      data.paidAt || null,
      data.dateClosed || null,
      data.dateLastUpdated || null,
      data.rawJson === undefined ? null : toSafeJson(data.rawJson),
      Number(orderId)
    ]
  )
}

async function fetchMercadoLibreOrders(accessToken, sellerId, options = {}) {
  const limit = Math.max(1, Math.min(50, normalizeMercadoLibreInteger(options.limit, MERCADOLIBRE_DEFAULT_SYNC_LIMIT)))
  const offset = Math.max(0, normalizeMercadoLibreInteger(options.offset, 0))
  const response = await mercadolibreAuthenticatedRequest(
    accessToken,
    buildMercadoLibreApiUrl('/orders/search', {
      seller: sellerId,
      sort: 'date_desc',
      limit,
      offset
    }),
    { operation: 'orders_search' }
  )

  return {
    results: Array.isArray(response?.results) ? response.results : [],
    paging: response?.paging || {}
  }
}

async function getMercadoLibreOrderDetail(accessToken, orderId) {
  return mercadolibreAuthenticatedRequest(
    accessToken,
    `/orders/${Number(orderId)}`,
    { operation: 'order_detail' }
  )
}

function isMercadoLibreOrderProcessable(order) {
  const status = String(order?.status || '').trim().toLowerCase()
  if (MERCADOLIBRE_ORDER_PROCESSABLE_STATUSES.has(status)) {
    return { processable: true, reason: 'paid', processingStatus: 'ready' }
  }

  const approvedPayments = (Array.isArray(order?.payments) ? order.payments : []).filter((payment) => {
    return String(payment?.status || '').trim().toLowerCase() === 'approved'
  })

  if (approvedPayments.length > 0 && status !== 'cancelled') {
    return { processable: true, reason: 'approved_payment', processingStatus: 'ready' }
  }

  if (status === 'cancelled') {
    return { processable: false, reason: 'cancelled', processingStatus: 'skipped' }
  }

  return { processable: false, reason: status || 'pending', processingStatus: 'pending' }
}

async function getMercadoLibreIntegrationUserId(conn = pool) {
  const [adminRows] = await conn.query(
    `SELECT id_usuario
     FROM usuarios
     WHERE COALESCE(activo, 1) = 1
       AND LOWER(COALESCE(rol, '')) = 'admin'
     ORDER BY id_usuario ASC
     LIMIT 1`
  )
  if (adminRows && adminRows.length) {
    return Number(adminRows[0].id_usuario)
  }

  const [activeRows] = await conn.query(
    `SELECT id_usuario
     FROM usuarios
     WHERE COALESCE(activo, 1) = 1
     ORDER BY id_usuario ASC
     LIMIT 1`
  )
  if (activeRows && activeRows.length) {
    return Number(activeRows[0].id_usuario)
  }

  throw new Error('No existe un usuario activo en ALUMAS para registrar ventas importadas de Mercado Libre.')
}

async function resolveMercadoLibreClienteId(order, conn = pool) {
  const buyerName = String(
    `${order?.buyer?.first_name || ''} ${order?.buyer?.last_name || ''}`
  ).replace(/\s+/g, ' ').trim()
  const buyerNickname = String(order?.buyer?.nickname || '').trim()

  const candidateNames = [buyerName, buyerNickname].filter(Boolean)
  for (const candidateName of candidateNames) {
    const [rows] = await conn.query(
      `SELECT id_cliente
       FROM clientes
       WHERE TRIM(COALESCE(nombre, '')) = ?
       LIMIT 1`,
      [candidateName]
    )
    if (rows && rows.length) {
      return Number(rows[0].id_cliente)
    }
  }

  const [fallbackRows] = await conn.query(
    `SELECT id_cliente, nombre
     FROM clientes
     WHERE TRIM(COALESCE(nombre, '')) IN ('CONSUMIDOR FINAL', 'FERRETERIA GENERAL')
     ORDER BY CASE
       WHEN TRIM(COALESCE(nombre, '')) = 'CONSUMIDOR FINAL' THEN 0
       WHEN TRIM(COALESCE(nombre, '')) = 'FERRETERIA GENERAL' THEN 1
       ELSE 2
     END
     LIMIT 1`
  )
  if (fallbackRows && fallbackRows.length) {
    return Number(fallbackRows[0].id_cliente)
  }

  throw new Error('No se encontró un cliente reutilizable para registrar ventas importadas de Mercado Libre.')
}

async function buildMercadoLibreVentaBodyFromOrder(order, conn = pool) {
  const orderItems = Array.isArray(order?.order_items) ? order.order_items : []
  if (orderItems.length === 0) {
    throw new Error(`La orden ${order?.id} no contiene items para registrar en ALUMAS.`)
  }

  const ventaItems = []
  for (const orderItem of orderItems) {
    const itemId = String(orderItem?.item?.id || '').trim()
    if (!itemId) {
      throw new Error(`La orden ${order?.id} contiene un item sin item_id de Mercado Libre.`)
    }

    const publication = await ensureMercadoLibrePublicationMapping(itemId, conn)
    const productoId = Number(publication?.producto_id || 0)
    if (!productoId) {
      throw new Error(`La publicación ${itemId} de Mercado Libre no está vinculada a un producto de ALUMAS.`)
    }

    const producto = await getProductoByIdProducto(productoId, conn)
    if (!producto) {
      throw new Error(`El producto ${productoId} vinculado a la publicación ${itemId} ya no existe en ALUMAS.`)
    }

    const cantidad = normalizeVentaNumeric(orderItem?.quantity, 0)
    if (!cantidad || cantidad <= 0) {
      throw new Error(`La orden ${order?.id} contiene una cantidad inválida para el item ${itemId}.`)
    }

    const precioUnitario = normalizeVentaNumeric(
      orderItem?.unit_price ?? orderItem?.full_unit_price ?? producto.precio_final,
      0
    )
    const subtotal = Number((cantidad * precioUnitario).toFixed(2))

    ventaItems.push({
      id_producto: Number(producto.id_producto),
      producto_id: Number(producto.id_producto),
      descripcion: String(producto.nombre || orderItem?.item?.title || '').trim() || `Producto ${producto.id_producto}`,
      cantidad,
      precio_unitario: precioUnitario,
      valor_unitario: precioUnitario,
      subtotal,
      valor_total: subtotal
    })
  }

  const total = normalizeVentaNumeric(order?.total_amount, ventaItems.reduce((acc, item) => acc + normalizeVentaNumeric(item.valor_total, 0), 0))
  const usuarioId = await getMercadoLibreIntegrationUserId(conn)
  const clienteId = await resolveMercadoLibreClienteId(order, conn)

  return {
    usuario_id: usuarioId,
    cliente_id: clienteId,
    total,
    tipo_pago: 'CONTADO',
    forma_pago: 'MERCADO_LIBRE',
    punto_venta: 'mercadolibre',
    observation: `Venta importada desde Mercado Libre. Orden ${order.id}.`,
    factura_electronica: false,
    items: ventaItems,
    payment_details: [
      {
        payment_form: 'contado',
        payment_method_code: 'mercado_libre',
        amount: total,
        reference_code: `ML-${order.id}`
      }
    ]
  }
}

async function getMercadoLibreOrderRowsByIds(orderIds, conn = pool) {
  const normalizedOrderIds = [...new Set((Array.isArray(orderIds) ? orderIds : [])
    .map((orderId) => Number(orderId))
    .filter((orderId) => Number.isFinite(orderId) && orderId > 0))]

  if (normalizedOrderIds.length === 0) return []

  const [rows] = await conn.query(
    `SELECT *
     FROM mercadolibre_ordenes
     WHERE order_id IN (${normalizedOrderIds.map(() => '?').join(', ')})`,
    normalizedOrderIds
  )
  return rows || []
}

async function processMercadoLibreOrderImport(order, account) {
  const orderId = Number(order?.id)
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden de Mercado Libre inválida.')
  }

  await upsertMercadoLibreOrderSnapshot(order, account)

  const processability = isMercadoLibreOrderProcessable(order)
  if (!processability.processable) {
    await updateMercadoLibreOrderProcessing(orderId, {
      processingStatus: processability.processingStatus,
      processingMessage: `La orden ${orderId} todavía no está lista para importarse (${processability.reason}).`,
      lastProcessedAt: new Date(),
      status: order?.status,
      statusDetail: order?.status_detail,
      paidAt: normalizeMercadoLibreDateTime(order?.paid_at),
      dateClosed: normalizeMercadoLibreDateTime(order?.date_closed),
      dateLastUpdated: normalizeMercadoLibreDateTime(order?.date_last_updated || order?.last_updated),
      rawJson: order
    })
    return {
      order_id: orderId,
      status: processability.processingStatus,
      reason: processability.reason
    }
  }

  const ventaBody = await buildMercadoLibreVentaBodyFromOrder(order)
  const conn = await pool.getConnection()

  try {
    await conn.beginTransaction()

    const lockedOrder = await getMercadoLibreOrderRowForUpdate(orderId, conn)
    if (lockedOrder?.venta_id) {
      await conn.commit()
      return {
        order_id: orderId,
        status: 'already_processed',
        venta_id: Number(lockedOrder.venta_id)
      }
    }

    const ventaResult = await processVentaWithExistingLogic(conn, ventaBody, {
      allowFacturaElectronica: false
    })

    await updateMercadoLibreOrderProcessing(orderId, {
      ventaId: ventaResult.resolvedConsecutivo,
      processingStatus: 'processed',
      processingMessage: `Orden ${orderId} importada correctamente a la venta ${ventaResult.resolvedConsecutivo}.`,
      lastProcessedAt: new Date(),
      status: order?.status,
      statusDetail: order?.status_detail,
      paidAt: normalizeMercadoLibreDateTime(order?.paid_at),
      dateClosed: normalizeMercadoLibreDateTime(order?.date_closed),
      dateLastUpdated: normalizeMercadoLibreDateTime(order?.date_last_updated || order?.last_updated),
      rawJson: order
    }, conn)

    await conn.commit()

    return {
      order_id: orderId,
      status: 'processed',
      venta_id: Number(ventaResult.resolvedConsecutivo)
    }
  } catch (err) {
    try { await conn.rollback() } catch {}
    await updateMercadoLibreOrderProcessing(orderId, {
      processingStatus: 'error',
      processingMessage: err?.message || 'No se pudo importar la orden de Mercado Libre.',
      lastProcessedAt: new Date(),
      status: order?.status,
      statusDetail: order?.status_detail,
      paidAt: normalizeMercadoLibreDateTime(order?.paid_at),
      dateClosed: normalizeMercadoLibreDateTime(order?.date_closed),
      dateLastUpdated: normalizeMercadoLibreDateTime(order?.date_last_updated || order?.last_updated),
      rawJson: order
    })
    throw err
  } finally {
    conn.release()
  }
}

async function syncMercadoLibreStock(mappings, accessToken, conn = pool) {
  const results = []
  for (const mapping of mappings) {
    const itemId = String(mapping?.item_id || '').trim()
    const productoId = Number(mapping?.producto_id || 0)

    if (!itemId || !productoId) {
      results.push({
        item_id: itemId || null,
        producto_id: productoId || null,
        status: 'skipped',
        message: 'La publicación no tiene un producto de ALUMAS vinculado.'
      })
      continue
    }

    const [rows] = await conn.query(
      `SELECT id_producto, stock
       FROM productos
       WHERE id_producto = ?
       LIMIT 1`,
      [productoId]
    )
    const producto = rows && rows.length ? rows[0] : null
    if (!producto) {
      await conn.query(
        `UPDATE mercadolibre_publicaciones
         SET
           last_stock_sync_at = NOW(),
           last_stock_sync_status = ?,
           last_stock_sync_message = ?
         WHERE item_id = ?`,
        ['error', 'El producto vinculado ya no existe en ALUMAS.', itemId]
      )
      results.push({
        item_id: itemId,
        producto_id: productoId,
        status: 'error',
        message: 'El producto vinculado ya no existe en ALUMAS.'
      })
      continue
    }

    const availableQuantity = normalizeMercadoLibreInteger(producto.stock, 0)
    try {
      await mercadolibreAuthenticatedRequest(accessToken, `/items/${itemId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          available_quantity: availableQuantity
        }),
        operation: `item_stock_${itemId}`
      })

      await conn.query(
        `UPDATE mercadolibre_publicaciones
         SET
           available_quantity = ?,
           last_stock_sync_at = NOW(),
           last_stock_sync_status = ?,
           last_stock_sync_message = ?
         WHERE item_id = ?`,
        [availableQuantity, 'synced', `Stock sincronizado desde ALUMAS: ${availableQuantity}`, itemId]
      )

      results.push({
        item_id: itemId,
        producto_id: productoId,
        stock: availableQuantity,
        status: 'synced'
      })
    } catch (err) {
      await conn.query(
        `UPDATE mercadolibre_publicaciones
         SET
           last_stock_sync_at = NOW(),
           last_stock_sync_status = ?,
           last_stock_sync_message = ?
         WHERE item_id = ?`,
        ['error', String(err?.message || 'No se pudo sincronizar el stock.').slice(0, 255), itemId]
      )
      results.push({
        item_id: itemId,
        producto_id: productoId,
        stock: availableQuantity,
        status: 'error',
        message: err?.message || 'No se pudo sincronizar el stock.'
      })
    }
  }

  return results
}

function normalizeMercadoLibreLimitQuery(value, fallback) {
  return Math.max(1, Math.min(200, normalizeMercadoLibreInteger(value, fallback)))
}

function normalizeMercadoLibreStringValue(value, maxLength = 0) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  if (maxLength > 0) {
    return normalized.slice(0, maxLength)
  }
  return normalized
}

function buildMercadoLibreProductoImageUrl(producto, req = null) {
  const imagen = String(producto?.imagen || '').trim()
  if (!imagen) return ''
  if (/^https?:\/\//i.test(imagen)) return imagen
  const nombreArchivo = path.basename(imagen.replace(/\\/g, '/')).trim()
  if (!nombreArchivo) return ''
  return `${getServerPublicBaseUrl(req)}/img/productos/${encodeURIComponent(nombreArchivo)}`
}

function formatMercadoLibrePlainNumberString(value, maxDecimals = 2) {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue) || numericValue <= 0) return ''
  const fixed = numericValue.toFixed(Math.max(0, maxDecimals))
  return fixed.replace(/\.?0+$/, '')
}

function getMercadoLibrePackageMetrics(producto) {
  const heightCm = Number(producto?.ml_package_height_cm)
  const widthCm = Number(producto?.ml_package_width_cm)
  const lengthCm = Number(producto?.ml_package_length_cm)
  const weightKg = Number(producto?.ml_weight_kg)
  const weightGrams = Number.isFinite(weightKg) && weightKg > 0
    ? Math.round(weightKg * 1000)
    : 0

  return {
    heightCm: Number.isFinite(heightCm) && heightCm > 0 ? heightCm : 0,
    widthCm: Number.isFinite(widthCm) && widthCm > 0 ? widthCm : 0,
    lengthCm: Number.isFinite(lengthCm) && lengthCm > 0 ? lengthCm : 0,
    weightKg: Number.isFinite(weightKg) && weightKg > 0 ? weightKg : 0,
    weightGrams: weightGrams > 0 ? weightGrams : 0
  }
}

function buildMercadoLibreDefaultAttributes(producto) {
  const attributes = []
  const brand = normalizeMercadoLibreStringValue(producto?.ml_brand, 255)
  const model = normalizeMercadoLibreStringValue(producto?.ml_model, 255)
  const gtin = normalizeMercadoLibreStringValue(producto?.ml_gtin || producto?.codigo_barras, 32)

  if (brand) {
    attributes.push({
      id: 'BRAND',
      value_name: brand
    })
  }

  if (model) {
    attributes.push({
      id: 'MODEL',
      value_name: model
    })
  }

  if (isValidMercadoLibreGtin(gtin)) {
    attributes.push({
      id: 'GTIN',
      value_name: gtin
    })
  }

  const packageMetrics = getMercadoLibrePackageMetrics(producto)
  const packageAttributeMap = [
    ['SELLER_PACKAGE_HEIGHT', formatMercadoLibrePlainNumberString(packageMetrics.heightCm, 2)],
    ['SELLER_PACKAGE_WIDTH', formatMercadoLibrePlainNumberString(packageMetrics.widthCm, 2)],
    ['SELLER_PACKAGE_LENGTH', formatMercadoLibrePlainNumberString(packageMetrics.lengthCm, 2)],
    ['SELLER_PACKAGE_WEIGHT', packageMetrics.weightGrams > 0 ? String(packageMetrics.weightGrams) : '']
  ]

  for (const [attributeId, valueName] of packageAttributeMap) {
    if (!valueName) continue
    attributes.push({
      id: attributeId,
      value_name: valueName
    })
  }

  return attributes
}

function buildMercadoLibreStoredAttributes(producto) {
  return normalizeMercadoLibrePublicationAttributes(producto?._ml_stored_attributes || [])
}

function normalizeMercadoLibrePublicationAttributes(attributes) {
  if (!Array.isArray(attributes)) return []
  const normalizedMap = new Map()
  for (const attribute of attributes) {
    const id = normalizeMercadoLibreStringValue(attribute?.id, 80).toUpperCase()
    if (!id) continue
    const valueId = normalizeMercadoLibreStringValue(attribute?.value_id, 120)
    const valueName = normalizeMercadoLibreStringValue(attribute?.value_name, 255)
    const entry = { id }
    if (valueId) entry.value_id = valueId
    if (valueName) entry.value_name = valueName
    if (!entry.value_id && !entry.value_name) continue
    normalizedMap.set(id, entry)
  }
  return [...normalizedMap.values()]
}

function getMercadoLibreAttributeMap(attributes) {
  const attributeMap = new Map()
  for (const attribute of normalizeMercadoLibrePublicationAttributes(attributes)) {
    attributeMap.set(String(attribute.id || '').trim().toUpperCase(), attribute)
  }
  return attributeMap
}

function getMercadoLibreRequiredAttributesMissing(categoryAttributes, draftAttributes) {
  const draftAttributeMap = getMercadoLibreAttributeMap(draftAttributes)
  return (Array.isArray(categoryAttributes) ? categoryAttributes : [])
    .filter((attribute) => attribute?.tags?.required === true || String(attribute?.tags?.required || '').toLowerCase() === 'true')
    .filter((attribute) => !draftAttributeMap.has(String(attribute?.id || '').trim().toUpperCase()))
    .map((attribute) => ({
      id: String(attribute?.id || '').trim(),
      name: String(attribute?.name || attribute?.id || '').trim() || null
    }))
}

async function getMercadoLibreListingTypes(siteId, accessToken) {
  const listingTypes = await mercadolibreAuthenticatedRequest(
    accessToken,
    buildMercadoLibreApiUrl(`/sites/${siteId}/listing_types`),
    { operation: 'listing_types' }
  )
  return Array.isArray(listingTypes) ? listingTypes : []
}

async function suggestMercadoLibreCategory(siteId, query, accessToken) {
  const normalizedQuery = normalizeMercadoLibreStringValue(query, 120)
  if (!normalizedQuery) return []
  const predictions = await mercadolibreAuthenticatedRequest(
    accessToken,
    buildMercadoLibreApiUrl(`/sites/${siteId}/domain_discovery/search`, {
      q: normalizedQuery,
      limit: 3
    }),
    { operation: 'category_predictor' }
  )
  return Array.isArray(predictions) ? predictions : []
}

async function getMercadoLibreCategoryAttributes(categoryId, accessToken) {
  const normalizedCategoryId = normalizeMercadoLibreStringValue(categoryId, 64)
  if (!normalizedCategoryId) return []
  const attributes = await mercadolibreAuthenticatedRequest(
    accessToken,
    buildMercadoLibreApiUrl(`/categories/${normalizedCategoryId}/attributes`),
    { operation: 'category_attributes' }
  )
  return Array.isArray(attributes) ? attributes : []
}

async function getMercadoLibreCategoryDetail(categoryId, accessToken) {
  const normalizedCategoryId = normalizeMercadoLibreStringValue(categoryId, 64)
  if (!normalizedCategoryId) return null
  return mercadolibreAuthenticatedRequest(
    accessToken,
    buildMercadoLibreApiUrl(`/categories/${normalizedCategoryId}`),
    { operation: 'category_detail' }
  )
}

async function getMercadoLibreProductForPublishing(idProducto, conn = pool) {
  const producto = await getProductoByIdProducto(idProducto, conn)
  if (!producto) {
    const error = new Error('Producto no encontrado en ALUMAS.')
    error.statusCode = 404
    throw error
  }
  producto._ml_stored_attributes = await getMercadoLibreStoredProductAttributes(
    producto.id_producto,
    producto.ml_category_id,
    conn
  )
  return producto
}

async function buildMercadoLibrePublicationDraft(producto, options = {}, req = null) {
  const mlEnabled = parseBooleanLike(options.mlEnabled ?? producto.ml_enabled ?? false)
  const isUserProductSeller = parseBooleanLike(options.isUserProductSeller ?? false)
  const categoryId = normalizeMercadoLibreStringValue(options.categoryId || producto.ml_category_id, 64)
  const requestTitle = normalizeMercadoLibreStringValue(options.title, 255)
  const storedPublicationTitle = normalizeMercadoLibreStringValue(producto?.ml_publication_title, 255)
  const baseProductTitle = normalizeMercadoLibreStringValue(producto?.nombre, 255)
  const effectiveTitleSource = requestTitle || storedPublicationTitle || baseProductTitle || ''
  const normalizedRequestPrice = normalizeVentaNumeric(options.price, 0)
  const normalizedStoredPublicationPrice = normalizeVentaNumeric(producto?.ml_publication_price, 0)
  const normalizedBaseProductPrice = normalizeVentaNumeric(producto?.precio_final, 0)
  const effectivePriceSource = normalizedRequestPrice > 0
    ? normalizedRequestPrice
    : normalizedStoredPublicationPrice > 0
      ? normalizedStoredPublicationPrice
      : normalizedBaseProductPrice
  const title = normalizeMercadoLibreStringValue(
    effectiveTitleSource,
    60
  )
  const familyName = normalizeMercadoLibreStringValue(
    options.familyName || title || effectiveTitleSource || '',
    60
  )
  const description = normalizeMercadoLibreStringValue(
    options.description || producto.ml_marketplace_description || producto.descripcion || producto.nombre || '',
    50000
  )
  const price = normalizeVentaNumeric(
    effectivePriceSource,
    0
  )
  const stockValue = options.availableQuantity ?? producto.stock
  const availableQuantity = Math.max(0, normalizeMercadoLibreInteger(stockValue, 0))
  const listingTypeId = normalizeMercadoLibreStringValue(options.listingTypeId || producto.ml_listing_type, 64) || 'gold_special'
  const condition = normalizeMercadoLibreStringValue(options.condition || producto.ml_condition, 16) || 'new'
  const pictures = []
  const imageUrl = normalizeMercadoLibreStringValue(options.imageUrl || buildMercadoLibreProductoImageUrl(producto, req), 500)
  if (imageUrl) {
    pictures.push({ source: imageUrl })
  }

  const packageMetrics = getMercadoLibrePackageMetrics(producto)
  const attributes = normalizeMercadoLibrePublicationAttributes([
    ...buildMercadoLibreDefaultAttributes(producto),
    ...buildMercadoLibreStoredAttributes(producto),
    ...(Array.isArray(options.attributes) ? options.attributes : [])
  ])
  const saleTerms = [
    {
      id: 'MANUFACTURING_TIME',
      value_name: '0'
    }
  ]

  const missing = []
  if (!mlEnabled) missing.push('ml_enabled')
  if (!categoryId) missing.push('category_id')
  if (!isUserProductSeller && !title) missing.push('title')
  if (!familyName) missing.push('family_name')
  if (!(price > 0)) missing.push('price')
  if (availableQuantity < 0) missing.push('available_quantity')
  if (!listingTypeId) missing.push('listing_type_id')
  if (!condition) missing.push('condition')
  if (pictures.length === 0) missing.push('pictures')
  if (!(packageMetrics.weightGrams > 0)) missing.push('ml_weight_kg')
  if (!(packageMetrics.lengthCm > 0)) missing.push('ml_package_length_cm')
  if (!(packageMetrics.widthCm > 0)) missing.push('ml_package_width_cm')
  if (!(packageMetrics.heightCm > 0)) missing.push('ml_package_height_cm')

  const draft = {
    family_name: familyName,
    category_id: categoryId,
    price,
    currency_id: 'COP',
    available_quantity: availableQuantity,
    buying_mode: 'buy_it_now',
    listing_type_id: listingTypeId,
    condition,
    seller_custom_field: String(producto.id_producto),
    channels: ['marketplace'],
    pictures,
    attributes,
    sale_terms: saleTerms
  }

  if (!isUserProductSeller) {
    draft.title = title
  }

  return {
    producto,
    draft,
    description,
    metadata: {
      user_product_seller: isUserProductSeller,
      payload_model: isUserProductSeller ? 'user_products' : 'legacy_item',
      title_sent: !isUserProductSeller,
      effective_title: title || familyName || null,
      effective_price: price > 0 ? price : null,
      effective_title_source: requestTitle
        ? 'request'
        : storedPublicationTitle
          ? 'ml_publication_title'
          : 'nombre',
      effective_price_source: normalizedRequestPrice > 0
        ? 'request'
        : normalizedStoredPublicationPrice > 0
          ? 'ml_publication_price'
          : 'precio_final',
      ml_enabled: mlEnabled,
      image_url: imageUrl || null,
      family_name: familyName || null,
      title: title || null,
      gtin: normalizeMercadoLibreStringValue(producto?.ml_gtin || producto?.codigo_barras, 32) || null,
      brand: normalizeMercadoLibreStringValue(producto?.ml_brand, 255) || null,
      model: normalizeMercadoLibreStringValue(producto?.ml_model, 255) || null,
      package_height_cm: packageMetrics.heightCm || null,
      package_width_cm: packageMetrics.widthCm || null,
      package_length_cm: packageMetrics.lengthCm || null,
      weight_kg: packageMetrics.weightKg || null,
      weight_grams: packageMetrics.weightGrams || null,
      stored_attributes_count: Array.isArray(producto?._ml_stored_attributes) ? producto._ml_stored_attributes.length : 0
    },
    missing
  }
}

function buildMercadoLibrePublicationPayload(publicationDraft, options = {}) {
  const payload = removeEmptyObjectFields({
    ...(publicationDraft && typeof publicationDraft === 'object' ? publicationDraft : {})
  })
  const isUserProductSeller = parseBooleanLike(options.userProductSeller ?? false)
  if (isUserProductSeller) {
    delete payload.title
  }
  return payload
}

async function publishMercadoLibreItem(producto, publicationDraft, description, account, accessToken, conn = pool) {
  const payload = buildMercadoLibrePublicationPayload(publicationDraft, {
    userProductSeller: !Object.prototype.hasOwnProperty.call(publicationDraft || {}, 'title')
  })
  let createdItem
  try {
    createdItem = await mercadolibreAuthenticatedRequest(accessToken, '/items', {
      method: 'POST',
      operation: 'items_create',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
  } catch (err) {
    err.publicationPayload = payload
    throw err
  }

  const itemId = String(createdItem?.id || '').trim()
  if (!itemId) {
    const error = new Error('Mercado Libre no devolvio un item_id al crear la publicacion.')
    error.statusCode = 502
    throw error
  }

  const normalizedDescription = normalizeMercadoLibreStringValue(description, 50000)
  if (normalizedDescription) {
    try {
      await mercadolibreAuthenticatedRequest(accessToken, `/items/${itemId}/description`, {
        method: 'POST',
        operation: 'item_description_create',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          plain_text: normalizedDescription
        })
      })
    } catch (err) {
      console.warn('[MercadoLibre][Publicacion] No se pudo guardar la descripcion inicial:', JSON.stringify({
        item_id: itemId,
        status: err?.statusCode,
        error: err?.message || 'description_create_failed',
        payload: err?.payload || undefined
      }))
    }
  }

  const productoRelacionado = await resolveMercadoLibreProductoForItem({
    ...createdItem,
    seller_custom_field: publicationDraft.seller_custom_field
  }, conn)

  await upsertMercadoLibrePublication({
    meliUserId: account.meli_user_id,
    itemId,
    productoId: productoRelacionado?.id_producto || producto.id_producto,
    sellerSku: extractMercadoLibreSellerSku({
      ...createdItem,
      seller_custom_field: payload.seller_custom_field
    }),
    categoryId: createdItem.category_id || payload.category_id || null,
    title: createdItem.title || payload.title || payload.family_name || null,
    status: createdItem.status || null,
    price: createdItem.price ?? payload.price,
    availableQuantity: createdItem.available_quantity ?? payload.available_quantity,
    permalink: createdItem.permalink || null,
    rawJson: createdItem
  }, conn)
  await updateMercadoLibreProductPublishedState(productoRelacionado?.id_producto || producto.id_producto, true, conn)

  return createdItem
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

function sanitizeFactusAuthResponse(data) {
  return removeEmptyObjectFields({
    token_type: data?.token_type,
    expires_in: data?.expires_in,
    scope: data?.scope
  })
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

  console.log('[Factus][OAuth] Solicitud de token:', JSON.stringify({
    environment: getFactusEnvironmentName(),
    endpoint: `${getFactusApiBase()}/oauth/token`,
    force_refresh: !!forceRefresh,
    username: String(process.env.FACTUS_USERNAME || '').trim(),
    grant_type: 'password'
  }))

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
    console.error('[Factus][OAuth] Error de autenticacion:', JSON.stringify({
      status: response.status,
      response: data
    }))
    throw new Error(extractFactusErrorMessage(data, 'No se pudo autenticar contra Factus.'))
  }

  console.log('[Factus][OAuth] Respuesta recibida:', JSON.stringify({
    status: response.status,
    response: sanitizeFactusAuthResponse(data)
  }))

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

function getFactusNumberingDocumentCode() {
  return String(process.env.FACTUS_DOCUMENT_CODE || '21').trim() || '21'
}

function getFactusBillDocumentCode() {
  return String(process.env.FACTUS_BILL_DOCUMENT_CODE || '01').trim() || '01'
}

async function getFactusActiveNumberingRange() {
  ensureFactusConfigured()
  const configuredId = Number(process.env.FACTUS_NUMBERING_RANGE_ID || 0)
  const documentCode = getFactusNumberingDocumentCode()
  const params = new URLSearchParams()
  params.set('filter[document]', documentCode)
  params.set('filter[is_active]', '1')
  if (configuredId > 0) {
    params.set('filter[id]', String(configuredId))
  }

  console.log('[Factus][NumberingRange] Consulta de rangos:', JSON.stringify({
    endpoint: `/v2/numbering-ranges?${params.toString()}`,
    configured_id: configuredId > 0 ? configuredId : null,
    document_code: documentCode,
    environment: getFactusEnvironmentName()
  }))
  let payload
  try {
    payload = await factusApiRequest(`/v2/numbering-ranges?${params.toString()}`)
    console.log('[Factus][NumberingRange] Respuesta completa:', JSON.stringify({
      typeof_payload: typeof payload,
      payload,
      payload_data: payload?.data,
      is_array_payload_data: Array.isArray(payload?.data),
      payload_data_length: Array.isArray(payload?.data)
        ? payload.data.length
        : (payload?.data && typeof payload.data.length !== 'undefined' ? payload.data.length : null)
    }))
  } catch (err) {
    console.error('[Factus][NumberingRange] Excepcion consultando rangos:', JSON.stringify({
      message: err?.message || null,
      stack: err?.stack || null,
      response: err?.payload || err?.response || null
    }))
    throw err
  }

  const ranges = parseFactusNumberingResponse(payload)
  if (!Array.isArray(ranges) || ranges.length === 0) {
    console.warn('[Factus][NumberingRange] No se encontraron rangos activos:', JSON.stringify({
      payload
    }))
  }
  const activeRange = ranges.find((range) => Number(range?.is_active || 0) === 1 && Number(range?.is_expired || 0) === 0)
    || ranges[0]

  if (!activeRange?.id) {
    throw new Error('Factus no devolvió un rango de numeración activo para factura electrónica.')
  }

  console.log('[Factus][NumberingRange] Rango seleccionado:', JSON.stringify({
    total_ranges: ranges.length,
    selected: activeRange
  }))

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
       , ${selectField('department_code')}
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
  const identificationDocumentCode = String(cliente.identification_document_code || '').trim()
  const identification = String(cliente.identification || cliente.nit_cc || '').trim()
  const company = String(cliente.company || cliente.trade_name || '').trim()
  const names = String(cliente.names || cliente.nombre || '').trim()
  const factusStatus = buildClienteFactusEmissionStatus(cliente)
  if (!factusStatus.ready) {
    const error = new Error(factusStatus.message)
    error.statusCode = 422
    error.payload = {
      status: 'Validation error',
      message: factusStatus.message,
      data: {
        message: factusStatus.message,
        errors: factusStatus.missing_fields.reduce((acc, key, index) => {
          acc[key] = factusStatus.missing_labels[index] || key
          return acc
        }, {})
      }
    }
    throw error
  }

  const payload = removeEmptyObjectFields({
    identification_document_code: identificationDocumentCode,
    identification,
    dv: String(cliente.dv || '').trim() || undefined,
    legal_organization_code: legalOrganizationCode,
    tribute_code: String(cliente.tribute_code || '').trim() || undefined,
    company: legalOrganizationCode === '1' ? (company || names) : company,
    trade_name: String(cliente.trade_name || '').trim(),
    names: legalOrganizationCode === '1' ? (names || company) : (names || company),
    address: String(cliente.direccion || '').trim(),
    email: String(cliente.email || '').trim(),
    phone: String(cliente.telefono || '').trim(),
    country_code: String(cliente.country_code || '').trim() || undefined,
    municipality_code: String(cliente.municipality_code || '').trim() || undefined
  })

  if (!payload.identification_document_code || !payload.identification || !payload.legal_organization_code || !payload.tribute_code || !payload.address || !payload.email || !payload.country_code || !payload.municipality_code) {
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

function buildClienteFactusEmissionStatus(cliente) {
  const baseStatus = buildClienteFacturacionStatus(cliente)
  const identificationDocumentCode = String(cliente?.identification_document_code || '').trim()
  const extraFields = [
    {
      key: 'municipality_code',
      label: 'Municipio DIAN / Factus',
      value: String(cliente?.municipality_code || '').trim()
    },
    {
      key: 'country_code',
      label: 'Pais DIAN / Factus',
      value: String(cliente?.country_code || '').trim()
    }
  ]

  if (String(cliente?.department_code || '').trim()) {
    extraFields.push({
      key: 'department_code',
      label: 'Departamento DIAN / Factus',
      value: String(cliente?.department_code || '').trim()
    })
  }

  if (identificationDocumentCode === '31') {
    extraFields.push({
      key: 'dv',
      label: 'Digito de verificacion (DV)',
      value: String(cliente?.dv || '').trim()
    })
  }

  const missingMap = new Map()
  for (const field of [
    ...baseStatus.missing_fields.map((key, index) => ({
      key,
      label: baseStatus.missing_labels[index] || key
    })),
    ...extraFields
      .filter((field) => !String(field.value || '').trim())
      .map((field) => ({ key: field.key, label: field.label }))
  ]) {
    if (!missingMap.has(field.key)) {
      missingMap.set(field.key, field.label)
    }
  }

  if (missingMap.size === 0) {
    return {
      ready: true,
      missing_fields: [],
      missing_labels: [],
      message: 'Cliente apto para emisión en Factus.'
    }
  }

  const missing_fields = Array.from(missingMap.keys())
  const missing_labels = Array.from(missingMap.values())
  return {
    ready: false,
    missing_fields,
    missing_labels,
    message: `No se puede enviar la factura electronica a Factus porque al cliente le faltan estos datos: ${missing_labels.join(', ')}. Verifica ademas que el nombre o razon social coincida exactamente con el RUT.`
  }
}

function getFactusValidationEntries(payload) {
  const errors = payload?.data?.errors || payload?.errors || {}
  return Object.entries(errors).flatMap(([code, value]) => {
    if (Array.isArray(value)) {
      return value.map((message) => [code, String(message || '').trim()])
    }
    return [[code, String(value || '').trim()]]
  })
}

function buildFriendlyFactusValidationMessage(payload) {
  const entries = getFactusValidationEntries(payload)
  if (entries.length === 0) {
    return String(payload?.message || 'Factus rechazó la factura electrónica.')
  }

  const codes = new Set(entries.map(([code]) => code))
  const lines = ['No se pudo emitir la factura electronica en Factus por estas validaciones:']

  if (codes.has('FAK28') || codes.has('FAK08')) {
    lines.push('- La direccion fiscal del cliente esta incompleta. Verifica direccion, municipio, departamento y pais.')
  }
  if (codes.has('FAK29')) {
    lines.push('- El tipo de documento del cliente no es valido en Factus.')
  }
  if (codes.has('FAK09')) {
    lines.push('- El tributo del cliente no es valido en Factus.')
  }
  if (codes.has('FAK32')) {
    lines.push('- La organizacion legal del cliente no es valida en Factus.')
  }
  if (codes.has('FAJ44b') || codes.has('FAJ43b')) {
    lines.push('- El nombre o razon social del cliente no coincide con el NIT o documento registrado en el RUT.')
  }

  const details = entries.map(([code, message]) => `- ${code}: ${message}`)
  return `${lines.join('\n')}\n\nDetalle Factus:\n${details.join('\n')}`
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
  const factusItems = buildFactusItemsPayload(items)
  const canonicalTotal = calculateFactusItemsTotal(factusItems)
  const paymentForm = mapFactusPaymentForm(paymentDetails[0]?.payment_form || body?.tipo_pago)
  const factusPaymentDetails = paymentDetails.map((pago, index, pagos) => removeEmptyObjectFields({
    payment_form: mapFactusPaymentForm(pago.payment_form || body?.tipo_pago),
    payment_method_code: mapFactusPaymentMethodCode(pago.payment_method_code || body?.forma_pago, paymentForm),
    amount: formatFactusDecimal(
      pagos.length === 1
        ? canonicalTotal
        : (index === pagos.length - 1
          ? roundFactusMoney(canonicalTotal - pagos.slice(0, -1).reduce((acc, current) => acc + roundFactusMoney(current?.amount), 0))
          : roundFactusMoney(pago.amount ?? 0))
    ),
    due_date: mapFactusPaymentForm(pago.payment_form || body?.tipo_pago) === '2'
      ? (normalizeVentaDate(pago.due_date || body?.fecha) || normalizeVentaDate(body?.fecha))
      : undefined,
    reference_code: pago.reference_code ? String(pago.reference_code).trim() : undefined
  }))

  const payload = removeEmptyObjectFields({
    reference_code: referenceCode,
    document: getFactusBillDocumentCode(),
    numbering_range_id: numberingRange?.id || undefined,
    operation_type: String(body?.operation_type || '10'),
    send_email: parseBooleanLike(process.env.FACTUS_SEND_EMAIL || 'false'),
    observation: String(body?.observation || '').trim() || undefined,
    created_time: normalizeVentaTime(body?.fecha) || undefined,
    customer: buildFactusCustomerPayload(cliente),
    payment_details: factusPaymentDetails,
    items: factusItems
  })

  if (!Array.isArray(payload.payment_details) || payload.payment_details.length === 0) {
    throw new Error('La venta no tiene métodos de pago válidos para Factus.')
  }

  return payload
}

function parseFactusInvoiceResult(payload) {
  const data = payload?.data || payload
  const bill = data?.bill || data
  const dataLinks = data?.links || {}
  const billLinks = bill?.links || {}
  const rawBillId = (
    data?.id
    ?? bill?.id
    ?? data?.bill_id
    ?? bill?.bill_id
    ?? data?.bill?.id
    ?? data?.data?.id
    ?? data?.data?.bill_id
    ?? null
  )
  const number = String(data?.number || bill?.number || '').trim()
  const prefix = String(data?.prefix || bill?.prefix || '').trim()
  const cufe = String(data?.cufe || bill?.cufe || '').trim()
  const qr = String(
    data?.qr
    || bill?.qr
    || data?.qr_url
    || bill?.qr_url
    || dataLinks?.qr
    || billLinks?.qr
    || ''
  ).trim()
  const documentUrl = String(
    data?.document_url
    || bill?.document_url
    || data?.pdf_url
    || bill?.pdf_url
    || dataLinks?.public_url
    || billLinks?.public_url
    || ''
  ).trim()
  const urls = removeEmptyObjectFields({
    document_url: documentUrl || undefined,
    pdf_url: String(data?.pdf_url || bill?.pdf_url || '').trim() || undefined,
    xml_url: String(data?.xml_url || bill?.xml_url || '').trim() || undefined,
    zip_url: String(data?.zip_url || bill?.zip_url || '').trim() || undefined,
    public_url: String(dataLinks?.public_url || billLinks?.public_url || '').trim() || undefined,
    qr_url: qr || undefined
  })
  const referenceCode = String(data?.reference_code || bill?.reference_code || '').trim()
  const validated = (
    typeof data?.is_validated === 'boolean' ? data.is_validated
      : typeof bill?.is_validated === 'boolean' ? bill.is_validated
        : parseBooleanLike(data?.is_validated ?? bill?.is_validated)
  )
  const status = String(data?.status_name || bill?.status_name || data?.status || bill?.status || '').trim() || 'validated'
  const normalizedBillId = Number(rawBillId)
  const billId = Number.isFinite(normalizedBillId) && normalizedBillId > 0
    ? Math.trunc(normalizedBillId)
    : (rawBillId !== null && rawBillId !== undefined && String(rawBillId).trim() !== '' ? String(rawBillId).trim() : null)

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

function getServerPublicBaseUrl(req = null) {
  const configured = String(
    process.env.PUBLIC_BASE_URL
    || process.env.APP_BASE_URL
    || process.env.BASE_URL
    || ''
  ).trim()
  if (configured) {
    return configured.replace(/\/+$/, '')
  }

  if (req) {
    const protocol = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim()
    const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim()
    if (host) {
      return `${protocol}://${host}`.replace(/\/+$/, '')
    }
  }

  return `http://localhost:${Number(process.env.PORT || 8080)}`
}

function buildFactusProxyUrls(number, req = null) {
  const safeNumber = encodeURIComponent(String(number || '').trim())
  if (!safeNumber) return {}
  const baseUrl = getServerPublicBaseUrl(req)
  return {
    document_url: `${baseUrl}/api/factus/bills/${safeNumber}/download-pdf`,
    pdf_url: `${baseUrl}/api/factus/bills/${safeNumber}/download-pdf`,
    xml_url: `${baseUrl}/api/factus/bills/${safeNumber}/download-xml`
  }
}

function mergeFactusUrls(primary = {}, fallback = {}) {
  return removeEmptyObjectFields({
    document_url: primary.document_url || fallback.document_url,
    public_url: primary.public_url || fallback.public_url,
    pdf_url: primary.pdf_url || fallback.pdf_url,
    xml_url: primary.xml_url || fallback.xml_url,
    zip_url: primary.zip_url || fallback.zip_url,
    qr_url: primary.qr_url || fallback.qr_url
  })
}

async function fetchFactusDocumentDownload(number, kind) {
  const safeNumber = encodeURIComponent(String(number || '').trim())
  if (!safeNumber) {
    throw new Error('Número de factura inválido para descarga.')
  }
  if (kind !== 'pdf' && kind !== 'xml') {
    throw new Error('Tipo de descarga Factus no soportado.')
  }

  const payload = await factusApiRequest(`/v2/bills/${safeNumber}/download-${kind}`)
  const data = payload?.data || payload || {}
  const fileName = String(data?.file_name || `${safeNumber}.${kind}`).trim() || `${safeNumber}.${kind}`
  const base64Key = kind === 'pdf' ? 'pdf_base_64_encoded' : 'xml_base_64_encoded'
  const mimeType = kind === 'pdf' ? 'application/pdf' : 'application/xml'
  const encoded = String(data?.[base64Key] || '').trim()

  if (!encoded) {
    const error = new Error(`Factus no devolvió ${kind.toUpperCase()} para la factura ${safeNumber}.`)
    error.payload = payload
    throw error
  }

  return {
    payload,
    file_name: fileName,
    mime_type: mimeType,
    buffer: Buffer.from(encoded, 'base64')
  }
}

async function getFactusBillByNumber(number) {
  const safeNumber = String(number || '').trim()
  if (!safeNumber) {
    throw new Error('Número de factura inválido para consultar en Factus.')
  }
  return factusApiRequest(`/v2/bills/${encodeURIComponent(safeNumber)}`)
}

async function updateFactusPersistedData(conn, ventaId, referenceCode, factusPayload, factusResponse) {
  let factus = parseFactusInvoiceResult(factusResponse)
  let factusLookupResponse = null

  if (!factus.bill_id && factus.number) {
    try {
      factusLookupResponse = await getFactusBillByNumber(factus.number)
      const lookedUpFactus = parseFactusInvoiceResult(factusLookupResponse)
      factus = {
        ...factus,
        ...lookedUpFactus,
        bill_id: lookedUpFactus.bill_id || factus.bill_id,
        number: lookedUpFactus.number || factus.number,
        prefix: lookedUpFactus.prefix || factus.prefix,
        cufe: lookedUpFactus.cufe || factus.cufe,
        document_url: lookedUpFactus.document_url || factus.document_url,
        urls: mergeFactusUrls(lookedUpFactus.urls || {}, factus.urls || {})
      }
    } catch (lookupError) {
      console.error('[Factus][BillLookup] No se pudo consultar la factura emitida:', JSON.stringify({
        venta_id: Number(ventaId),
        reference_code: referenceCode,
        number: factus.number || null,
        message: lookupError?.message || null,
        statusCode: lookupError?.statusCode || null,
        payload: lookupError?.payload || null,
        stack: lookupError?.stack || null
      }))
    }
  }

  const proxyUrls = factus.number ? buildFactusProxyUrls(factus.number) : {}
  factus.urls = mergeFactusUrls(factus.urls || {}, proxyUrls)
  factus.document_url = factus.document_url || factus.urls.document_url || null
  const statusText = String(factus.status || '').trim() || (factus.is_validated ? 'validated' : 'created')
  const responseWithDerivedUrls = {
    ...(factusResponse || {}),
    bill_lookup: factusLookupResponse || undefined,
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

function normalizeConsecutivoValue(value) {
  const numero = Number(value)
  if (!Number.isFinite(numero) || numero <= 0) return null
  return Math.trunc(numero)
}

async function getNextVentaConsecutivo(conn = pool) {
  const [rows] = await conn.query(
    'SELECT id_consecutivo FROM ventas WHERE id_consecutivo >= 1000 ORDER BY id_consecutivo DESC LIMIT 1'
  )
  const ultimo = rows && rows.length ? Number(rows[0].id_consecutivo) : 999
  return Math.max(1000, (Number.isFinite(ultimo) ? ultimo : 999) + 1)
}

async function resolveVentaConsecutivo(conn, requestedId) {
  const preferred = normalizeConsecutivoValue(requestedId)
  if (preferred) {
    const [[existing]] = await conn.query(
      'SELECT id_consecutivo FROM ventas WHERE id_consecutivo = ? LIMIT 1',
      [preferred]
    )
    if (!existing) {
      return preferred
    }
  }

  const nextId = await getNextVentaConsecutivo(conn)
  return normalizeConsecutivoValue(nextId)
}

async function processVentaWithExistingLogic(conn, body, options = {}) {
  const {
    allowFacturaElectronica = true
  } = options

  const {
    id_consecutivo,
    usuario_id,
    cliente_id,
    total,
    tipo_pago,
    forma_pago,
    punto_venta
  } = body || {}

  const requestedConsecutivo = id_consecutivo
  const esFacturaElectronica = allowFacturaElectronica && body?.factura_electronica === true
  const items = normalizeVentaDetalleItems(body)
  const paymentDetails = normalizeVentaPaymentDetails(body)
  let factusPayload = null
  let factusResult = null
  let factusReferenceCode = null
  let resolvedConsecutivo = normalizeConsecutivoValue(requestedConsecutivo)

  if (!usuario_id || !cliente_id) {
    const error = new Error('faltan_campos')
    error.statusCode = 400
    throw error
  }

  if ((esFacturaElectronica && !Array.isArray(items)) || (esFacturaElectronica && items.length === 0)) {
    const error = new Error('La venta electrónica requiere items persistibles.')
    error.statusCode = 400
    error.payload = { error: 'items_factura_electronica_requeridos' }
    throw error
  }

  if (esFacturaElectronica && (!Number.isFinite(Number(cliente_id)) || Number(cliente_id) <= 0)) {
    const error = new Error('La venta electrónica requiere un cliente válido.')
    error.statusCode = 400
    error.payload = { error: 'cliente_invalido' }
    throw error
  }

  resolvedConsecutivo = await resolveVentaConsecutivo(conn, requestedConsecutivo)

  if (esFacturaElectronica) {
    const clienteFactus = await getClienteForFactus(Number(cliente_id), conn)
    const clienteFactusStatus = buildClienteFactusEmissionStatus(clienteFactus)
    if (!clienteFactusStatus.ready) {
      const error = new Error(clienteFactusStatus.message)
      error.statusCode = 422
      error.payload = {
        error: 'cliente_factus_incompleto',
        facturacion: clienteFactusStatus
      }
      throw error
    }
    const numberingRange = await getFactusActiveNumberingRange()
    factusReferenceCode = buildFactusReferenceCode(body, resolvedConsecutivo)
    factusPayload = buildFactusBillPayload({
      body,
      ventaId: resolvedConsecutivo,
      cliente: clienteFactus,
      items,
      paymentDetails,
      numberingRange,
      referenceCode: factusReferenceCode
    })
    console.log('[Factus] Payload a enviar:', JSON.stringify({
      venta_id: Number(resolvedConsecutivo),
      reference_code: factusReferenceCode,
      payload: factusPayload
    }))
  }

  const ventaTotal = Number(total || 0)
  await insertVentaCabecera(conn, {
    id_consecutivo: resolvedConsecutivo,
    usuario_id,
    cliente_id,
    total: ventaTotal,
    tipo_pago,
    forma_pago,
    punto_venta,
    subtotal: body?.subtotal ?? null,
    total_discount: body?.total_discount ?? 0,
    total_tax: body?.total_tax ?? 0,
    observation: body?.observation || null,
    factura_electronica: esFacturaElectronica,
    electronic_status: esFacturaElectronica ? 'pending' : null,
    factus_number: null
  })

  if (esFacturaElectronica) {
    await persistVentaElectronicaData(conn, body, resolvedConsecutivo, items, paymentDetails, {
      referenceCode: factusReferenceCode
    })
  }

  for (const it of items) {
    const cantidad = Number(it.cantidad || 0)
    const descripcion = String(it.descripcion || '')
    const idProducto = it.id_producto || it.producto_id ? Number(it.id_producto || it.producto_id) : null

    if (!cantidad) continue

    let updated = false

    if (idProducto) {
      const [res] = await conn.query(
        'UPDATE productos SET stock = GREATEST(0, stock - ?) WHERE id_producto = ?',
        [cantidad, idProducto]
      )
      if (res.affectedRows > 0) updated = true
    }

    if (!updated && descripcion) {
      const [res] = await conn.query(
        'UPDATE productos SET stock = GREATEST(0, stock - ?) WHERE nombre = ? LIMIT 1',
        [cantidad, descripcion]
      )
      if (res.affectedRows > 0) updated = true
    }

    if (!updated && descripcion) {
      await conn.query(
        'UPDATE productos SET stock = GREATEST(0, stock - ?) WHERE nombre LIKE ? LIMIT 1',
        [cantidad, `%${descripcion}%`]
      )
    }
  }

  if (esFacturaElectronica) {
    const factusResponse = await factusApiRequest('/v2/bills/validate', {
      method: 'POST',
      body: factusPayload
    })
    console.log('[Factus] Respuesta recibida:', JSON.stringify({
      venta_id: Number(resolvedConsecutivo),
      reference_code: factusReferenceCode,
      response: factusResponse
    }))
    factusResult = await updateFactusPersistedData(conn, resolvedConsecutivo, factusReferenceCode, factusPayload, factusResponse)
  }

  return {
    resolvedConsecutivo,
    facturaElectronica: esFacturaElectronica,
    factusResult
  }
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

app.get('/api/mercadolibre/auth', async (req, res) => {
  try {
    const rateLimit = checkMercadoLibreAuthRateLimit(req)
    if (!rateLimit.allowed) {
      res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds))
      console.warn('[MercadoLibre][OAuth] Rate limit excedido al iniciar autorizacion:', JSON.stringify({
        ip: rateLimit.ip,
        attempts: rateLimit.attempts,
        retry_after_seconds: rateLimit.retryAfterSeconds
      }))
      return sendMercadoLibreOAuthPage(res, 429, {
        title: 'Demasiados intentos',
        message: 'Se excedió temporalmente el límite de intentos para iniciar OAuth de Mercado Libre. Intenta nuevamente más tarde.'
      })
    }

    if (!requireMercadoLibreAdminAuthorization(req, res)) {
      return
    }
    ensureMercadoLibreConfigured()
    const state = createMercadoLibreState()
    await createMercadoLibreOauthStateRecord(state)
    setMercadoLibreStateCookie(res, state)
    const authUrl = buildMercadoLibreAuthorizationUrl(state)
    return res.redirect(authUrl)
  } catch (err) {
    console.error('[MercadoLibre][OAuth] No se pudo iniciar la autorizacion:', JSON.stringify({
      error: err?.message || 'oauth_init_failed'
    }))
    return sendMercadoLibreOAuthPage(res, 500, {
      title: 'Error iniciando Mercado Libre',
      message: 'No se pudo iniciar la autorizacion de Mercado Libre. Verifica la configuracion del servidor.'
    })
  }
})

app.get('/api/mercadolibre/callback', async (req, res) => {
  clearMercadoLibreStateCookie(res)

  try {
    ensureMercadoLibreConfigured()

    const error = String(req.query.error || '').trim()
    const errorDescription = String(req.query.error_description || '').trim()
    const code = String(req.query.code || '').trim()
    const state = String(req.query.state || '').trim()

    if (!state) {
      return sendMercadoLibreOAuthPage(res, 400, {
        title: 'State ausente',
        message: 'La respuesta de Mercado Libre no incluyo el parametro state.'
      })
    }

    const stateValidation = validateMercadoLibreState(req, state)
    if (!stateValidation.ok) {
      return sendMercadoLibreOAuthPage(res, 400, {
        title: 'State invalido',
        message: 'La validacion de seguridad del flujo OAuth fallo. Intenta iniciar la conexion nuevamente.'
      })
    }

    const consumedState = await consumeMercadoLibreOauthState(state)
    if (!consumedState.ok) {
      const messageByReason = {
        state_not_found: 'El intento OAuth no existe o ya no está disponible.',
        state_already_used: 'Este intento OAuth ya fue utilizado anteriormente y fue rechazado.',
        state_expired: 'El intento OAuth expiró. Inicia nuevamente la conexión.',
        state_invalid: 'El intento OAuth no es válido.'
      }
      return sendMercadoLibreOAuthPage(res, 400, {
        title: 'State rechazado',
        message: messageByReason[consumedState.reason] || 'No se pudo validar el intento OAuth.'
      })
    }

    if (error) {
      const wasDenied = error === 'access_denied'
      return sendMercadoLibreOAuthPage(res, wasDenied ? 400 : 502, {
        title: wasDenied ? 'Autorizacion cancelada' : 'Error de Mercado Libre',
        message: wasDenied
          ? 'La autorizacion de Mercado Libre fue cancelada por el usuario.'
          : (errorDescription || 'Mercado Libre devolvio un error durante la autorizacion.')
      })
    }

    if (!code) {
      return sendMercadoLibreOAuthPage(res, 400, {
        title: 'Codigo ausente',
        message: 'Mercado Libre no devolvio el authorization code requerido.'
      })
    }

    const tokenData = await exchangeMercadoLibreAuthorizationCode(code)
    const missingScopes = buildMercadoLibreMissingScopes(tokenData.scope)
    if (missingScopes.length > 0) {
      console.error('[MercadoLibre][OAuth] La cuenta no tiene todos los scopes requeridos:', JSON.stringify({
        missing_scopes: missingScopes,
        token: sanitizeMercadoLibreTokenResponse(tokenData)
      }))
      return sendMercadoLibreOAuthPage(res, 403, {
        title: 'Permisos insuficientes',
        message: `La autorización de Mercado Libre no devolvió todos los permisos requeridos: ${missingScopes.join(', ')}. Revisa la configuración de la app en DevCenter.`
      })
    }

    const userData = await getMercadoLibreAuthenticatedUser(tokenData.access_token)
    const allowedUserId = getMercadoLibreAllowedUserId()
    if (allowedUserId && String(userData.id) !== allowedUserId) {
      console.error('[MercadoLibre][OAuth] La cuenta conectada no coincide con el vendedor permitido:', JSON.stringify({
        expected_user_id: allowedUserId,
        received_user: sanitizeMercadoLibreUser(userData)
      }))
      return sendMercadoLibreOAuthPage(res, 403, {
        title: 'Cuenta no autorizada',
        message: 'La cuenta de Mercado Libre autenticada no coincide con la cuenta permitida para este servidor.'
      })
    }

    const existingAccount = await getMercadoLibreAccountByUserId(userData.id)

    const expiresInSeconds = Number(tokenData.expires_in || 0)
    const tokenExpiresAt = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
      ? new Date(Date.now() + (expiresInSeconds * 1000))
      : null

    await upsertMercadoLibreAccount({
      meliUserId: userData.id,
      nickname: userData.nickname,
      siteId: userData.site_id,
      scope: tokenData.scope,
      accessTokenEncrypted: encryptMercadoLibreToken(tokenData.access_token),
      refreshTokenEncrypted: encryptMercadoLibreToken(tokenData.refresh_token),
      tokenExpiresAt,
      status: 'connected'
    })

    console.log('[MercadoLibre][OAuth] Cuenta conectada correctamente:', JSON.stringify({
      account_existed: !!existingAccount,
      token: sanitizeMercadoLibreTokenResponse(tokenData),
      user: sanitizeMercadoLibreUser(userData)
    }))

    return sendMercadoLibreOAuthPage(res, 200, {
      success: true,
      title: existingAccount ? 'Cuenta actualizada' : 'Cuenta conectada',
      message: existingAccount
        ? `La cuenta de Mercado Libre ${userData.nickname || userData.id} ya estaba registrada y se actualizaron sus credenciales de forma segura.`
        : `La cuenta de Mercado Libre ${userData.nickname || userData.id} fue conectada correctamente en ALUMAS.`
    })
  } catch (err) {
    console.error('[MercadoLibre][OAuth] Error en callback:', JSON.stringify({
      status: err?.statusCode,
      error: err?.message || 'oauth_callback_failed',
      payload: err?.payload || undefined
    }))

    return sendMercadoLibreOAuthPage(res, 500, {
      title: 'Error conectando Mercado Libre',
      message: 'No se pudo completar la conexion con Mercado Libre. Revisa la configuracion o vuelve a intentarlo.'
    })
  }
})

app.get('/api/mercadolibre/status', async (req, res) => {
  try {
    if (!requireMercadoLibreApiAuthorization(req, res)) {
      return
    }

    const account = await getMercadoLibrePrimaryAccount()
    if (!account) {
      return res.json({
        ok: true,
        connected: false,
        account: null
      })
    }

    const [[publicacionesStats]] = await pool.query(
      `SELECT
         COUNT(*) AS total_publicaciones,
         SUM(CASE WHEN producto_id IS NOT NULL THEN 1 ELSE 0 END) AS publicaciones_mapeadas
       FROM mercadolibre_publicaciones
       WHERE meli_user_id = ?`,
      [String(account.meli_user_id)]
    )

    const [[ordenesStats]] = await pool.query(
      `SELECT
         COUNT(*) AS total_ordenes,
         SUM(CASE WHEN processing_status = 'processed' THEN 1 ELSE 0 END) AS ordenes_procesadas
       FROM mercadolibre_ordenes
       WHERE meli_user_id = ?`,
      [String(account.meli_user_id)]
    )

    return res.json({
      ok: true,
      connected: true,
      meli_user_id: String(account.meli_user_id),
      nickname: account.nickname || null,
      site_id: account.site_id || null,
      scope: account.scope || null,
      token_expires_at: account.token_expires_at || null,
      status: account.status || 'connected',
      publicaciones: {
        total: Number(publicacionesStats?.total_publicaciones || 0),
        mapeadas: Number(publicacionesStats?.publicaciones_mapeadas || 0)
      },
      ordenes: {
        total: Number(ordenesStats?.total_ordenes || 0),
        procesadas: Number(ordenesStats?.ordenes_procesadas || 0)
      }
    })
  } catch (err) {
    return res.status(Number(err?.statusCode || 500)).json({
      ok: false,
      error: err?.message || 'No se pudo consultar el estado de Mercado Libre.'
    })
  }
})

app.get('/api/mercadolibre/publicaciones', async (req, res) => {
  try {
    if (!requireMercadoLibreApiAuthorization(req, res)) {
      return
    }

    const limit = normalizeMercadoLibreLimitQuery(req.query.limit, MERCADOLIBRE_DEFAULT_REMOTE_PAGE_SIZE)
    const shouldRefresh = String(req.query.refresh || '1').trim() !== '0'
    const account = await getMercadoLibrePrimaryAccount()
    if (!account) {
      return res.status(404).json({
        ok: false,
        error: 'No hay una cuenta de Mercado Libre conectada en ALUMAS.'
      })
    }

    const publicaciones = shouldRefresh
      ? await syncMercadoLibrePublicationsFromRemote({ limit })
      : await getMercadoLibrePublicationMappings({ meliUserId: account.meli_user_id, limit })

    return res.json({
      ok: true,
      refreshed: shouldRefresh,
      count: publicaciones.length,
      publicaciones
    })
  } catch (err) {
    return res.status(Number(err?.statusCode || 500)).json({
      ok: false,
      error: err?.message || 'No se pudieron consultar las publicaciones de Mercado Libre.'
    })
  }
})

app.get('/api/mercadolibre/producto/:id/preparar-publicacion', async (req, res) => {
  try {
    if (!requireMercadoLibreApiAuthorization(req, res)) {
      return
    }

    const producto = await getMercadoLibreProductForPublishing(req.params.id)
    const existingPublication = await getMercadoLibreExistingPublicationForProduct(producto.id_producto)
    const { account, accessToken } = await getValidMercadoLibreAccessToken()
    const sellerProfile = await getMercadoLibreAuthenticatedUser(accessToken)
    const siteId = normalizeMercadoLibreStringValue(req.query.site_id || account?.site_id || 'MCO', 8) || 'MCO'
    const categoryQuery = normalizeMercadoLibreStringValue(
      req.query.q || producto.ml_category_hint || producto.nombre || producto.descripcion || '',
      120
    )
    const suggestedCategories = await suggestMercadoLibreCategory(siteId, categoryQuery, accessToken)
    const suggestedCategoryId = normalizeMercadoLibreStringValue(
      req.query.category_id || producto.ml_category_id || suggestedCategories?.[0]?.category_id || '',
      64
    )
    const categoryAttributes = suggestedCategoryId
      ? await getMercadoLibreCategoryAttributes(suggestedCategoryId, accessToken)
      : []
    const categoryDetail = suggestedCategoryId
      ? await getMercadoLibreCategoryDetail(suggestedCategoryId, accessToken)
      : null
    const listingTypes = await getMercadoLibreListingTypes(siteId, accessToken)
    const draftInfo = await buildMercadoLibrePublicationDraft(producto, {
      categoryId: suggestedCategoryId,
      isUserProductSeller: isMercadoLibreUserProductSeller(sellerProfile)
    }, req)
    const requiredAttributesMissing = getMercadoLibreRequiredAttributesMissing(categoryAttributes, draftInfo.draft.attributes)
    const completeMissing = [...draftInfo.missing]
    if (requiredAttributesMissing.length > 0) {
      completeMissing.push(...requiredAttributesMissing.map((attribute) => `attribute:${attribute.id}`))
    }

    return res.json({
      ok: true,
      site_id: siteId,
      producto,
      ya_publicado: isMercadoLibrePublicationAlreadyActive(existingPublication),
      publicacion_existente: existingPublication ? {
        item_id: String(existingPublication.item_id || '').trim() || null,
        status: existingPublication.status || null,
        permalink: existingPublication.permalink || null,
        title: existingPublication.title || null,
        category_id: existingPublication.category_id || null
      } : null,
      category_query: categoryQuery,
      sugerencias_categoria: suggestedCategories,
      categoria_seleccionada: categoryDetail,
      atributos_requeridos: categoryAttributes.filter((attribute) => String(attribute?.tags?.required || '').toLowerCase() === 'true' || attribute?.tags?.required === true),
      atributos_borrador: draftInfo.draft.attributes,
      atributos_obligatorios_faltantes: requiredAttributesMissing,
      listing_types: listingTypes,
      borrador: draftInfo.draft,
      metadata: draftInfo.metadata,
      seller_profile: sanitizeMercadoLibreUser(sellerProfile),
      faltantes: completeMissing
    })
  } catch (err) {
    return res.status(Number(err?.statusCode || 500)).json({
      ok: false,
      error: err?.message || 'No se pudo preparar la publicacion de Mercado Libre.'
    })
  }
})

app.get('/api/mercadolibre/categorias/sugerir', async (req, res) => {
  try {
    if (!requireMercadoLibreApiAuthorization(req, res)) {
      return
    }

    const { account, accessToken } = await getValidMercadoLibreAccessToken()
    const q = normalizeMercadoLibreStringValue(req.query.q, 120)
    if (!q) {
      return res.status(400).json({
        ok: false,
        error: 'Debes enviar el parametro q para sugerir una categoria.'
      })
    }

    const siteId = normalizeMercadoLibreStringValue(req.query.site_id || account?.site_id || 'MCO', 8) || 'MCO'
    const predictions = await suggestMercadoLibreCategory(siteId, q, accessToken)
    return res.json({
      ok: true,
      site_id: siteId,
      count: predictions.length,
      sugerencias: predictions
    })
  } catch (err) {
    return res.status(Number(err?.statusCode || 500)).json({
      ok: false,
      error: err?.message || 'No se pudo sugerir una categoria de Mercado Libre.'
    })
  }
})

app.get('/api/mercadolibre/categorias/:categoryId/atributos', async (req, res) => {
  try {
    if (!requireMercadoLibreApiAuthorization(req, res)) {
      return
    }

    const { accessToken } = await getValidMercadoLibreAccessToken()
    const categoryId = normalizeMercadoLibreStringValue(req.params.categoryId, 64)
    if (!categoryId) {
      return res.status(400).json({
        ok: false,
        error: 'Debes indicar una categoria valida.'
      })
    }

    const category = await getMercadoLibreCategoryDetail(categoryId, accessToken)
    const attributes = await getMercadoLibreCategoryAttributes(categoryId, accessToken)
    return res.json({
      ok: true,
      category,
      atributos: attributes,
      atributos_requeridos: attributes.filter((attribute) => String(attribute?.tags?.required || '').toLowerCase() === 'true' || attribute?.tags?.required === true)
    })
  } catch (err) {
    return res.status(Number(err?.statusCode || 500)).json({
      ok: false,
      error: err?.message || 'No se pudieron consultar los atributos de la categoria.'
    })
  }
})

app.post('/api/mercadolibre/publicar', async (req, res) => {
  try {
    if (!requireMercadoLibreApiAuthorization(req, res)) {
      return
    }

    const productoId = Number(req.body?.producto_id)
    if (!Number.isFinite(productoId) || productoId <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'Debes enviar producto_id valido para publicar en Mercado Libre.'
      })
    }

    const producto = await getMercadoLibreProductForPublishing(productoId)
    const existingPublication = await getMercadoLibreExistingPublicationForProduct(producto.id_producto)
    if (isMercadoLibrePublicationAlreadyActive(existingPublication)) {
      await updateMercadoLibreProductPublishedState(producto.id_producto, true)
      return res.json({
        ok: true,
        already_published: true,
        message: 'Este producto ya está publicado en Mercado Libre.',
        producto_id: producto.id_producto,
        item_id: String(existingPublication.item_id || '').trim() || null,
        status: existingPublication.status || null,
        permalink: existingPublication.permalink || null,
        title: existingPublication.title || null,
        category_id: existingPublication.category_id || producto.ml_category_id || null
      })
    }

    const { account, accessToken } = await getValidMercadoLibreAccessToken()
    const sellerProfile = await getMercadoLibreAuthenticatedUser(accessToken)
    const isUserProductSeller = isMercadoLibreUserProductSeller(sellerProfile)
    const draftInfo = await buildMercadoLibrePublicationDraft(producto, {
      categoryId: req.body?.category_id,
      title: req.body?.title,
      description: req.body?.description,
      price: req.body?.price,
      availableQuantity: req.body?.available_quantity,
      listingTypeId: req.body?.listing_type_id,
      condition: req.body?.condition,
      imageUrl: req.body?.image_url,
      attributes: req.body?.attributes,
      isUserProductSeller
    }, req)
    const finalPayload = buildMercadoLibrePublicationPayload(draftInfo.draft, {
      userProductSeller: isUserProductSeller
    })
    const categoryAttributes = draftInfo.draft.category_id
      ? await getMercadoLibreCategoryAttributes(draftInfo.draft.category_id, accessToken)
      : []
    const requiredAttributesMissing = getMercadoLibreRequiredAttributesMissing(categoryAttributes, draftInfo.draft.attributes)
    const completeMissing = [...draftInfo.missing]
    if (requiredAttributesMissing.length > 0) {
      completeMissing.push(...requiredAttributesMissing.map((attribute) => `attribute:${attribute.id}`))
    }

    if (completeMissing.length > 0) {
      return res.status(400).json({
        ok: false,
        error: 'Faltan datos obligatorios para publicar el producto en Mercado Libre.',
        faltantes: completeMissing,
        atributos_obligatorios_faltantes: requiredAttributesMissing,
        borrador: draftInfo.draft,
        metadata: draftInfo.metadata,
        payload_final: finalPayload
      })
    }

    const createdItem = await publishMercadoLibreItem(
      producto,
      finalPayload,
      draftInfo.description,
      account,
      accessToken
    )

    return res.status(201).json({
      ok: true,
      already_published: false,
      message: 'Producto publicado correctamente en Mercado Libre.',
      producto_id: producto.id_producto,
      item_id: createdItem.id || null,
      status: createdItem.status || null,
      permalink: createdItem.permalink || null,
      title: createdItem.title || null,
      category_id: createdItem.category_id || draftInfo.draft.category_id || null
    })
  } catch (err) {
    return res.status(Number(err?.statusCode || 500)).json({
      ok: false,
      error: err?.message || 'No se pudo publicar el producto en Mercado Libre.',
      details: err?.payload || undefined,
      payload_final: err?.publicationPayload || undefined
    })
  }
})

app.post('/api/mercadolibre/sync-stock', async (req, res) => {
  try {
    if (!requireMercadoLibreApiAuthorization(req, res)) {
      return
    }

    const refreshPublications = parseBooleanLike(req.body?.refresh_publicaciones ?? true)
    const { account, accessToken } = await getValidMercadoLibreAccessToken()

    if (refreshPublications) {
      await syncMercadoLibrePublicationsFromRemote({
        limit: normalizeMercadoLibreLimitQuery(req.body?.limit, 200)
      })
    }

    let mappings = await getMercadoLibrePublicationMappings({
      meliUserId: account.meli_user_id,
      limit: 500,
      onlyMapped: true
    })

    const bodyItemIds = Array.isArray(req.body?.item_ids) ? req.body.item_ids.map((itemId) => String(itemId || '').trim()).filter(Boolean) : []
    const bodyProductoIds = Array.isArray(req.body?.producto_ids) ? req.body.producto_ids.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0) : []

    if (bodyItemIds.length > 0) {
      const itemIdSet = new Set(bodyItemIds)
      mappings = mappings.filter((mapping) => itemIdSet.has(String(mapping.item_id)))
    }

    if (bodyProductoIds.length > 0) {
      const productoIdSet = new Set(bodyProductoIds)
      mappings = mappings.filter((mapping) => productoIdSet.has(Number(mapping.producto_id)))
    }

    const results = await syncMercadoLibreStock(mappings, accessToken)
    return res.json({
      ok: true,
      requested: mappings.length,
      synced: results.filter((result) => result.status === 'synced').length,
      errors: results.filter((result) => result.status === 'error').length,
      skipped: results.filter((result) => result.status === 'skipped').length,
      results
    })
  } catch (err) {
    return res.status(Number(err?.statusCode || 500)).json({
      ok: false,
      error: err?.message || 'No se pudo sincronizar el stock de Mercado Libre.'
    })
  }
})

app.get('/api/mercadolibre/ordenes', async (req, res) => {
  try {
    if (!requireMercadoLibreApiAuthorization(req, res)) {
      return
    }

    const limit = Math.max(1, Math.min(50, normalizeMercadoLibreInteger(req.query.limit, MERCADOLIBRE_DEFAULT_SYNC_LIMIT)))
    const offset = Math.max(0, normalizeMercadoLibreInteger(req.query.offset, 0))
    const { account, accessToken } = await getValidMercadoLibreAccessToken()
    const remote = await fetchMercadoLibreOrders(accessToken, account.meli_user_id, { limit, offset })

    for (const order of remote.results) {
      await upsertMercadoLibreOrderSnapshot(order, account)
    }

    const localRows = await getMercadoLibreOrderRowsByIds(remote.results.map((order) => order.id))
    const localByOrderId = new Map(localRows.map((row) => [String(row.order_id), row]))

    const ordenes = remote.results.map((order) => {
      const local = localByOrderId.get(String(order.id))
      const processability = isMercadoLibreOrderProcessable(order)
      return {
        order_id: Number(order.id),
        status: order.status || null,
        status_detail: order.status_detail || null,
        total_amount: order.total_amount ?? null,
        currency_id: order.currency_id || null,
        date_created: order.date_created || null,
        date_closed: order.date_closed || null,
        buyer: {
          nickname: order?.buyer?.nickname || null,
          first_name: order?.buyer?.first_name || null,
          last_name: order?.buyer?.last_name || null
        },
        import_ready: processability.processable,
        import_reason: processability.reason,
        local: local ? {
          venta_id: local.venta_id ? Number(local.venta_id) : null,
          processing_status: local.processing_status || null,
          processing_message: local.processing_message || null,
          last_processed_at: local.last_processed_at || null
        } : null
      }
    })

    return res.json({
      ok: true,
      count: ordenes.length,
      paging: remote.paging || {},
      ordenes
    })
  } catch (err) {
    return res.status(Number(err?.statusCode || 500)).json({
      ok: false,
      error: err?.message || 'No se pudieron consultar las órdenes de Mercado Libre.'
    })
  }
})

app.post('/api/mercadolibre/sync', async (req, res) => {
  try {
    if (!requireMercadoLibreApiAuthorization(req, res)) {
      return
    }

    const { account, accessToken } = await getValidMercadoLibreAccessToken()
    const requestedOrderIds = Array.isArray(req.body?.order_ids)
      ? [...new Set(req.body.order_ids.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0))]
      : []

    const limit = Math.max(1, Math.min(50, normalizeMercadoLibreInteger(req.body?.limit, MERCADOLIBRE_DEFAULT_SYNC_LIMIT)))
    const ordersToProcess = []

    if (requestedOrderIds.length > 0) {
      for (const orderId of requestedOrderIds) {
        ordersToProcess.push(await getMercadoLibreOrderDetail(accessToken, orderId))
      }
    } else {
      const remote = await fetchMercadoLibreOrders(accessToken, account.meli_user_id, { limit })
      for (const order of remote.results) {
        ordersToProcess.push(await getMercadoLibreOrderDetail(accessToken, order.id))
      }
    }

    const results = []
    for (const order of ordersToProcess) {
      try {
        results.push(await processMercadoLibreOrderImport(order, account))
      } catch (err) {
        results.push({
          order_id: Number(order?.id || 0) || null,
          status: 'error',
          message: err?.message || 'No se pudo importar la orden.'
        })
      }
    }

    return res.json({
      ok: true,
      requested: ordersToProcess.length,
      processed: results.filter((result) => result.status === 'processed').length,
      already_processed: results.filter((result) => result.status === 'already_processed').length,
      pending: results.filter((result) => result.status === 'pending').length,
      skipped: results.filter((result) => result.status === 'skipped').length,
      errors: results.filter((result) => result.status === 'error').length,
      results
    })
  } catch (err) {
    return res.status(Number(err?.statusCode || 500)).json({
      ok: false,
      error: err?.message || 'No se pudieron sincronizar las órdenes de Mercado Libre.'
    })
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
  const conn = await pool.getConnection()
  try {
    const numero = await getNextVentaConsecutivo(conn)
    if (!numero) {
      return res.status(409).json({ ok: false, error: 'no_consecutivo', msg: 'No se pudo generar un consecutivo único' })
    }
    res.json({ ok: true, id_consecutivo: numero })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  } finally {
    conn.release()
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

app.get('/api/factus/bills/:number/download-pdf', async (req, res) => {
  try {
    const documento = await fetchFactusDocumentDownload(req.params.number, 'pdf')
    res.setHeader('Content-Type', documento.mime_type)
    res.setHeader('Content-Disposition', `inline; filename="${documento.file_name.replace(/"/g, '')}"`)
    res.send(documento.buffer)
  } catch (err) {
    console.error('[Factus][DownloadPDF] Error:', JSON.stringify({
      number: req.params.number,
      message: err?.message || null,
      payload: err?.payload || null,
      stack: err?.stack || null
    }))
    res.status(502).json({
      ok: false,
      error: err?.message || 'No se pudo descargar el PDF desde Factus.'
    })
  }
})

app.get('/api/factus/bills/:number/download-xml', async (req, res) => {
  try {
    const documento = await fetchFactusDocumentDownload(req.params.number, 'xml')
    res.setHeader('Content-Type', documento.mime_type)
    res.setHeader('Content-Disposition', `attachment; filename="${documento.file_name.replace(/"/g, '')}"`)
    res.send(documento.buffer)
  } catch (err) {
    console.error('[Factus][DownloadXML] Error:', JSON.stringify({
      number: req.params.number,
      message: err?.message || null,
      payload: err?.payload || null,
      stack: err?.stack || null
    }))
    res.status(502).json({
      ok: false,
      error: err?.message || 'No se pudo descargar el XML desde Factus.'
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
  let resolvedConsecutivo = normalizeConsecutivoValue(req.body?.id_consecutivo)
  try {
    await conn.beginTransaction()
    const result = await processVentaWithExistingLogic(conn, req.body)
    resolvedConsecutivo = result.resolvedConsecutivo

    await conn.commit()
    res.json({
      ok: true,
      id_consecutivo: Number(resolvedConsecutivo),
      venta_id: Number(resolvedConsecutivo),
      factura_electronica: result.facturaElectronica,
      factus_number: result.factusResult?.number || null,
      prefix: result.factusResult?.prefix || null,
      number: result.factusResult?.number || null,
      cufe: result.factusResult?.cufe || null,
      status: result.factusResult?.status || null,
      is_validated: typeof result.factusResult?.is_validated === 'boolean' ? result.factusResult.is_validated : null,
      document_url: result.factusResult?.document_url || null,
      urls: result.factusResult?.urls || null,
      factus: result.factusResult
    })
  } catch (err) {
    try { await conn.rollback() } catch {}
    console.error('[Factus][Venta] Excepcion completa:', JSON.stringify({
      venta_id: resolvedConsecutivo || req.body?.id_consecutivo || null,
      factura_electronica: req.body?.factura_electronica === true,
      message: err?.message || 'Error desconocido',
      statusCode: err?.statusCode || null,
      payload: err?.payload || null,
      stack: err?.stack || null
    }))
    const statusCode = Number(err?.statusCode || 0)
    if (statusCode === 422 && err?.payload?.error === 'cliente_factus_incompleto') {
      return res.status(422).json({
        ok: false,
        error: 'cliente_factus_incompleto',
        message: err?.message || 'El cliente no está listo para facturación electrónica.',
        facturacion: err?.payload?.facturacion || null
      })
    }
    if (statusCode === 422) {
      return res.status(422).json({
        ok: false,
        error: 'factus_validation_error',
        message: buildFriendlyFactusValidationMessage(err?.payload || {}),
        factus_validation_errors: err?.payload?.data?.errors || err?.payload?.errors || null,
        factus_payload: err?.payload || null
      })
    }
    res.status(statusCode >= 400 ? statusCode : 500).json({
      ok: false,
      error: err.message,
      message: err.message
    })
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
