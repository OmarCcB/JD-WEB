from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import RedirectResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.settings import COOKIE_NAME
from app.auth import (
    sign_session, verify_session,
    validate_token_and_status, validate_session_live
)
from app.db import get_conn

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

def _deny(resp: JSONResponse) -> JSONResponse:
    resp.delete_cookie(COOKIE_NAME, path="/", samesite="lax")
    return resp

@app.get("/portal/{token}")
def portal_token(token: str, request: Request):
    ok = validate_token_and_status(token)
    if not ok:
        return RedirectResponse(url="/acceso-denegado", status_code=302)

    codigo_cliente, _nombre = ok
    cookie_val = sign_session(codigo_cliente, token)

    resp = RedirectResponse(url="/portal", status_code=302)
    # secure=True en prod con HTTPS.
    # Si pruebas en local SIN https, pon secure=False temporalmente.
    resp.set_cookie(
        key=COOKIE_NAME,
        value=cookie_val,
        httponly=True,
        secure=False,
        samesite="lax",
        path="/",
    )
    return resp

@app.get("/portal")
def portal_home():
    return FileResponse("static/index.html")

@app.get("/acceso-denegado")
def acceso_denegado():
    return FileResponse("static/index.html")

def require_session(request: Request) -> str:
    cookie = request.cookies.get(COOKIE_NAME)
    if not cookie:
        raise HTTPException(status_code=401, detail="No session")

    parsed = verify_session(cookie)
    if not parsed:
        raise HTTPException(status_code=401, detail="Invalid session")

    codigo_cliente, token, _iat = parsed

    if not validate_session_live(codigo_cliente, token):
        raise HTTPException(status_code=401, detail="Session not allowed")

    return codigo_cliente

@app.get("/api/me")
def api_me(request: Request):
    try:
        codigo_cliente = require_session(request)
    except HTTPException:
        return _deny(JSONResponse({"ok": False, "reason": "DENIED"}, status_code=401))

    sql = """
    SELECT TOP 1 CODIGO_CLIENTE, DESCRIPCION_CLIENTE
    FROM dbo.WEB_JD_CLIENTES
    WHERE CODIGO_CLIENTE = ?
    """
    with get_conn() as conn:
        cur = conn.cursor()
        row = cur.execute(sql, codigo_cliente).fetchone()

    return {
        "ok": True,
        "codigo_cliente": row[0] if row else codigo_cliente,
        "descripcion_cliente": (row[1] if row else "") or ""
    }

@app.get("/api/equipos")
def api_equipos(request: Request):
    try:
        codigo_cliente = require_session(request)
    except HTTPException:
        return _deny(JSONResponse({"ok": False, "reason": "DENIED"}, status_code=401))

    sql = """
    SELECT
        EQUIPO,
        DESCRIPCION,
        FABRICANTE_EQUIPO,
        DESCRIPCION_PAIS_FABRICACION,
        CODIGO_PROYECTO,
        DESCRIPCION_PROYECTO
    FROM dbo.WEB_JD_EQUIPO_CLIENTE
    WHERE CODIGO_CLIENTE = ?
    ORDER BY EQUIPO
    """
    with get_conn() as conn:
        cur = conn.cursor()
        rows = cur.execute(sql, codigo_cliente).fetchall()

    items = []
    for r in rows:
        items.append({
            "equipo": r[0],
            "descripcion": r[1],
            "fabricante": r[2],
            "pais": r[3],
            "codigo_proyecto": r[4],
            "descripcion_proyecto": r[5],
        })

    return {"ok": True, "items": items}

@app.post("/api/logout")
def api_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE_NAME, path="/", samesite="lax")
    return resp
