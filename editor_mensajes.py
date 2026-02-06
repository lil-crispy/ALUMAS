import json
import os
import sys
import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext, simpledialog

class EditorMensajesApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Editor Avanzado ALUMAS")
        self.root.geometry("1000x700")
        
        # Datos
        self.data = {}
        self.current_day = None
        self.current_contact_index = None
        self.json_path = self.get_json_path()
        
        # Cargar datos
        self.load_data()
        
        # Configurar UI con Pestañas
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
        # Crear Notebook (Pestañas)
        notebook = ttk.Notebook(self.root)
        notebook.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)
        
        # Pestaña 1: Contactos
        self.frame_contactos = ttk.Frame(notebook)
        notebook.add(self.frame_contactos, text="📞 Contactos y Mensajes")
        self.setup_contacts_tab(self.frame_contactos)
        
        # Pestaña 2: Promociones
        self.frame_promociones = ttk.Frame(notebook)
        notebook.add(self.frame_promociones, text="🎁 Promociones y Globales")
        self.setup_promotions_tab(self.frame_promociones)

    # -------------------------------------------------------------------------
    # PESTAÑA 1: CONTACTOS
    # -------------------------------------------------------------------------
    def setup_contacts_tab(self, parent):
        # Panel Izquierdo: Navegación y Lista
        left_panel = ttk.LabelFrame(parent, text="Lista de Contactos", padding="10")
        left_panel.pack(side=tk.LEFT, fill=tk.BOTH, expand=False, padx=(0, 10))
        
        # Selector de día
        ttk.Label(left_panel, text="Día:").pack(anchor=tk.W, pady=(0, 5))
        self.day_var = tk.StringVar()
        days = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
        self.day_combo = ttk.Combobox(left_panel, textvariable=self.day_var, values=days, state="readonly", width=25)
        self.day_combo.pack(fill=tk.X, pady=(0, 10))
        self.day_combo.bind("<<ComboboxSelected>>", self.on_day_selected)
        
        # Buscador
        ttk.Label(left_panel, text="🔍 Buscar (Número o Nombre):").pack(anchor=tk.W, pady=(0, 5))
        self.search_var = tk.StringVar()
        self.search_var.trace("w", self.on_search_change)
        self.entry_search = ttk.Entry(left_panel, textvariable=self.search_var)
        self.entry_search.pack(fill=tk.X, pady=(0, 10))
        
        # Lista
        list_frame = ttk.Frame(left_panel)
        list_frame.pack(fill=tk.BOTH, expand=True)
        
        scrollbar = ttk.Scrollbar(list_frame)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        self.contact_list = tk.Listbox(list_frame, yscrollcommand=scrollbar.set, font=("Arial", 10), width=40)
        self.contact_list.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.config(command=self.contact_list.yview)
        self.contact_list.bind("<<ListboxSelect>>", self.on_contact_selected)
        
        # Botones de Acción (Agregar/Eliminar)
        action_frame = ttk.Frame(left_panel)
        action_frame.pack(fill=tk.X, pady=(10, 0))
        ttk.Button(action_frame, text="➕ Agregar Nuevo", command=self.add_contact).pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 2))
        ttk.Button(action_frame, text="❌ Eliminar", command=self.delete_contact).pack(side=tk.RIGHT, fill=tk.X, expand=True, padx=(2, 0))
        
        # Panel Derecho: Edición
        right_panel = ttk.LabelFrame(parent, text="Editor", padding="10")
        right_panel.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True)
        
        info_frame = ttk.Frame(right_panel)
        info_frame.pack(fill=tk.X, pady=(0, 10))
        ttk.Label(info_frame, text="Número:", font=("Arial", 10, "bold")).grid(row=0, column=0, sticky=tk.W, padx=5)
        self.lbl_number = ttk.Label(info_frame, text="-")
        self.lbl_number.grid(row=0, column=1, sticky=tk.W, padx=5)
        
        ttk.Label(right_panel, text="Mensaje:").pack(anchor=tk.W, pady=(0, 5))
        self.txt_message = scrolledtext.ScrolledText(right_panel, wrap=tk.WORD, width=40, height=15, font=("Arial", 11))
        self.txt_message.pack(fill=tk.BOTH, expand=True, pady=(0, 10))
        
        btn_frame = ttk.Frame(right_panel)
        btn_frame.pack(fill=tk.X)
        ttk.Button(btn_frame, text="💾 Guardar Cambios", command=self.save_contact_changes).pack(side=tk.RIGHT)

    # -------------------------------------------------------------------------
    # PESTAÑA 2: PROMOCIONES
    # -------------------------------------------------------------------------
    def setup_promotions_tab(self, parent):
        left_panel = ttk.LabelFrame(parent, text="Seleccionar Semana", padding="10")
        left_panel.pack(side=tk.LEFT, fill=tk.Y, padx=(0, 10))
        
        self.promo_list = tk.Listbox(left_panel, font=("Arial", 11), width=20)
        self.promo_list.pack(fill=tk.BOTH, expand=True)
        self.promo_list.bind("<<ListboxSelect>>", self.on_promo_selected)
        
        for i in range(1, 5):
            self.promo_list.insert(tk.END, f"Semana {i}")
            
        right_panel = ttk.LabelFrame(parent, text="Texto de la Promoción (Se envía a TODOS)", padding="10")
        right_panel.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True)
        
        self.txt_promo = scrolledtext.ScrolledText(right_panel, wrap=tk.WORD, width=40, height=15, font=("Arial", 11))
        self.txt_promo.pack(fill=tk.BOTH, expand=True, pady=(0, 10))
        
        ttk.Button(right_panel, text="💾 Guardar Promoción", command=self.save_promo_changes).pack(side=tk.RIGHT)

    # -------------------------------------------------------------------------
    # LOGICA CONTACTOS
    # -------------------------------------------------------------------------
    def on_day_selected(self, event):
        self.current_day = self.day_var.get()
        self.search_var.set("") # Limpiar búsqueda
        self.populate_contacts()
        self.clear_editor()

    def on_search_change(self, *args):
        self.populate_contacts()

    def populate_contacts(self):
        self.contact_list.delete(0, tk.END)
        self.filtered_indices = [] # Mapeo de indice visual -> indice real
        
        if not self.current_day: return
        
        contacts = self.data.get("mensajes_por_dia", {}).get(self.current_day, [])
        search_term = self.search_var.get().lower()
        
        for idx, contact in enumerate(contacts):
            number = str(contact[0])
            message = str(contact[1]).lower()
            
            # Filtro
            if search_term in number or search_term in message:
                self.filtered_indices.append(idx)
                # Preview limpio
                preview = contact[1][:30].replace("\n", " ") + "..."
                self.contact_list.insert(tk.END, f"{number} - {preview}")

    def on_contact_selected(self, event):
        selection = self.contact_list.curselection()
        if not selection: return
        
        visual_index = selection[0]
        real_index = self.filtered_indices[visual_index]
        self.current_contact_index = real_index
        
        contact = self.data["mensajes_por_dia"][self.current_day][real_index]
        self.lbl_number.config(text=contact[0])
        self.txt_message.delete("1.0", tk.END)
        self.txt_message.insert("1.0", contact[1])

    def add_contact(self):
        if not self.current_day:
            messagebox.showwarning("Aviso", "Seleccione un día primero.")
            return
            
        new_number = simpledialog.askstring("Nuevo Contacto", "Ingrese el número de teléfono (con código país, ej: 573...):")
        if not new_number: return
        
        # Verificar duplicados
        contacts = self.data["mensajes_por_dia"][self.current_day]
        for c in contacts:
            if c[0] == new_number:
                messagebox.showerror("Error", "Este número ya existe en este día.")
                return
        
        # Agregar
        default_msg = f"Hola, buenas tardes. Le enviamos un cordial saludo desde ALUMAS..."
        self.data["mensajes_por_dia"][self.current_day].append([new_number, default_msg])
        self.save_data() # Guardar automáticamente
        self.populate_contacts()
        messagebox.showinfo("Éxito", "Contacto agregado.")

    def delete_contact(self):
        if self.current_contact_index is None:
            messagebox.showwarning("Aviso", "Seleccione un contacto para eliminar.")
            return
            
        if messagebox.askyesno("Confirmar", "¿Está seguro de eliminar este contacto?"):
            del self.data["mensajes_por_dia"][self.current_day][self.current_contact_index]
            self.save_data()
            self.clear_editor()
            self.populate_contacts()
            messagebox.showinfo("Éxito", "Contacto eliminado.")

    def save_contact_changes(self):
        if self.current_contact_index is None: return
        
        new_msg = self.txt_message.get("1.0", tk.END).strip()
        self.data["mensajes_por_dia"][self.current_day][self.current_contact_index][1] = new_msg
        self.save_data()
        self.populate_contacts()
        messagebox.showinfo("Éxito", "Mensaje actualizado.")

    def clear_editor(self):
        self.lbl_number.config(text="-")
        self.txt_message.delete("1.0", tk.END)
        self.current_contact_index = None

    # -------------------------------------------------------------------------
    # LOGICA PROMOCIONES
    # -------------------------------------------------------------------------
    def on_promo_selected(self, event):
        selection = self.promo_list.curselection()
        if not selection: return
        
        # Indice 0 -> Semana 1
        week_key = str(selection[0] + 1)
        self.current_promo_key = week_key
        
        promo_text = self.data.get("promociones_por_semana", {}).get(week_key, "")
        self.txt_promo.delete("1.0", tk.END)
        self.txt_promo.insert("1.0", promo_text)

    def save_promo_changes(self):
        if not hasattr(self, 'current_promo_key'): return
        
        new_text = self.txt_promo.get("1.0", tk.END).strip()
        self.data["promociones_por_semana"][self.current_promo_key] = new_text
        self.save_data()
        messagebox.showinfo("Éxito", "Promoción actualizada.")


if __name__ == "__main__":
    root = tk.Tk()
    app = EditorMensajesApp(root)
    root.mainloop()
