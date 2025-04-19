var swiper = new Swiper(".swiper", {
    effect: "coverflow",
    grabCursor: true,
    centeredSlides: true,
    initialSlide: 2,
    speed: 600,
    preventClicks: true,
    slidesPerView: "auto",
    coverflowEffect: {
      rotate: 0,
      stretch: 80,
      depth: 350,
      modifier: 1,
      slideShadows: true,
    },
    on: {
      click(event) {
        swiper.slideTo(this.clickedIndex);
      },
    },
    pagination: {
      el: ".swiper-pagination",
    },
  });
  function printDiv() {
    var contenido = document.getElementById("printSection").innerHTML;
    var ventana = window.open('', '', 'width=300,height=600');
    ventana.document.write(`
        <html>
        <head>
            <title>Imprimir</title>
            <style>
                body { font-family: Arial, sans-serif; font-size: 12px; margin: 0; padding: 0; width: 80mm; }
                table { width: 100%; border-collapse: collapse; }
                th, td { border: 1px solid #000; padding: 4px; text-align: left; }
                th { background-color: #f2f2f2; }
            </style>
        </head>
        <body onload="window.print(); window.close();">
            ${contenido}
        </body>
        </html>
    `);
    ventana.document.close();
}