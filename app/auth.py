import time
import hmac
import hashlib
import base64
from typing import Optional, Tuple
from app.settings import SECRET_KEY, SESSION_TTL_SECONDS
from app.db import get_conn

def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")

def _b64d(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)

def sign_session(codigo_cliente: str, token: str) -> str:
    iat = str(int(time.time()))
    payload = f"{codigo_cliente}|{token}|{iat}".encode()
    sig = hmac.new(SECRET_KEY.encode(), payload, hashlib.sha256).digest()
    return f"{_b64e(payload)}.{_b64e(sig)}"

def verify_session(cookie_value: str) -> Optional[Tuple[str, str, int]]:
    try:
        p64, s64 = cookie_value.split(".", 1)
        payload = _b64d(p64)
        sig = _b64d(s64)
        expected = hmac.new(SECRET_KEY.encode(), payload, hashlib.sha256).digest()
        if not hmac.compare_digest(sig, expected):
            return None
        codigo_cliente, token, iat = payload.decode().split("|")
        iat_int = int(iat)
        if int(time.time()) - iat_int > SESSION_TTL_SECONDS:
            return None
        return codigo_cliente, token, iat_int
    except Exception:
        return None

def validate_token_and_status(token: str) -> Optional[Tuple[str, str]]:
    """
    OK si:
    - token existe
    - REVOCADO=0
    - cliente STATUS=1
    Retorna (CODIGO_CLIENTE, DESCRIPCION_CLIENTE)
    """
    sql = """
    SELECT C.CODIGO_CLIENTE, C.DESCRIPCION_CLIENTE
    FROM dbo.WEB_JD_TOKENS T
    JOIN dbo.WEB_JD_CLIENTES C ON C.CODIGO_CLIENTE = T.CODIGO_CLIENTE
    WHERE T.TOKEN = ?
      AND T.REVOCADO = 0
      AND C.STATUS = 1
    """
    with get_conn() as conn:
        cur = conn.cursor()
        row = cur.execute(sql, token).fetchone()
        if not row:
            return None
        return row[0], (row[1] or "")

def validate_session_live(codigo_cliente: str, token: str) -> bool:
    """
    Corta si STATUS baja o token revocado.
    """
    sql = """
    SELECT 1
    FROM dbo.WEB_JD_TOKENS T
    JOIN dbo.WEB_JD_CLIENTES C ON C.CODIGO_CLIENTE = T.CODIGO_CLIENTE
    WHERE T.CODIGO_CLIENTE = ?
      AND T.TOKEN = ?
      AND T.REVOCADO = 0
      AND C.STATUS = 1
    """
    with get_conn() as conn:
        cur = conn.cursor()
        row = cur.execute(sql, codigo_cliente, token).fetchone()
        return bool(row)
