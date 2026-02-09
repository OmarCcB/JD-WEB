import pyodbc
from app.settings import ODBC_DRIVER, SQL_SERVER, SQL_DATABASE, SQL_USER, SQL_PASSWORD
#mod
def get_conn():
    if not all([SQL_SERVER, SQL_DATABASE, SQL_USER, SQL_PASSWORD]):
        raise RuntimeError("Faltan variables SQL_* en .env")

    conn = pyodbc.connect(
        f"DRIVER={{{ODBC_DRIVER}}};"
        f"SERVER={SQL_SERVER};"
        f"DATABASE={SQL_DATABASE};"
        f"UID={SQL_USER};"
        f"PWD={SQL_PASSWORD};"
        "Encrypt=yes;TrustServerCertificate=no;Connection Timeout=30;"
    )
    return conn
