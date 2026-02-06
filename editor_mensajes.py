import json
import os
import sys
import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext

class EditorMensajesApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Editor de Mensajes ALUMAS")
        self.root.geometry("900x600")
        
        # Datos
        self.data = {}
        self.current_day = None
        self.current_contact_index = None
        self.json_path = self.get_json_path()
        
        # Cargar datos
        self.load_data()
        
        # Configurar UI
        self.setup_ui()
        
    def get_json_path(self):
        """Obtiene la ruta del archivo JSON."""
        if getattr(sys, 'frozen', False):
            application_path = os.path.dirname(sys.executable)
        else:
            application_path = os.path.dirname(os.path.abspath(__file__))
        return os.path.join(application_path, 'contactos.json')

    def load_data(self):
        """Carga los datos desde el archivo JSON."""
        try:
            with open(self.json_path, 'r', encoding='utf-8') as f:
                self.data = json.load(f)
        except FileNotFoundError:
            messagebox.showerror("Error", f"No se encontró el archivo {self.json_path}")
            sys.exit(1)
        except json.JSONDecodeError as e:
            messagebox.showerror("Error", f"Error al leer el JSON: {e}")
            sys.exit(1)

    def save_data(self):
        """Guarda los cambios en el archivo JSON."""
        try:
            with open(self.json_path, 'w', encoding='utf-8') as f:
                json.dump(self.data, f, indent=4, ensure_ascii=False)
            messagebox.showinfo("Éxito", "Cambios guardados correctamente.")
        except Exception as e:
            messagebox.showerror("Error", f"No se pudo guardar: {e}")

    def setup_ui(self):
        # Frame principal
        main_frame = ttk.Frame(self.root, padding="10")
        main_frame.pack(fill=tk.BOTH, expand=True)
        
        # --- Panel Izquierdo: Selección de Día y Contactos ---
        left_panel = ttk.LabelFrame(main_frame, text="Navegación", padding="10")
        
        # CORRECCION: Eliminado width=300 para evitar error en pack
        left_panel.pack(side=tk.LEFT, fill=tk.BOTH, expand=False, padx=(0, 10))
        
        # Selector de día
        ttk.Label(left_panel, text="Seleccione el día:").pack(anchor=tk.W, pady=(0, 5))
        self.day_var = tk.StringVar()
        days = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
        self.day_combo = ttk.Combobox(left_panel, textvariable=self.day_var, values=days, state="readonly", width=25)
        self.day_combo.pack(fill=tk.X, pady=(0, 10))
        self.day_combo.bind("<<ComboboxSelected>>", self.on_day_selected)
        
        # Lista de contactos
        ttk.Label(left_panel, text="Contactos:").pack(anchor=tk.W, pady=(0, 5))
        
        # Scrollbar para la lista
        list_frame = ttk.Frame(left_panel)
        list_frame.pack(fill=tk.BOTH, expand=True)
        
        scrollbar = ttk.Scrollbar(list_frame)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        self.contact_list = tk.Listbox(list_frame, yscrollcommand=scrollbar.set, font=("Arial", 10), width=40)
        self.contact_list.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.config(command=self.contact_list.yview)
        
        self.contact_list.bind("<<ListboxSelect>>", self.on_contact_selected)
        
        # --- Panel Derecho: Edición ---
        right_panel = ttk.LabelFrame(main_frame, text="Editor de Mensaje", padding="10")
        right_panel.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True)
        
        # Info del contacto
        info_frame = ttk.Frame(right_panel)
        info_frame.pack(fill=tk.X, pady=(0, 10))
        
        ttk.Label(info_frame, text="Número:", font=("Arial", 10, "bold")).grid(row=0, column=0, sticky=tk.W, padx=5)
        self.lbl_number = ttk.Label(info_frame, text="-")
        self.lbl_number.grid(row=0, column=1, sticky=tk.W, padx=5)
        
        # Área de texto
        ttk.Label(right_panel, text="Mensaje:").pack(anchor=tk.W, pady=(0, 5))
        self.txt_message = scrolledtext.ScrolledText(right_panel, wrap=tk.WORD, width=40, height=15, font=("Arial", 11))
        self.txt_message.pack(fill=tk.BOTH, expand=True, pady=(0, 10))
        
        # Botones
        btn_frame = ttk.Frame(right_panel)
        btn_frame.pack(fill=tk.X)
        
        ttk.Button(btn_frame, text="Actualizar Mensaje en Memoria", command=self.update_memory_message).pack(side=tk.LEFT, padx=5)
        ttk.Button(btn_frame, text="💾 Guardar Todo en Archivo", command=self.save_data).pack(side=tk.RIGHT, padx=5)

        # Instrucciones
        status_bar = ttk.Label(self.root, text="Seleccione un día y un contacto para editar.", relief=tk.SUNKEN, anchor=tk.W)
        status_bar.pack(side=tk.BOTTOM, fill=tk.X)

    def on_day_selected(self, event):
        self.current_day = self.day_var.get()
        self.populate_contacts()
        self.clear_editor()

    def populate_contacts(self):
        self.contact_list.delete(0, tk.END)
        contacts = self.data.get("mensajes_por_dia", {}).get(self.current_day, [])
        
        for idx, contact in enumerate(contacts):
            # contact es [numero, mensaje]
            number = contact[0]
            # Mostramos el número y un fragmento del mensaje para identificar
            msg_preview = contact[1][:30].replace("\n", " ") + "..."
            self.contact_list.insert(tk.END, f"{number} - {msg_preview}")

    def on_contact_selected(self, event):
        selection = self.contact_list.curselection()
        if not selection:
            return
            
        index = selection[0]
        self.current_contact_index = index
        
        contacts = self.data.get("mensajes_por_dia", {}).get(self.current_day, [])
        if 0 <= index < len(contacts):
            contact = contacts[index]
            number = contact[0]
            message = contact[1]
            
            self.lbl_number.config(text=number)
            self.txt_message.delete("1.0", tk.END)
            self.txt_message.insert("1.0", message)

    def clear_editor(self):
        self.lbl_number.config(text="-")
        self.txt_message.delete("1.0", tk.END)
        self.current_contact_index = None

    def update_memory_message(self):
        if self.current_day is None or self.current_contact_index is None:
            messagebox.showwarning("Aviso", "Por favor seleccione un contacto primero.")
            return
            
        new_message = self.txt_message.get("1.0", tk.END).strip()
        
        # Actualizar en memoria
        self.data["mensajes_por_dia"][self.current_day][self.current_contact_index][1] = new_message
        
        # Actualizar lista visualmente para reflejar cambios en el preview
        self.populate_contacts()
        
        # Restaurar selección
        self.contact_list.selection_set(self.current_contact_index)
        self.contact_list.see(self.current_contact_index)
        
        messagebox.showinfo("Info", "Mensaje actualizado en memoria. No olvide 'Guardar Todo en Archivo' para hacer los cambios permanentes.")

if __name__ == "__main__":
    root = tk.Tk()
    # Intentar establecer ícono si existe (opcional)
    # try:
    #     root.iconbitmap("icono.ico")
    # except:
    #     pass
    
    app = EditorMensajesApp(root)
    root.mainloop()
