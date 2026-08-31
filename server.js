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
const FACTUS_DEBUG_ENV_PATH = path.resolve(__dirname, '.dbg', 'factus-intermittent.env')

function getFactusDebugConfig() {
  let debugServerUrl = 'http://127.0.0.1:7777/event'
  let debugSessionId = 'factus-intermittent'
  try {
    const content = fs.readFileSync(FACTUS_DEBUG_ENV_PATH, 'utf8')
    for (const line of content.split(/\r?\n/)) {
      if (line.startsWith('DEBUG_SERVER_URL=')) {
        debugServerUrl = line.slice('DEBUG_SERVER_URL='.length).trim() || debugServerUrl
      } else if (line.startsWith('DEBUG_SESSION_ID=')) {
        debugSessionId = line.slice('DEBUG_SESSION_ID='.length).trim() || debugSessionId
      }
    }
  } catch {}
  return { debugServerUrl, debugSessionId }
}

function buildFactusDebugBogotaTimestamp() {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
  return formatter.format(new Date()).replace(' ', 'T')
}

function reportFactusDebugEvent({
  runId = 'pre-fix',
  hypothesisId,
  location,
  msg,
  data,
  traceId
}) {
  try {
    const { debugServerUrl, debugSessionId } = getFactusDebugConfig()
    fetch(debugServerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: debugSessionId,
        runId,
        hypothesisId,
        location,
        msg,
        data,
        traceId,
        ts: Date.now()
      })
    }).catch(() => {})
  } catch {}
}

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
  const createMercadoLibreN8nEventos = `
    CREATE TABLE IF NOT EXISTS mercadolibre_n8n_eventos (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      event_key CHAR(64) NOT NULL,
      event_type VARCHAR(64) NOT NULL,
      order_id BIGINT NOT NULL,
      payload_json LONGTEXT NULL,
      delivery_status VARCHAR(32) NOT NULL DEFAULT 'pending',
      http_status INT NULL DEFAULT NULL,
      response_body TEXT NULL,
      first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_attempt_at DATETIME NULL DEFAULT NULL,
      dispatched_at DATETIME NULL DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mercadolibre_n8n_eventos_event_key (event_key),
      KEY idx_mercadolibre_n8n_eventos_order_id (order_id),
      KEY idx_mercadolibre_n8n_eventos_event_type (event_type),
      KEY idx_mercadolibre_n8n_eventos_delivery_status (delivery_status)
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
  await pool.query(createMercadoLibreN8nEventos)

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

function normalizeClienteQuickText(value, maxLength = 0) {
  let normalized = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (maxLength > 0) normalized = normalized.slice(0, maxLength)
  return normalized
}

function sanitizeDigits(value) {
  return String(value ?? '').replace(/\D/g, '').trim()
}

function calculateNitVerificationDigit(nitValue) {
  const digits = sanitizeDigits(nitValue)
  if (!digits) return ''
  const weights = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71]
  const reversed = digits.split('').reverse()
  let total = 0
  for (let index = 0; index < reversed.length; index += 1) {
    const digit = Number(reversed[index] || 0)
    const weight = Number(weights[index] || 0)
    total += digit * weight
  }
  const remainder = total % 11
  return String(remainder > 1 ? 11 - remainder : remainder)
}

function looksLikeEmpresaCliente(data = {}) {
  const nitDigits = sanitizeDigits(data.nit || data.nit_cc || data.identification)
  const dv = normalizeClienteQuickText(data.dv, 8)
  const docCode = normalizeClienteQuickText(data.identification_document_code, 8)
  const text = [
    data.clase_identificacion,
    data.organizacion_juridica,
    data.tipo_sociedad,
    data.nombre,
    data.company
  ].map((value) => normalizeClienteQuickText(value).toUpperCase()).join(' ')
  if (docCode === '31') return true
  if (dv) return true
  if (nitDigits.length >= 9) return true
  return /(NIT|SAS|S\.A|LTDA|SOCIEDAD|EMPRESA|COOPERATIVA|ASOCIACION|FUNDACION|CORPORACION)/i.test(text)
}

function inferClienteIdentificationDocumentCode(data = {}) {
  const current = normalizeClienteQuickText(data.identification_document_code, 8)
  if (current) return current
  const clase = normalizeClienteQuickText(data.clase_identificacion).toUpperCase()
  if (clase.includes('NIT')) return '31'
  if (clase.includes('CEDULA DE CIUDADANIA') || clase.includes('CÉDULA DE CIUDADANÍA')) return '13'
  if (clase.includes('CEDULA DE EXTRANJERIA') || clase.includes('CÉDULA DE EXTRANJERÍA')) return '22'
  if (clase.includes('PASAPORTE')) return '41'
  return looksLikeEmpresaCliente(data) ? '31' : '13'
}

function inferClienteLegalOrganizationCode(data = {}) {
  const current = normalizeClienteQuickText(data.legal_organization_code, 8)
  if (current) return current
  const organizationText = [
    data.organizacion_juridica,
    data.tipo_sociedad,
    data.company,
    data.nombre
  ].map((value) => normalizeClienteQuickText(value).toUpperCase()).join(' ')
  if (organizationText.includes('PERSONA NATURAL')) return '1'
  if (normalizeClienteQuickText(data.identification_document_code, 8) === '31') return '2'
  return looksLikeEmpresaCliente(data) ? '2' : '1'
}

function buildClienteQuickDraft(input = {}) {
  const nitDigits = sanitizeDigits(input.nit_cc || input.identification)
  const identification = sanitizeDigits(input.identification) || nitDigits
  const draft = {
    id: Number.isFinite(Number(input.id)) && Number(input.id) > 0 ? Number(input.id) : null,
    nombre: normalizeClienteQuickText(input.nombre, 255),
    nit_cc: nitDigits || normalizeClienteQuickText(input.nit_cc, 64),
    telefono: normalizeClienteQuickText(input.telefono, 64),
    direccion: normalizeClienteQuickText(input.direccion, 255),
    email: normalizeClienteQuickText(input.email, 255).toLowerCase(),
    tipo_cliente: normalizeClienteQuickText(input.tipo_cliente, 64) || 'Cliente final',
    identification,
    identification_document_code: inferClienteIdentificationDocumentCode({
      ...input,
      nit_cc: nitDigits,
      identification
    }),
    dv: normalizeClienteQuickText(input.dv, 8),
    legal_organization_code: inferClienteLegalOrganizationCode(input),
    tribute_code: normalizeClienteQuickText(input.tribute_code, 16) || 'ZZ',
    company: normalizeClienteQuickText(input.company, 255),
    trade_name: normalizeClienteQuickText(input.trade_name, 255),
    names: normalizeClienteQuickText(input.names, 255),
    country_code: normalizeClienteQuickText(input.country_code, 8).toUpperCase() || 'CO',
    municipality_code: sanitizeDigits(input.municipality_code) || '11001',
    department_code: sanitizeDigits(input.department_code) || '11'
  }

  if (!draft.identification) {
    draft.identification = draft.nit_cc
  }
  if (draft.identification_document_code === '31' && !draft.dv && draft.identification) {
    draft.dv = calculateNitVerificationDigit(draft.identification)
  }
  if (!draft.legal_organization_code) {
    draft.legal_organization_code = inferClienteLegalOrganizationCode(draft)
  }
  if (!draft.company) {
    draft.company = draft.nombre
  }
  if (!draft.names) {
    draft.names = draft.company || draft.nombre
  }
  if (!draft.trade_name) {
    draft.trade_name = draft.names || draft.company || draft.nombre
  }
  return draft
}

function buildClienteRuesExpedienteId(codigoCamara, matricula) {
  const codigo = sanitizeDigits(codigoCamara)
  const matriculaDigits = sanitizeDigits(matricula)
  if (!codigo || !matriculaDigits) return ''
  return `${codigo}${matriculaDigits.padStart(10, '0')}`
}

async function fetchJsonWithBasicError(url, options = {}) {
  const response = await fetch(url, options)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} consultando ${url}`)
  }
  return response.json()
}

async function lookupClientePublicoPorNit(nitDigits) {
  const cleanNit = sanitizeDigits(nitDigits)
  if (cleanNit.length < 5) {
    throw new Error('El NIT o documento debe tener al menos 5 dígitos para consultarlo.')
  }

  const selectFields = [
    'razon_social',
    'numero_identificacion',
    'codigo_camara',
    'matricula',
    'clase_identificacion',
    'organizacion_juridica',
    'tipo_sociedad'
  ].join(',')
  const summaryUrl = `https://www.datos.gov.co/resource/c82u-588k.json?$limit=1&$select=${encodeURIComponent(selectFields)}&$where=${encodeURIComponent(`numero_identificacion='${cleanNit}'`)}`

  let summary = null
  let detail = null
  let summaryError = null
  let detailError = null

  try {
    const data = await fetchJsonWithBasicError(summaryUrl)
    summary = Array.isArray(data) && data.length ? data[0] : null
  } catch (error) {
    summaryError = error
  }

  if (summary?.codigo_camara && summary?.matricula) {
    const expedienteId = buildClienteRuesExpedienteId(summary.codigo_camara, summary.matricula)
    if (expedienteId) {
      try {
        const detailPayload = await fetchJsonWithBasicError(`https://ruesapi.rues.org.co/WEB2/api/Expediente/DetalleRM/${encodeURIComponent(expedienteId)}`)
        detail = detailPayload?.registros || null
      } catch (error) {
        detailError = error
      }
    }
  }

  return {
    nit: cleanNit,
    found: !!summary,
    summary,
    detail,
    summaryError,
    detailError
  }
}

function buildClienteDraftFromLookupResult(lookupResult = {}) {
  const summary = lookupResult?.summary || {}
  const detail = lookupResult?.detail || {}
  const nombre = normalizeClienteQuickText(
    detail.razon_social
    || summary.razon_social
    || ''
  )
  return buildClienteQuickDraft({
    nombre,
    nit_cc: lookupResult?.nit || summary.numero_identificacion || detail.numero_identificacion,
    identification: lookupResult?.nit || summary.numero_identificacion || detail.numero_identificacion,
    clase_identificacion: detail.clase_identificacion || summary.clase_identificacion,
    organizacion_juridica: detail.organizacion_juridica || summary.organizacion_juridica,
    tipo_sociedad: detail.tipo_sociedad || summary.tipo_sociedad,
    dv: detail.dv || '',
    direccion: detail.dir_fiscal || detail.dir_comercial || '',
    telefono: detail.tel_fiscal_1 || detail.tel_com_1 || detail.tel_fiscal_2 || detail.tel_com_2 || '',
    email: detail.email_fiscal || detail.email_com || '',
    company: nombre,
    trade_name: nombre,
    names: nombre,
    tribute_code: 'ZZ',
    country_code: 'CO',
    municipality_code: '11001',
    department_code: '11'
  })
}

async function getClienteForUi(clienteId, conn = pool) {
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
       ${selectField('nombre')},
       ${selectField('nit_cc')},
       ${selectField('telefono')},
       ${selectField('direccion')},
       ${selectField('tipo_cliente')},
       ${selectField('identification')},
       ${selectField('identification_document_code')},
       ${selectField('legal_organization_code')},
       ${selectField('tribute_code')},
       ${selectField('email')},
       ${selectField('company')},
       ${selectField('trade_name')},
       ${selectField('names')},
       ${selectField('dv')},
       ${selectField('department_code')},
       ${selectField('municipality_code')},
       ${selectField('country_code')}
     FROM clientes
     WHERE id_cliente = ?
     LIMIT 1`,
    [Number(clienteId)]
  )

  const cliente = rows && rows.length ? rows[0] : null
  if (!cliente) return null
  const facturacion = buildClienteFactusEmissionStatus(cliente)
  return {
    ...enrichClienteWithFacturacion(cliente),
    factus_emision_completa: facturacion.ready,
    factus_emision_campos_faltantes: facturacion.missing_fields,
    factus_emision_mensaje: facturacion.message
  }
}

async function findExistingClienteByDraft(draft, conn = pool) {
  const columns = await getTableColumns('clientes', conn)
  const nitColumn = pickFirstExistingColumn(columns, ['nit_cc'])
  const identificationColumn = pickFirstExistingColumn(columns, ['identification'])
  const conditions = []
  const params = []
  const normalizedNit = sanitizeDigits(draft?.nit_cc)
  const normalizedIdentification = sanitizeDigits(draft?.identification)

  const normalizedColumnSql = (columnName) => `REPLACE(REPLACE(REPLACE(COALESCE(\`${columnName}\`, ''), '.', ''), '-', ''), ' ', '')`

  if (nitColumn && normalizedNit) {
    conditions.push(`${normalizedColumnSql(nitColumn)} = ?`)
    params.push(normalizedNit)
  }
  if (identificationColumn && normalizedIdentification) {
    conditions.push(`${normalizedColumnSql(identificationColumn)} = ?`)
    params.push(normalizedIdentification)
  }

  if (!conditions.length) return null

  const [rows] = await conn.query(
    `SELECT id_cliente AS id
     FROM clientes
     WHERE ${conditions.join(' OR ')}
     ORDER BY id_cliente ASC
     LIMIT 1`,
    params
  )
  return rows && rows.length ? Number(rows[0].id) : null
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

function normalizeVentaPaymentFormForStorage(value, tipoPago) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === '2' || normalized === 'credito' || normalized === 'crédito' || String(tipoPago || '').trim().toUpperCase() === 'CREDITO') {
    return 'credito'
  }
  return 'contado'
}

function normalizeVentaPaymentMethodForStorage(value, tipoPago) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === '10' || normalized === 'cash' || normalized === 'efectivo') return 'cash'
  if (normalized === '48' || normalized === 'card' || normalized === 'tarjeta') return 'card'
  if (normalized === '42' || normalized === 'qr') return 'qr'
  if (normalized === '1' || normalized === 'credit' || String(tipoPago || '').trim().toUpperCase() === 'CREDITO') return 'credit'
  if (normalized === 'mixed' || normalized === 'mixto') return 'mixed'
  return normalized || 'cash'
}

function buildVentaPaymentDetailsForPersistence(body, totalFallback = 0, sourceDetails = null) {
  const details = Array.isArray(sourceDetails) && sourceDetails.length
    ? sourceDetails
    : normalizeVentaPaymentDetails(body)

  if (details.length) {
    return details
      .map((rawPago) => {
        const pago = rawPago || {}
        return {
          payment_form: normalizeVentaPaymentFormForStorage(pago.payment_form, body?.tipo_pago),
          payment_method_code: normalizeVentaPaymentMethodForStorage(pago.payment_method_code || pago.metodo_pago || body?.forma_pago, body?.tipo_pago),
          amount: normalizeVentaNumeric(pago.amount ?? totalFallback ?? body?.total, 0),
          due_date: normalizeVentaDate(pago.due_date),
          reference_code: pago.reference_code ? String(pago.reference_code) : null
        }
      })
      .filter((pago) => normalizeVentaNumeric(pago.amount, 0) > 0)
  }

  if (!String(body?.forma_pago || '').trim()) {
    return []
  }

  return [
    {
      payment_form: normalizeVentaPaymentFormForStorage(null, body?.tipo_pago),
      payment_method_code: normalizeVentaPaymentMethodForStorage(body?.forma_pago, body?.tipo_pago),
      amount: normalizeVentaNumeric(totalFallback ?? body?.total, 0),
      due_date: null,
      reference_code: null
    }
  ].filter((pago) => normalizeVentaNumeric(pago.amount, 0) > 0)
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

function getSafeFactusCreatedTime() {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Bogota',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })

  const parts = formatter.formatToParts(new Date())
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0)
  const second = Number(parts.find((part) => part.type === 'second')?.value || 0)
  const safetyMarginSeconds = Math.max(10, Number(process.env.FACTUS_CREATED_TIME_SAFETY_SECONDS || 180))
  const totalSeconds = Math.max(0, ((hour * 3600) + (minute * 60) + second) - safetyMarginSeconds)
  const safeHour = String(Math.floor(totalSeconds / 3600)).padStart(2, '0')
  const safeMinute = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0')
  const safeSecond = String(totalSeconds % 60).padStart(2, '0')
  return `${safeHour}:${safeMinute}:${safeSecond}`
}

function formatFactusDecimal(value, decimals = 2) {
  return normalizeVentaNumeric(value, 0).toFixed(decimals)
}

function roundFactusPrecision(value, decimals = 6) {
  const numericValue = normalizeVentaNumeric(value, 0)
  return Number(numericValue.toFixed(decimals))
}

function roundFactusMoney(value) {
  const numericValue = normalizeVentaNumeric(value, 0)
  return Number(numericValue.toFixed(2))
}

function factusMoneyToCents(value) {
  return Math.round(normalizeVentaNumeric(value, 0) * 100)
}

function centsToFactusMoney(value) {
  return Number((Number(value || 0) / 100).toFixed(2))
}

function calculateFactusLineFinancials(item) {
  const quantity = roundFactusPrecision(item?.quantity, 6)
  const price = roundFactusPrecision(item?.price, 6)
  const discountRate = roundFactusPrecision(item?.discount_rate, 6)
  const lineBase = roundFactusPrecision(quantity * price, 6)
  const discountValue = roundFactusPrecision(lineBase * (discountRate / 100), 6)
  const taxableBase = roundFactusPrecision(lineBase - discountValue, 6)
  const taxes = Array.isArray(item?.taxes) ? item.taxes : []
  const lineTaxes = taxes.reduce((taxAcc, tax) => {
    const rate = roundFactusPrecision(tax?.rate, 6)
    return roundFactusPrecision(taxAcc + roundFactusPrecision(taxableBase * (rate / 100), 6), 6)
  }, 0)
  const total = roundFactusPrecision(taxableBase + lineTaxes, 6)

  return {
    quantity,
    price,
    discountRate,
    lineBase,
    discountValue,
    taxableBase,
    lineTaxes,
    total
  }
}

function calculateFactusItemsTotal(items) {
  return (Array.isArray(items) ? items : []).reduce((acc, item) => {
    const financials = calculateFactusLineFinancials(item)
    return roundFactusMoney(acc + financials.total)
  }, 0)
}

function summarizeFactusPayload(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : []
  const summary = items.reduce((acc, item) => {
    const financials = calculateFactusLineFinancials(item)
    acc.subtotal = roundFactusMoney(acc.subtotal + financials.taxableBase)
    acc.total_tax = roundFactusMoney(acc.total_tax + financials.lineTaxes)
    acc.total = roundFactusMoney(acc.total + financials.total)
    return acc
  }, {
    subtotal: 0,
    total_tax: 0,
    total: 0
  })

  return {
    subtotal: roundFactusMoney(summary.subtotal),
    total_discount: 0,
    total_tax: roundFactusMoney(summary.total_tax),
    total: roundFactusMoney(summary.total)
  }
}

function buildCanonicalVentaDetalleItems(items, factusPayload) {
  const rawItems = Array.isArray(items) ? items : []
  const payloadItems = Array.isArray(factusPayload?.items) ? factusPayload.items : []

  if (!rawItems.length || rawItems.length !== payloadItems.length) {
    return rawItems
  }

  const canonicalItems = payloadItems.map((payloadItem, index) => {
    const rawItem = rawItems[index] || {}
    const financials = calculateFactusLineFinancials(payloadItem)
    return {
      ...rawItem,
      discount_rate: roundFactusMoney(payloadItem?.discount_rate ?? rawItem?.discount_rate ?? 0),
      subtotal: roundFactusMoney(financials.taxableBase),
      valor_total: roundFactusMoney(financials.total)
    }
  })

  const payloadSummary = summarizeFactusPayload({ items: payloadItems })
  const persistedSubtotal = canonicalItems.reduce((acc, item) => roundFactusMoney(acc + normalizeVentaNumeric(item?.subtotal, 0)), 0)
  const persistedTotal = canonicalItems.reduce((acc, item) => roundFactusMoney(acc + normalizeVentaNumeric(item?.valor_total, 0)), 0)
  const subtotalDelta = roundFactusMoney(payloadSummary.subtotal - persistedSubtotal)
  const totalDelta = roundFactusMoney(payloadSummary.total - persistedTotal)

  if (canonicalItems.length > 0 && (subtotalDelta !== 0 || totalDelta !== 0)) {
    const lastIndex = canonicalItems.length - 1
    canonicalItems[lastIndex] = {
      ...canonicalItems[lastIndex],
      subtotal: roundFactusMoney(normalizeVentaNumeric(canonicalItems[lastIndex]?.subtotal, 0) + subtotalDelta),
      valor_total: roundFactusMoney(normalizeVentaNumeric(canonicalItems[lastIndex]?.valor_total, 0) + totalDelta)
    }
  }

  return canonicalItems
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
const FACTUS_FALLBACK_PRODUCT_ID = 1417
const FACTUS_FALLBACK_PRODUCT_NAME = 'Producto electronico no registrado'
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
const MERCADOLIBRE_N8N_WEBHOOK_TIMEOUT_MS = 10000
const MERCADOLIBRE_APPROVED_PAYMENT_STATUSES = new Set(['approved'])
const MERCADOLIBRE_TERMINAL_SHIPMENT_STATUSES = new Set(['delivered', 'cancelled', 'not_delivered'])
const MERCADOLIBRE_TERMINAL_ORDER_STATUSES = new Set(['cancelled'])

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
    sendMercadoLibreApiAuthError(res, 401, 'La autorizacion interna de Mercado Libre es invalida o expiro.')
    return false
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
    sendMercadoLibreApiAuthError(res, 503, 'La autorizacion administrativa de Mercado Libre no esta configurada en el servidor.')
    return false
  }

  sendMercadoLibreApiAuthError(res, 401, 'Debes autenticarte para usar esta operacion de Mercado Libre.')
  return false
}

function requireMercadoLibreInternalApiAuthorization(req, res) {
  const validation = validateMercadoLibreInternalAuthorization(req)
  if (validation.ok) {
    req.mercadolibreAuthContext = validation
    return true
  }

  if (validation.reason === 'config_missing') {
    sendMercadoLibreApiAuthError(res, 503, 'La autenticacion interna de Mercado Libre no esta configurada en el servidor.')
    return false
  }

  sendMercadoLibreApiAuthError(res, 401, 'Debes autenticarte con las credenciales internas de Mercado Libre para usar esta operacion.')
  return false
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

async function getMercadoLibreItemDetail(accessToken, itemId) {
  const normalizedItemId = normalizeMercadoLibreStringValue(itemId, 32)
  if (!normalizedItemId) {
    const error = new Error('Debes indicar un item_id valido de Mercado Libre.')
    error.statusCode = 400
    throw error
  }

  return mercadolibreAuthenticatedRequest(accessToken, `/items/${normalizedItemId}`, {
    operation: `item_detail_${normalizedItemId}`
  })
}

async function getMercadoLibreItemPrices(accessToken, itemId) {
  const normalizedItemId = normalizeMercadoLibreStringValue(itemId, 32)
  if (!normalizedItemId) {
    const error = new Error('Debes indicar un item_id valido para consultar precios.')
    error.statusCode = 400
    throw error
  }

  return mercadolibreAuthenticatedRequest(
    accessToken,
    buildMercadoLibreApiUrl(`/items/${normalizedItemId}/prices`),
    { operation: `item_prices_${normalizedItemId}` }
  )
}

async function getMercadoLibreItemPriceToWin(accessToken, itemId) {
  const normalizedItemId = normalizeMercadoLibreStringValue(itemId, 32)
  if (!normalizedItemId) {
    const error = new Error('Debes indicar un item_id valido para consultar automatizacion de precios.')
    error.statusCode = 400
    throw error
  }

  return mercadolibreAuthenticatedRequest(
    accessToken,
    buildMercadoLibreApiUrl(`/items/${normalizedItemId}/price_to_win`),
    { operation: `item_price_to_win_${normalizedItemId}` }
  )
}

function sanitizeMercadoLibreItemPrices(data) {
  return removeEmptyObjectFields({
    id: data?.id,
    prices: Array.isArray(data?.prices)
      ? data.prices.slice(0, 10).map((price) => removeEmptyObjectFields({
        id: price?.id,
        type: price?.type,
        amount: price?.amount,
        regular_amount: price?.regular_amount,
        currency_id: price?.currency_id,
        last_updated: price?.last_updated,
        conditions: removeEmptyObjectFields({
          context_restrictions: Array.isArray(price?.conditions?.context_restrictions)
            ? price.conditions.context_restrictions.slice(0, 10)
            : undefined,
          start_time: price?.conditions?.start_time,
          end_time: price?.conditions?.end_time
        })
      }))
      : undefined
  })
}

function sanitizeMercadoLibrePriceToWin(data) {
  return removeEmptyObjectFields({
    item_id: data?.item_id,
    current_price: data?.current_price,
    currency_id: data?.currency_id,
    price_to_win: data?.price_to_win,
    status: data?.status,
    consistent: data?.consistent,
    reason: Array.isArray(data?.reason) ? data.reason.slice(0, 10) : undefined
  })
}

function sanitizeMercadoLibreOperationError(err) {
  return removeEmptyObjectFields({
    status: Number(err?.statusCode || 0) || undefined,
    message: err?.message || undefined,
    details: err?.payload || undefined
  })
}

function detectMercadoLibrePriceAutomation(itemPrices, priceToWin) {
  const prices = Array.isArray(itemPrices?.prices) ? itemPrices.prices : []
  const nonStandardPrices = prices.filter((price) => String(price?.type || '').trim().toLowerCase() !== 'standard')
  const contextualPrices = prices.filter((price) => {
    const conditions = price?.conditions || {}
    return (
      (Array.isArray(conditions.context_restrictions) && conditions.context_restrictions.length > 0) ||
      Boolean(conditions.start_time) ||
      Boolean(conditions.end_time)
    )
  })

  const priceToWinStatus = String(priceToWin?.status || '').trim().toLowerCase()
  const priceToWinReasons = Array.isArray(priceToWin?.reason)
    ? priceToWin.reason.map((reason) => String(reason || '').trim().toLowerCase()).filter(Boolean)
    : []
  const priceToWinOptedOut = priceToWinReasons.includes('item_not_opted_in')
  const priceToWinActive = Boolean(
    (priceToWinStatus && priceToWinStatus !== 'not_listed') ||
    (priceToWin?.current_price !== null && priceToWin?.current_price !== undefined) ||
    (priceToWin?.price_to_win !== null && priceToWin?.price_to_win !== undefined) ||
    (Array.isArray(priceToWin?.boosts) && priceToWin.boosts.length > 0)
  ) && !priceToWinOptedOut

  const active = nonStandardPrices.length > 0 || contextualPrices.length > 0 || priceToWinActive
  return {
    active,
    message: active
      ? 'No se puede modificar el precio vía API porque Mercado Libre tiene automatización de precios activa.'
      : null,
    diagnostics: {
      prices: sanitizeMercadoLibreItemPrices(itemPrices),
      price_to_win: sanitizeMercadoLibrePriceToWin(priceToWin),
      non_standard_prices: nonStandardPrices.length,
      contextual_prices: contextualPrices.length,
      price_to_win_active: priceToWinActive
    }
  }
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

function getMercadoLibreN8nConfig() {
  return {
    webhookUrl: String(process.env.MERCADOLIBRE_N8N_WEBHOOK_URL || '').trim(),
    webhookTimeoutMs: Math.max(1000, normalizeMercadoLibreInteger(process.env.MERCADOLIBRE_N8N_WEBHOOK_TIMEOUT_MS, MERCADOLIBRE_N8N_WEBHOOK_TIMEOUT_MS)),
    whatsappTargetNumber: String(process.env.MERCADOLIBRE_WHATSAPP_TARGET_NUMBER || '3197245235').trim() || '3197245235'
  }
}

function truncateMercadoLibreWebhookText(value, maxLength = 2000) {
  const text = typeof value === 'string' ? value : toSafeJson(value)
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function parseMercadoLibreStoredOrderRaw(row) {
  const raw = String(row?.raw_json || '').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function getMercadoLibreOrderBuyerName(order) {
  const fullName = String(
    `${order?.buyer?.first_name || ''} ${order?.buyer?.last_name || ''}`
  ).replace(/\s+/g, ' ').trim()
  return fullName || String(order?.buyer?.nickname || '').trim() || null
}

function getMercadoLibreOrderPaymentStatus(order) {
  const payments = Array.isArray(order?.payments) ? order.payments : []
  const approvedPayment = payments.find((payment) => MERCADOLIBRE_APPROVED_PAYMENT_STATUSES.has(String(payment?.status || '').trim().toLowerCase()))
  if (approvedPayment) return 'approved'

  const firstStatus = payments
    .map((payment) => String(payment?.status || '').trim().toLowerCase())
    .find(Boolean)
  if (firstStatus) return firstStatus

  const orderStatus = String(order?.status || '').trim().toLowerCase()
  if (orderStatus === 'paid') return 'approved'
  return null
}

function getMercadoLibreApprovedPaymentId(order) {
  const approvedPayment = (Array.isArray(order?.payments) ? order.payments : []).find((payment) => {
    return MERCADOLIBRE_APPROVED_PAYMENT_STATUSES.has(String(payment?.status || '').trim().toLowerCase())
  })
  return approvedPayment?.id ? String(approvedPayment.id).trim() : null
}

function getMercadoLibreOrderShipmentId(order) {
  const shipmentId = order?.shipping?.id ?? order?.shipping_id ?? order?.shipment_id
  const normalized = Number(shipmentId)
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null
}

async function getMercadoLibreShipmentDetail(accessToken, shipmentId) {
  const normalizedShipmentId = Number(shipmentId)
  if (!Number.isFinite(normalizedShipmentId) || normalizedShipmentId <= 0) {
    return null
  }

  return mercadolibreAuthenticatedRequest(
    accessToken,
    `/shipments/${normalizedShipmentId}`,
    { operation: `shipment_detail_${normalizedShipmentId}` }
  )
}

function sanitizeMercadoLibreShipmentSummary(shipment) {
  const receiverAddress = shipment?.receiver_address || shipment?.receiverAddress || {}
  return removeEmptyObjectFields({
    id: Number(shipment?.id || 0) || undefined,
    status: String(shipment?.status || '').trim() || undefined,
    substatus: String(shipment?.substatus || '').trim() || undefined,
    logistic_type: String(shipment?.logistic_type || '').trim() || undefined,
    shipping_mode: String(shipment?.shipping_mode || '').trim() || undefined,
    tracking_number: String(shipment?.tracking_number || '').trim() || undefined,
    receiver_name: String(shipment?.receiver_address?.receiver_name || '').trim() || undefined,
    address: removeEmptyObjectFields({
      address_line: String(receiverAddress?.address_line || '').trim() || undefined,
      city: String(receiverAddress?.city?.name || receiverAddress?.city_name || '').trim() || undefined,
      state: String(receiverAddress?.state?.name || receiverAddress?.state_name || '').trim() || undefined,
      zip_code: String(receiverAddress?.zip_code || '').trim() || undefined,
      comment: String(receiverAddress?.comment || '').trim() || undefined
    })
  })
}

function sanitizeMercadoLibrePaymentSummary(order) {
  const payments = Array.isArray(order?.payments) ? order.payments : []
  return payments.slice(0, 10).map((payment) => removeEmptyObjectFields({
    id: payment?.id,
    status: payment?.status,
    status_detail: payment?.status_detail,
    transaction_amount: payment?.transaction_amount,
    currency_id: payment?.currency_id,
    date_approved: payment?.date_approved,
    payment_type: payment?.payment_type,
    payment_method_id: payment?.payment_method_id
  }))
}

async function buildMercadoLibreOrderItemSummary(orderItem, conn = pool) {
  const itemId = String(orderItem?.item?.id || '').trim() || null
  const publication = itemId ? await ensureMercadoLibrePublicationMapping(itemId, conn) : null
  const productoId = Number(publication?.producto_id || 0) || null
  const producto = productoId ? await getProductoByIdProducto(productoId, conn) : null
  const quantity = normalizeVentaNumeric(orderItem?.quantity, 0)
  const unitPrice = normalizeVentaNumeric(
    orderItem?.unit_price ?? orderItem?.full_unit_price ?? producto?.precio_final,
    0
  )

  return removeEmptyObjectFields({
    item_id: itemId || undefined,
    producto_id: productoId || undefined,
    referencia: producto?.id_producto ? Number(producto.id_producto) : undefined,
    nombre_producto: String(producto?.nombre || orderItem?.item?.title || '').trim() || undefined,
    title: String(orderItem?.item?.title || producto?.nombre || '').trim() || undefined,
    quantity,
    cantidad: quantity,
    unit_price: unitPrice,
    precio_unitario: unitPrice,
    permalink: String(publication?.permalink || '').trim() || undefined,
    seller_sku: String(publication?.seller_sku || '').trim() || undefined
  })
}

function isMercadoLibreOrderPendingAttention(orderView) {
  const orderStatus = String(orderView?.status || orderView?.estado || '').trim().toLowerCase()
  const paymentStatus = String(orderView?.payment_status || orderView?.estado_pago || '').trim().toLowerCase()
  const shipmentStatus = String(orderView?.shipment?.status || orderView?.estado_envio || '').trim().toLowerCase()

  if (MERCADOLIBRE_TERMINAL_ORDER_STATUSES.has(orderStatus)) return false
  if (!paymentStatus || paymentStatus !== 'approved') return true
  if (!shipmentStatus) return true
  return !MERCADOLIBRE_TERMINAL_SHIPMENT_STATUSES.has(shipmentStatus)
}

function matchesMercadoLibreOrderFilters(orderView, filters = {}) {
  const referenceFilter = Number(filters.referencia || filters.producto_id || 0) || null
  const itemIdFilter = String(filters.item_id || '').trim()
  const statusFilter = String(filters.status || '').trim().toLowerCase()
  const paymentStatusFilter = String(filters.payment_status || '').trim().toLowerCase()
  const shipmentStatusFilter = String(filters.shipment_status || filters.estado_envio || '').trim().toLowerCase()
  const buyerFilter = String(filters.buyer || filters.comprador || '').trim().toLowerCase()
  const pendingShipping = parseBooleanLike(filters.pending_shipping ?? filters.pendientes_envio ?? false)

  if (referenceFilter && !orderView.items.some((item) => Number(item?.producto_id || item?.referencia || 0) === referenceFilter)) {
    return false
  }

  if (itemIdFilter && !orderView.items.some((item) => String(item?.item_id || '').trim() === itemIdFilter)) {
    return false
  }

  if (statusFilter && String(orderView.status || '').trim().toLowerCase() !== statusFilter) {
    return false
  }

  if (paymentStatusFilter && String(orderView.payment_status || '').trim().toLowerCase() !== paymentStatusFilter) {
    return false
  }

  if (shipmentStatusFilter && String(orderView.shipment?.status || '').trim().toLowerCase() !== shipmentStatusFilter) {
    return false
  }

  if (buyerFilter) {
    const haystack = [
      String(orderView.buyer || '').trim().toLowerCase(),
      ...orderView.items.map((item) => String(item?.nombre_producto || item?.title || '').trim().toLowerCase())
    ].join(' ')
    if (!haystack.includes(buyerFilter)) {
      return false
    }
  }

  if (pendingShipping) {
    const paymentApproved = String(orderView.payment_status || '').trim().toLowerCase() === 'approved'
    const shipmentStatus = String(orderView.shipment?.status || '').trim().toLowerCase()
    if (!paymentApproved || !shipmentStatus || MERCADOLIBRE_TERMINAL_SHIPMENT_STATUSES.has(shipmentStatus)) {
      return false
    }
  }

  return true
}

async function buildMercadoLibreOrderView(order, options = {}) {
  const { accessToken, conn = pool } = options
  const items = []
  const orderItems = Array.isArray(order?.order_items) ? order.order_items : []
  for (const orderItem of orderItems) {
    items.push(await buildMercadoLibreOrderItemSummary(orderItem, conn))
  }

  let shipmentDetail = null
  const shipmentId = getMercadoLibreOrderShipmentId(order)
  if (shipmentId && accessToken) {
    try {
      shipmentDetail = await getMercadoLibreShipmentDetail(accessToken, shipmentId)
    } catch (err) {
      shipmentDetail = order?.shipping || null
    }
  } else if (order?.shipping) {
    shipmentDetail = order.shipping
  }

  const paymentStatus = getMercadoLibreOrderPaymentStatus(order)
  const buyerName = getMercadoLibreOrderBuyerName(order)
  const shipment = sanitizeMercadoLibreShipmentSummary(shipmentDetail || removeEmptyObjectFields({
    id: shipmentId || undefined,
    status: order?.shipping?.status || undefined
  }))
  const primaryItem = items[0] || {}

  const view = removeEmptyObjectFields({
    order_id: Number(order?.id || 0) || undefined,
    fecha: order?.date_created || undefined,
    status: String(order?.status || '').trim() || undefined,
    estado: String(order?.status || '').trim() || undefined,
    status_detail: String(order?.status_detail || '').trim() || undefined,
    estado_pago: paymentStatus || undefined,
    payment_status: paymentStatus || undefined,
    buyer: buyerName || undefined,
    buyer_detail: removeEmptyObjectFields({
      nickname: String(order?.buyer?.nickname || '').trim() || undefined,
      first_name: String(order?.buyer?.first_name || '').trim() || undefined,
      last_name: String(order?.buyer?.last_name || '').trim() || undefined
    }),
    total: order?.total_amount ?? undefined,
    moneda: String(order?.currency_id || '').trim() || undefined,
    item_id: primaryItem.item_id || undefined,
    producto_id: primaryItem.producto_id || undefined,
    referencia: primaryItem.referencia || undefined,
    nombre_producto: primaryItem.nombre_producto || undefined,
    cantidad: primaryItem.cantidad || undefined,
    precio_unitario: primaryItem.precio_unitario ?? undefined,
    shipment_id: shipment.id || undefined,
    estado_envio: shipment.status || undefined,
    permalink: primaryItem.permalink || undefined,
    items,
    shipment,
    payments: sanitizeMercadoLibrePaymentSummary(order),
    tags: Array.isArray(order?.tags) ? order.tags.slice(0, 20) : undefined,
    operation: removeEmptyObjectFields({
      ready_for_whatsapp: true,
      needs_attention: false
    })
  })

  view.operation = {
    ...view.operation,
    needs_attention: isMercadoLibreOrderPendingAttention(view)
  }

  return view
}

async function getMercadoLibreOrderRowById(orderId, conn = pool) {
  const normalizedOrderId = Number(orderId)
  if (!Number.isFinite(normalizedOrderId) || normalizedOrderId <= 0) {
    return null
  }

  const [rows] = await conn.query(
    `SELECT *
     FROM mercadolibre_ordenes
     WHERE order_id = ?
     LIMIT 1`,
    [normalizedOrderId]
  )

  return rows && rows.length ? rows[0] : null
}

async function collectMercadoLibreOrderViews(options = {}, conn = pool) {
  const requestedOrderIds = Array.isArray(options.orderIds)
    ? [...new Set(options.orderIds.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0))]
    : []
  const limit = Math.max(1, Math.min(50, normalizeMercadoLibreInteger(options.limit, MERCADOLIBRE_DEFAULT_SYNC_LIMIT)))
  const offset = Math.max(0, normalizeMercadoLibreInteger(options.offset, 0))
  const onlyPending = options.onlyPending === true
  const { account, accessToken } = await getValidMercadoLibreAccessToken(conn)

  let baseOrders = []
  if (requestedOrderIds.length > 0) {
    baseOrders = requestedOrderIds.map((orderId) => ({ id: orderId }))
  } else {
    const remote = await fetchMercadoLibreOrders(accessToken, account.meli_user_id, { limit, offset })
    baseOrders = Array.isArray(remote?.results) ? remote.results : []
  }

  const previousRows = await getMercadoLibreOrderRowsByIds(baseOrders.map((order) => order.id), conn)
  const previousRowMap = new Map(previousRows.map((row) => [String(row.order_id), row]))
  const views = []

  for (const baseOrder of baseOrders) {
    const detail = requestedOrderIds.length > 0 && Array.isArray(baseOrder?.order_items)
      ? baseOrder
      : await getMercadoLibreOrderDetail(accessToken, baseOrder.id)

    const previousRow = previousRowMap.get(String(detail.id)) || null
    await upsertMercadoLibreOrderSnapshot(detail, account, conn)
    const view = await buildMercadoLibreOrderView(detail, { accessToken, conn })
    if (onlyPending && !isMercadoLibreOrderPendingAttention(view)) {
      continue
    }
    if (!matchesMercadoLibreOrderFilters(view, options.filters || {})) {
      continue
    }

    views.push({
      order: detail,
      previousRow,
      view
    })
  }

  return {
    account,
    orders: views
  }
}

function buildMercadoLibreOrderEventKey(eventPayload) {
  const eventType = String(eventPayload?.event || '').trim()
  const orderId = String(eventPayload?.order_id || '').trim()
  const shipmentId = String(eventPayload?.shipment?.id || '').trim()
  const shipmentStatus = String(eventPayload?.shipment?.status || '').trim().toLowerCase()
  const paymentStatus = String(eventPayload?.payment_status || '').trim().toLowerCase()
  const approvedPaymentId = String(eventPayload?.approved_payment_id || '').trim()

  let fingerprint = `${eventType}|${orderId}`
  if (eventType === 'shipment_status_changed') {
    fingerprint = `${fingerprint}|${shipmentId}|${shipmentStatus}`
  } else if (eventType === 'payment_approved') {
    fingerprint = `${fingerprint}|${paymentStatus}|${approvedPaymentId}`
  }

  return crypto.createHash('sha256').update(fingerprint, 'utf8').digest('hex')
}

function buildMercadoLibreN8nEventPayload(eventType, orderView, order) {
  const config = getMercadoLibreN8nConfig()
  return removeEmptyObjectFields({
    event: eventType,
    order_id: orderView?.order_id,
    fecha: orderView?.fecha,
    status: orderView?.status,
    payment_status: orderView?.payment_status,
    approved_payment_id: getMercadoLibreApprovedPaymentId(order) || undefined,
    buyer: orderView?.buyer,
    total: orderView?.total,
    currency: orderView?.moneda,
    items: Array.isArray(orderView?.items)
      ? orderView.items.map((item) => removeEmptyObjectFields({
        producto_id: item?.producto_id,
        item_id: item?.item_id,
        title: item?.title || item?.nombre_producto,
        quantity: item?.quantity ?? item?.cantidad,
        unit_price: item?.unit_price ?? item?.precio_unitario,
        referencia: item?.referencia
      }))
      : undefined,
    shipment: removeEmptyObjectFields({
      id: orderView?.shipment?.id,
      status: orderView?.shipment?.status
    }),
    notification_target: removeEmptyObjectFields({
      channel: 'whatsapp',
      number: config.whatsappTargetNumber || undefined
    })
  })
}

function detectMercadoLibreOrderEvents(previousOrder, currentOrderView, currentOrderRaw) {
  const events = []
  const previousStatus = String(previousOrder?.status || '').trim().toLowerCase()
  const currentStatus = String(currentOrderView?.status || '').trim().toLowerCase()
  const previousPaymentStatus = getMercadoLibreOrderPaymentStatus(previousOrder)
  const currentPaymentStatus = String(currentOrderView?.payment_status || '').trim().toLowerCase()
  const previousShipmentId = getMercadoLibreOrderShipmentId(previousOrder)
  const previousShipmentStatus = String(previousOrder?.shipping?.status || '').trim().toLowerCase()
  const currentShipmentId = Number(currentOrderView?.shipment?.id || 0) || null
  const currentShipmentStatus = String(currentOrderView?.shipment?.status || '').trim().toLowerCase()

  if (!previousOrder) {
    const payload = buildMercadoLibreN8nEventPayload('new_order', currentOrderView, currentOrderRaw)
    events.push({
      ...payload,
      event_key: buildMercadoLibreOrderEventKey(payload)
    })
    return events
  }

  if (currentPaymentStatus === 'approved' && previousPaymentStatus !== 'approved') {
    const payload = buildMercadoLibreN8nEventPayload('payment_approved', currentOrderView, currentOrderRaw)
    events.push({
      ...payload,
      event_key: buildMercadoLibreOrderEventKey(payload)
    })
  }

  if (currentStatus === 'cancelled' && previousStatus !== 'cancelled') {
    const payload = buildMercadoLibreN8nEventPayload('order_cancelled', currentOrderView, currentOrderRaw)
    events.push({
      ...payload,
      event_key: buildMercadoLibreOrderEventKey(payload)
    })
  }

  if (
    currentShipmentId
    && currentShipmentStatus
    && previousOrder
    && previousShipmentId === currentShipmentId
    && previousShipmentStatus
    && previousShipmentStatus !== currentShipmentStatus
  ) {
    const payload = buildMercadoLibreN8nEventPayload('shipment_status_changed', currentOrderView, currentOrderRaw)
    events.push({
      ...payload,
      event_key: buildMercadoLibreOrderEventKey(payload)
    })
  }

  return events
}

async function reserveMercadoLibreN8nEvent(eventPayload, conn = pool) {
  const [result] = await conn.query(
    `INSERT IGNORE INTO mercadolibre_n8n_eventos (
       event_key,
       event_type,
       order_id,
       payload_json,
       delivery_status,
       first_seen_at
     ) VALUES (?, ?, ?, ?, 'pending', NOW())`,
    [
      String(eventPayload?.event_key || '').trim(),
      String(eventPayload?.event || '').trim(),
      Number(eventPayload?.order_id || 0),
      toSafeJson(eventPayload)
    ]
  )

  return result?.affectedRows > 0
}

async function updateMercadoLibreN8nEventDelivery(eventKey, data, conn = pool) {
  await conn.query(
    `UPDATE mercadolibre_n8n_eventos
     SET
       delivery_status = ?,
       http_status = ?,
       response_body = ?,
       last_attempt_at = NOW(),
       dispatched_at = ?,
       payload_json = ?
     WHERE event_key = ?`,
    [
      String(data?.deliveryStatus || 'pending').trim() || 'pending',
      data?.httpStatus ? Number(data.httpStatus) : null,
      data?.responseBody ? truncateMercadoLibreWebhookText(data.responseBody) : null,
      data?.deliveryStatus === 'delivered' ? new Date() : null,
      data?.payload ? toSafeJson(data.payload) : null,
      String(eventKey || '').trim()
    ]
  )
}

async function dispatchMercadoLibreEventToConfiguredN8nWebhook(eventPayload) {
  const config = getMercadoLibreN8nConfig()
  if (!config.webhookUrl) {
    const error = new Error('Debes configurar MERCADOLIBRE_N8N_WEBHOOK_URL para despachar eventos a n8n.')
    error.statusCode = 503
    throw error
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.webhookTimeoutMs)

  try {
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(eventPayload),
      signal: controller.signal
    })

    const contentType = response.headers.get('content-type') || ''
    const body = contentType.includes('application/json')
      ? await response.json().catch(() => null)
      : await response.text().catch(() => '')

    if (!response.ok) {
      const error = new Error('n8n rechazó el webhook de Mercado Libre.')
      error.statusCode = response.status
      error.payload = body
      throw error
    }

    return {
      httpStatus: response.status,
      body
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeoutError = new Error('Tiempo de espera agotado enviando webhook de Mercado Libre a n8n.')
      timeoutError.statusCode = 504
      throw timeoutError
    }
    throw err
  } finally {
    clearTimeout(timer)
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

async function updateMercadoLibreItemPrice(producto, publication, nextPrice, account, accessToken, conn = pool) {
  const itemId = normalizeMercadoLibreStringValue(publication?.item_id, 32)
  const normalizedPrice = normalizeVentaNumeric(nextPrice, 0)

  if (!itemId) {
    const error = new Error('El producto no tiene una publicación de Mercado Libre vinculada.')
    error.statusCode = 404
    throw error
  }

  if (!(normalizedPrice > 0)) {
    const error = new Error('Debes enviar un precio valido para actualizar la publicación de Mercado Libre.')
    error.statusCode = 400
    throw error
  }

  const remoteItemBefore = await getMercadoLibreItemDetail(accessToken, itemId)
  let itemPrices = null
  let priceToWin = null
  let itemPricesError = null
  let priceToWinError = null

  try {
    itemPrices = await getMercadoLibreItemPrices(accessToken, itemId)
  } catch (err) {
    itemPricesError = sanitizeMercadoLibreOperationError(err)
  }

  try {
    priceToWin = await getMercadoLibreItemPriceToWin(accessToken, itemId)
  } catch (err) {
    priceToWinError = sanitizeMercadoLibreOperationError(err)
  }

  const priceState = detectMercadoLibrePriceAutomation(itemPrices, priceToWin)
  priceState.diagnostics = removeEmptyObjectFields({
    ...priceState.diagnostics,
    prices_error: itemPricesError,
    price_to_win_error: priceToWinError
  })

  if (priceState.active) {
    const error = new Error(priceState.message)
    error.statusCode = 409
    error.payload = priceState.diagnostics
    throw error
  }

  let updatedItem
  try {
    updatedItem = await mercadolibreAuthenticatedRequest(accessToken, `/items/${itemId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        price: normalizedPrice
      }),
      operation: `item_price_update_${itemId}`
    })
  } catch (err) {
    err.remoteItemBefore = removeEmptyObjectFields({
      id: remoteItemBefore?.id,
      status: remoteItemBefore?.status,
      sub_status: remoteItemBefore?.sub_status,
      price: remoteItemBefore?.price,
      permalink: remoteItemBefore?.permalink
    })
    throw err
  }

  await upsertMercadoLibrePublication({
    meliUserId: account.meli_user_id,
    itemId,
    productoId: publication?.producto_id || producto?.id_producto || null,
    sellerSku: extractMercadoLibreSellerSku(updatedItem),
    categoryId: updatedItem.category_id || publication?.category_id || null,
    title: updatedItem.title || updatedItem.family_name || publication?.title || null,
    status: updatedItem.status || publication?.status || null,
    price: updatedItem.price ?? normalizedPrice,
    availableQuantity: updatedItem.available_quantity ?? publication?.available_quantity ?? null,
    permalink: updatedItem.permalink || publication?.permalink || null,
    rawJson: updatedItem
  }, conn)

  return {
    item: updatedItem,
    remoteItemBefore: removeEmptyObjectFields({
      id: remoteItemBefore?.id,
      status: remoteItemBefore?.status,
      sub_status: remoteItemBefore?.sub_status,
      price: remoteItemBefore?.price,
      permalink: remoteItemBefore?.permalink
    }),
    priceState
  }
}

async function updateMercadoLibreItemStatus(producto, publication, nextStatus, account, accessToken, conn = pool) {
  const itemId = normalizeMercadoLibreStringValue(publication?.item_id, 32)
  const normalizedStatus = normalizeMercadoLibreStringValue(nextStatus, 32).toLowerCase()
  const allowedStatuses = new Set(['active', 'paused'])

  if (!itemId) {
    const error = new Error('El producto no tiene una publicación de Mercado Libre vinculada.')
    error.statusCode = 404
    throw error
  }

  if (!allowedStatuses.has(normalizedStatus)) {
    const error = new Error('Debes enviar un status valido para la publicación de Mercado Libre.')
    error.statusCode = 400
    throw error
  }

  const remoteItemBefore = await getMercadoLibreItemDetail(accessToken, itemId)
  const currentStatus = normalizeMercadoLibreStringValue(remoteItemBefore?.status, 32).toLowerCase()

  let updatedItem = remoteItemBefore
  let changed = false
  if (currentStatus !== normalizedStatus) {
    try {
      updatedItem = await mercadolibreAuthenticatedRequest(accessToken, `/items/${itemId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          status: normalizedStatus
        }),
        operation: `item_status_update_${itemId}`
      })
      changed = true
    } catch (err) {
      err.remoteItemBefore = removeEmptyObjectFields({
        id: remoteItemBefore?.id,
        status: remoteItemBefore?.status,
        sub_status: remoteItemBefore?.sub_status,
        price: remoteItemBefore?.price,
        permalink: remoteItemBefore?.permalink
      })
      throw err
    }
  }

  await upsertMercadoLibrePublication({
    meliUserId: account.meli_user_id,
    itemId,
    productoId: publication?.producto_id || producto?.id_producto || null,
    sellerSku: extractMercadoLibreSellerSku(updatedItem),
    categoryId: updatedItem.category_id || publication?.category_id || null,
    title: updatedItem.title || updatedItem.family_name || publication?.title || null,
    status: updatedItem.status || normalizedStatus || publication?.status || null,
    price: updatedItem.price ?? publication?.price ?? null,
    availableQuantity: updatedItem.available_quantity ?? publication?.available_quantity ?? null,
    permalink: updatedItem.permalink || publication?.permalink || null,
    rawJson: updatedItem
  }, conn)

  return {
    item: updatedItem,
    changed,
    requestedStatus: normalizedStatus,
    remoteItemBefore: removeEmptyObjectFields({
      id: remoteItemBefore?.id,
      status: remoteItemBefore?.status,
      sub_status: remoteItemBefore?.sub_status,
      price: remoteItemBefore?.price,
      permalink: remoteItemBefore?.permalink
    })
  }
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

function getMercadoLibrePictureUploadFilename(sourceUrl, contentType = '') {
  const defaultExtension = String(contentType || '').toLowerCase().includes('png') ? '.png' : '.jpg'
  try {
    const parsedUrl = new URL(String(sourceUrl || ''))
    const baseName = path.basename(parsedUrl.pathname || '').trim()
    if (baseName) return baseName
  } catch {}
  return `mercadolibre-producto${defaultExtension}`
}

async function uploadMercadoLibrePictureFromUrl(accessToken, sourceUrl) {
  const normalizedUrl = normalizeMercadoLibreStringValue(sourceUrl, 1000)
  if (!normalizedUrl) {
    const error = new Error('La imagen del producto no tiene una URL valida para subir a Mercado Libre.')
    error.statusCode = 400
    throw error
  }

  const imageResponse = await fetch(normalizedUrl, {
    method: 'GET',
    headers: {
      Accept: 'image/*'
    }
  })
  if (!imageResponse.ok) {
    const error = new Error('No se pudo descargar la imagen del producto para subirla a Mercado Libre.')
    error.statusCode = 502
    error.payload = {
      source_url: normalizedUrl,
      status: imageResponse.status
    }
    throw error
  }

  const contentType = String(imageResponse.headers.get('content-type') || 'image/jpeg').trim() || 'image/jpeg'
  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer())
  if (!imageBuffer.length) {
    const error = new Error('La imagen del producto esta vacia y no se puede subir a Mercado Libre.')
    error.statusCode = 400
    error.payload = {
      source_url: normalizedUrl
    }
    throw error
  }

  const form = new FormData()
  form.append(
    'file',
    new Blob([imageBuffer], { type: contentType }),
    getMercadoLibrePictureUploadFilename(normalizedUrl, contentType)
  )

  const uploadedPicture = await mercadolibreAuthenticatedRequest(accessToken, '/pictures/items/upload', {
    method: 'POST',
    operation: 'picture_upload',
    body: form
  })

  const pictureId = normalizeMercadoLibreStringValue(uploadedPicture?.id, 120)
  if (!pictureId) {
    const error = new Error('Mercado Libre no devolvio un picture_id al subir la imagen.')
    error.statusCode = 502
    error.payload = sanitizeMercadoLibreError(uploadedPicture)
    throw error
  }

  return {
    id: pictureId,
    source_url: normalizedUrl,
    secure_url: uploadedPicture?.variations?.[0]?.secure_url || uploadedPicture?.secure_url || null,
    raw: uploadedPicture
  }
}

async function prepareMercadoLibrePicturesForPayload(payload, accessToken) {
  const draftPictures = Array.isArray(payload?.pictures) ? payload.pictures : []
  if (draftPictures.length === 0) return { payload, uploadedPictures: [] }

  const preparedPictures = []
  const uploadedPictures = []
  for (const picture of draftPictures) {
    const existingId = normalizeMercadoLibreStringValue(picture?.id, 120)
    if (existingId) {
      preparedPictures.push({ id: existingId })
      continue
    }

    const sourceUrl = normalizeMercadoLibreStringValue(picture?.source || picture?.url, 1000)
    if (!sourceUrl) continue
    const uploadedPicture = await uploadMercadoLibrePictureFromUrl(accessToken, sourceUrl)
    preparedPictures.push({ id: uploadedPicture.id })
    uploadedPictures.push(uploadedPicture)
  }

  return {
    payload: {
      ...payload,
      pictures: preparedPictures
    },
    uploadedPictures
  }
}

function formatMercadoLibrePlainNumberString(value, maxDecimals = 2) {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue) || numericValue <= 0) return ''
  const fixed = numericValue.toFixed(Math.max(0, maxDecimals))
  return fixed.replace(/\.?0+$/, '')
}

function formatMercadoLibreAttributeUnitValue(attributeId, rawValue) {
  const id = normalizeMercadoLibreStringValue(attributeId, 80).toUpperCase()
  const normalizedRawValue = normalizeMercadoLibreStringValue(rawValue, 255)
  const numericValue = Number(normalizedRawValue)
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return normalizedRawValue
  }

  if (['SELLER_PACKAGE_HEIGHT', 'SELLER_PACKAGE_WIDTH', 'SELLER_PACKAGE_LENGTH'].includes(id)) {
    return `${formatMercadoLibrePlainNumberString(numericValue, 2)} cm`
  }

  if (id === 'SELLER_PACKAGE_WEIGHT') {
    return `${formatMercadoLibrePlainNumberString(numericValue, 0)} g`
  }

  return normalizedRawValue
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
    ['SELLER_PACKAGE_HEIGHT', packageMetrics.heightCm > 0 ? `${formatMercadoLibrePlainNumberString(packageMetrics.heightCm, 2)} cm` : ''],
    ['SELLER_PACKAGE_WIDTH', packageMetrics.widthCm > 0 ? `${formatMercadoLibrePlainNumberString(packageMetrics.widthCm, 2)} cm` : ''],
    ['SELLER_PACKAGE_LENGTH', packageMetrics.lengthCm > 0 ? `${formatMercadoLibrePlainNumberString(packageMetrics.lengthCm, 2)} cm` : ''],
    ['SELLER_PACKAGE_WEIGHT', packageMetrics.weightGrams > 0 ? `${packageMetrics.weightGrams} g` : '']
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
    const valueName = formatMercadoLibreAttributeUnitValue(id, attribute?.value_name)
    const entry = { id }
    if (valueId) entry.value_id = valueId
    if (valueName) entry.value_name = valueName
    if (!entry.value_id && !entry.value_name) continue
    normalizedMap.set(id, entry)
  }
  return [...normalizedMap.values()]
}

function normalizeMercadoLibreComparableText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function inferMercadoLibrePowerSupplyType(producto, draft = {}, description = '') {
  const text = normalizeMercadoLibreComparableText([
    producto?.nombre,
    producto?.descripcion,
    producto?.ml_marketplace_description,
    draft?.title,
    draft?.family_name,
    description
  ].filter(Boolean).join(' '))

  if (!text) return ''

  if (
    /\b(bateria|inalambric[oa]s?|inalambrico|inalambrica|recargable|cordless)\b/.test(text)
  ) {
    return 'Batería'
  }

  if (/\b(pila|pilas)\b/.test(text)) {
    return 'Pila'
  }

  if (/\b(manual|manivela)\b/.test(text)) {
    return 'Operación manual'
  }

  const hasElectricalSignal =
    /\b\d+(?:[.,]\d+)?\s*(w|kw|v|kv|watts?|volt(?:s|ios?)?)\b/.test(text) ||
    /\b(voltaje|electrica|electrico|corriente)\b/.test(text)

  if (hasElectricalSignal) {
    return 'Corriente doméstica'
  }

  return ''
}

function inferMercadoLibreCuttingBladesNumber(producto, draft = {}, description = '') {
  const text = normalizeMercadoLibreComparableText([
    producto?.nombre,
    producto?.descripcion,
    producto?.ml_marketplace_description,
    draft?.title,
    draft?.family_name,
    description
  ].filter(Boolean).join(' '))

  if (!text) return ''

  const explicitCountMatch = text.match(/\b(\d+)\s*(cuchillas?|cuchilla|blades?|blade|hojas?|hoja)\b/)
  if (explicitCountMatch?.[1]) {
    const explicitCount = Number(explicitCountMatch[1])
    if (Number.isFinite(explicitCount) && explicitCount > 0) {
      return String(Math.trunc(explicitCount))
    }
  }

  if (
    /\b(cortador(?:es)? de vidrio|glass cutter|cortavidrio(?:s)?|corta vidrio)\b/.test(text) ||
    (/\b(cuchilla|blade|hoja)\b/.test(text) && !/\b(cuchillas|blades|hojas)\b/.test(text))
  ) {
    return '1'
  }

  return ''
}

function resolveMercadoLibreCategoryAttributeValue(categoryAttribute, desiredValueName, options = {}) {
  const allowRawValueName = parseBooleanLike(options?.allowRawValueName ?? false)
  const normalizedDesired = normalizeMercadoLibreComparableText(desiredValueName)
  const rawDesired = normalizeMercadoLibreStringValue(desiredValueName, 120)
  if (!normalizedDesired && !rawDesired) return null

  const allowedValues = Array.isArray(categoryAttribute?.values) ? categoryAttribute.values : []
  const matchedValue = allowedValues.find((value) => {
    if (rawDesired && normalizeMercadoLibreStringValue(value?.id, 120) === rawDesired) {
      return true
    }
    const candidates = [
      value?.name,
      value?.value_name,
      value?.label
    ]
    return normalizedDesired
      ? candidates.some((candidate) => normalizeMercadoLibreComparableText(candidate) === normalizedDesired)
      : false
  })

  if (!matchedValue) {
    if (allowRawValueName) {
      return removeEmptyObjectFields({
        id: normalizeMercadoLibreStringValue(categoryAttribute?.id, 80).toUpperCase(),
        value_name: rawDesired || null
      })
    }
    return null
  }

  return removeEmptyObjectFields({
    id: normalizeMercadoLibreStringValue(categoryAttribute?.id, 80).toUpperCase(),
    value_id: normalizeMercadoLibreStringValue(matchedValue?.id, 120) || null,
    value_name: normalizeMercadoLibreStringValue(
      matchedValue?.name || matchedValue?.value_name || desiredValueName,
      255
    ) || null
  })
}

function enrichMercadoLibreDraftAttributes(producto, draft, categoryAttributes, description = '') {
  const categoryAttributeMap = new Map(
    (Array.isArray(categoryAttributes) ? categoryAttributes : [])
      .map((attribute) => [
        normalizeMercadoLibreStringValue(attribute?.id, 80).toUpperCase(),
        attribute
      ])
      .filter(([id]) => Boolean(id))
  )

  const attributeMap = getMercadoLibreAttributeMap(draft?.attributes || [])
  const inferredAttributes = []

  const powerSupplyAttributeId = 'POWER_SUPPLY_TYPE'
  const powerSupplyCategoryAttribute = categoryAttributeMap.get(powerSupplyAttributeId)
  if (powerSupplyCategoryAttribute) {
    const existingPowerSupplyAttribute = attributeMap.get(powerSupplyAttributeId)
    const inferredPowerSupplyValue = inferMercadoLibrePowerSupplyType(producto, draft, description)
    const resolvedExistingPowerSupplyAttribute = resolveMercadoLibreCategoryAttributeValue(
      powerSupplyCategoryAttribute,
      existingPowerSupplyAttribute?.value_name || existingPowerSupplyAttribute?.value_id
    )
    const resolvedInferredPowerSupplyAttribute = resolveMercadoLibreCategoryAttributeValue(
      powerSupplyCategoryAttribute,
      inferredPowerSupplyValue
    )
    const resolvedPowerSupplyAttribute = resolvedExistingPowerSupplyAttribute || resolvedInferredPowerSupplyAttribute

    if (resolvedPowerSupplyAttribute) {
      attributeMap.set(powerSupplyAttributeId, resolvedPowerSupplyAttribute)
      inferredAttributes.push({
        id: powerSupplyAttributeId,
        source: resolvedExistingPowerSupplyAttribute ? 'existing_attribute_resolved' : 'inferred_from_text',
        value_name: resolvedPowerSupplyAttribute.value_name || null,
        value_id: resolvedPowerSupplyAttribute.value_id || null
      })
    }
  }

  const cuttingBladesAttributeId = 'CUTTING_BLADES_NUMBER'
  const cuttingBladesCategoryAttribute = categoryAttributeMap.get(cuttingBladesAttributeId)
  if (cuttingBladesCategoryAttribute) {
    const existingCuttingBladesAttribute = attributeMap.get(cuttingBladesAttributeId)
    const inferredCuttingBladesValue = inferMercadoLibreCuttingBladesNumber(producto, draft, description)
    const resolvedExistingCuttingBladesAttribute = resolveMercadoLibreCategoryAttributeValue(
      cuttingBladesCategoryAttribute,
      existingCuttingBladesAttribute?.value_name || existingCuttingBladesAttribute?.value_id,
      { allowRawValueName: true }
    )
    const resolvedInferredCuttingBladesAttribute = resolveMercadoLibreCategoryAttributeValue(
      cuttingBladesCategoryAttribute,
      inferredCuttingBladesValue,
      { allowRawValueName: true }
    )
    const resolvedCuttingBladesAttribute = resolvedExistingCuttingBladesAttribute || resolvedInferredCuttingBladesAttribute

    if (resolvedCuttingBladesAttribute) {
      attributeMap.set(cuttingBladesAttributeId, resolvedCuttingBladesAttribute)
      inferredAttributes.push({
        id: cuttingBladesAttributeId,
        source: resolvedExistingCuttingBladesAttribute ? 'existing_attribute_resolved' : 'inferred_from_text',
        value_name: resolvedCuttingBladesAttribute.value_name || null,
        value_id: resolvedCuttingBladesAttribute.value_id || null
      })
    }
  }

  return {
    draft: {
      ...draft,
      attributes: normalizeMercadoLibrePublicationAttributes([...attributeMap.values()])
    },
    inferredAttributes
  }
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
  const saleTerms = Array.isArray(options.saleTerms) ? options.saleTerms : []

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
    attributes
  }

  const {
    draft: enrichedDraft,
    inferredAttributes
  } = enrichMercadoLibreDraftAttributes(
    producto,
    draft,
    options.categoryAttributes,
    description
  )

  if (saleTerms.length > 0) {
    enrichedDraft.sale_terms = saleTerms
  }

  if (!isUserProductSeller) {
    enrichedDraft.title = title
  }

  return {
    producto,
    draft: enrichedDraft,
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
      stored_attributes_count: Array.isArray(producto?._ml_stored_attributes) ? producto._ml_stored_attributes.length : 0,
      inferred_attributes: inferredAttributes
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
  const basePayload = buildMercadoLibrePublicationPayload(publicationDraft, {
    userProductSeller: !Object.prototype.hasOwnProperty.call(publicationDraft || {}, 'title')
  })
  const { payload, uploadedPictures } = await prepareMercadoLibrePicturesForPayload(basePayload, accessToken)
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
    err.uploadedPictures = uploadedPictures
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

  if (uploadedPictures.length > 0) {
    createdItem.uploaded_pictures = uploadedPictures.map((picture) => ({
      id: picture.id,
      source_url: picture.source_url,
      secure_url: picture.secure_url || null
    }))
  }

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
    retryAuth = true,
    debugContext = null
  } = options

  const token = await getFactusAccessToken(false)
  // #region debug-point D:factus-request-dispatch
  if (pathname === '/v2/bills/validate' && body) {
    reportFactusDebugEvent({
      runId: 'pre-fix',
      hypothesisId: 'D',
      location: 'server.js:factusApiRequest',
      traceId: debugContext?.traceId || null,
      msg: '[DEBUG] Dispatching Factus validate request',
      data: {
        pathname,
        method,
        venta_id: debugContext?.ventaId || null,
        created_time: body?.created_time || null,
        payment_details_sum: roundFactusMoney(
          Array.isArray(body?.payment_details)
            ? body.payment_details.reduce((acc, pago) => acc + normalizeVentaNumeric(pago?.amount, 0), 0)
            : 0
        ),
        payment_details_count: Array.isArray(body?.payment_details) ? body.payment_details.length : 0,
        items_count: Array.isArray(body?.items) ? body.items.length : 0
      }
    })
  }
  // #endregion
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
    // #region debug-point E:factus-response-error
    if (pathname === '/v2/bills/validate') {
      reportFactusDebugEvent({
        runId: 'pre-fix',
        hypothesisId: 'E',
        location: 'server.js:factusApiRequest',
        traceId: debugContext?.traceId || null,
        msg: '[DEBUG] Factus validate request failed',
        data: {
          venta_id: debugContext?.ventaId || null,
          status_code: response.status,
          payload
        }
      })
    }
    // #endregion
    const error = new Error(extractFactusErrorMessage(payload))
    error.statusCode = response.status
    error.payload = payload
    throw error
  }

  // #region debug-point E:factus-response-success
  if (pathname === '/v2/bills/validate') {
    reportFactusDebugEvent({
      runId: 'pre-fix',
      hypothesisId: 'E',
      location: 'server.js:factusApiRequest',
      traceId: debugContext?.traceId || null,
      msg: '[DEBUG] Factus validate request succeeded',
      data: {
        venta_id: debugContext?.ventaId || null,
        status_code: response.status,
        number: payload?.data?.number || payload?.number || null,
        reference_code: payload?.data?.reference_code || payload?.reference_code || null
      }
    })
  }
  // #endregion

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

function itemRequiresFactusProductReplacement(item) {
  const productoId = Number(item?.producto_id ?? item?.id_producto ?? 0)
  if (parseBooleanLike(item?.factus_requires_product_replacement)) {
    return true
  }
  if (!Number.isFinite(productoId) || productoId <= 0) {
    return true
  }

  const factusIsExcluded = parseBooleanLike(item?.factus_is_excluded)
  const hasFactusExcludedConfig = Object.prototype.hasOwnProperty.call(item || {}, 'factus_is_excluded')
  if (!String(item?.factus_code_reference || '').trim()) return true
  if (!String(item?.descripcion || '').trim()) return true
  if (!String(item?.factus_unit_measure_code || '').trim()) return true
  if (!String(item?.factus_standard_code || '').trim()) return true
  if (!hasFactusExcludedConfig) return true
  if (!factusIsExcluded) {
    if (!String(item?.factus_tax_code || '').trim()) return true
    if (normalizeVentaNumeric(item?.factus_tax_rate, -1) < 0) return true
  }

  return false
}

async function getFactusFallbackProducto(conn = pool) {
  const productColumns = await getTableColumns('productos')
  const productoSelectFields = buildProductoSelectFields(productColumns)
  const [rows] = await conn.query(
    `SELECT ${productoSelectFields}
     FROM productos
     WHERE id_producto = ?
     LIMIT 1`,
    [FACTUS_FALLBACK_PRODUCT_ID]
  )

  const producto = rows && rows.length ? rows[0] : null
  if (!producto) {
    throw new Error(`No existe el producto de reemplazo Factus con ID ${FACTUS_FALLBACK_PRODUCT_ID}.`)
  }

  const facturacionStatus = buildProductoFacturacionStatus(producto)
  if (!facturacionStatus.ready) {
    throw new Error(`El producto de reemplazo Factus con ID ${FACTUS_FALLBACK_PRODUCT_ID} no está listo para facturación electrónica.`)
  }

  return producto
}

async function buildFactusItemsPayload(items, options = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('No hay items válidos para enviar a Factus.')
  }

  const fallbackProduct = options.fallbackProduct || await getFactusFallbackProducto(options.conn || pool)
  const replacements = []
  const factusItems = items.map((item, index) => {
    const quantity = normalizeVentaNumeric(item.cantidad, 0)
    const subtotal = normalizeVentaNumeric(item.subtotal, 0)
    const rawUnitPrice = normalizeVentaNumeric(item.precio_unitario ?? item.valor_unitario, 0)
    const unitPrice = quantity > 0 && subtotal > 0 ? subtotal / quantity : rawUnitPrice
    const replaceProduct = itemRequiresFactusProductReplacement(item)
    const sourceItem = replaceProduct ? fallbackProduct : item
    const factusIsExcluded = parseBooleanLike(sourceItem.factus_is_excluded)
    const taxes = factusIsExcluded
      ? []
      : [{
          code: String(sourceItem.factus_tax_code || '').trim(),
          rate: formatFactusDecimal(sourceItem.factus_tax_rate ?? 0)
        }]

    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw new Error('Hay productos con cantidad o precio inválido para emitir la factura electrónica.')
    }

    if (!String(sourceItem.factus_code_reference || '').trim() || !String(sourceItem.nombre || sourceItem.descripcion || '').trim() || !String(sourceItem.factus_unit_measure_code || '').trim() || !String(sourceItem.factus_standard_code || '').trim()) {
      throw new Error('Hay productos sin metadatos Factus completos para emitir la factura electrónica.')
    }

    if (!factusIsExcluded && (!taxes[0]?.code || normalizeVentaNumeric(sourceItem.factus_tax_rate, -1) < 0)) {
      throw new Error('Hay productos gravados sin impuesto o tarifa válida para Factus.')
    }

    if (replaceProduct) {
      replacements.push({
        line: index + 1,
        replacement_product_id: FACTUS_FALLBACK_PRODUCT_ID,
        original_product_id: Number.isFinite(Number(item?.producto_id ?? item?.id_producto))
          ? Number(item?.producto_id ?? item?.id_producto)
          : null,
        original_description: String(item?.descripcion || '').trim() || null
      })
    }

    return removeEmptyObjectFields({
      code_reference: String(sourceItem.factus_code_reference || '').trim(),
      name: String(sourceItem.nombre || sourceItem.descripcion || FACTUS_FALLBACK_PRODUCT_NAME).trim(),
      // Factus v2 está validando estos campos como numéricos reales.
      quantity: roundFactusPrecision(quantity, 6),
      discount_rate: roundFactusPrecision(item.discount_rate ?? 0, 2),
      price: roundFactusPrecision(unitPrice, 6),
      unit_measure_code: String(sourceItem.factus_unit_measure_code || '').trim(),
      standard_code: String(sourceItem.factus_standard_code || '').trim(),
      taxes,
      withholding_taxes: []
    })
  })

  // #region debug-point C:factus-items-payload
  reportFactusDebugEvent({
    runId: 'pre-fix',
    hypothesisId: 'C',
    location: 'server.js:buildFactusItemsPayload',
    traceId: options.referenceCode || `venta-${Number(options.ventaId || 0)}`,
    msg: '[DEBUG] Factus items payload built',
    data: {
      venta_id: Number(options.ventaId || 0) || null,
      replacements_count: replacements.length,
      items: factusItems.map((item, index) => ({
        line: index + 1,
        quantity: item.quantity,
        quantity_type: typeof item.quantity,
        price: item.price,
        price_type: typeof item.price,
        discount_rate: item.discount_rate,
        discount_rate_type: typeof item.discount_rate,
        taxes_count: Array.isArray(item.taxes) ? item.taxes.length : 0,
        code_reference: item.code_reference
      }))
    }
  })
  // #endregion

  return {
    factusItems,
    replacements
  }
}

async function buildFactusBillPayload({ body, ventaId, cliente, items, paymentDetails, numberingRange, referenceCode, conn = pool }) {
  const fallbackProduct = await getFactusFallbackProducto(conn)
  const { factusItems, replacements } = await buildFactusItemsPayload(items, { fallbackProduct, conn, ventaId, referenceCode })
  const canonicalTotal = calculateFactusItemsTotal(factusItems)
  const canonicalTotalCents = factusMoneyToCents(canonicalTotal)
  const paymentForm = mapFactusPaymentForm(paymentDetails[0]?.payment_form || body?.tipo_pago)
  const factusPaymentDetails = paymentDetails.map((pago, index, pagos) => removeEmptyObjectFields({
    payment_form: mapFactusPaymentForm(pago.payment_form || body?.tipo_pago),
    payment_method_code: mapFactusPaymentMethodCode(pago.payment_method_code || body?.forma_pago, paymentForm),
    amount: formatFactusDecimal(
      pagos.length === 1
        ? centsToFactusMoney(canonicalTotalCents)
        : (index === pagos.length - 1
          ? centsToFactusMoney(canonicalTotalCents - pagos.slice(0, -1).reduce((acc, current) => acc + factusMoneyToCents(current?.amount), 0))
          : centsToFactusMoney(factusMoneyToCents(pago.amount ?? 0)))
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
    created_time: getSafeFactusCreatedTime(),
    customer: buildFactusCustomerPayload(cliente),
    payment_details: factusPaymentDetails,
    items: factusItems
  })

  if (!Array.isArray(payload.payment_details) || payload.payment_details.length === 0) {
    throw new Error('La venta no tiene métodos de pago válidos para Factus.')
  }

  // #region debug-point A:factus-created-time
  reportFactusDebugEvent({
    runId: 'pre-fix',
    hypothesisId: 'A',
    location: 'server.js:buildFactusBillPayload',
    traceId: referenceCode || `venta-${Number(ventaId || 0)}`,
    msg: '[DEBUG] Factus created_time prepared',
    data: {
      venta_id: Number(ventaId || 0) || null,
      created_time: payload.created_time,
      bogota_now: buildFactusDebugBogotaTimestamp(),
      document: payload.document,
      numbering_range_id: payload.numbering_range_id || null
    }
  })
  // #endregion

  // #region debug-point B:factus-payment-details
  reportFactusDebugEvent({
    runId: 'pre-fix',
    hypothesisId: 'B',
    location: 'server.js:buildFactusBillPayload',
    traceId: referenceCode || `venta-${Number(ventaId || 0)}`,
    msg: '[DEBUG] Factus payment details prepared',
    data: {
      venta_id: Number(ventaId || 0) || null,
      canonical_total: canonicalTotal,
      payment_details_sum: roundFactusMoney(
        factusPaymentDetails.reduce((acc, pago) => acc + normalizeVentaNumeric(pago?.amount, 0), 0)
      ),
      payment_details_count: factusPaymentDetails.length,
      payment_details: factusPaymentDetails.map((pago, index) => ({
        line: index + 1,
        payment_form: pago.payment_form,
        payment_method_code: pago.payment_method_code,
        amount: pago.amount,
        due_date: pago.due_date || null
      })),
      source_payment_details: (Array.isArray(paymentDetails) ? paymentDetails : []).map((pago, index) => ({
        line: index + 1,
        payment_form: pago?.payment_form || null,
        payment_method_code: pago?.payment_method_code || null,
        amount: pago?.amount ?? null
      }))
    }
  })
  // #endregion

  return {
    payload,
    replacements
  }
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
  const persistedItems = Array.isArray(options.persistedItems) && options.persistedItems.length
    ? options.persistedItems
    : items
  const referenceCode = String(
    options.referenceCode
    || body?.facturacion?.reference_code
    || paymentDetails.find((pago) => String(pago?.reference_code || '').trim())?.reference_code
    || `VENTA-${ventaId}`
  ).trim()

  for (const rawItem of persistedItems) {
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

async function persistVentaPaymentDetails(conn, ventaId, paymentDetails) {
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
        normalizeVentaNumeric(pago.amount, 0),
        normalizeVentaDate(pago.due_date),
        pago.reference_code ? String(pago.reference_code) : null
      ]
    )
  }
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
  let factusFinancialSummary = null
  let factusResult = null
  let factusReferenceCode = null
  let factusItemReplacements = []
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
    const factusBuildResult = await buildFactusBillPayload({
      body,
      ventaId: resolvedConsecutivo,
      cliente: clienteFactus,
      items,
      paymentDetails,
      numberingRange,
      referenceCode: factusReferenceCode,
      conn
    })
    factusPayload = factusBuildResult?.payload || null
    factusItemReplacements = Array.isArray(factusBuildResult?.replacements) ? factusBuildResult.replacements : []
    factusFinancialSummary = summarizeFactusPayload(factusPayload)
    const requestedTotal = roundFactusMoney(total || body?.total || 0)
    if (Math.abs((factusFinancialSummary?.total || 0) - requestedTotal) >= 0.01) {
      console.warn('[Factus][Totals] Ajustando total de venta al canonico de Factus:', JSON.stringify({
        venta_id: Number(resolvedConsecutivo),
        requested_total: requestedTotal,
        canonical_total: factusFinancialSummary.total,
        canonical_subtotal: factusFinancialSummary.subtotal,
        canonical_total_tax: factusFinancialSummary.total_tax,
        difference: roundFactusMoney(factusFinancialSummary.total - requestedTotal)
      }))
    }
    if (factusItemReplacements.length > 0) {
      console.warn('[Factus][Items] Se reemplazaron productos no válidos por el producto de contingencia:', JSON.stringify({
        venta_id: Number(resolvedConsecutivo),
        replacement_product_id: FACTUS_FALLBACK_PRODUCT_ID,
        replacements: factusItemReplacements
      }))
    }
    console.log('[Factus] Payload a enviar:', JSON.stringify({
      venta_id: Number(resolvedConsecutivo),
      reference_code: factusReferenceCode,
      payload: factusPayload
    }))
  }

  const ventaTotal = esFacturaElectronica
    ? roundFactusMoney(factusFinancialSummary?.total || total || 0)
    : Number(total || 0)
  const persistedPaymentDetails = buildVentaPaymentDetailsForPersistence(
    body,
    ventaTotal,
    esFacturaElectronica ? (factusPayload?.payment_details || paymentDetails) : paymentDetails
  )
  await insertVentaCabecera(conn, {
    id_consecutivo: resolvedConsecutivo,
    usuario_id,
    cliente_id,
    total: ventaTotal,
    tipo_pago,
    forma_pago,
    punto_venta,
    subtotal: esFacturaElectronica ? (factusFinancialSummary?.subtotal ?? body?.subtotal ?? null) : (body?.subtotal ?? null),
    total_discount: esFacturaElectronica ? (factusFinancialSummary?.total_discount ?? body?.total_discount ?? 0) : (body?.total_discount ?? 0),
    total_tax: esFacturaElectronica ? (factusFinancialSummary?.total_tax ?? body?.total_tax ?? 0) : (body?.total_tax ?? 0),
    observation: body?.observation || null,
    factura_electronica: esFacturaElectronica,
    electronic_status: esFacturaElectronica ? 'pending' : null,
    factus_number: null
  })

  if (esFacturaElectronica) {
    const persistedItems = buildCanonicalVentaDetalleItems(items, factusPayload)
    await persistVentaElectronicaData(conn, body, resolvedConsecutivo, items, paymentDetails, {
      referenceCode: factusReferenceCode,
      persistedItems
    })
  }

  if (persistedPaymentDetails.length > 0) {
    await persistVentaPaymentDetails(conn, resolvedConsecutivo, persistedPaymentDetails)
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
      body: factusPayload,
      debugContext: {
        traceId: factusReferenceCode || `venta-${Number(resolvedConsecutivo)}`,
        ventaId: Number(resolvedConsecutivo)
      }
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
  if (columnSet.has('imagen')) {
    baseFields.push('`imagen`')
  } else {
    baseFields.push('NULL AS `imagen`')
  }
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
    `SELECT COALESCE(SUM(
        CASE
          WHEN vpd.id IS NOT NULL THEN
            CASE
              WHEN LOWER(TRIM(COALESCE(vpd.payment_method_code, ''))) IN ('cash', 'efectivo', '10') THEN COALESCE(vpd.amount, 0)
              ELSE 0
            END
          WHEN UPPER(TRIM(COALESCE(v.forma_pago, ''))) = 'EFECTIVO' THEN COALESCE(v.total, 0)
          ELSE 0
        END
      ), 0) AS total_efectivo
     FROM ventas v
     LEFT JOIN ventas_payment_details vpd
       ON vpd.venta_id = v.id_consecutivo
     WHERE v.fecha >= ? AND v.fecha <= ?
       AND LOWER(TRIM(COALESCE(v.punto_venta, 'ferreteria'))) = 'ferreteria'`,
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

app.get('/api/clientes/lookup-nit', async (req, res) => {
  try {
    const nit = sanitizeDigits(req.query.nit || req.query.q || '')
    if (nit.length < 5) {
      return res.status(400).json({
        ok: false,
        error: 'El NIT o documento debe tener al menos 5 dígitos.'
      })
    }

    const lookup = await lookupClientePublicoPorNit(nit)
    const cliente = buildClienteDraftFromLookupResult(lookup)
    const facturacion = buildClienteFactusEmissionStatus(cliente)

    if (!lookup.found) {
      return res.json({
        ok: true,
        found: false,
        cliente,
        facturacion,
        message: lookup.summaryError
          ? 'No fue posible consultar automaticamente el NIT en este momento.'
          : 'No se encontraron resultados publicos para ese NIT.'
      })
    }

    return res.json({
      ok: true,
      found: true,
      cliente,
      facturacion,
      message: lookup.detailError
        ? 'Se autocompletaron los datos disponibles. Revisa manualmente tributo, municipio y departamento.'
        : 'Datos fiscales autocompletados correctamente.',
      source: {
        resumen: !!lookup.summary,
        detalle: !!lookup.detail
      }
    })
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message || 'No fue posible consultar automáticamente el NIT en este momento.'
    })
  }
})

app.post('/api/clientes/facturacion-preview', async (req, res) => {
  try {
    const cliente = buildClienteQuickDraft(req.body || {})
    const facturacion = buildClienteFactusEmissionStatus(cliente)
    return res.json({
      ok: true,
      cliente,
      facturacion
    })
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message || 'No se pudo validar el formulario del cliente.'
    })
  }
})

app.post('/api/clientes/quick-create', async (req, res) => {
  try {
    const draft = buildClienteQuickDraft(req.body || {})
    if (!draft.nombre) {
      return res.status(400).json({
        ok: false,
        error: 'El nombre del cliente es obligatorio.'
      })
    }
    if (!draft.nit_cc && !draft.identification) {
      return res.status(400).json({
        ok: false,
        error: 'Debes ingresar al menos NIT/CC o identificación fiscal.'
      })
    }

    const conn = await pool.getConnection()
    try {
      const existingId = await findExistingClienteByDraft(draft, conn)
      if (existingId) {
        const clienteExistente = await getClienteForUi(existingId, conn)
        return res.json({
          ok: true,
          created: false,
          existing: true,
          cliente: clienteExistente,
          facturacion: buildClienteFactusEmissionStatus(clienteExistente),
          message: 'El cliente ya existía y fue reutilizado.'
        })
      }

      const columns = await getTableColumns('clientes', conn)
      const columnSet = new Set(columns.map((column) => String(column || '').toLowerCase()))
      const payloadByColumn = {
        nombre: draft.nombre,
        nit_cc: draft.nit_cc,
        telefono: draft.telefono || null,
        direccion: draft.direccion || null,
        email: draft.email || null,
        tipo_cliente: draft.tipo_cliente || 'Cliente final',
        identification: draft.identification || null,
        identification_document_code: draft.identification_document_code || null,
        legal_organization_code: draft.legal_organization_code || null,
        tribute_code: draft.tribute_code || null,
        company: draft.company || null,
        trade_name: draft.trade_name || null,
        names: draft.names || null,
        dv: draft.dv || null,
        municipality_code: draft.municipality_code || null,
        department_code: draft.department_code || null,
        country_code: draft.country_code || null
      }

      const insertColumns = Object.keys(payloadByColumn).filter((column) => columnSet.has(column.toLowerCase()))
      if (!insertColumns.length) {
        return res.status(500).json({
          ok: false,
          error: 'La tabla clientes no tiene columnas disponibles para guardar el cliente rápido.'
        })
      }

      const insertValues = insertColumns.map((column) => payloadByColumn[column])
      const placeholders = insertColumns.map(() => '?').join(', ')
      const [result] = await conn.query(
        `INSERT INTO clientes (${insertColumns.map((column) => `\`${column}\``).join(', ')})
         VALUES (${placeholders})`,
        insertValues
      )

      const clienteCreado = await getClienteForUi(result.insertId, conn)
      return res.status(201).json({
        ok: true,
        created: true,
        existing: false,
        cliente: clienteCreado,
        facturacion: buildClienteFactusEmissionStatus(clienteCreado),
        message: 'Cliente creado correctamente.'
      })
    } finally {
      conn.release()
    }
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message || 'No se pudo crear el cliente.'
    })
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

    const cliente = await getClienteForFactus(id)
    if (!cliente) {
      return res.status(404).json({
        ready: false,
        missing_fields: ['cliente'],
        missing_labels: ['Cliente'],
        message: 'Cliente no encontrado.'
      })
    }

    return res.json(buildClienteFactusEmissionStatus(cliente))
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
      categoryAttributes,
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
    const requestedCategoryId = normalizeMercadoLibreStringValue(req.body?.category_id || producto.ml_category_id, 64)
    const categoryAttributes = requestedCategoryId
      ? await getMercadoLibreCategoryAttributes(requestedCategoryId, accessToken)
      : []
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
      categoryAttributes,
      isUserProductSeller
    }, req)
    const finalPayload = buildMercadoLibrePublicationPayload(draftInfo.draft, {
      userProductSeller: isUserProductSeller
    })
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
      payload_final: err?.publicationPayload || undefined,
      uploaded_pictures: Array.isArray(err?.uploadedPictures)
        ? err.uploadedPictures.map((picture) => ({
          id: picture?.id || null,
          source_url: picture?.source_url || null,
          secure_url: picture?.secure_url || null
        }))
        : undefined
    })
  }
})

app.post('/api/mercadolibre/publicacion/actualizar-precio', async (req, res) => {
  try {
    if (!requireMercadoLibreApiAuthorization(req, res)) {
      return
    }

    const productoId = Number(req.body?.producto_id)
    const requestedPrice = normalizeVentaNumeric(req.body?.price, 0)
    if (!Number.isFinite(productoId) || productoId <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'Debes enviar producto_id valido para actualizar el precio en Mercado Libre.'
      })
    }

    if (!(requestedPrice > 0)) {
      return res.status(400).json({
        ok: false,
        error: 'Debes enviar un price valido para actualizar la publicación de Mercado Libre.'
      })
    }

    const producto = await getProductoByIdProducto(productoId)
    if (!producto) {
      return res.status(404).json({
        ok: false,
        error: 'El producto indicado no existe en ALUMAS.'
      })
    }

    const publication = await getMercadoLibreExistingPublicationForProduct(productoId)
    if (!publication || !String(publication.item_id || '').trim()) {
      return res.status(404).json({
        ok: false,
        error: 'El producto no tiene una publicación de Mercado Libre vinculada.'
      })
    }

    const { account, accessToken } = await getValidMercadoLibreAccessToken()
    const updateResult = await updateMercadoLibreItemPrice(
      producto,
      publication,
      requestedPrice,
      account,
      accessToken
    )

    return res.json({
      ok: true,
      message: 'Precio actualizado correctamente',
      producto_id: productoId,
      item_id: updateResult.item?.id || String(publication.item_id || '').trim() || null,
      status: updateResult.item?.status || publication.status || null,
      permalink: updateResult.item?.permalink || publication.permalink || null,
      price: updateResult.item?.price ?? requestedPrice,
      net_amount_estimated: null,
      details: {
        remote_item_before: updateResult.remoteItemBefore,
        prices: updateResult.priceState?.diagnostics?.prices,
        price_to_win: updateResult.priceState?.diagnostics?.price_to_win
      }
    })
  } catch (err) {
    return res.status(Number(err?.statusCode || 500)).json({
      ok: false,
      error: err?.message || 'No se pudo actualizar el precio de la publicación en Mercado Libre.',
      details: err?.payload || undefined,
      cause: Array.isArray(err?.payload?.cause) ? err.payload.cause : undefined,
      remote_item_before: err?.remoteItemBefore || undefined
    })
  }
})

app.post('/api/mercadolibre/publicacion/actualizar-estado', async (req, res) => {
  try {
    if (!requireMercadoLibreApiAuthorization(req, res)) {
      return
    }

    const productoId = Number(req.body?.producto_id)
    const requestedStatus = normalizeMercadoLibreStringValue(req.body?.status, 32).toLowerCase()
    if (!Number.isFinite(productoId) || productoId <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'Debes enviar producto_id valido para actualizar el estado en Mercado Libre.'
      })
    }

    if (!['active', 'paused'].includes(requestedStatus)) {
      return res.status(400).json({
        ok: false,
        error: 'Debes enviar un status valido para actualizar la publicación de Mercado Libre.'
      })
    }

    const producto = await getProductoByIdProducto(productoId)
    if (!producto) {
      return res.status(404).json({
        ok: false,
        error: 'El producto indicado no existe en ALUMAS.'
      })
    }

    const publication = await getMercadoLibreExistingPublicationForProduct(productoId)
    if (!publication || !String(publication.item_id || '').trim()) {
      return res.status(404).json({
        ok: false,
        error: 'El producto no tiene una publicación de Mercado Libre vinculada.'
      })
    }

    const { account, accessToken } = await getValidMercadoLibreAccessToken()
    const updateResult = await updateMercadoLibreItemStatus(
      producto,
      publication,
      requestedStatus,
      account,
      accessToken
    )

    const finalStatus = updateResult.item?.status || requestedStatus || publication.status || null
    const actionLabel = requestedStatus === 'active' ? 'reactivada' : 'pausada'
    const message = updateResult.changed
      ? `Publicación ${actionLabel} correctamente`
      : `La publicación ya estaba en estado ${finalStatus || requestedStatus}`

    return res.json({
      ok: true,
      message,
      producto_id: productoId,
      item_id: updateResult.item?.id || String(publication.item_id || '').trim() || null,
      status: finalStatus,
      permalink: updateResult.item?.permalink || publication.permalink || null,
      price: updateResult.item?.price ?? publication.price ?? null,
      available_quantity: updateResult.item?.available_quantity ?? publication.available_quantity ?? null,
      details: {
        requested_status: requestedStatus,
        changed: updateResult.changed,
        remote_item_before: updateResult.remoteItemBefore
      }
    })
  } catch (err) {
    return res.status(Number(err?.statusCode || 500)).json({
      ok: false,
      error: err?.message || 'No se pudo actualizar el estado de la publicación en Mercado Libre.',
      details: err?.payload || undefined,
      cause: Array.isArray(err?.payload?.cause) ? err.payload.cause : undefined,
      remote_item_before: err?.remoteItemBefore || undefined
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

app.get('/api/mercadolibre/pedidos', async (req, res) => {
  try {
    if (!requireMercadoLibreInternalApiAuthorization(req, res)) {
      return
    }

    const result = await collectMercadoLibreOrderViews({
      limit: req.query.limit,
      offset: req.query.offset,
      filters: {
        referencia: req.query.referencia,
        producto_id: req.query.producto_id,
        item_id: req.query.item_id,
        buyer: req.query.buyer,
        comprador: req.query.comprador,
        status: req.query.status,
        payment_status: req.query.payment_status,
        shipment_status: req.query.shipment_status,
        estado_envio: req.query.estado_envio,
        pending_shipping: req.query.pending_shipping,
        pendientes_envio: req.query.pendientes_envio
      }
    })

    return res.json({
      ok: true,
      count: result.orders.length,
      pedidos: result.orders.map((entry) => entry.view)
    })
  } catch (err) {
    return res.status(Number(err?.statusCode || 500)).json({
      ok: false,
      error: err?.message || 'No se pudieron consultar los pedidos de Mercado Libre.'
    })
  }
})

app.get('/api/mercadolibre/pedidos/pendientes', async (req, res) => {
  try {
    if (!requireMercadoLibreInternalApiAuthorization(req, res)) {
      return
    }

    const result = await collectMercadoLibreOrderViews({
      limit: req.query.limit,
      offset: req.query.offset,
      onlyPending: true,
      filters: {
        referencia: req.query.referencia,
        producto_id: req.query.producto_id,
        item_id: req.query.item_id,
        buyer: req.query.buyer,
        comprador: req.query.comprador,
        shipment_status: req.query.shipment_status,
        estado_envio: req.query.estado_envio,
        pending_shipping: req.query.pending_shipping,
        pendientes_envio: req.query.pendientes_envio
      }
    })

    return res.json({
      ok: true,
      count: result.orders.length,
      pedidos: result.orders.map((entry) => entry.view)
    })
  } catch (err) {
    return res.status(Number(err?.statusCode || 500)).json({
      ok: false,
      error: err?.message || 'No se pudieron consultar los pedidos pendientes de Mercado Libre.'
    })
  }
})

app.get('/api/mercadolibre/pedidos/:orderId', async (req, res) => {
  try {
    if (!requireMercadoLibreInternalApiAuthorization(req, res)) {
      return
    }

    const orderId = Number(req.params.orderId)
    if (!Number.isFinite(orderId) || orderId <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'Debes indicar un orderId valido de Mercado Libre.'
      })
    }

    const result = await collectMercadoLibreOrderViews({
      orderIds: [orderId]
    })
    const entry = result.orders[0]
    if (!entry) {
      return res.status(404).json({
        ok: false,
        error: `No se encontro la orden ${orderId} en Mercado Libre.`
      })
    }

    return res.json({
      ok: true,
      pedido: entry.view
    })
  } catch (err) {
    return res.status(Number(err?.statusCode || 500)).json({
      ok: false,
      error: err?.message || 'No se pudo consultar el detalle del pedido de Mercado Libre.'
    })
  }
})

app.post('/api/mercadolibre/n8n/webhook', async (req, res) => {
  try {
    if (!requireMercadoLibreInternalApiAuthorization(req, res)) {
      return
    }

    const requestedOrderIds = Array.isArray(req.body?.order_ids)
      ? req.body.order_ids
      : []
    const dryRun = parseBooleanLike(req.body?.dry_run ?? req.query.dry_run ?? false)
    const result = await collectMercadoLibreOrderViews({
      orderIds: requestedOrderIds,
      limit: req.body?.limit ?? req.query.limit,
      offset: req.body?.offset ?? req.query.offset
    })

    const dispatchResults = []
    for (const entry of result.orders) {
      const previousOrder = parseMercadoLibreStoredOrderRaw(entry.previousRow)
      const events = detectMercadoLibreOrderEvents(previousOrder, entry.view, entry.order)

      for (const eventPayload of events) {
        const reserved = await reserveMercadoLibreN8nEvent(eventPayload)
        if (!reserved) {
          dispatchResults.push({
            event: eventPayload.event,
            order_id: eventPayload.order_id,
            status: 'duplicate_skipped'
          })
          continue
        }

        if (dryRun) {
          await updateMercadoLibreN8nEventDelivery(eventPayload.event_key, {
            deliveryStatus: 'dry_run',
            payload: eventPayload
          })
          dispatchResults.push({
            event: eventPayload.event,
            order_id: eventPayload.order_id,
            status: 'dry_run'
          })
          continue
        }

        try {
          const delivery = await dispatchMercadoLibreEventToConfiguredN8nWebhook(eventPayload)
          await updateMercadoLibreN8nEventDelivery(eventPayload.event_key, {
            deliveryStatus: 'delivered',
            httpStatus: delivery.httpStatus,
            responseBody: delivery.body,
            payload: eventPayload
          })
          dispatchResults.push({
            event: eventPayload.event,
            order_id: eventPayload.order_id,
            status: 'delivered'
          })
        } catch (err) {
          await updateMercadoLibreN8nEventDelivery(eventPayload.event_key, {
            deliveryStatus: 'failed',
            httpStatus: err?.statusCode || null,
            responseBody: err?.payload || err?.message || null,
            payload: eventPayload
          })
          dispatchResults.push({
            event: eventPayload.event,
            order_id: eventPayload.order_id,
            status: 'failed',
            error: err?.message || 'No se pudo entregar el webhook a n8n.'
          })
        }
      }
    }

    return res.json({
      ok: true,
      scanned_orders: result.orders.length,
      detected_events: dispatchResults.length,
      delivered: dispatchResults.filter((item) => item.status === 'delivered').length,
      duplicates: dispatchResults.filter((item) => item.status === 'duplicate_skipped').length,
      dry_run: dispatchResults.filter((item) => item.status === 'dry_run').length,
      failed: dispatchResults.filter((item) => item.status === 'failed').length,
      results: dispatchResults
    })
  } catch (err) {
    return res.status(Number(err?.statusCode || 500)).json({
      ok: false,
      error: err?.message || 'No se pudo procesar el webhook interno hacia n8n.'
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
    const saleIds = rows.map((row) => Number(row.id_consecutivo)).filter((id) => Number.isFinite(id) && id > 0)
    let paymentDetailsByVenta = new Map()

    if (saleIds.length) {
      const placeholders = saleIds.map(() => '?').join(', ')
      const [paymentRows] = await pool.query(
        `SELECT venta_id, payment_form, payment_method_code, SUM(amount) AS amount
         FROM ventas_payment_details
         WHERE venta_id IN (${placeholders})
         GROUP BY venta_id, payment_form, payment_method_code
         ORDER BY venta_id DESC, payment_method_code ASC`,
        saleIds
      )

      paymentDetailsByVenta = paymentRows.reduce((acc, row) => {
        const ventaId = Number(row.venta_id)
        if (!acc.has(ventaId)) acc.set(ventaId, [])
        acc.get(ventaId).push({
          payment_form: row.payment_form,
          payment_method_code: row.payment_method_code,
          amount: normalizeVentaNumeric(row.amount, 0)
        })
        return acc
      }, new Map())
    }

    res.json({
      ok: true,
      ventas: rows.map((row) => ({
        ...row,
        payment_details: paymentDetailsByVenta.get(Number(row.id_consecutivo)) || []
      }))
    })
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
let serverInstance = null

async function startServer() {
  await initPool()
  return new Promise((resolve) => {
    serverInstance = app.listen(PORT, () => {
      console.log(`Servidor web en http://localhost:${PORT}`)
      resolve(serverInstance)
    })
  })
}

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

if (require.main === module) {
  startServer().catch((err) => {
    console.error('No se pudo iniciar el servidor:', err?.message || err)
    process.exit(1)
  })
}

module.exports = {
  app,
  startServer,
  buildMercadoLibreInternalSignature,
  getMercadoLibreOrderPaymentStatus,
  getMercadoLibreOrderBuyerName,
  isMercadoLibreOrderPendingAttention,
  buildMercadoLibreOrderEventKey,
  buildMercadoLibreN8nEventPayload,
  detectMercadoLibreOrderEvents
}
