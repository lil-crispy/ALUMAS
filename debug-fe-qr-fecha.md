# Debug Session: fe-qr-fecha
- **Status**: [OPEN]
- **Issue**: La FE a veces falla por validaciones de fecha en Factus y, cuando sí sale, el QR no aparece en la previsualización POS.
- **Debug Server**: http://127.0.0.1:7777/event
- **Log File**: .dbg/trae-debug-log-fe-qr-fecha.ndjson

## Reproduction Steps
1. Abrir `remision.html`.
2. Seleccionar un cliente y marcar el checkbox de factura electrónica.
3. Probar tanto venta de contado como venta a crédito.
4. Generar la venta y observar:
   - si Factus devuelve advertencia/error de fecha,
   - si el comprobante POS muestra QR cuando la FE fue exitosa.

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | `due_date` se está enviando para contado o con una fecha que no cumple la regla de Factus en ciertos flujos | High | Low | Rejected en corrida observada: `paymentForm=contado`, `dueDate=null` |
| B | El flujo FE exitoso llama `window.print()` antes de que `ultimaFacturaElectronicaEmitida` quede lista para poblar el QR | High | Low | Rejected: antes de imprimir ya existe `currentStateNumber=SETP...` en estado FE |
| C | Factus no devuelve `qr`/`qr_url` en todos los casos y la plantilla POS cae silenciosamente a un comprobante normal | Medium | Low | Confirmed: llega clave `qr`, pero `hasQr=false` en dos emisiones |
| D | La previsualización POS se arma desde un estado distinto al usado para pintar el encabezado FE y por eso pierde el QR | Medium | Medium | Rejected: el número FE sí está en el mismo estado al imprimir |
| E | El tipo de pago/forma de pago altera la construcción de `payment_details.due_date` y explica por qué a veces sirve y a veces no | High | Low | Rejected en corrida observada: contado construye `dueDate=null` consistentemente |

## Log Evidence
- Línea 1: `paymentForm=contado`, `dueDate=null`.
- Líneas 2 y 5: `factusNumber=SETP...`, `hasQr=false`, `qrKeys=["qr"]`.
- Líneas 3 y 6: antes de imprimir FE, `hasQrInState=false`, pero `currentStateNumber=SETP...`.

## Verification Conclusion
Se confirmó que el QR no se pierde por timing de impresión ni por usar un estado incorrecto. El frontend recibe el número FE correctamente, pero el campo `qr` llega vacío en las emisiones observadas. Se aplica fix mínimo en frontend: si Factus no entrega QR útil, la previsualización POS generará uno de respaldo usando `document_url` y, si tampoco existe, `number + cufe`.
