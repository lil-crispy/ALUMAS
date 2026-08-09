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
| A | `due_date` se está enviando para contado o con una fecha que no cumple la regla de Factus en ciertos flujos | High | Low | Pending |
| B | El flujo FE exitoso llama `window.print()` antes de que `ultimaFacturaElectronicaEmitida` quede lista para poblar el QR | High | Low | Pending |
| C | Factus no devuelve `qr`/`qr_url` en todos los casos y la plantilla POS cae silenciosamente a un comprobante normal | Medium | Low | Pending |
| D | La previsualización POS se arma desde un estado distinto al usado para pintar el encabezado FE y por eso pierde el QR | Medium | Medium | Pending |
| E | El tipo de pago/forma de pago altera la construcción de `payment_details.due_date` y explica por qué a veces sirve y a veces no | High | Low | Pending |

## Log Evidence
Pending

## Verification Conclusion
Pending
