#!/usr/bin/env python3
"""
Script para convertir todas las imágenes del proyecto ALUMAS a formato WebP
para mejorar la velocidad de carga del sitio web.
"""

import os
import sys
from PIL import Image
import glob

def convert_image_to_webp(input_path, output_path, quality=85):
    """
    Convierte una imagen a formato WebP
    
    Args:
        input_path (str): Ruta de la imagen original
        output_path (str): Ruta donde guardar la imagen WebP
        quality (int): Calidad de compresión (1-100)
    """
    try:
        # Abrir la imagen
        with Image.open(input_path) as img:
            # Convertir a RGB si es necesario (para PNG con transparencia)
            if img.mode in ('RGBA', 'LA', 'P'):
                # Mantener transparencia para WebP
                img = img.convert('RGBA')
            elif img.mode != 'RGB':
                img = img.convert('RGB')
            
            # Guardar como WebP
            img.save(output_path, 'WebP', quality=quality, optimize=True)
            print(f"✓ Convertido: {input_path} -> {output_path}")
            return True
    except Exception as e:
        print(f"✗ Error convirtiendo {input_path}: {str(e)}")
        return False

def get_all_images(base_path):
    """
    Obtiene todas las imágenes del proyecto
    
    Args:
        base_path (str): Ruta base del proyecto
        
    Returns:
        list: Lista de rutas de imágenes
    """
    extensions = ['*.png', '*.jpg', '*.jpeg', '*.jfif']
    images = []
    
    for ext in extensions:
        # Buscar en todas las subcarpetas
        pattern = os.path.join(base_path, '**', ext)
        images.extend(glob.glob(pattern, recursive=True))
    
    return images

def main():
    """Función principal"""
    base_path = os.path.dirname(os.path.abspath(__file__))
    print(f"Buscando imágenes en: {base_path}")
    
    # Obtener todas las imágenes
    images = get_all_images(base_path)
    print(f"Encontradas {len(images)} imágenes para convertir")
    
    if not images:
        print("No se encontraron imágenes para convertir")
        return
    
    converted_count = 0
    failed_count = 0
    
    for img_path in images:
        # Crear la ruta de salida cambiando la extensión a .webp
        base_name = os.path.splitext(img_path)[0]
        webp_path = base_name + '.webp'
        
        # Crear directorio si no existe
        os.makedirs(os.path.dirname(webp_path), exist_ok=True)
        
        # Convertir la imagen
        if convert_image_to_webp(img_path, webp_path):
            converted_count += 1
        else:
            failed_count += 1
    
    print(f"\n=== RESUMEN ===")
    print(f"Imágenes convertidas exitosamente: {converted_count}")
    print(f"Imágenes con errores: {failed_count}")
    print(f"Total procesadas: {len(images)}")
    
    if converted_count > 0:
        print(f"\n✓ Conversión completada. Las imágenes WebP están listas.")
        print("Ahora necesitas actualizar las referencias en HTML y CSS.")

if __name__ == "__main__":
    main()