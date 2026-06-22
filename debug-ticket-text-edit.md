# Debug Session: ticket-text-edit [OPEN]

## Objetivo
- Corregir que el doble clic no permita editar texto en el lienzo.
- Corregir que al redimensionar un bloque de texto solo cambie el marco y no el contenido.

## Sintomas reportados
- El doble clic sobre un texto no muestra cursor ni habilita edición inline.
- Al agrandar un texto, el cuadro aumenta pero la fuente no escala.

## Hipotesis
1. Un evento de `pointerdown` o `blur` cancela la edición inmediatamente.
2. `renderStage()` recrea el nodo editable y se pierde el foco/caret.
3. El resize actual solo cambia caja y no sincroniza `fontSize`.
4. Arrastre y edición compiten sobre el mismo bloque.
5. El contexto `file://` agrega ruido, pero no es la causa raíz de la edición.

## Evidencia pendiente
- Instrumentar entrada a `dblclick`, `pointerdown`, `blur`, `focusEditableText`, `startDrag`, `startResize` y cambios de tamaño de fuente.

## Evidencia recogida
- Reproducción en navegador integrado sobre `http://localhost:4173/ticket-editor.html`.
- Observación previa al fix: tras activar edición, el nodo quedaba editable pero el foco seguía en `BODY`, por eso no aparecía el cursor.
- Observación previa al fix: al cambiar el tamaño del bloque seleccionado, el valor de `fontSize` seguía intacto y solo cambiaban `width` y `height`.
- Nueva hipótesis confirmada: el primer clic sobre el texto re-renderizaba el bloque, así que el doble clic nativo podía romperse entre un nodo viejo y uno nuevo.

## Cambio aplicado
- Se reemplazó la edición inline por un `textarea` superpuesto dentro del bloque de texto.
- Se reforzó el enfoque con múltiples intentos (`requestAnimationFrame` + `setTimeout`) y `tabIndex`.
- El resize de bloques de texto ahora escala también `fontSize` proporcionalmente.
- Se agregó una ruta extra de entrada a edición por "segundo clic rápido sobre el mismo texto ya seleccionado", sin depender únicamente del `dblclick` nativo del nodo.

## Estado
- Fix aplicado, pendiente de validación del usuario.
