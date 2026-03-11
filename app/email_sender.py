import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from app.settings import SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM, ADMIN_EMAIL

# ═══════════════════════════════════════
# HELPER INTERNO
# ═══════════════════════════════════════
def _send(to_email: str, subject: str, html: str) -> None:
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = SMTP_FROM or SMTP_USER
    msg["To"]      = to_email
    msg.attach(MIMEText(html, "html", "utf-8"))
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
        server.ehlo()
        if SMTP_PORT == 587:
            server.starttls()
        if SMTP_USER and SMTP_PASSWORD:
            server.login(SMTP_USER, SMTP_PASSWORD)
        server.sendmail(msg["From"], [to_email], msg.as_string())

# ═══════════════════════════════════════
# EMAIL PIN AL CLIENTE
# ═══════════════════════════════════════
def send_pin_email(to_email: str, pin: str) -> None:
    subject = "Tu código de acceso · Portal CGM"
    html = f"""
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    </head>
    <body style="margin:0;padding:0;background:#f4f6f4;font-family:'DM Sans',system-ui,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f4;padding:40px 20px;">
        <tr>
          <td align="center">
            <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(12,83,76,.1);">
              <tr>
                <td style="background:#0c534c;padding:32px 36px;">
                  <p style="margin:0;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">
                    Portal de <em style="font-style:italic;color:#c5e86c;">Equipos</em>
                  </p>
                  <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,.6);">CGM · Acceso seguro</p>
                </td>
              </tr>
              <tr>
                <td style="padding:36px 36px 24px;">
                  <p style="margin:0 0 16px;font-size:15px;color:#2d4a46;line-height:1.6;">
                    Hemos recibido una solicitud de acceso para tu cuenta. Usa el siguiente código:
                  </p>
                  <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0;">
                    <tr>
                      <td align="center" style="background:#f4f6f4;border:1.5px solid #dde5e3;border-radius:12px;padding:28px;">
                        <p style="margin:0 0 8px;font-size:11px;color:#7a9490;text-transform:uppercase;letter-spacing:1px;font-weight:600;">
                          Código de acceso
                        </p>
                        <p style="margin:0;font-size:40px;font-weight:700;color:#0c534c;letter-spacing:12px;font-family:Georgia,serif;">
                          {pin}
                        </p>
                      </td>
                    </tr>
                  </table>
                  <p style="margin:0 0 12px;font-size:13px;color:#7a9490;line-height:1.5;">
                    ⏱ Este código es válido por <strong style="color:#2d4a46;">10 minutos</strong> y solo puede usarse una vez.
                  </p>
                  <p style="margin:0;font-size:13px;color:#7a9490;line-height:1.5;">
                    🔒 Si no solicitaste este acceso, ignora este mensaje.
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding:20px 36px 28px;border-top:1px solid #edf1f0;">
                  <p style="margin:0;font-size:12px;color:#b0bfbd;">
                    CGM · Portal de Equipos John Deere · Sistema automatizado, no responder.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
    """
    _send(to_email, subject, html)

# ═══════════════════════════════════════
# ALERTA AL ADMINISTRADOR
# ═══════════════════════════════════════
def send_alert_email(asunto: str, detalle: str) -> None:
    """Envía alerta crítica a omar.ccencho@cgmrental.com. No propaga errores."""
    if not ADMIN_EMAIL:
        return
    html = f"""
    <!DOCTYPE html>
    <html lang="es">
    <body style="margin:0;padding:0;background:#f4f6f4;font-family:system-ui,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f4;padding:40px 20px;">
        <tr><td align="center">
          <table width="520" cellpadding="0" cellspacing="0"
                 style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.1);">
            <tr>
              <td style="background:#b91c1c;padding:28px 36px;">
                <p style="margin:0;font-size:20px;font-weight:700;color:#fff;">⚠️ Alerta · Portal CGM</p>
                <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,.7);">Notificación automática del sistema</p>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 36px;">
                <p style="margin:0 0 12px;font-size:16px;font-weight:600;color:#1f2937;">{asunto}</p>
                <pre style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;
                            font-size:13px;color:#374151;white-space:pre-wrap;word-break:break-word;">{detalle}</pre>
                <p style="margin:20px 0 0;font-size:13px;color:#6b7280;">
                  Revisa los logs del servidor para más detalle.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 36px 24px;border-top:1px solid #e5e7eb;">
                <p style="margin:0;font-size:12px;color:#9ca3af;">CGM · Portal de Equipos John Deere</p>
              </td>
            </tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>
    """
    try:
        _send(ADMIN_EMAIL, f"[CGM ALERTA] {asunto}", html)
    except Exception:
        pass  # No propagar error del email de alerta