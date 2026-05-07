import json
import logging
import os
import random
import re
import sys
import tkinter as tk
import traceback
from pathlib import Path
from tkinter import ttk, messagebox, scrolledtext, simpledialog
from urllib import error, request

try:
    # PyInstaller no detecta este import dinámico de mysql.connector por sí solo.
    import mysql.connector.locales.eng.client_error  # noqa: F401
except Exception:
    pass

class EditorMensajesApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Editor Avanzado ALUMAS")
        self.root.geometry("1000x700")
        self.days = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado"]
        self.distribution_days = ["lunes", "martes", "miércoles", "jueves", "viernes"]
        
        # Datos
        self.data = {}
        self.current_day = None
        self.current_contact_index = None
        self.json_path = self.get_json_path()
        self.app_dir = os.path.dirname(self.json_path)
        self.debug_log_path = os.path.join(self.app_dir, "editor_mensajes_debug.log")
        self.setup_debug_logging()
        
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

    def setup_debug_logging(self):
        try:
            logging.basicConfig(
                filename=self.debug_log_path,
                level=logging.INFO,
                format="%(asctime)s [%(levelname)s] %(message)s",
                encoding="utf-8",
                force=True,
            )
            logging.info("==== Inicio editor_mensajes ====")
            logging.info("Ruta JSON: %s", self.json_path)
            logging.info("Modo congelado: %s", getattr(sys, "frozen", False))
            logging.info("Python executable: %s", sys.executable)
        except Exception:
            pass

    def log_exception(self, context, exc):
        try:
            logging.error("%s | %s | %r", context, type(exc).__name__, exc)
            logging.error("%s", traceback.format_exc())
        except Exception:
            pass

    def load_data(self):
        """Carga los datos desde el archivo JSON."""
        try:
            with open(self.json_path, 'r', encoding='utf-8') as f:
                self.data = json.load(f)
            self.ensure_day_structure()
        except FileNotFoundError:
            logging.error("No se encontró el JSON en %s", self.json_path)
            messagebox.showerror("Error", f"No se encontró el archivo {self.json_path}")
            sys.exit(1)
        except json.JSONDecodeError as e:
            self.log_exception("Error leyendo JSON", e)
            messagebox.showerror("Error", f"Error al leer el JSON: {e}")
            sys.exit(1)

    def save_data(self, show_success=True):
        """Guarda los cambios en el archivo JSON."""
        try:
            self.ensure_day_structure()
            with open(self.json_path, 'w', encoding='utf-8') as f:
                json.dump(self.data, f, indent=4, ensure_ascii=False)
            if show_success:
                messagebox.showinfo("Éxito", "Cambios guardados correctamente.")
        except Exception as e:
            self.log_exception("Error guardando JSON", e)
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
        self.day_combo = ttk.Combobox(left_panel, textvariable=self.day_var, values=self.days, state="readonly", width=25)
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
        ttk.Button(action_frame, text="🔄 Actualizar Contactos", command=self.update_contacts_from_database).pack(side=tk.LEFT, fill=tk.X, expand=True, padx=2)
        ttk.Button(action_frame, text="❌ Eliminar", command=self.delete_contact).pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(2, 0))
        
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

    def ensure_day_structure(self):
        mensajes = self.data.setdefault("mensajes_por_dia", {})
        for day in self.days:
            mensajes.setdefault(day, [])

    def build_phone_key(self, raw_phone):
        normalized = self.normalize_phone(raw_phone)
        if normalized:
            return normalized

        digits = re.sub(r"\D", "", str(raw_phone or ""))
        return digits or None

    def find_existing_contact_day(self, phone):
        phone_key = self.build_phone_key(phone)
        if not phone_key:
            return None

        for day in self.days:
            for contact in self.data.get("mensajes_por_dia", {}).get(day, []):
                if self.build_phone_key(contact[0]) == phone_key:
                    return day
        return None

    def deduplicate_contacts(self):
        seen = set()
        removed = 0

        for day in self.days:
            unique_contacts = []
            contacts = self.data.get("mensajes_por_dia", {}).get(day, [])
            for contact in contacts:
                if not isinstance(contact, list) or len(contact) < 2:
                    unique_contacts.append(contact)
                    continue

                phone_key = self.build_phone_key(contact[0])
                normalized_phone = self.normalize_phone(contact[0])
                if normalized_phone:
                    contact[0] = normalized_phone

                if phone_key and phone_key in seen:
                    removed += 1
                    continue

                if phone_key:
                    seen.add(phone_key)
                unique_contacts.append(contact)

            self.data["mensajes_por_dia"][day] = unique_contacts

        return removed

    def choose_day_for_new_contact(self):
        counts = {
            day: len(self.data.get("mensajes_por_dia", {}).get(day, []))
            for day in self.distribution_days
        }
        max_count = max(counts.values()) if counts else 0
        weights = [(max_count - counts[day] + 1) for day in self.distribution_days]
        return random.choices(self.distribution_days, weights=weights, k=1)[0]

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
        normalized_number = self.normalize_phone(new_number)
        if not normalized_number:
            messagebox.showerror("Error", "El número no tiene un formato válido. Use 10 dígitos móviles o el formato 573XXXXXXXXX.")
            return
        
        existing_day = self.find_existing_contact_day(normalized_number)
        if existing_day:
            messagebox.showerror("Error", f"Este número ya existe en {existing_day.upper()}.")
            return
        
        # Agregar
        default_msg = self.build_default_message()
        self.data["mensajes_por_dia"][self.current_day].append([normalized_number, default_msg])
        self.save_data(show_success=False) # Guardar automáticamente
        self.populate_contacts()
        messagebox.showinfo("Éxito", "Contacto agregado.")

    def delete_contact(self):
        if self.current_contact_index is None:
            messagebox.showwarning("Aviso", "Seleccione un contacto para eliminar.")
            return
            
        if messagebox.askyesno("Confirmar", "¿Está seguro de eliminar este contacto?"):
            del self.data["mensajes_por_dia"][self.current_day][self.current_contact_index]
            self.save_data(show_success=False)
            self.clear_editor()
            self.populate_contacts()
            messagebox.showinfo("Éxito", "Contacto eliminado.")

    def save_contact_changes(self):
        if self.current_contact_index is None: return
        
        new_msg = self.txt_message.get("1.0", tk.END).strip()
        self.data["mensajes_por_dia"][self.current_day][self.current_contact_index][1] = new_msg
        self.save_data(show_success=False)
        self.populate_contacts()
        messagebox.showinfo("Éxito", "Mensaje actualizado.")

    def clear_editor(self):
        self.lbl_number.config(text="-")
        self.txt_message.delete("1.0", tk.END)
        self.current_contact_index = None

    def build_default_message(self, nombre=""):
        saludo = f"{nombre.strip()}, " if nombre and str(nombre).strip() else ""
        return (
            f"{saludo}muy buenas tardes. Le enviamos un cordial saludo desde ALUMAS. "
            "Solo queríamos recordarle que estamos a su disposición para lo que necesite. "
            "Si requiere algún producto o mercancía, no dude en escribirnos. "
            "¡Con mucho gusto le atendemos! Dios le bendiga siempre."
        )

    def normalize_phone(self, raw_phone):
        digits = re.sub(r"\D", "", str(raw_phone or ""))
        digits = digits.lstrip("0")

        if len(digits) == 10 and digits.startswith("3"):
            digits = f"57{digits}"

        if len(digits) == 12 and digits.startswith("57") and digits[2] == "3":
            return digits

        return None

    def parse_env_file(self, env_path):
        config = {}
        try:
            with open(env_path, "r", encoding="utf-8") as env_file:
                for raw_line in env_file:
                    line = raw_line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    if line.startswith("export "):
                        line = line[7:].strip()
                    key, value = line.split("=", 1)
                    config[key.strip()] = value.strip().strip('"').strip("'")
        except OSError:
            logging.warning("No se pudo leer .env: %s", env_path)
            return {}
        return config

    def get_candidate_env_paths(self):
        home = Path.home()
        candidates = [
            Path(os.path.dirname(os.path.abspath(__file__))) / ".env",
            home / "OneDrive" / "Documentos" / "GitHub" / "ALUMAS" / ".env",
            home / "OneDrive" / "Documents" / "GitHub" / "ALUMAS" / ".env",
            home / "Documents" / "GitHub" / "ALUMAS" / ".env",
            home / "Downloads" / "sistetema_contable" / "sistetema_contable" / ".env",
        ]

        if getattr(sys, "frozen", False):
            candidates.insert(0, Path(sys.executable).resolve().parent / ".env")

        unique_candidates = []
        seen = set()
        for candidate in candidates:
            candidate_str = str(candidate)
            if candidate_str not in seen:
                unique_candidates.append(candidate)
                seen.add(candidate_str)
        return unique_candidates

    def get_candidate_connection_modules(self):
        home = Path.home()
        candidates = [
            home / "Downloads" / "sistetema_contable" / "sistetema_contable" / "conexion.py",
            home / "OneDrive" / "Documentos" / "GitHub" / "ALUMAS" / "conexion.py",
            home / "Documents" / "GitHub" / "ALUMAS" / "conexion.py",
        ]

        unique_candidates = []
        seen = set()
        for candidate in candidates:
            candidate_str = str(candidate)
            if candidate_str not in seen:
                unique_candidates.append(candidate)
                seen.add(candidate_str)
        return unique_candidates

    def get_external_db_config(self):
        keys = ["DB_HOST", "DB_USER", "DB_PASS", "DB_NAME", "DB_PORT"]

        for module_path in self.get_candidate_connection_modules():
            env_path = module_path.with_name(".env")
            if not env_path.exists():
                continue

            file_config = self.parse_env_file(env_path)
            if all(file_config.get(key) for key in keys):
                logging.info("Usando respaldo DB desde .env externo: %s", env_path)
                return {key: file_config.get(key, "") for key in keys}, env_path

        raise RuntimeError("No se encontró un archivo .env válido para usar como respaldo de la base de datos.")

    def get_db_config(self):
        keys = ["DB_HOST", "DB_USER", "DB_PASS", "DB_NAME", "DB_PORT"]
        config = {key: os.getenv(key, "") for key in keys}

        if all(config.values()):
            logging.info("Usando configuración DB desde variables de entorno del proceso.")
            return config

        for env_path in self.get_candidate_env_paths():
            if env_path.exists():
                file_config = self.parse_env_file(env_path)
                merged = {key: file_config.get(key) or config.get(key, "") for key in keys}
                if all(merged.values()):
                    logging.info("Usando configuración DB desde .env: %s", env_path)
                    return merged

        missing = [key for key, value in config.items() if not value]
        raise RuntimeError(
            "No se encontró la configuración de base de datos. "
            f"Faltan estas variables: {', '.join(missing)}"
        )

    def fetch_contacts_from_api(self):
        api_urls = []
        api_from_env = os.getenv("ALUMAS_API_URL", "").strip()
        if api_from_env:
            api_urls.append(api_from_env.rstrip("/"))
        api_urls.append("http://localhost:8080")

        tried = set()
        last_error = None

        for base_url in api_urls:
            if not base_url or base_url in tried:
                continue
            tried.add(base_url)

            url = f"{base_url}/api/clientes-mayoristas-contactos"
            try:
                logging.info("Probando API de contactos: %s", url)
                with request.urlopen(url, timeout=8) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                if payload.get("ok"):
                    logging.info("API respondió correctamente desde %s con %s registros", base_url, len(payload.get("clientes", [])))
                    return payload.get("clientes", []), f"API {base_url}"
                last_error = payload.get("error", "Respuesta inválida del servidor")
            except (error.URLError, error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
                self.log_exception(f"Fallo API {url}", exc)
                last_error = str(exc)

        raise RuntimeError(last_error or "No fue posible consultar la API local.")

    def fetch_contacts_from_database(self):
        try:
            import mysql.connector
        except ImportError as exc:
            self.log_exception("ImportError mysql.connector", exc)
            raise RuntimeError(
                "No está instalado mysql-connector-python para consultar la base de datos directamente."
            ) from exc

        config = self.get_db_config()
        connection = None
        cursor = None

        try:
            try:
                logging.info("Intentando conexión directa a base de datos.")
                connection = mysql.connector.connect(**self.build_mysql_connect_kwargs(config))
                source = "conexión directa"
            except Exception:
                logging.warning("Falló la conexión directa. Probando respaldo.")
                external_config, env_path = self.get_external_db_config()
                connection = mysql.connector.connect(**self.build_mysql_connect_kwargs(external_config))
                source = f"respaldo {env_path.name}"

            cursor = connection.cursor(dictionary=True)
            cursor.execute(
                """
                SELECT nombre, telefono, tipo_cliente
                FROM clientes
                WHERE LOWER(COALESCE(tipo_cliente, '')) LIKE '%mayor%'
                  AND TRIM(COALESCE(telefono, '')) <> ''
                ORDER BY nombre
                """
            )
            rows = cursor.fetchall()
            logging.info("Consulta DB correcta desde %s con %s registros", source, len(rows))
            return rows, source
        finally:
            if cursor is not None:
                cursor.close()
            if connection is not None and connection.is_connected():
                connection.close()

    def build_mysql_connect_kwargs(self, config):
        return {
            "host": str(config["DB_HOST"]).strip(),
            "user": str(config["DB_USER"]).strip(),
            "password": str(config["DB_PASS"]),
            "database": str(config["DB_NAME"]).strip(),
            "port": int(str(config["DB_PORT"]).strip()),
            "connection_timeout": 8,
            "use_pure": True,
            "charset": "utf8mb4",
        }

    def update_contacts_from_database(self):
        if not messagebox.askyesno(
            "Actualizar contactos",
            "Se consultarán los clientes mayoristas y se actualizará el programa completo.\n\n"
            "Los contactos nuevos se repartirán entre lunes y viernes, con más probabilidad en los días con menos contactos.\n"
            "Además, se omitirán números ya existentes en cualquier día. ¿Desea continuar?"
        ):
            logging.info("Actualización cancelada por el usuario.")
            return

        try:
            logging.info("Iniciando actualización de contactos.")
            try:
                rows, source = self.fetch_contacts_from_api()
            except Exception:
                rows, source = self.fetch_contacts_from_database()
        except Exception as exc:
            self.log_exception("Fallo actualización de contactos", exc)
            messagebox.showerror(
                "Error",
                f"No fue posible actualizar los contactos:\n{exc}\n\nRevise el log:\n{self.debug_log_path}"
            )
            return

        removed_duplicates = self.deduplicate_contacts()
        existing_numbers = set()
        for day in self.days:
            for contact in self.data.get("mensajes_por_dia", {}).get(day, []):
                phone_key = self.build_phone_key(contact[0])
                if phone_key:
                    existing_numbers.add(phone_key)

        added = 0
        duplicates = 0
        invalid_numbers = 0
        added_by_day = {day: 0 for day in self.distribution_days}

        for row in rows:
            phone = self.normalize_phone(row.get("telefono"))
            phone_key = self.build_phone_key(row.get("telefono"))
            if not phone or not phone_key:
                invalid_numbers += 1
                continue

            if phone_key in existing_numbers:
                duplicates += 1
                continue

            target_day = self.choose_day_for_new_contact()
            self.data["mensajes_por_dia"][target_day].append([phone, self.build_default_message(row.get("nombre", ""))])
            existing_numbers.add(phone_key)
            added_by_day[target_day] += 1
            added += 1

        if added or removed_duplicates:
            self.save_data(show_success=False)
        if self.current_day:
            self.populate_contacts()

        logging.info(
            "Actualización completada | origen=%s agregados=%s duplicados=%s invalidos=%s eliminados=%s",
            source, added, duplicates, invalid_numbers, removed_duplicates
        )
        day_summary = "\n".join(
            f"{day.capitalize()}: {count}"
            for day, count in added_by_day.items()
            if count > 0
        ) or "No se agregaron contactos nuevos."
        messagebox.showinfo(
            "Actualización completada",
            f"Origen: {source}\n"
            f"Distribución: lunes a viernes\n\n"
            f"Agregados: {added}\n"
            f"Duplicados omitidos: {duplicates}\n"
            f"Números inválidos o vacíos: {invalid_numbers}\n"
            f"Duplicados antiguos eliminados: {removed_duplicates}\n\n"
            f"Reparto por día:\n{day_summary}"
        )

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
        self.save_data(show_success=False)
        messagebox.showinfo("Éxito", "Promoción actualizada.")


if __name__ == "__main__":
    try:
        root = tk.Tk()
        app = EditorMensajesApp(root)
        root.mainloop()
    except Exception as e:
        try:
            fallback_dir = os.path.dirname(sys.executable) if getattr(sys, "frozen", False) else os.path.dirname(os.path.abspath(__file__))
            fallback_log = os.path.join(fallback_dir, "editor_mensajes_debug.log")
            logging.basicConfig(
                filename=fallback_log,
                level=logging.INFO,
                format="%(asctime)s [%(levelname)s] %(message)s",
                encoding="utf-8",
                force=True,
            )
            logging.error("Fallo fatal iniciando editor | %s | %r", type(e).__name__, e)
            logging.error("%s", traceback.format_exc())
        except Exception:
            pass
        messagebox.showerror("Error Fatal", f"Ocurrió un error inesperado:\n{e}")
