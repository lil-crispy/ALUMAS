const test = require('node:test')
const assert = require('node:assert/strict')

const {
  app,
  buildMercadoLibreOrderEventKey,
  buildMercadoLibreInternalSignature,
  buildMercadoLibreN8nEventPayload,
  detectMercadoLibreOrderEvents,
  getMercadoLibreOrderBuyerName,
  getMercadoLibreOrderPaymentStatus,
  isMercadoLibreOrderPendingAttention
} = require('./server')

function buildBaseOrderRaw(overrides = {}) {
  return {
    id: 2000000001,
    status: 'confirmed',
    buyer: {
      nickname: 'comprador_ml',
      first_name: 'Juan',
      last_name: 'Perez'
    },
    payments: [
      {
        id: 991,
        status: 'pending'
      }
    ],
    shipping: {
      id: 445566,
      status: 'ready_to_ship'
    },
    access_token: 'must_not_leak',
    refresh_token: 'must_not_leak',
    ...overrides
  }
}

function buildBaseOrderView(overrides = {}) {
  return {
    order_id: 2000000001,
    fecha: '2026-08-22T08:00:00.000-05:00',
    status: 'confirmed',
    payment_status: 'pending',
    buyer: 'Juan Perez',
    total: 37000,
    moneda: 'COP',
    items: [
      {
        producto_id: 1442,
        item_id: 'MLA123',
        title: 'Bisagra aluminio',
        quantity: 1,
        unit_price: 37000,
        referencia: 1442
      }
    ],
    shipment: {
      id: 445566,
      status: 'ready_to_ship'
    },
    ...overrides
  }
}

async function withTestServer(run) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance))
  })

  try {
    const address = server.address()
    const baseUrl = `http://127.0.0.1:${address.port}`
    await run(baseUrl)
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }
}

test('getMercadoLibreOrderBuyerName prioriza nombre completo', () => {
  const buyer = getMercadoLibreOrderBuyerName(buildBaseOrderRaw())
  assert.equal(buyer, 'Juan Perez')
})

test('getMercadoLibreOrderPaymentStatus detecta approved', () => {
  const status = getMercadoLibreOrderPaymentStatus(buildBaseOrderRaw({
    payments: [{ id: 1001, status: 'approved' }]
  }))
  assert.equal(status, 'approved')
})

test('buildMercadoLibreN8nEventPayload mantiene solo datos utiles y sin secretos', () => {
  const payload = buildMercadoLibreN8nEventPayload(
    'new_order',
    buildBaseOrderView(),
    buildBaseOrderRaw({
      payments: [{ id: 1001, status: 'approved' }]
    })
  )

  assert.equal(payload.event, 'new_order')
  assert.equal(payload.order_id, 2000000001)
  assert.equal(payload.payment_status, 'pending')
  assert.equal(payload.notification_target.number, '3197245235')
  assert.equal(payload.items[0].producto_id, 1442)
  assert.equal(payload.access_token, undefined)
  assert.equal(payload.refresh_token, undefined)
  assert.equal(payload.client_secret, undefined)
  assert.equal(JSON.stringify(payload).includes('must_not_leak'), false)
})

test('detectMercadoLibreOrderEvents para orden nueva emite solo new_order', () => {
  const events = detectMercadoLibreOrderEvents(
    null,
    buildBaseOrderView({
      payment_status: 'approved'
    }),
    buildBaseOrderRaw({
      payments: [{ id: 1001, status: 'approved' }]
    })
  )

  assert.equal(events.length, 1)
  assert.equal(events[0].event, 'new_order')
})

test('detectMercadoLibreOrderEvents emite payment_approved y shipment_status_changed sin duplicar', () => {
  const previousOrder = buildBaseOrderRaw({
    payments: [{ id: 1001, status: 'pending' }],
    shipping: { id: 445566, status: 'ready_to_ship' }
  })
  const currentView = buildBaseOrderView({
    payment_status: 'approved',
    shipment: { id: 445566, status: 'shipped' }
  })
  const currentRaw = buildBaseOrderRaw({
    payments: [{ id: 1001, status: 'approved' }],
    shipping: { id: 445566, status: 'shipped' }
  })

  const firstPass = detectMercadoLibreOrderEvents(previousOrder, currentView, currentRaw)
  const secondPass = detectMercadoLibreOrderEvents(currentRaw, currentView, currentRaw)

  assert.deepEqual(firstPass.map((event) => event.event), ['payment_approved', 'shipment_status_changed'])
  assert.equal(secondPass.length, 0)
})

test('buildMercadoLibreOrderEventKey cambia cuando cambia el estado de envio', () => {
  const payloadA = {
    event: 'shipment_status_changed',
    order_id: 2000000001,
    shipment: { id: 445566, status: 'ready_to_ship' }
  }
  const payloadB = {
    event: 'shipment_status_changed',
    order_id: 2000000001,
    shipment: { id: 445566, status: 'shipped' }
  }

  assert.notEqual(
    buildMercadoLibreOrderEventKey(payloadA),
    buildMercadoLibreOrderEventKey(payloadB)
  )
})

test('isMercadoLibreOrderPendingAttention detecta pedidos pendientes de envio', () => {
  assert.equal(
    isMercadoLibreOrderPendingAttention(buildBaseOrderView({
      payment_status: 'approved',
      shipment: { id: 445566, status: 'ready_to_ship' }
    })),
    true
  )

  assert.equal(
    isMercadoLibreOrderPendingAttention(buildBaseOrderView({
      status: 'cancelled',
      payment_status: 'approved',
      shipment: { id: 445566, status: 'cancelled' }
    })),
    false
  )
})

test('GET /api/mercadolibre/pedidos/pendientes exige autenticacion interna', async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/mercadolibre/pedidos/pendientes`)
    const body = await response.json()

    assert.equal(response.status, 401)
    assert.equal(body.ok, false)
  })
})

test('GET /api/mercadolibre/pedidos/:orderId valida orderId antes de consultar Mercado Libre', async () => {
  process.env.MERCADOLIBRE_INTERNAL_CLIENT_ID = 'test-client'
  process.env.MERCADOLIBRE_INTERNAL_SHARED_SECRET = 'test-shared-secret'

  await withTestServer(async (baseUrl) => {
    const timestamp = String(Date.now())
    const pathname = '/api/mercadolibre/pedidos/abc'
    const signature = buildMercadoLibreInternalSignature({
      clientId: process.env.MERCADOLIBRE_INTERNAL_CLIENT_ID,
      timestamp,
      method: 'GET',
      pathname
    }, process.env.MERCADOLIBRE_INTERNAL_SHARED_SECRET)

    const response = await fetch(`${baseUrl}${pathname}`, {
      headers: {
        'x-alumas-client-id': process.env.MERCADOLIBRE_INTERNAL_CLIENT_ID,
        'x-alumas-timestamp': timestamp,
        'x-alumas-signature': signature
      }
    })
    const body = await response.json()

    assert.equal(response.status, 400)
    assert.equal(body.ok, false)
  })
})
