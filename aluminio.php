<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Catálogo Virtual</title>
  <link rel="stylesheet" href="./css/aluminio.css">
  <link rel="manifest" href="manifest.json">
  <link rel="icon" type="image/svg+xml" href="./img/LOGO3.webp" />

</head>
<body>

<header>DISTRIBUCION PARA FERRETERIA</header>
<div id="ticket" style="display: none; font-family: monospace; padding: 10px;">
  <!-- Logo y número de celular -->
  <h1 style="text-align: center; font-family: 'Arial', sans-serif;">ALUMAS</h1>
  <h3 style="text-align: center;">🛒 ORDEN DE COMPRA </h3>
  <samp style="text-align: center;">📞 3197245235 </samp>
  <div style="text-align: center; margin-top: 20px;">_______________________</div>
  <div style="text-align: center; margin-top: 20px;">Descripcion de prodcutos:</div>

  <!-- Los items del ticket, ahora más cerca de la línea -->
  <div id="ticket-items" style="margin-top: 5px;"></div>

  <div id="ticket-total" style="margin-top: 10px;"></div>

  <div style="text-align: center; margin-top: 20px;">Gracias por su compra</div>
</div>

<!-- Estilos responsivos -->
<style>
  @media (max-width: 600px) {
    #ticket {
      padding: 15px;
    }

    #ticket h1 {
      font-size: 18px;
      font-family: 'Arial', sans-serif; 
    }

    #ticket h3 {
      font-size: 12px;
    }

    #ticket-items,
    #ticket-total {
      font-size: 14px;
    }

    #ticket img {
      max-width: 80px;
    }

    #ticket span {
      font-size: 12px;
    }
  }
</style>

<div class="buscar">
  <input type="text" id="buscador" placeholder="Buscar producto..." onkeyup="filtrarProductos()">
</div>

<button class="abrir-carrito" id="btn-carrito">🛒 Ver Carrito</button>

<div class="catalogo" id="catalogo">
  <?php
  require_once 'db.php';

  try {
      // Consulta para obtener los productos del inventario
      // Se asume que la tabla 'inventario' tiene las columnas: nombre, precio_mayor, imagen, unidad_empaque
      // Ajusta los nombres de columnas según tu base de datos real.
      $sql = "SELECT nombre, precio_mayorista, imagen FROM productos";
      $stmt = $pdo->query($sql);

      while ($row = $stmt->fetch()) {
          $nombre = $row['nombre'];
          $precio = $row['precio_mayorista'];
          $imagen = $row['imagen'];
          $ue = '';

          // Formatear precio
          $precio_formateado = "$" . number_format($precio, 0, ',', '.');

          // Configurar ruta de imagen
          // Ruta absoluta en el servidor (como referencia o validación)
          // /var/www/html/public/img/productos
          
          // Ruta web relativa para el navegador
          // Asumiendo que las imágenes están en public/img/productos/
          $ruta_web_imagen = "./public/img/productos/" . $imagen;

          // Generar atributo data-ue si existe
          $data_ue_attr = $ue ? 'data-ue="' . htmlspecialchars($ue) . '"' : '';

          // Valor inicial del input
          $input_value = 1;
          // Si la unidad de empaque es un número simple, podríamos usarlo como mínimo, 
          // pero el HTML original variaba (algunos min=1, otros min=UE).
          // Usaremos 1 por defecto.

          echo '
          <div class="producto" data-nombre="' . htmlspecialchars($nombre) . '" ' . $data_ue_attr . '>
            <img src="' . htmlspecialchars($ruta_web_imagen) . '" alt="' . htmlspecialchars($nombre) . '">
            <div class="descripcion">' . htmlspecialchars($nombre) . '</div>
            <div class="precio">' . $precio_formateado . '</div>
            <div class="acciones">
              <input type="number" value="' . $input_value . '" min="1">
              <button onclick="agregarAlCarrito(\'' . htmlspecialchars($nombre, ENT_QUOTES) . '\', ' . $precio . ', this)">Agregar</button>
            </div>
          </div>';
      }
  } catch (PDOException $e) {
      echo '<p>Error al cargar el catálogo: ' . $e->getMessage() . '</p>';
  }
  ?>
</div>


<div class="carrito-container" id="carrito">
  <div class="carrito-header">Carrito</div>
  <div id="carrito-items"></div>
  <div class="carrito-total" id="total">Total: $0</div>
  <button class="btn-comprar" onclick="mostrarFormulario()">Comprar</button>

  <div class="formulario-compra" id="formulario-compra">
    <input type="text" id="nombre-ferreteria" placeholder="Nombre de la ferretería">
    <input type="text" id="direccion-ferreteria" placeholder="Dirección de la ferretería">
    <button onclick="imprimirOrdenCompra()" class="btn-imprimir">🖨️ Imprimir orden de compra</button>
<button id="editar-precios-btn" class="editar-precios-btn">✏️ Editar precios</button>


    <button class="btn-comprar" onclick="finalizarCompra()">Finalizar Compra</button>
  </div>
</div>
<div id="notificacion" style="display:none; position:fixed; top:10px; left:50%; transform:translateX(-50%); background-color:#4CAF50; color:white; padding:10px 20px; border-radius:5px; z-index:9999; font-weight:bold;">
  EL PRODUCTO SE HA AGREGADO CORRECTAMENTE
</div>

<script>
  
  let carrito = [];

  function mostrarNotificacion(mensaje) {
    const notificacion = document.getElementById("notificacion");
    notificacion.textContent = `✅ ${mensaje}`;
    notificacion.style.display = "block";
    setTimeout(() => { notificacion.style.display = "none"; }, 3000);
  }

  function toggleCarrito() {
    document.getElementById('carrito').classList.toggle('open');
  }

  function ajustarCantidadUE(cantidad, unidades) {
    let cantidadesValidas = [];
    for (let i = 1; i <= 1000; i++) {
      unidades.forEach(ue => cantidadesValidas.push(ue * i));
    }
    return cantidadesValidas.reduce((prev, curr) =>
      Math.abs(curr - cantidad) < Math.abs(prev - cantidad) ? curr : prev
    );
  }

  function agregarAlCarrito(nombre, precio, boton) {
    const productoDiv = boton.closest('.producto');
    const cantidadInput = productoDiv.querySelector('input[type="number"]');
    let cantidad = parseInt(cantidadInput.value);
    const imgSrc = productoDiv.querySelector('img').src;

    const ueData = productoDiv.getAttribute('data-ue');
    if (ueData) {
      const unidades = ueData.split(',').map(Number);
      const cantidadAjustada = ajustarCantidadUE(cantidad, unidades);
      if (cantidad !== cantidadAjustada) {
        cantidad = cantidadAjustada;
        cantidadInput.value = cantidadAjustada;
        mostrarNotificacion(`${nombre}: cantidad ajustada a ${cantidadAjustada}`);
      } else {
        mostrarNotificacion(`${nombre} se ha agregado correctamente`);
      }
    } else {
      mostrarNotificacion(`${nombre} se ha agregado correctamente`);
    }

    carrito.push({ nombre, precio, cantidad, imgSrc });
    mostrarCarrito();
  }

  function eliminarDelCarrito(index) {
    carrito.splice(index, 1);
    mostrarCarrito();
  }

  function mostrarCarrito() {
  const carritoItems = document.getElementById('carrito-items');
  carritoItems.innerHTML = '';
  let total = 0;

  carrito.forEach((item, index) => {
    const div = document.createElement('div');
    div.className = 'carrito-item';
    div.innerHTML = `
      <img src="${item.imgSrc}" alt="${item.nombre}">
      <div class="carrito-item-details">
        <div>${item.nombre}</div>
        <div>Cant: ${item.cantidad}</div>
        <div>
          $<input type="number" min="0" step="100" value="${item.precio}" data-index="${index}" class="editable-precio" disabled style="width: 80px;">
        </div>
      </div>
      <button class="eliminar-item" onclick="eliminarDelCarrito(${index})">🗑️</button>
    `;
    carritoItems.appendChild(div);
    total += item.precio * item.cantidad;
  });

  document.getElementById('total').textContent = `Total: $${total.toLocaleString()}`;
  
  // Event listener para editar precios
  document.querySelectorAll('.editable-precio').forEach(input => {
    input.addEventListener('input', (e) => {
      const index = parseInt(e.target.getAttribute('data-index'));
      const nuevoPrecio = parseInt(e.target.value);
      if (!isNaN(nuevoPrecio) && nuevoPrecio >= 0) {
        carrito[index].precio = nuevoPrecio;
        mostrarCarrito();
      }
    });
  });
}

  function filtrarProductos() {
    const input = document.getElementById('buscador').value.toLowerCase();
    const productos = document.querySelectorAll('.producto');
    productos.forEach(p => {
      const nombre = p.getAttribute('data-nombre').toLowerCase();
      p.style.display = nombre.includes(input) ? 'flex' : 'none';
    });
  }

  function mostrarFormulario() {
    document.getElementById('formulario-compra').style.display = 'flex';
  }

  function finalizarCompra() {
  const nombre = document.getElementById('nombre-ferreteria').value.trim();
  const direccion = document.getElementById('direccion-ferreteria').value.trim();
  if (!nombre || !direccion) {
    alert('Por favor llena todos los campos.');
    return;
  }

  let mensaje = `*Pedido de ferretería*\n`;
  mensaje += `*Nombre:* ${nombre}\n`;
  mensaje += `*Dirección:* ${direccion}\n\n`;
  carrito.forEach(item => {
    mensaje += `🔹 ${item.nombre} (Cant: ${item.cantidad}) - $${(item.precio * item.cantidad).toLocaleString()}\n`;
  });

  const totalTexto = document.getElementById('total').textContent;
  mensaje += `\n*${totalTexto}*`;

  const mensajeCodificado = encodeURIComponent(mensaje);
  const numero = "573197245235";

  // Detectar si es dispositivo móvil
  const esMovil = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  if (esMovil) {
    // Abre app WhatsApp
    window.location.href = `intent://send?phone=${numero}&text=${mensajeCodificado}#Intent;scheme=smsto;package=com.whatsapp;action=android.intent.action.SENDTO;end`;
  } else {
    // Abre versión web
    window.open(`https://wa.me/${numero}?text=${mensajeCodificado}`, '_blank');
  }
}


  async function convertirImagenABase64(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "Anonymous";
      img.onload = function () {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const dataURL = canvas.toDataURL("image/png");
        resolve(dataURL);
      };
      img.onerror = function (error) {
        console.error("Error al cargar la imagen:", error);
        reject(error);
      };
      img.src = url;
    });
  }

  async function imprimirOrdenCompra() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4'
    });

    const nombreFerreteria = document.getElementById('nombre-ferreteria').value.trim();
    const direccionFerreteria = document.getElementById('direccion-ferreteria').value.trim();

    let y = 20;
    let total = 0;

    try {
const logoBase64 = await convertirImagenABase64('./img/logo5.webp');
const logoWidth = 120;
const logoHeight = 45;
const x = 4; // margen izquierdo
doc.addImage(logoBase64, 'PNG', x, y, logoWidth, logoHeight);

y += logoHeight + 10;

    } catch (error) {
      console.error("No se pudo cargar el logo:", error);
    }

// Obtener fecha y hora actual
const fechaActual = new Date();
const fechaStr = fechaActual.toLocaleDateString();  // Ej: 04/06/2025
const horaStr = fechaActual.toLocaleTimeString();   // Ej: 15:45:22

doc.setFont("helvetica", "bold");
doc.setFontSize(26);
doc.text('REMISIÓN DE COMPRA', 20, y);
y += 16;

// Teléfono de ventas
doc.setFontSize(16);
doc.setFont("helvetica", "normal");
doc.text('Ventas:  3197245235', 20, y);
y += 8;

// Hora
doc.text(`Hora: ${horaStr}`, 20, y);
y += 8;

// Fecha
doc.text(`Fecha: ${fechaStr}`, 20, y);
y += 12;

// Datos de la ferretería
doc.setFontSize(20);
doc.text(`Nombre: ${nombreFerreteria || 'ALUMAS FERRETERÍA'}`, 20, y);
y += 12;
doc.text(`Dirección: ${direccionFerreteria || 'Dirección no especificada'}`, 20, y);
y += 14;

// Línea separadora
doc.setLineWidth(0.5);
doc.line(20, y, 190, y);
y += 10;

// Título de detalle
doc.setFont("helvetica", "bold");
doc.setFontSize(20);
doc.text("Detalle del pedido:", 20, y);
y += 14;

// Listado del carrito
doc.setFontSize(18);
doc.setFont("helvetica", "normal");

carrito.forEach(item => {
  const subtotal = item.precio * item.cantidad;
  total += subtotal;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text(`${item.nombre.substring(0, 60)}`, 25, y);
  y += 10;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(16);
  doc.text(`Cantidad: ${item.cantidad}  |  Subtotal: $${subtotal.toLocaleString()}`, 30, y);
  y += 14;

  if (y > 270) {
    doc.addPage();
    y = 20;
  }
});

doc.setLineWidth(0.5);
doc.line(20, y, 190, y);
y += 14;

// TOTAL alineado a la izquierda
doc.setFontSize(22);
doc.setFont("helvetica", "bold");
doc.text(`TOTAL: $${total.toLocaleString()}`, 20, y);
y += 20;

// Mensaje final
doc.setFontSize(16);
doc.setFont("helvetica", "italic");
doc.text('Gracias por tu compra.', 20, y);
y += 8;
doc.text('www.ferredistribucionesalumas.com', 20, y);

doc.save('remision_ALUMAS.pdf');

  }

 document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-carrito').addEventListener('click', toggleCarrito);

  document.querySelectorAll('.agregar-btn').forEach((btn, i) => {
    btn.addEventListener('click', function () {
      const producto = btn.closest('.producto');
      const nombre = producto.querySelector('.descripcion').textContent;
      const precioTexto = producto.querySelector('.precio').textContent.replace('$', '').replace('.', '');
      agregarAlCarrito(nombre, parseInt(precioTexto), btn);
    });
  });

  document.getElementById('buscador').addEventListener('keyup', filtrarProductos);

  // 👉 NUEVO BLOQUE: botón editar precios
  const btnEditarPrecios = document.getElementById('editar-precios-btn');
  if (btnEditarPrecios) {
    btnEditarPrecios.addEventListener('click', () => {
      const clave = prompt("Ingrese la clave para editar precios:");
      if (clave === "0000") {
        document.querySelectorAll('.editable-precio').forEach(input => {
          input.disabled = false;
        });
        alert("Ahora puedes editar los precios.");
      } else {
        alert("Clave incorrecta.");
      }
    });
  }
});

</script>

<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>

</body>
</html>
