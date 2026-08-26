# Debug Session: factus-intermittent
- **Status**: [OPEN]
- **Issue**: La facturación electrónica en Factus es intermitente: algunas ventas son aceptadas y otras fallan con validaciones de `quantity`, `price`, `payment_details` o `created_time`.
- **Debug Server**: http://127.0.0.1:7777/event
- **Log File**: .dbg/trae-debug-log-factus-intermittent.ndjson

## Reproduction Steps
1. Generar una venta con facturación electrónica desde `remision.html`.
2. Confirmar el intento contra Factus.
3. Revisar el resultado aceptado o rechazado y correlacionarlo con el payload instrumentado.

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | `created_time` queda demasiado cerca de la hora actual y Factus lo rechaza por desfase. | High | Low | Confirmed por rechazos en ventas `10811` y `10812`. |
| B | `payment_details` no siempre suma exactamente el total canónico por redondeo. | High | Low | Confirmed por rechazo en venta `10747` con diferencia de `0.01`. |
| C | Algunos items quedan serializados con formato distinto según producto/impuesto/reemplazo. | Medium | Medium | Inconclusive; hubo rechazos en `11049`/`11056`, pero también una validación exitosa reciente (`11075`) con payload numérico nuevo. |
| D | Los errores observados mezclan payloads viejos con payloads nuevos y están contaminando el diagnóstico. | Medium | Low | Confirmed; coexistían rechazos históricos y una validación exitosa reciente. |
| E | El comportamiento cambia según el tipo de venta o método de pago. | Medium | Medium | Inconclusive; una venta mixta reciente fue aceptada. |

## Log Evidence
- Instrumentation active in `server.js` for:
  - item serialization (`C`)
  - `created_time` generation (`A`)
  - `payment_details` total reconciliation (`B`)
  - request dispatch to `/v2/bills/validate` (`D`)
  - Factus response success/error (`E`)

## Verification Conclusion
- Root cause confirmado parcialmente por logs previos: había dos fuentes reales de intermitencia (`created_time` y redondeo de `payment_details`).
- Fix aplicado localmente:
  - mayor margen de seguridad para `created_time`
  - reparto de `payment_details` por centavos enteros para eliminar diferencias de `0.01`
- Pendiente: desplegar y capturar evidencia `pre-fix/post-fix` con la nueva instrumentación.
