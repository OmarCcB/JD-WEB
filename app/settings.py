import os
from dotenv import load_dotenv

load_dotenv()

SECRET_KEY          = os.getenv("SECRET_KEY", "cambia-esto-por-uno-largo")
ODBC_DRIVER         = os.getenv("ODBC_DRIVER", "ODBC Driver 18 for SQL Server")
SQL_SERVER          = os.getenv("SQL_SERVER", "")
SQL_DATABASE        = os.getenv("SQL_DATABASE", "")
SQL_USER            = os.getenv("SQL_USER", "")
SQL_PASSWORD        = os.getenv("SQL_PASSWORD", "")

COOKIE_NAME         = "webjd_session"
SESSION_TTL_SECONDS = int(os.getenv("SESSION_TTL_SECONDS", "28800"))  # 8h
PORT                = int(os.getenv("PORT", "8013"))

# SMTP
SMTP_HOST           = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT           = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER           = os.getenv("SMTP_USER", "")
SMTP_PASSWORD       = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM           = os.getenv("SMTP_FROM", "")

# Alertas admin
ADMIN_EMAIL         = os.getenv("ADMIN_EMAIL", "omar.ccencho@cgmrental.com")