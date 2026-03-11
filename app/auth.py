import time
import hmac
import hashlib
import base64
import random
import string
from typing import Optional, Tuple
from app.settings import SECRET_KEY, SESSION_TTL_SECONDS
from app.db import get_conn

# ═══════════════════════════════════════
# SESSION HELPERS
# ═══════════════════════════════════════

def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")

def _b64d(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)

def sign_session(codigo_cliente: str) -> str:
    iat = str(int(time.time()))
    payload = f"{codigo_cliente}|{iat}".encode()
    sig = hmac.new(SECRET_KEY.encode(), payload, hashlib.sha256).digest()
    return f"{_b64e(payload)}.{_b64e(sig)}"

def verify_session(cookie_value: str) -> Optional[Tuple[str, int]]:
    try:
        p64, s64 = cookie_value.split(".", 1)
        payload  = _b64d(p64)
        sig      = _b64d(s64)
        expected = hmac.new(SECRET_KEY.encode(), payload, hashlib.sha256).digest()
        if not hmac.compare_digest(sig, expected):
            return None
        codigo_cliente, iat = payload.decode().split("|")
        iat_int = int(iat)
        if int(time.time()) - iat_int > SESSION_TTL_SECONDS:
            return None
        return codigo_cliente, iat_int
    except Exception:
        return None

# ═══════════════════════════════════════
# PIN HELPERS
# ═══════════════════════════════════════

PIN_TTL_SECONDS  = 600   # 10 minutos
PIN_MAX_ATTEMPTS = 5

def _hash_pin(pin: str) -> str:
    return hashlib.sha256(pin.encode()).hexdigest()

def generate_pin() -> str:
    return "".join(random.SystemRandom().choices(string.digits, k=6))

# ═══════════════════════════════════════
# ADMIN HELPERS  (Opción A — WEB_JD_ADMINS)
# ═══════════════════════════════════════

# Prefijo especial que identifica una sesión admin en la cookie
ADMIN_PREFIX = "__ADMIN__"

def is_admin_email(email: str) -> bool:
    """True si el email existe en WEB_JD_ADMINS con ACTIVO=1."""
    sql = """
    SELECT 1 FROM dbo.WEB_JD_ADMINS
    WHERE LOWER(EMAIL) = LOWER(?) AND ACTIVO = 1
    """
    with get_conn() as conn:
        row = conn.cursor().execute(sql, email.strip().lower()).fetchone()
        return bool(row)

def is_admin_session(codigo_cliente: str) -> bool:
    """True si la sesión activa es de un admin."""
    return codigo_cliente.startswith(ADMIN_PREFIX)

def get_codigo_cliente_by_email(email: str) -> Optional[str]:
    """
    Busca el identificador de sesión por email:
    - Admin  → ADMIN_PREFIX + email  (ve toda la flota)
    - Normal → CODIGO_CLIENTE de WEB_JD_CONTACTOS
    - Sin acceso → None
    """
    if is_admin_email(email):
        return ADMIN_PREFIX + email.strip().lower()

    sql = """
    SELECT C.CODIGO_CLIENTE
    FROM dbo.WEB_JD_CONTACTOS CON
    JOIN dbo.WEB_JD_CLIENTES C ON C.CODIGO_CLIENTE = CON.CODIGO_CLIENTE
    WHERE LOWER(CON.EMAIL) = LOWER(?)
      AND CON.ACTIVO = 1
      AND C.STATUS   = 1
    """
    with get_conn() as conn:
        cur = conn.cursor()
        row = cur.execute(sql, email.strip().lower()).fetchone()
        return row[0] if row else None

def create_pin(codigo_cliente: str, pin: str, ip: str = None) -> None:
    """Invalida PINs anteriores e inserta uno nuevo.
    - Admin  → usa WEB_JD_ADMIN_PINS (sin FK, apto para multiworker/producción)
    - Normal → usa WEB_JD_PINS (con FK a WEB_JD_CLIENTES)
    """
    pin_hash = _hash_pin(pin)

    # ── Admin: tabla dedicada sin FK ─────────────────────────
    if is_admin_session(codigo_cliente):
        with get_conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                UPDATE dbo.WEB_JD_ADMIN_PINS
                   SET USADO = 1
                 WHERE CODIGO_CLIENTE = ? AND USADO = 0
            """, codigo_cliente)
            cur.execute("""
                INSERT INTO dbo.WEB_JD_ADMIN_PINS
                    (CODIGO_CLIENTE, PIN_HASH, CREADO_EN, EXPIRA_EN, USADO, INTENTOS, IP_SOLICITUD)
                VALUES
                    (?, ?, SYSUTCDATETIME(),
                     DATEADD(SECOND, ?, SYSUTCDATETIME()),
                     0, 0, ?)
            """, codigo_cliente, pin_hash, PIN_TTL_SECONDS, ip)
            conn.commit()
        return

    # ── Normal: tabla estándar con FK ────────────────────────
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE dbo.WEB_JD_PINS
               SET USADO = 1
             WHERE CODIGO_CLIENTE = ? AND USADO = 0
        """, codigo_cliente)
        cur.execute("""
            INSERT INTO dbo.WEB_JD_PINS
                (CODIGO_CLIENTE, PIN_HASH, CREADO_EN, EXPIRA_EN, USADO, INTENTOS, IP_SOLICITUD)
            VALUES
                (?, ?, SYSUTCDATETIME(),
                 DATEADD(SECOND, ?, SYSUTCDATETIME()),
                 0, 0, ?)
        """, codigo_cliente, pin_hash, PIN_TTL_SECONDS, ip)
        conn.commit()

def verify_pin(codigo_cliente: str, pin: str) -> Tuple[bool, str]:
    """Verifica el PIN. Retorna (ok, mensaje)."""
    pin_hash = _hash_pin(pin)

    # ── Admin: verificar desde WEB_JD_ADMIN_PINS ────────────
    if is_admin_session(codigo_cliente):
        sql = """
        SELECT TOP 1 ID, INTENTOS, EXPIRA_EN
        FROM dbo.WEB_JD_ADMIN_PINS
        WHERE CODIGO_CLIENTE = ? AND USADO = 0
        ORDER BY CREADO_EN DESC
        """
        with get_conn() as conn:
            cur = conn.cursor()
            row = cur.execute(sql, codigo_cliente).fetchone()

            if not row:
                return False, "No existe un código activo. Solicita uno nuevo."

            pid, intentos, expira_en = row

            expired = cur.execute(
                "SELECT CASE WHEN SYSUTCDATETIME() > ? THEN 1 ELSE 0 END", expira_en
            ).fetchone()[0]

            if expired:
                cur.execute("UPDATE dbo.WEB_JD_ADMIN_PINS SET USADO=1 WHERE ID=?", pid)
                conn.commit()
                return False, "El código ha expirado. Solicita uno nuevo."

            if intentos >= PIN_MAX_ATTEMPTS:
                cur.execute("UPDATE dbo.WEB_JD_ADMIN_PINS SET USADO=1 WHERE ID=?", pid)
                conn.commit()
                return False, "Demasiados intentos. Solicita un nuevo código."

            valid_row = cur.execute("""
                SELECT 1 FROM dbo.WEB_JD_ADMIN_PINS
                WHERE ID = ? AND PIN_HASH = ?
            """, pid, pin_hash).fetchone()

            if valid_row:
                cur.execute("UPDATE dbo.WEB_JD_ADMIN_PINS SET USADO=1 WHERE ID=?", pid)
                conn.commit()
                return True, "OK"
            else:
                cur.execute(
                    "UPDATE dbo.WEB_JD_ADMIN_PINS SET INTENTOS = INTENTOS + 1 WHERE ID=?", pid
                )
                conn.commit()
                restantes = PIN_MAX_ATTEMPTS - intentos - 1
                return False, f"Código incorrecto. {restantes} intento(s) restante(s)."

    # ── Normal: verificar desde WEB_JD_PINS ─────────────────
    sql = """
    SELECT TOP 1 ID, INTENTOS, EXPIRA_EN, USADO
    FROM dbo.WEB_JD_PINS
    WHERE CODIGO_CLIENTE = ?
      AND USADO = 0
    ORDER BY CREADO_EN DESC
    """
    with get_conn() as conn:
        cur = conn.cursor()
        row = cur.execute(sql, codigo_cliente).fetchone()

        if not row:
            return False, "No existe un código activo. Solicita uno nuevo."

        pid, intentos, expira_en, usado = row

        expired = cur.execute(
            "SELECT CASE WHEN SYSUTCDATETIME() > ? THEN 1 ELSE 0 END", expira_en
        ).fetchone()[0]

        if expired:
            cur.execute("UPDATE dbo.WEB_JD_PINS SET USADO=1 WHERE ID=?", pid)
            conn.commit()
            return False, "El código ha expirado. Solicita uno nuevo."

        if intentos >= PIN_MAX_ATTEMPTS:
            cur.execute("UPDATE dbo.WEB_JD_PINS SET USADO=1 WHERE ID=?", pid)
            conn.commit()
            return False, "Demasiados intentos. Solicita un nuevo código."

        valid_row = cur.execute("""
            SELECT 1 FROM dbo.WEB_JD_PINS
            WHERE ID = ? AND PIN_HASH = ?
        """, pid, pin_hash).fetchone()

        if valid_row:
            cur.execute("UPDATE dbo.WEB_JD_PINS SET USADO=1 WHERE ID=?", pid)
            conn.commit()
            return True, "OK"
        else:
            cur.execute(
                "UPDATE dbo.WEB_JD_PINS SET INTENTOS = INTENTOS + 1 WHERE ID=?", pid
            )
            conn.commit()
            restantes = PIN_MAX_ATTEMPTS - intentos - 1
            return False, f"Código incorrecto. {restantes} intento(s) restante(s)."

def validate_session_live(codigo_cliente: str) -> bool:
    """Verifica que el cliente/admin siga activo."""
    if is_admin_session(codigo_cliente):
        email = codigo_cliente[len(ADMIN_PREFIX):]
        return is_admin_email(email)

    sql = """
    SELECT 1 FROM dbo.WEB_JD_CLIENTES
    WHERE CODIGO_CLIENTE = ? AND STATUS = 1
    """
    with get_conn() as conn:
        cur = conn.cursor()
        row = cur.execute(sql, codigo_cliente).fetchone()
        return bool(row)