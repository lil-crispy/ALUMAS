import os
import re
import glob

def update_image_references_in_file(file_path):
    """
    Actualiza las referencias de imágenes en un archivo específico
    """
    try:
        with open(file_path, 'r', encoding='utf-8') as file:
            content = file.read()
        
        original_content = content
        
        # Patrones para encontrar referencias de imágenes
        patterns = [
            (r'\.png\b', '.webp'),
            (r'\.jpg\b', '.webp'),
            (r'\.jpeg\b', '.webp'),
            (r'\.jfif\b', '.webp'),
            (r'\.PNG\b', '.webp'),
            (r'\.JPG\b', '.webp'),
            (r'\.JPEG\b', '.webp'),
            (r'\.JFIF\b', '.webp')
        ]
        
        changes_made = 0
        for pattern, replacement in patterns:
            new_content = re.sub(pattern, replacement, content)
            if new_content != content:
                changes_made += len(re.findall(pattern, content))
                content = new_content
        
        # Solo escribir si hubo cambios
        if content != original_content:
            with open(file_path, 'w', encoding='utf-8') as file:
                file.write(content)
            return changes_made
        
        return 0
        
    except Exception as e:
        print(f"Error procesando {file_path}: {e}")
        return 0

def main():
    """
    Función principal que actualiza todas las referencias de imágenes
    """
    project_root = "."
    
    # Buscar todos los archivos HTML y CSS (excluyendo node_modules)
    html_files = []
    css_files = []
    
    for root, dirs, files in os.walk(project_root):
        # Excluir node_modules
        if 'node_modules' in root:
            continue
            
        for file in files:
            file_path = os.path.join(root, file)
            if file.endswith('.html'):
                html_files.append(file_path)
            elif file.endswith('.css'):
                css_files.append(file_path)
    
    all_files = html_files + css_files
    
    print(f"Procesando {len(all_files)} archivos...")
    print(f"- {len(html_files)} archivos HTML")
    print(f"- {len(css_files)} archivos CSS")
    print()
    
    total_changes = 0
    files_updated = 0
    
    for file_path in all_files:
        changes = update_image_references_in_file(file_path)
        if changes > 0:
            files_updated += 1
            total_changes += changes
            print(f"✓ {file_path}: {changes} referencias actualizadas")
    
    print(f"\n=== RESUMEN ===")
    print(f"Archivos procesados: {len(all_files)}")
    print(f"Archivos actualizados: {files_updated}")
    print(f"Total de referencias cambiadas: {total_changes}")
    print("¡Todas las referencias ahora apuntan a archivos WebP!")

if __name__ == "__main__":
    main()