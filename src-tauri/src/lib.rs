use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Puerto preferido. Si está ocupado por otro programa se prueban los siguientes.
const PUERTO_PREFERIDO: u16 = 8000;
const PUERTOS_ALTERNATIVOS: u16 = 10;

/// Nombres con los que Windows ve el binario del sidecar.
/// - En release: backend_server.exe
/// - En dev: backend_server-x86_64-pc-windows-msvc.exe
/// El `taskkill` por nombre del código original solo cubría el primero, por eso
/// en desarrollo quedaban procesos huérfanos con la webcam y el puerto tomados.
const NOMBRES_SIDECAR: [&str; 2] = [
    "backend_server.exe",
    "backend_server-x86_64-pc-windows-msvc.exe",
];

// ============================================================
// LOG EN ARCHIVO
// ============================================================
fn ruta_log() -> PathBuf {
    static RUTA: OnceLock<PathBuf> = OnceLock::new();
    RUTA.get_or_init(|| {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join("GestorIA").join("logs");
        let _ = std::fs::create_dir_all(&dir);
        dir.join("backend.log")
    })
    .clone()
}

fn inicializar_log() {
    let ruta = ruta_log();
    if let Ok(meta) = std::fs::metadata(&ruta) {
        if meta.len() > 4 * 1024 * 1024 {
            let _ = std::fs::remove_file(&ruta);
        }
    }
    if let Some(dir) = ruta.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    registrar("========== Nueva sesión de GestorIA ==========");
    registrar(&format!("Sistema: {} {}", std::env::consts::OS, std::env::consts::ARCH));
    registrar(&format!("Log: {}", ruta.display()));
}

fn registrar(mensaje: &str) {
    println!("[Rust] {}", mensaje);
    let linea = format!("[{}] {}\n", ahora_ms(), mensaje);
    if let Ok(mut archivo) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(ruta_log())
    {
        let _ = archivo.write_all(linea.as_bytes());
    }
}

fn ahora_ms() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() % 100_000_000)
        .unwrap_or(0)
}

// ============================================================
// LATIDO DE LA INTERFAZ (detección de ventana "muerta")
// ============================================================
static INICIO_APP: OnceLock<Instant> = OnceLock::new();
static ULTIMO_LATIDO_UI: AtomicU64 = AtomicU64::new(0);

fn inicio_app() -> Instant {
    *INICIO_APP.get_or_init(Instant::now)
}

fn ms_desde_inicio() -> u64 {
    inicio_app().elapsed().as_millis() as u64
}

// ============================================================
// PROCESOS (Windows)
// ============================================================
#[cfg(windows)]
fn comando_oculto(programa: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = Command::new(programa);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    cmd
}

/// Igual que `comando_oculto` pero conservando la salida estándar.
/// Necesario para `tasklist`: si stdout va a `null`, la comprobación del PID
/// siempre fallaba y el cierre acababa esperando 4 s al `taskkill` por nombre.
#[cfg(windows)]
fn comando_con_salida(programa: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = Command::new(programa);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    cmd
}

/// Mata el árbol completo de procesos con ese PID.
/// Necesario porque el onefile de PyInstaller son DOS procesos: el bootloader
/// y el proceso Python real. `child.kill()` solo mata al primero.
#[cfg(windows)]
fn matar_arbol_pid(pid: u32) -> bool {
    let estado = comando_oculto("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .status();
    matches!(estado, Ok(s) if s.success())
}

#[cfg(not(windows))]
fn matar_arbol_pid(pid: u32) -> bool {
    let estado = Command::new("kill")
        .args(["-9", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    matches!(estado, Ok(s) if s.success())
}

/// Comprueba que el PID siga siendo nuestro sidecar antes de matarlo.
/// Evita matar un proceso ajeno si Windows reutilizó el PID.
#[cfg(windows)]
fn pid_es_sidecar(pid: u32) -> bool {
    let salida = comando_con_salida("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
        .output();

    match salida {
        Ok(out) => {
            let texto = String::from_utf8_lossy(&out.stdout).to_lowercase();
            NOMBRES_SIDECAR.iter().any(|nombre| texto.contains(&nombre.to_lowercase()))
        }
        Err(_) => false,
    }
}

#[cfg(not(windows))]
fn pid_es_sidecar(_pid: u32) -> bool {
    true
}

/// Elimina cualquier instancia residual del backend (de esta app u otra previa).
fn matar_instancias_residuales() {
    #[cfg(windows)]
    {
        for nombre in NOMBRES_SIDECAR {
            let _ = comando_oculto("taskkill")
                .args(["/F", "/T", "/IM", nombre])
                .status();
        }
    }
    #[cfg(not(windows))]
    {
        for nombre in NOMBRES_SIDECAR {
            let _ = Command::new("pkill")
                .args(["-9", "-f", nombre])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

/// Comprueba en una sola llamada si queda algún proceso del backend vivo.
#[cfg(windows)]
fn hay_procesos_sidecar() -> bool {
    comando_con_salida("tasklist")
        .args(["/FO", "CSV", "/NH"])
        .output()
        .map(|out| {
            let texto = String::from_utf8_lossy(&out.stdout).to_lowercase();
            NOMBRES_SIDECAR.iter().any(|nombre| texto.contains(&nombre.to_lowercase()))
        })
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn hay_procesos_sidecar() -> bool {
    false
}

fn puerto_ocupado(host: &str, puerto: u16) -> bool {
    let addr: SocketAddr = match format!("{}:{}", host, puerto).parse() {
        Ok(addr) => addr,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn esperar_puerto_libre(host: &str, puerto: u16, timeout: Duration) -> bool {
    let limite = Instant::now() + timeout;
    loop {
        if !puerto_ocupado(host, puerto) {
            return true;
        }
        if Instant::now() >= limite {
            return false;
        }
        std::thread::sleep(Duration::from_millis(60));
    }
}

/// Pide al backend un cierre ordenado (`POST /shutdown`) para que suelte la
/// webcam antes de morir. Sin esto Windows mantiene el dispositivo ocupado
/// varios segundos y el siguiente arranque tarda 10-20 s en abrir la cámara.
fn pedir_cierre_ordenado(puerto: u16) -> bool {
    use std::io::{Read, Write};

    let addr: SocketAddr = match format!("127.0.0.1:{}", puerto).parse() {
        Ok(addr) => addr,
        Err(_) => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(300)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(400)));
    let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));

    let peticion = format!(
        "POST /shutdown HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        puerto
    );
    if stream.write_all(peticion.as_bytes()).is_err() {
        return false;
    }

    // La respuesta puede llegar o no (el proceso sale enseguida): basta con
    // que la conexión se haya establecido y la petición se haya enviado.
    let mut buffer = [0u8; 64];
    let _ = stream.read(&mut buffer);
    true
}

/// Devuelve el primer puerto libre a partir de 8000.
fn elegir_puerto(host: &str) -> Option<u16> {
    for offset in 0..=PUERTOS_ALTERNATIVOS {
        let puerto = PUERTO_PREFERIDO.saturating_add(offset);
        if !puerto_ocupado(host, puerto) {
            return Some(puerto);
        }
    }
    None
}

// ============================================================
// ESTADO DEL SIDECAR
// ============================================================
struct SidecarInner {
    child: Option<CommandChild>,
    corriendo: bool,
    pid: Option<u32>,
    puerto: u16,
    ultimo_error: Option<String>,
}

struct SidecarState {
    inner: Arc<Mutex<SidecarInner>>,
    /// Serializa start/stop para que dos invocaciones simultáneas no dupliquen procesos.
    operacion: Arc<Mutex<()>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EstadoSidecar {
    corriendo: bool,
    puerto: u16,
    pid: Option<u32>,
    log: String,
    ultimo_error: Option<String>,
}

impl SidecarInner {
    fn estado(&self) -> EstadoSidecar {
        EstadoSidecar {
            corriendo: self.corriendo,
            puerto: self.puerto,
            pid: self.pid,
            log: ruta_log().to_string_lossy().to_string(),
            ultimo_error: self.ultimo_error.clone(),
        }
    }
}

fn detener_sidecar(inner_state: &Arc<Mutex<SidecarInner>>, operacion: &Arc<Mutex<()>>) {
    let _operacion = match operacion.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };

    let (child, pid, puerto) = {
        let mut inner = match inner_state.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };

        if !inner.corriendo && inner.child.is_none() && inner.pid.is_none() {
            return;
        }

        inner.corriendo = false;
        (inner.child.take(), inner.pid.take(), inner.puerto)
    };

    // 1) Cierre ordenado: el backend suelta la webcam y termina solo.
    //    Es la diferencia entre cerrar en ~0,3 s y cerrar en 4-5 s (y dejar
    //    la cámara ocupada para el siguiente arranque).
    let mut cerrado = false;
    if let Some(pid) = pid {
        if pid_es_sidecar(pid) {
            registrar("Solicitando cierre ordenado del backend (libera la cámara)...");
            let inicio = Instant::now();
            let _ = pedir_cierre_ordenado(puerto);
            while inicio.elapsed() < Duration::from_millis(2500) {
                if !pid_es_sidecar(pid) {
                    cerrado = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(60));
            }
            if cerrado {
                registrar(&format!(
                    "Backend cerrado ordenadamente en {} ms.",
                    inicio.elapsed().as_millis()
                ));
            }
        }
    }

    // 2) Si no respondió, forzar el árbol de procesos.
    if !cerrado {
        if let Some(pid) = pid {
            if pid_es_sidecar(pid) {
                registrar(&format!("Forzando cierre del árbol de procesos (PID {})...", pid));
                matar_arbol_pid(pid);
            }
        }
        if let Some(child) = child {
            // Por si el taskkill anterior falló o el proceso ya no existe.
            let _ = child.kill();
        }
    }

    // 3) Confirmar que el puerto quedó libre; si no, limpieza por nombre.
    if !esperar_puerto_libre("127.0.0.1", puerto, Duration::from_millis(1200)) {
        registrar("El backend no liberó su puerto; limpiando procesos residuales...");
        matar_instancias_residuales();
        let _ = esperar_puerto_libre("127.0.0.1", puerto, Duration::from_millis(1000));
    }

    let mut inner = match inner_state.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    inner.corriendo = false;
    inner.pid = None;
    inner.child = None;

    registrar("Sidecar detenido y cámara liberada.");
}

/// Localiza el ejecutable del sidecar.
///
/// El backend se empaqueta en modo *onedir* (carpeta `backend_server/` con
/// `backend_server.exe` + `_internal/`). Eso elimina los ~3,5 s que el onefile
/// de PyInstaller perdía extrayéndose en cada arranque; a cambio hay que
/// resolver la carpeta en cada tipo de instalación.
fn resolver_ruta_backend(app: &tauri::AppHandle) -> Option<PathBuf> {
    let nombre = if cfg!(windows) {
        "backend_server.exe"
    } else {
        "backend_server"
    };

    let mut candidatos: Vec<PathBuf> = Vec::new();

    // 1. Instalado con bundle (recursos copiados junto a la aplicación).
    if let Ok(dir) = app.path().resource_dir() {
        candidatos.push(dir.join("backend_server").join(nombre));
        candidatos.push(dir.join("bin").join("backend_server").join(nombre));
        candidatos.push(
            dir.join("resources")
                .join("bin")
                .join("backend_server")
                .join(nombre),
        );
    }

    // 2. Compilación portable: la carpeta queda junto a gestoria.exe.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidatos.push(dir.join("backend_server").join(nombre));
            // Compatibilidad con el empaquetado onefile anterior.
            candidatos.push(dir.join(nombre));
        }
    }

    // 3. Desarrollo (`tauri dev`): carpeta dentro de src-tauri.
    candidatos.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("bin")
            .join("backend_server")
            .join(nombre),
    );

    candidatos.into_iter().find(|ruta| ruta.is_file())
}

/// Arranque síncrono. Se ejecuta en un hilo de bloqueo para no congelar la UI.
fn iniciar_bloqueante(
    app: &tauri::AppHandle,
    inner_state: &Arc<Mutex<SidecarInner>>,
    operacion: &Arc<Mutex<()>>,
) -> Result<u16, String> {
    let _operacion = operacion
        .lock()
        .map_err(|_| "No se pudo bloquear el estado del sidecar".to_string())?;

    // ¿Ya está corriendo?
    {
        let inner = inner_state
            .lock()
            .map_err(|_| "Estado del sidecar corrupto".to_string())?;
        if inner.corriendo {
            registrar("El sidecar ya estaba en ejecución. Omitiendo arranque duplicado.");
            return Ok(inner.puerto);
        }
    }

    // 1) Limpieza preventiva de huérfanos (incluye el proceso hijo del onefile).
    //    Solo si hay alguno vivo: lanzar dos `taskkill` siempre costaba ~1 s
    //    de arranque en cada inicio.
    if hay_procesos_sidecar() {
        registrar("Limpiando instancias residuales del backend...");
        matar_instancias_residuales();

        // 2) Esperar a que el puerto quede libre tras la limpieza.
        if !esperar_puerto_libre("127.0.0.1", PUERTO_PREFERIDO, Duration::from_secs(3)) {
            registrar("El puerto 8000 sigue ocupado; se buscará un puerto alternativo.");
        }
    }

    let puerto = elegir_puerto("127.0.0.1").ok_or_else(|| {
        let mensaje = "No hay ningún puerto libre entre 8000 y 8010 para el backend de IA. \
                       Cierra los programas que los estén usando."
            .to_string();
        registrar(&mensaje);
        if let Ok(mut inner) = inner_state.lock() {
            inner.ultimo_error = Some(mensaje.clone());
        }
        mensaje
    })?;

    registrar(&format!("Iniciando sidecar en el puerto {}...", puerto));

    // 3) Lanzar el sidecar.
    let puerto_texto = puerto.to_string();
    let resource_dir = app.path().resource_dir().ok();

    let ruta_backend = resolver_ruta_backend(app).ok_or_else(|| {
        let mensaje = "No se encontró el backend de IA (carpeta backend_server). \
                       Ejecuta 'npm run build:backend' para regenerarlo."
            .to_string();
        registrar(&mensaje);
        if let Ok(mut inner) = inner_state.lock() {
            inner.ultimo_error = Some(mensaje.clone());
        }
        mensaje
    })?;
    registrar(&format!("Sidecar: {}", ruta_backend.display()));

    let mut comando = app
        .shell()
        .command(ruta_backend.to_string_lossy().to_string())
        .args(["--port", puerto_texto.as_str()])
        .env("GESTORIA_PORT", puerto_texto)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8");

    if let Some(dir) = resource_dir {
        comando = comando.env("GESTORIA_RESOURCE_DIR", dir.to_string_lossy().to_string());
    }

    let (mut rx, child) = comando.spawn().map_err(|error| {
        let mensaje = format!("No se pudo iniciar el sidecar de Python: {}", error);
        registrar(&mensaje);
        if let Ok(mut inner) = inner_state.lock() {
            inner.ultimo_error = Some(mensaje.clone());
        }
        mensaje
    })?;

    let pid = child.pid();
    registrar(&format!("Sidecar lanzado (PID {}, puerto {}).", pid, puerto));

    {
        let mut inner = inner_state
            .lock()
            .map_err(|_| "Estado del sidecar corrupto".to_string())?;
        inner.child = Some(child);
        inner.corriendo = true;
        inner.pid = Some(pid);
        inner.puerto = puerto;
        inner.ultimo_error = None;
    }

    // 4) Bomba de logs + detección de salida.
    let inner_clone = Arc::clone(inner_state);
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let texto = String::from_utf8_lossy(&line);
                    registrar(&format!("[stdout] {}", texto.trim_end()));
                }
                CommandEvent::Stderr(line) => {
                    let texto = String::from_utf8_lossy(&line);
                    registrar(&format!("[stderr] {}", texto.trim_end()));
                }
                CommandEvent::Error(error) => {
                    registrar(&format!("[ERROR sidecar] {}", error));
                }
                CommandEvent::Terminated(payload) => {
                    let codigo = payload.code;
                    registrar(&format!("Sidecar terminado (código {:?}).", codigo));

                    if let Ok(mut inner) = inner_clone.lock() {
                        // Solo limpiamos si el proceso terminado es el actual;
                        // si ya se relanzó otro, no tocamos su estado.
                        if inner.pid == Some(pid) {
                            inner.corriendo = false;
                            inner.pid = None;
                            inner.child = None;
                            if codigo.unwrap_or(0) != 0 {
                                inner.ultimo_error = Some(format!(
                                    "El backend de IA se cerró inesperadamente (código {:?}).",
                                    codigo
                                ));
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    });

    Ok(puerto)
}

// ============================================================
// COMANDOS
// ============================================================
#[tauri::command]
async fn start_python_sidecar(
    app: tauri::AppHandle,
    state: State<'_, SidecarState>,
) -> Result<EstadoSidecar, String> {
    let inner = Arc::clone(&state.inner);
    let operacion = Arc::clone(&state.operacion);

    let puerto = {
        let app_clone = app.clone();
        let inner_clone = Arc::clone(&inner);
        let operacion_clone = Arc::clone(&operacion);
        tauri::async_runtime::spawn_blocking(move || {
            iniciar_bloqueante(&app_clone, &inner_clone, &operacion_clone)
        })
        .await
        .map_err(|error| format!("Fallo interno al iniciar el backend: {}", error))??
    };

    // 5) Verificación temprana: el onefile de PyInstaller tarda unos segundos en
    //    extraerse. Esperamos (sin bloquear la UI) hasta 12 s a que abra el puerto.
    let puerto_abierto = tauri::async_runtime::spawn_blocking(move || {
        let limite = Instant::now() + Duration::from_secs(12);
        while Instant::now() < limite {
            if puerto_ocupado("127.0.0.1", puerto) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        false
    })
    .await
    .unwrap_or(false);

    let inner_guard = inner
        .lock()
        .map_err(|_| "Estado del sidecar corrupto".to_string())?;

    if !puerto_abierto && !inner_guard.corriendo {
        let mensaje = inner_guard.ultimo_error.clone().unwrap_or_else(|| {
            "El backend de IA no llegó a iniciar. Revisa el registro.".to_string()
        });
        return Err(mensaje);
    }

    if !puerto_abierto {
        registrar("El sidecar aún no abrió el puerto; el frontend seguirá reintentando.");
    } else {
        registrar("Puerto del sidecar abierto correctamente.");
    }

    Ok(inner_guard.estado())
}

#[tauri::command]
async fn stop_python_sidecar(state: State<'_, SidecarState>) -> Result<EstadoSidecar, String> {
    let inner = Arc::clone(&state.inner);
    let operacion = Arc::clone(&state.operacion);

    tauri::async_runtime::spawn_blocking(move || detener_sidecar(&inner, &operacion))
        .await
        .map_err(|error| format!("Fallo interno al detener el backend: {}", error))?;

    let inner_guard = state
        .inner
        .lock()
        .map_err(|_| "Estado del sidecar corrupto".to_string())?;
    Ok(inner_guard.estado())
}

#[tauri::command]
fn estado_sidecar(state: State<'_, SidecarState>) -> Result<EstadoSidecar, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "Estado del sidecar corrupto".to_string())?;
    Ok(inner.estado())
}

#[tauri::command]
fn abrir_log_sidecar() -> Result<String, String> {
    let ruta = ruta_log();
    if !ruta.exists() {
        return Err("Todavía no se ha creado el registro del backend.".to_string());
    }

    #[cfg(windows)]
    {
        Command::new("notepad.exe")
            .arg(&ruta)
            .spawn()
            .map_err(|e| format!("No se pudo abrir el registro: {}", e))?;
    }
    #[cfg(not(windows))]
    {
        Command::new("xdg-open")
            .arg(&ruta)
            .spawn()
            .map_err(|e| format!("No se pudo abrir el registro: {}", e))?;
    }

    Ok(ruta.to_string_lossy().to_string())
}

/// Deja en el registro una línea del frontend con prefijo `[ui]`.
///
/// Sin esto, cuando la interfaz se queda "muerta" (pantalla en blanco,
/// WebSocket perdido) el log solo muestra un backend perfectamente sano y no
/// hay forma de saber qué pasó del lado de la ventana.
#[tauri::command]
fn registrar_evento(mensaje: String) {
    registrar(&format!("[ui] {}", mensaje));
}

/// Latido periódico del frontend (cada 5 s).
#[tauri::command]
fn latido_ui() {
    ULTIMO_LATIDO_UI.store(ms_desde_inicio(), Ordering::Relaxed);
}

/// Si el WebView se cuelga (pantalla en blanco, render agotado) la aplicación
/// deja de responder mientras el backend sigue perfectamente sano: el usuario
/// percibe que "el programa dejó de funcionar". Detectamos la ausencia de
/// latidos del frontend y recargamos la ventana en lugar de dejarla muerta.
fn vigilar_interfaz(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(5));

        let ahora = ms_desde_inicio();
        if ahora < 45_000 {
            continue; // margen para la primera carga de la ventana
        }

        let silencio = ahora.saturating_sub(ULTIMO_LATIDO_UI.load(Ordering::Relaxed));
        if silencio <= 30_000 {
            continue;
        }

        // Solo recargamos si el motor sigue vivo; si el backend se cayó, la
        // interfaz puede estar reintentando de forma legítima.
        let motor_vivo = app
            .try_state::<SidecarState>()
            .map(|state| {
                state
                    .inner
                    .lock()
                    .map(|inner| inner.corriendo)
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        if !motor_vivo {
            continue;
        }

        registrar(&format!(
            "La interfaz lleva {} s sin responder; recargando la ventana...",
            silencio / 1000
        ));
        ULTIMO_LATIDO_UI.store(ahora, Ordering::Relaxed);
        if let Some(ventana) = app.get_webview_window("main") {
            let _ = ventana.eval("window.location.reload()");
        }
    });
}

// ============================================================
// INSTANCIA ÚNICA (evita dos apps peleando por la webcam)
// ============================================================
#[cfg(windows)]
fn instancia_unica() -> bool {
    use std::iter::once;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;

    let nombre: Vec<u16> = "Local\\GestorIA.SingleInstance"
        .encode_utf16()
        .chain(once(0))
        .collect();

    unsafe {
        // El handle se mantiene abierto durante toda la vida del proceso.
        let handle = CreateMutexW(std::ptr::null(), 0, nombre.as_ptr());
        if handle.is_null() {
            return true;
        }
        GetLastError() != ERROR_ALREADY_EXISTS
    }
}

#[cfg(windows)]
fn avisar_instancia_duplicada() {
    use std::iter::once;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONINFORMATION, MB_OK,
    };

    let texto: Vec<u16> = "GestorIA ya está abierto.\r\n\r\n\
        Cierra la ventana existente antes de abrir otra instancia: dos copias \
        compitiendo por la cámara y el puerto hacen que el motor de IA falle."
        .encode_utf16()
        .chain(once(0))
        .collect();
    let titulo: Vec<u16> = "GestorIA".encode_utf16().chain(once(0)).collect();

    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            texto.as_ptr(),
            titulo.as_ptr(),
            MB_OK | MB_ICONINFORMATION,
        );
    }
}

#[cfg(not(windows))]
fn instancia_unica() -> bool {
    true
}

#[cfg(not(windows))]
fn avisar_instancia_duplicada() {}

// ============================================================
// APP
// ============================================================
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if !instancia_unica() {
        avisar_instancia_duplicada();
        return;
    }

    inicializar_log();

    let app = tauri::Builder::default()
        .manage(SidecarState {
            inner: Arc::new(Mutex::new(SidecarInner {
                child: None,
                corriendo: false,
                pid: None,
                puerto: PUERTO_PREFERIDO,
                ultimo_error: None,
            })),
            operacion: Arc::new(Mutex::new(())),
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // Arranca el motor en paralelo con la carga del WebView. El onefile
            // de PyInstaller tarda ~4 s en extraerse y la cámara otros ~4 s:
            // solaparlo con el arranque de la interfaz ahorra ~1-2 s de espera.
            let handle = app.handle().clone();
            let (inner, operacion) = {
                let state: State<SidecarState> = handle.state();
                (Arc::clone(&state.inner), Arc::clone(&state.operacion))
            };
            std::thread::spawn(move || {
                registrar("Arranque anticipado del motor de IA...");
                match iniciar_bloqueante(&handle, &inner, &operacion) {
                    Ok(puerto) => {
                        registrar(&format!("Motor de IA lanzado en el puerto {}.", puerto))
                    }
                    Err(error) => registrar(&format!("Arranque anticipado fallido: {}", error)),
                }
            });

            vigilar_interfaz(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_python_sidecar,
            stop_python_sidecar,
            estado_sidecar,
            abrir_log_sidecar,
            registrar_evento,
            latido_ui
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                registrar("Ventana cerrada. Liberando cámara y backend...");
                let state: State<SidecarState> = window.state();
                detener_sidecar(&state.inner, &state.operacion);
            }
        })
        .build(tauri::generate_context!())
        .expect("error al construir la aplicación Tauri");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            if let Some(state) = app_handle.try_state::<SidecarState>() {
                detener_sidecar(&state.inner, &state.operacion);
            }
        }
    });
}
