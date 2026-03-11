from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import RedirectResponse, FileResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr
import pyodbc

from app.settings import COOKIE_NAME
from app.auth import (
    sign_session,
    verify_session,
    validate_session_live,
    generate_pin,
    create_pin,
    verify_pin,
    get_codigo_cliente_by_email,
    is_admin_session,
)
from app.db import get_conn
from app.email_sender import send_pin_email, send_alert_email

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

# ═══════════════════════════════════════
# PÁGINA DE MANTENIMIENTO
# ═══════════════════════════════════════
MAINTENANCE_HTML = """<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Portal CGM · Mantenimiento</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#f4f6f4;font-family:system-ui,sans-serif;display:flex;
         align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .card{background:#fff;border-radius:16px;padding:48px 40px;max-width:480px;
          width:100%;text-align:center;box-shadow:0 4px 24px rgba(12,83,76,.1)}
    .icon{font-size:48px;margin-bottom:20px}
    h1{font-size:22px;color:#0c534c;margin-bottom:12px}
    p{font-size:14px;color:#6b7280;line-height:1.6}
    .btn{margin-top:28px;display:inline-block;padding:12px 28px;background:#0c534c;
         color:#fff;border-radius:8px;font-size:14px;font-weight:600;
         text-decoration:none;cursor:pointer}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🔧</div>
    <h1>Portal en mantenimiento</h1>
    <p>Estamos realizando tareas de mantenimiento.<br>
       El servicio estará disponible nuevamente en breve.</p>
    <a class="btn" href="/">Reintentar</a>
  </div>
</body>
</html>"""

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Captura errores SQL y otros críticos → página amigable o JSON."""
    if isinstance(exc, (pyodbc.Error, pyodbc.OperationalError, RuntimeError)):
        if request.url.path.startswith("/api/"):
            return JSONResponse({"ok": False, "detail": "Error de base de datos"}, status_code=503)
        return HTMLResponse(content=MAINTENANCE_HTML, status_code=503)
    if request.url.path.startswith("/api/"):
        return JSONResponse({"ok": False, "detail": "Error interno del servidor"}, status_code=500)
    return HTMLResponse(content=MAINTENANCE_HTML, status_code=503)

class SolicitarPinRequest(BaseModel):
    email: str

class VerificarPinRequest(BaseModel):
    email: str
    pin:   str

def require_session(request: Request) -> str:
    cookie = request.cookies.get(COOKIE_NAME)
    if not cookie:
        raise HTTPException(status_code=401, detail="No session")
    parsed = verify_session(cookie)
    if not parsed:
        raise HTTPException(status_code=401, detail="Invalid session")
    codigo_cliente, _iat = parsed
    if not validate_session_live(codigo_cliente):
        raise HTTPException(status_code=401, detail="Session not allowed")
    return codigo_cliente

def _deny(resp: JSONResponse) -> JSONResponse:
    resp.delete_cookie(COOKIE_NAME, path="/", samesite="lax")
    return resp

# ═══════════════════════════════════════
# ROUTES
# ═══════════════════════════════════════
@app.get("/")
def root():
    return RedirectResponse(url="/portal", status_code=302)

@app.get("/portal")
def portal_home():
    return FileResponse("static/index.html")

@app.get("/acceso-denegado")
def acceso_denegado():
    return FileResponse("static/index.html")

# ═══════════════════════════════════════
# AUTH
# ═══════════════════════════════════════
@app.post("/api/auth/solicitar-pin")
async def solicitar_pin(body: SolicitarPinRequest, request: Request):
    email = body.email.strip().lower()
    codigo_cliente = get_codigo_cliente_by_email(email)
    if not codigo_cliente:
        raise HTTPException(status_code=403, detail="Correo no registrado o sin acceso activo.")
    pin = generate_pin()
    ip  = request.client.host if request.client else None
    create_pin(codigo_cliente, pin, ip)
    try:
        send_pin_email(email, pin)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error al enviar el correo: {e}")
    return {"ok": True, "message": "Código enviado. Revisa tu bandeja de entrada."}

@app.post("/api/auth/verificar-pin")
async def verificar_pin_endpoint(body: VerificarPinRequest, response: JSONResponse):
    email = body.email.strip().lower()
    pin   = body.pin.strip()
    codigo_cliente = get_codigo_cliente_by_email(email)
    if not codigo_cliente:
        raise HTTPException(status_code=403, detail="Acceso no disponible.")
    ok, msg = verify_pin(codigo_cliente, pin)
    if not ok:
        raise HTTPException(status_code=401, detail=msg)
    cookie_val = sign_session(codigo_cliente)
    resp = JSONResponse({"ok": True})
    resp.set_cookie(
        key=COOKIE_NAME, value=cookie_val,
        httponly=True, secure=False, samesite="lax", path="/",
    )
    return resp

# ═══════════════════════════════════════
# APIS PROTEGIDAS
# ═══════════════════════════════════════
@app.get("/api/me")
def api_me(request: Request):
    try:
        codigo_cliente = require_session(request)
    except HTTPException:
        return _deny(JSONResponse({"ok": False, "reason": "DENIED"}, status_code=401))

    # Admin: respuesta especial sin consultar WEB_JD_CLIENTES
    if is_admin_session(codigo_cliente):
        return {
            "ok": True,
            "codigo_cliente":      "ADMIN",
            "descripcion_cliente": "Administrador — Vista global",
            "is_admin":            True,
        }

    sql = "SELECT TOP 1 CODIGO_CLIENTE, DESCRIPCION_CLIENTE FROM dbo.WEB_JD_CLIENTES WHERE CODIGO_CLIENTE = ?"
    with get_conn() as conn:
        cur = conn.cursor()
        row = cur.execute(sql, codigo_cliente).fetchone()
    return {
        "ok": True,
        "codigo_cliente":      row[0] if row else codigo_cliente,
        "descripcion_cliente": (row[1] if row else "") or "",
        "is_admin":            False,
    }

@app.get("/api/equipos")
def api_equipos(request: Request):
    try:
        codigo_cliente = require_session(request)
    except HTTPException:
        return _deny(JSONResponse({"ok": False, "reason": "DENIED"}, status_code=401))

    # Admin: ve todos los equipos de todos los clientes
    if is_admin_session(codigo_cliente):
        sql = """
        SELECT EC.EQUIPO, EC.DESCRIPCION, EC.FABRICANTE_EQUIPO,
               EC.DESCRIPCION_PAIS_FABRICACION,
               EC.CODIGO_PROYECTO, EC.DESCRIPCION_PROYECTO,
               EC.CODIGO_CLIENTE,
               ISNULL(C.DESCRIPCION_CLIENTE, EC.CODIGO_CLIENTE) AS DESCRIPCION_CLIENTE
        FROM dbo.WEB_JD_EQUIPO_CLIENTE EC
        LEFT JOIN dbo.WEB_JD_CLIENTES C
               ON C.CODIGO_CLIENTE = EC.CODIGO_CLIENTE
        ORDER BY C.DESCRIPCION_CLIENTE, EC.EQUIPO
        """
        with get_conn() as conn:
            rows = conn.cursor().execute(sql).fetchall()
        items = [
            {
                "equipo":               r[0],
                "descripcion":          r[1],
                "fabricante":           r[2],
                "pais":                 r[3],
                "codigo_proyecto":      r[4],
                "descripcion_proyecto": r[5],
                "codigo_cliente":       r[6],
                "descripcion_cliente":  r[7],
            }
            for r in rows
        ]
        return {"ok": True, "items": items}

    # Normal: solo sus equipos
    sql = """
    SELECT EQUIPO, DESCRIPCION, FABRICANTE_EQUIPO, DESCRIPCION_PAIS_FABRICACION,
           CODIGO_PROYECTO, DESCRIPCION_PROYECTO
    FROM dbo.WEB_JD_EQUIPO_CLIENTE
    WHERE CODIGO_CLIENTE = ?
    ORDER BY EQUIPO
    """
    with get_conn() as conn:
        cur = conn.cursor()
        rows = cur.execute(sql, codigo_cliente).fetchall()
    items = [
        {
            "equipo":               r[0],
            "descripcion":          r[1],
            "fabricante":           r[2],
            "pais":                 r[3],
            "codigo_proyecto":      r[4],
            "descripcion_proyecto": r[5],
        }
        for r in rows
    ]
    return {"ok": True, "items": items}

# ═══════════════════════════════════════
# TELEMETRÍA — NUEVO
# ═══════════════════════════════════════
@app.get("/api/telemetria")
def api_telemetria(request: Request):
    """Devuelve telemetría del mes ACTUAL para todos los equipos del cliente."""
    try:
        codigo_cliente = require_session(request)
    except HTTPException:
        return _deny(JSONResponse({"ok": False, "reason": "DENIED"}, status_code=401))

    sql = """
    SELECT
        T.EQUIPO,
        T.FECHA_INICIO,
        T.FECHA_FIN,
        T.HOROMETRO_TOTAL,
        T.HORAS_ON,
        T.HORAS_OFF,
        T.HORAS_RALENTI,
        T.HORAS_CARGA_BAJA,
        T.HORAS_CARGA_MEDIA,
        T.HORAS_CARGA_ALTA,
        T.PCT_UTILIZACION,
        T.PCT_RALENTI,
        T.PCT_TRABAJO_EFECTIVO,
        T.GPS_LAT,
        T.GPS_LON,
        T.GPS_FECHA,
        T.ENGINE_STATE_ACTUAL,
        T.FECHA_SYNC,
        T.SYNC_OK,
        EC.DESCRIPCION,
        EC.DESCRIPCION_PROYECTO,
        T.FUEL_REMAINING_PCT,
        T.FUEL_CONSUMED_MES,
        T.FUEL_LITROS_X_HORA,
        T.CODIGO_CLIENTE,
        ISNULL(C.DESCRIPCION_CLIENTE, T.CODIGO_CLIENTE) AS DESCRIPCION_CLIENTE
    FROM dbo.WEB_JD_TELEMETRIA T
    INNER JOIN dbo.WEB_JD_EQUIPO_CLIENTE EC
        ON EC.EQUIPO = T.EQUIPO
        AND EC.CODIGO_CLIENTE = T.CODIGO_CLIENTE
    LEFT JOIN dbo.WEB_JD_CLIENTES C
        ON C.CODIGO_CLIENTE = T.CODIGO_CLIENTE
    """

    with get_conn() as conn:
        # Admin: toda la flota sin filtro
        if is_admin_session(codigo_cliente):
            rows = conn.cursor().execute(sql + " ORDER BY T.EQUIPO").fetchall()
        else:
            rows = conn.cursor().execute(
                sql + " WHERE T.CODIGO_CLIENTE = ? ORDER BY T.EQUIPO", codigo_cliente
            ).fetchall()

    if not rows:
        return {"ok": True, "items": [], "kpis": _kpis_vacios()}

    items = []
    for r in rows:
        items.append({
            "equipo":               r[0],
            "fecha_inicio":         str(r[1]) if r[1] else None,
            "fecha_fin":            str(r[2]) if r[2] else None,
            "horometro_total":      float(r[3]) if r[3] is not None else None,
            "horas_on":             float(r[4]) if r[4] is not None else None,
            "horas_off":            float(r[5]) if r[5] is not None else None,
            "horas_ralenti":        float(r[6]) if r[6] is not None else None,
            "horas_carga_baja":     float(r[7]) if r[7] is not None else None,
            "horas_carga_media":    float(r[8]) if r[8] is not None else None,
            "horas_carga_alta":     float(r[9]) if r[9] is not None else None,
            "pct_utilizacion":      float(r[10]) if r[10] is not None else None,
            "pct_ralenti":          float(r[11]) if r[11] is not None else None,
            "pct_trabajo_efectivo": float(r[12]) if r[12] is not None else None,
            "gps_lat":              float(r[13]) if r[13] is not None else None,
            "gps_lon":              float(r[14]) if r[14] is not None else None,
            "gps_fecha":            str(r[15]) if r[15] else None,
            "engine_state":         r[16],
            "fecha_sync":           str(r[17]) if r[17] else None,
            "sync_ok":              bool(r[18]),
            "descripcion":          r[19],
            "descripcion_proyecto": r[20],
            "fuel_remaining_pct":   float(r[21]) if r[21] is not None else None,
            "fuel_consumed_mes":    float(r[22]) if r[22] is not None else None,
            "fuel_litros_x_hora":   float(r[23]) if r[23] is not None else None,
            "codigo_cliente":       r[24],
            "descripcion_cliente":  r[25],
        })

    con_datos = [x for x in items if x["sync_ok"] and x["horas_on"] is not None]
    total_on  = sum(x["horas_on"] or 0 for x in con_datos)
    total_off = sum(x["horas_off"] or 0 for x in con_datos)
    total_hrs = total_on + total_off
    pct_flota = round(total_on / total_hrs * 100, 1) if total_hrs > 0 else 0

    mas_utilizada = max(con_datos, key=lambda x: x["pct_utilizacion"] or 0, default=None)
    mas_ralenti   = max(con_datos, key=lambda x: x["pct_ralenti"] or 0, default=None)

    kpis = {
        "total_equipos":         len(items),
        "equipos_con_datos":     len(con_datos),
        "total_horas_on":        round(total_on, 1),
        "pct_utilizacion_flota": pct_flota,
        "mas_utilizada":         mas_utilizada["equipo"] if mas_utilizada else "—",
        "mas_utilizada_pct":     mas_utilizada["pct_utilizacion"] if mas_utilizada else 0,
        "mas_ralenti":           mas_ralenti["equipo"] if mas_ralenti else "—",
        "mas_ralenti_pct":       mas_ralenti["pct_ralenti"] if mas_ralenti else 0,
    }

    return {"ok": True, "items": items, "kpis": kpis}


@app.get("/api/telemetria/{equipo}")
def api_telemetria_equipo(equipo: str, request: Request):
    """Telemetría detallada del mes actual de un equipo específico."""
    try:
        codigo_cliente = require_session(request)
    except HTTPException:
        return _deny(JSONResponse({"ok": False, "reason": "DENIED"}, status_code=401))

    sql_base = """
    SELECT
        T.EQUIPO, T.FECHA_INICIO, T.FECHA_FIN,
        T.HOROMETRO_TOTAL, T.HOROMETRO_FECHA,
        T.HORAS_ON, T.HORAS_OFF,
        T.HORAS_RALENTI, T.HORAS_CARGA_BAJA, T.HORAS_CARGA_MEDIA,
        T.HORAS_CARGA_ALTA, T.HORAS_KEY_ON,
        T.PCT_UTILIZACION, T.PCT_RALENTI, T.PCT_TRABAJO_EFECTIVO,
        T.GPS_LAT, T.GPS_LON, T.GPS_FECHA, T.ENGINE_STATE_ACTUAL,
        T.FECHA_SYNC, T.SYNC_OK, T.ERROR_MSG,
        EC.DESCRIPCION, EC.DESCRIPCION_PROYECTO, EC.FABRICANTE_EQUIPO,
        EC.DESCRIPCION_PAIS_FABRICACION,
        T.FUEL_REMAINING_PCT, T.FUEL_CONSUMED_MES, T.FUEL_LITROS_X_HORA
    FROM dbo.WEB_JD_TELEMETRIA T
    INNER JOIN dbo.WEB_JD_EQUIPO_CLIENTE EC
        ON EC.EQUIPO = T.EQUIPO AND EC.CODIGO_CLIENTE = T.CODIGO_CLIENTE
    """

    with get_conn() as conn:
        # Admin: busca el equipo en cualquier cliente
        if is_admin_session(codigo_cliente):
            row = conn.cursor().execute(
                sql_base + " WHERE T.EQUIPO = ?", equipo
            ).fetchone()
        else:
            row = conn.cursor().execute(
                sql_base + " WHERE T.CODIGO_CLIENTE = ? AND T.EQUIPO = ?",
                codigo_cliente, equipo
            ).fetchone()

    if not row:
        return {"ok": False, "detail": "Equipo no encontrado o sin datos"}

    return {
        "ok":                   True,
        "equipo":               row[0],
        "fecha_inicio":         str(row[1]) if row[1] else None,
        "fecha_fin":            str(row[2]) if row[2] else None,
        "horometro_total":      float(row[3]) if row[3] is not None else None,
        "horometro_fecha":      str(row[4]) if row[4] else None,
        "horas_on":             float(row[5]) if row[5] is not None else None,
        "horas_off":            float(row[6]) if row[6] is not None else None,
        "horas_ralenti":        float(row[7]) if row[7] is not None else None,
        "horas_carga_baja":     float(row[8]) if row[8] is not None else None,
        "horas_carga_media":    float(row[9]) if row[9] is not None else None,
        "horas_carga_alta":     float(row[10]) if row[10] is not None else None,
        "horas_key_on":         float(row[11]) if row[11] is not None else None,
        "pct_utilizacion":      float(row[12]) if row[12] is not None else None,
        "pct_ralenti":          float(row[13]) if row[13] is not None else None,
        "pct_trabajo_efectivo": float(row[14]) if row[14] is not None else None,
        "gps_lat":              float(row[15]) if row[15] is not None else None,
        "gps_lon":              float(row[16]) if row[16] is not None else None,
        "gps_fecha":            str(row[17]) if row[17] else None,
        "engine_state":         row[18],
        "fecha_sync":           str(row[19]) if row[19] else None,
        "sync_ok":              bool(row[20]),
        "error_msg":            row[21],
        "descripcion":          row[22],
        "descripcion_proyecto": row[23],
        "fabricante":           row[24],
        "pais":                 row[25],
        "fuel_remaining_pct":   float(row[26]) if row[26] is not None else None,
        "fuel_consumed_mes":    float(row[27]) if row[27] is not None else None,
        "fuel_litros_x_hora":   float(row[28]) if row[28] is not None else None,
    }


def _kpis_vacios():
    return {
        "total_equipos": 0, "equipos_con_datos": 0,
        "total_horas_on": 0, "pct_utilizacion_flota": 0,
        "mas_utilizada": "—", "mas_utilizada_pct": 0,
        "mas_ralenti": "—", "mas_ralenti_pct": 0,
    }

def _flt(v):
    return float(v) if v is not None else None

# Helper: verifica ownership de equipo (omitido para admins)
def _check_equipo(conn, codigo_cliente: str, equipo: str) -> bool:
    """Retorna True si el equipo pertenece al cliente, o si es admin."""
    if is_admin_session(codigo_cliente):
        return True
    check = "SELECT 1 FROM dbo.WEB_JD_EQUIPO_CLIENTE WHERE CODIGO_CLIENTE=? AND EQUIPO=?"
    return bool(conn.cursor().execute(check, codigo_cliente, equipo).fetchone())

# ═══════════════════════════════════════
# HISTÓRICO POR EQUIPO
# ═══════════════════════════════════════
@app.get("/api/hist/{equipo}")
def api_hist_equipo(equipo: str, request: Request):
    """Histórico mensual del equipo — últimos 6 meses desde WEB_JD_TELEMETRIA_HIST."""
    try:
        codigo_cliente = require_session(request)
    except HTTPException:
        return _deny(JSONResponse({"ok": False, "reason": "DENIED"}, status_code=401))

    with get_conn() as conn:
        if not _check_equipo(conn, codigo_cliente, equipo):
            return JSONResponse({"ok": False, "detail": "Equipo no encontrado"}, status_code=404)

        sql = """
        SELECT
            ANIO, MES,
            SUM(HORAS_MOTOR_DIA)          AS HORAS_MOTOR,
            SUM(HORAS_RALENTI_DIA)        AS HORAS_RALENTI,
            SUM(HORAS_UTIL_DIA)           AS HORAS_UTIL,
            SUM(HORAS_CARGA_BAJA_DIA)     AS HORAS_BAJA,
            SUM(HORAS_CARGA_MEDIA_DIA)    AS HORAS_MEDIA,
            SUM(HORAS_CARGA_ALTA_DIA)     AS HORAS_ALTA,
            AVG(PCT_UTILIZACION_DIA)      AS PCT_UTIL,
            AVG(PCT_RALENTI_DIA)          AS PCT_RALENTI,
            AVG(PCT_TRABAJO_EFECTIVO_DIA) AS PCT_TRABAJO,
            MAX(HOROMETRO_TOTAL)          AS HOROMETRO,
            COUNT(*)                      AS DIAS_DATA
        FROM dbo.WEB_JD_TELEMETRIA_HIST
        WHERE EQUIPO = ?
          AND SYNC_OK = 1
          AND FECHA >= DATEADD(MONTH, -6, GETUTCDATE())
        GROUP BY ANIO, MES
        ORDER BY ANIO DESC, MES DESC
        """
        rows = conn.cursor().execute(sql, equipo).fetchall()

    MESES = ["","Ene","Feb","Mar","Abr","May","Jun",
             "Jul","Ago","Sep","Oct","Nov","Dic"]
    items = []
    for r in rows:
        anio, mes = r[0], r[1]
        items.append({
            "anio":          anio,
            "mes":           mes,
            "label":         f"{MESES[mes]} {anio}",
            "horas_motor":   _flt(r[2]),
            "horas_ralenti": _flt(r[3]),
            "horas_util":    _flt(r[4]),
            "horas_baja":    _flt(r[5]),
            "horas_media":   _flt(r[6]),
            "horas_alta":    _flt(r[7]),
            "pct_util":      _flt(r[8]),
            "pct_ralenti":   _flt(r[9]),
            "pct_trabajo":   _flt(r[10]),
            "fuel_total":    None,
            "fuel_lxh":      None,
            "fuel_pct":      None,
            "horometro":     _flt(r[11]),
            "dias_data":     r[12],
        })

    return {"ok": True, "equipo": equipo, "meses": items}

# ═══════════════════════════════════════
# HISTORIAL DIARIO — horas por día del mes
# GET /api/equipo/{equipo}/diario?mes=2026-03
# ═══════════════════════════════════════
@app.get("/api/equipo/{equipo}/diario")
def api_diario(equipo: str, request: Request, mes: str = None):
    """
    Devuelve horas por día para un mes dado.
    mes = 'YYYY-MM' (default: mes actual)
    """
    try:
        codigo_cliente = require_session(request)
    except HTTPException:
        return _deny(JSONResponse({"ok": False, "reason": "DENIED"}, status_code=401))

    with get_conn() as conn:
        if not _check_equipo(conn, codigo_cliente, equipo):
            return JSONResponse({"ok": False, "detail": "Equipo no encontrado"}, status_code=404)

    from datetime import date
    if mes:
        try:
            anio, mes_n = int(mes[:4]), int(mes[5:7])
        except Exception:
            return JSONResponse({"ok": False, "detail": "Formato mes inválido. Usar YYYY-MM"}, status_code=400)
    else:
        hoy = date.today()
        anio, mes_n = hoy.year, hoy.month

    sql = """
    SELECT
        FECHA,
        DIA,
        ISNULL(HORAS_MOTOR_DIA, 0)       AS HORAS_ON,
        ISNULL(HORAS_OFF_DIA, 0)          AS HORAS_OFF,
        ISNULL(HORAS_RALENTI_DIA, 0)      AS HORAS_RALENTI,
        ISNULL(HORAS_UTIL_DIA, 0)         AS HORAS_UTIL,
        ISNULL(HORAS_CARGA_BAJA_DIA, 0)   AS HORAS_BAJA,
        ISNULL(HORAS_CARGA_MEDIA_DIA, 0)  AS HORAS_MEDIA,
        ISNULL(HORAS_CARGA_ALTA_DIA, 0)   AS HORAS_ALTA,
        ISNULL(PCT_UTILIZACION_DIA, 0)    AS PCT_UTIL,
        ISNULL(PCT_RALENTI_DIA, 0)        AS PCT_RALENTI,
        ISNULL(SESIONES_DIA, 0)           AS SESIONES,
        ISNULL(FUEL_CONSUMED_DIA, 0)      AS FUEL_DIA,
        ISNULL(FUEL_LITROS_X_HORA, 0)     AS FUEL_LXH,
        ISNULL(FUEL_REMAINING_PCT, 0)     AS FUEL_PCT,
        ISNULL(HOROMETRO_TOTAL, 0)        AS HOROMETRO,
        ENGINE_STATE_ACTUAL
    FROM dbo.WEB_JD_TELEMETRIA_HIST
    WHERE EQUIPO = ? AND ANIO = ? AND MES = ?
    ORDER BY DIA ASC
    """

    with get_conn() as conn:
        rows = conn.cursor().execute(sql, equipo, anio, mes_n).fetchall()

    MESES = ["","Enero","Febrero","Marzo","Abril","Mayo","Junio",
             "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"]

    dias = []
    for r in rows:
        dias.append({
            "fecha":      str(r[0]),
            "dia":        r[1],
            "horas_on":   _flt(r[2]),
            "horas_off":  _flt(r[3]),
            "horas_ralenti": _flt(r[4]),
            "horas_util":    _flt(r[5]),
            "horas_baja":    _flt(r[6]),
            "horas_media":   _flt(r[7]),
            "horas_alta":    _flt(r[8]),
            "pct_util":      _flt(r[9]),
            "pct_ralenti":   _flt(r[10]),
            "sesiones":      r[11],
            "fuel_dia":      _flt(r[12]),
            "fuel_lxh":      _flt(r[13]),
            "fuel_pct":      _flt(r[14]),
            "horometro":     _flt(r[15]),
            "engine_state":  r[16],
        })

    total_on     = sum(d["horas_on"]  or 0 for d in dias)
    total_fuel   = sum(d["fuel_dia"]  or 0 for d in dias)
    dias_activos = sum(1 for d in dias if (d["horas_on"] or 0) > 0)
    prom_on_dia  = round(total_on / dias_activos, 2) if dias_activos > 0 else 0
    fuel_lxh_prom = round(total_fuel / total_on, 3) if total_on > 0 else None

    return {
        "ok":    True,
        "equipo": equipo,
        "anio":  anio,
        "mes":   mes_n,
        "label": f"{MESES[mes_n]} {anio}",
        "dias":  dias,
        "kpis": {
            "total_horas_on":    round(total_on, 1),
            "total_fuel":        round(total_fuel, 1),
            "dias_activos":      dias_activos,
            "dias_con_datos":    len(dias),
            "prom_horas_dia":    prom_on_dia,
            "fuel_lxh_promedio": fuel_lxh_prom,
        }
    }


# ═══════════════════════════════════════
# SESIONES — timeline del día
# GET /api/equipo/{equipo}/sesiones?fecha=2026-03-04
# ═══════════════════════════════════════
@app.get("/api/equipo/{equipo}/sesiones")
def api_sesiones(equipo: str, request: Request, fecha: str = None):
    """
    Devuelve las sesiones ON de un día específico.
    fecha = 'YYYY-MM-DD' (default: hoy)
    """
    try:
        codigo_cliente = require_session(request)
    except HTTPException:
        return _deny(JSONResponse({"ok": False, "reason": "DENIED"}, status_code=401))

    with get_conn() as conn:
        if not _check_equipo(conn, codigo_cliente, equipo):
            return JSONResponse({"ok": False, "detail": "Equipo no encontrado"}, status_code=404)

    from datetime import date
    fecha_consulta = fecha if fecha else str(date.today())

    sql = """
    SELECT
        FECHA_INICIO,
        FECHA_FIN,
        DURACION_H,
        TURNO,
        FUERA_HORARIO
    FROM dbo.WEB_JD_TELEMETRIA_SESIONES
    WHERE EQUIPO = ? AND FECHA = ?
    ORDER BY FECHA_INICIO ASC
    """

    with get_conn() as conn:
        rows = conn.cursor().execute(sql, equipo, fecha_consulta).fetchall()

    sesiones = []
    for r in rows:
        sesiones.append({
            "inicio":        str(r[0]),
            "fin":           str(r[1]),
            "duracion_h":    float(r[2]),
            "turno":         r[3],
            "fuera_horario": bool(r[4]),
        })

    total_h       = sum(s["duracion_h"] for s in sesiones)
    fuera_horario = sum(1 for s in sesiones if s["fuera_horario"])

    return {
        "ok":      True,
        "equipo":  equipo,
        "fecha":   fecha_consulta,
        "sesiones": sesiones,
        "resumen": {
            "total_sesiones":      len(sesiones),
            "total_horas":         round(total_h, 2),
            "fuera_horario_count": fuera_horario,
            "turnos": {
                "mañana": sum(1 for s in sesiones if s["turno"] == "MAÑANA"),
                "tarde":  sum(1 for s in sesiones if s["turno"] == "TARDE"),
                "noche":  sum(1 for s in sesiones if s["turno"] == "NOCHE"),
            }
        }
    }


# ═══════════════════════════════════════
# MENSUAL — comparativa histórica
# GET /api/equipo/{equipo}/mensual
# ═══════════════════════════════════════
@app.get("/api/equipo/{equipo}/mensual")
def api_mensual(equipo: str, request: Request):
    """
    Devuelve comparativa mensual de los últimos 6 meses.
    Combina WEB_JD_TELEMETRIA_MENSUAL (meses cerrados)
    + WEB_JD_TELEMETRIA_HIST (mes actual en curso).
    """
    try:
        codigo_cliente = require_session(request)
    except HTTPException:
        return _deny(JSONResponse({"ok": False, "reason": "DENIED"}, status_code=401))

    with get_conn() as conn:
        if not _check_equipo(conn, codigo_cliente, equipo):
            return JSONResponse({"ok": False, "detail": "Equipo no encontrado"}, status_code=404)

    MESES = ["","Ene","Feb","Mar","Abr","May","Jun",
             "Jul","Ago","Sep","Oct","Nov","Dic"]

    # ── Meses cerrados desde WEB_JD_TELEMETRIA_MENSUAL ──────────
    sql_hist = """
    SELECT
        ANIO, MES,
        ISNULL(HORAS_MOTOR, 0)        AS HORAS_MOTOR,
        ISNULL(HORAS_RALENTI, 0)      AS HORAS_RALENTI,
        ISNULL(HORAS_UTIL, 0)         AS HORAS_UTIL,
        ISNULL(HORAS_CARGA_BAJA, 0)   AS HORAS_BAJA,
        ISNULL(HORAS_CARGA_MEDIA, 0)  AS HORAS_MEDIA,
        ISNULL(HORAS_CARGA_ALTA, 0)   AS HORAS_ALTA,
        ISNULL(PCT_UTILIZACION, 0)    AS PCT_UTIL,
        ISNULL(PCT_RALENTI, 0)        AS PCT_RALENTI,
        ISNULL(FUEL_CONSUMED_MES, 0)  AS FUEL_MES,
        ISNULL(FUEL_LXH_PROMEDIO, 0)  AS FUEL_LXH,
        ISNULL(FUEL_REMAINING_PCT, 0) AS FUEL_PCT,
        ISNULL(HOROMETRO_CIERRE, 0)   AS HOROMETRO,
        ISNULL(DIAS_ACTIVO, 0)        AS DIAS_ACTIVO,
        ISNULL(DIAS_TOTAL, 0)         AS DIAS_TOTAL,
        ISNULL(SESIONES_TOTAL, 0)     AS SESIONES,
        ISNULL(SESIONES_FUERA_HORARIO, 0) AS FUERA_HORARIO,
        0 AS ES_MES_ACTUAL
    FROM dbo.WEB_JD_TELEMETRIA_MENSUAL
    WHERE EQUIPO = ?
      AND DATEFROMPARTS(ANIO, MES, 1) >= DATEADD(MONTH, -5, DATEFROMPARTS(YEAR(GETUTCDATE()), MONTH(GETUTCDATE()), 1))
    ORDER BY ANIO DESC, MES DESC
    """

    # ── Mes actual en curso desde HIST ──────────────────────────
    sql_actual = """
    SELECT
        YEAR(GETUTCDATE()) AS ANIO,
        MONTH(GETUTCDATE()) AS MES,
        ISNULL(SUM(HORAS_MOTOR_DIA), 0)       AS HORAS_MOTOR,
        ISNULL(SUM(HORAS_RALENTI_DIA), 0)     AS HORAS_RALENTI,
        ISNULL(SUM(HORAS_UTIL_DIA), 0)        AS HORAS_UTIL,
        ISNULL(SUM(HORAS_CARGA_BAJA_DIA), 0)  AS HORAS_BAJA,
        ISNULL(SUM(HORAS_CARGA_MEDIA_DIA), 0) AS HORAS_MEDIA,
        ISNULL(SUM(HORAS_CARGA_ALTA_DIA), 0)  AS HORAS_ALTA,
        ISNULL(AVG(PCT_UTILIZACION_DIA), 0)   AS PCT_UTIL,
        ISNULL(AVG(PCT_RALENTI_DIA), 0)       AS PCT_RALENTI,
        ISNULL(SUM(FUEL_CONSUMED_DIA), 0)     AS FUEL_MES,
        ISNULL(AVG(FUEL_LITROS_X_HORA), 0)    AS FUEL_LXH,
        ISNULL(MAX(FUEL_REMAINING_PCT), 0)    AS FUEL_PCT,
        ISNULL(MAX(HOROMETRO_TOTAL), 0)       AS HOROMETRO,
        COUNT(CASE WHEN HORAS_MOTOR_DIA > 0 THEN 1 END) AS DIAS_ACTIVO,
        COUNT(*) AS DIAS_TOTAL,
        ISNULL(SUM(SESIONES_DIA), 0)          AS SESIONES,
        0 AS FUERA_HORARIO,
        1 AS ES_MES_ACTUAL
    FROM dbo.WEB_JD_TELEMETRIA_HIST
    WHERE EQUIPO = ?
      AND ANIO = YEAR(GETUTCDATE())
      AND MES  = MONTH(GETUTCDATE())
      AND SYNC_OK = 1
    """

    meses = []
    with get_conn() as conn:
        cur = conn.cursor()
        for r in cur.execute(sql_hist, equipo).fetchall():
            meses.append(_row_a_mes(r, MESES))
        row_act = cur.execute(sql_actual, equipo).fetchone()
        if row_act and row_act[2] is not None:
            meses.insert(0, _row_a_mes(row_act, MESES))

    con_fuel = [m for m in meses if (m["fuel_lxh"] or 0) > 0]
    tendencia_lxh = None
    if len(con_fuel) >= 2:
        primero = con_fuel[-1]["fuel_lxh"]
        ultimo  = con_fuel[0]["fuel_lxh"]
        if primero and primero > 0:
            tendencia_lxh = round((ultimo - primero) / primero * 100, 1)

    return {
        "ok":     True,
        "equipo": equipo,
        "meses":  meses,
        "tendencia_lxh": tendencia_lxh,
    }


def _row_a_mes(r, MESES: list) -> dict:
    """Convierte una fila de query a dict de mes."""
    anio, mes = r[0], r[1]
    return {
        "anio":          anio,
        "mes":           mes,
        "label":         f"{MESES[mes]} {anio}",
        "horas_motor":   _flt(r[2]),
        "horas_ralenti": _flt(r[3]),
        "horas_util":    _flt(r[4]),
        "horas_baja":    _flt(r[5]),
        "horas_media":   _flt(r[6]),
        "horas_alta":    _flt(r[7]),
        "pct_util":      _flt(r[8]),
        "pct_ralenti":   _flt(r[9]),
        "fuel_mes":      _flt(r[10]),
        "fuel_lxh":      _flt(r[11]),
        "fuel_pct":      _flt(r[12]),
        "horometro":     _flt(r[13]),
        "dias_activos":  r[14],
        "dias_total":    r[15],
        "sesiones":      r[16],
        "fuera_horario": r[17],
        "es_mes_actual": bool(r[18]),
    }


# ═══════════════════════════════════════
# LOGOUT
# ═══════════════════════════════════════
@app.post("/api/logout")
def api_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE_NAME, path="/", samesite="lax")
    return resp