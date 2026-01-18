require('dotenv').config()
const path = require('path')
const express = require('express')
const cors = require('cors')
const mysql = require('mysql2/promise')
const crypto = require('crypto')

const app = express()
app.set('trust proxy', 1)

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

let pool
async function initPool() {
  pool = mysql.createPool(DB_CONFIG)
  try {
    const conn = await pool.getConnection()
    await conn.ping()
    conn.release()
    console.log('Conexión a MySQL inicializada correctamente')
    await ensureSchema()
  } catch (err) {
    console.error('Error inicializando conexión MySQL:', err.message)
  }
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
  await pool.query(createVentas)
  await pool.query(createItems)
}

app.use(cors())
app.use(express.json())

// Endpoints API
app.get('/api/db-ping', async (req, res) => {
  try {
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

app.get('/api/clientes', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim()
    if (!q) return res.json({ ok: true, clientes: [] })
    const like = `%${q}%`
    const [rows] = await pool.query(
      'SELECT id, nombre, nit_cc, telefono, direccion FROM clientes WHERE nombre LIKE ? OR nit_cc LIKE ? ORDER BY nombre LIMIT 20',
      [like, like]
    )
    res.json({ ok: true, clientes: rows || [] })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/login', async (req, res) => {
  try {
    const { usuario, contrasena } = req.body || {}
    if (!usuario || !contrasena) {
      return res.status(400).json({ ok: false, error: 'datos_invalidos' })
    }
    const [rows] = await pool.query(
      'SELECT * FROM usuarios WHERE usuario = ? LIMIT 1',
      [String(usuario)]
    )
    if (!rows || rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'credenciales_invalidas' })
    }
    const user = rows[0]
    const storedPass = String(
      user.contrasena ||
      user.clave ||
      user.password ||
      user.pass ||
      ''
    )
    const inputPass = String(contrasena)
    let okPass = storedPass === inputPass
    if (!okPass && /^[a-f0-9]{32}$/i.test(storedPass)) {
      const md5 = crypto.createHash('md5').update(inputPass).digest('hex')
      okPass = md5 === storedPass.toLowerCase()
    }
    if (!storedPass || !okPass) {
      return res.status(401).json({ ok: false, error: 'credenciales_invalidas' })
    }
    const idUsuario = user.id_usuario || user.id || user.usuario_id
    const nombreUsuario = user.nombre || user.usuario || user.nombre_usuario || usuario
    if (!idUsuario) {
      return res.status(500).json({ ok: false, error: 'id_usuario_invalido' })
    }
    res.json({
      ok: true,
      usuario_id: idUsuario,
      usuario: nombreUsuario,
    })
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
      if (!cantidad || !descripcion) continue
      // Intento 1: exacto
      const [exRes] = await conn.query('UPDATE productos SET stock = GREATEST(0, stock - ?) WHERE nombre = ? LIMIT 1', [cantidad, descripcion])
      if (exRes.affectedRows === 0) {
        // Intento 2: LIKE
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

// Servir estáticos del proyecto actual
app.use(express.static(path.resolve(__dirname)))

const PORT = Number(process.env.PORT || 8080)

initPool().then(() => {
  app.listen(PORT, () => {
    console.log(`Servidor web en http://localhost:${PORT}`)
  })
})
