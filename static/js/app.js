/* ═══════════════════════════════════════════════
   JD-WEB · app.js
   Sistema PIN + Portal de equipos + Telemetría
═══════════════════════════════════════════════ */

const el = (id) => document.getElementById(id);

let equipos      = [];
let telemetriaCache = null; // cache de telemetría flota completa
let pinInterval  = null;
let pinExpiraSeg = 600;
let currentEmail = "";
let isAdmin      = false;  // true cuando sesión admin
let previewCliente = null; // { codigo, nombre } cuando admin simula cliente

/* ══════════════════════════════════════════════
   VISTAS
══════════════════════════════════════════════ */
function showView(name) {
  ["viewAuth", "viewPortal", "viewDenied"].forEach(v => {
    const node = el(v);
    if (node) node.style.display = "none";
  });
  const map = { auth: "viewAuth", portal: "viewPortal", denied: "viewDenied" };
  const target = el(map[name]);
  if (target) {
    target.style.display = "flex";
    if (name === "portal") target.style.flexDirection = "column";
  }
  if (name === "auth") showStep("email");
}

function showStep(step) {
  const emailStep = el("stepEmail");
  const pinStep   = el("stepPin");
  // Ocultar ambos primero
  emailStep.classList.remove("active");
  emailStep.style.display = "none";
  pinStep.classList.remove("active");
  pinStep.style.display   = "none";
  setTimeout(() => {
    const target = step === "email" ? emailStep : pinStep;
    target.style.display = "block";
    target.classList.add("active");
  }, 10);
}

/* ══════════════════════════════════════════════
   STATUS PILL
══════════════════════════════════════════════ */
function setPill(text, ok = true) {
  const p = el("statusPill");
  if (!p) return;
  p.textContent    = text;
  p.style.background  = ok ? "#ecfdf5" : "#fef2f2";
  p.style.color       = ok ? "#065f46" : "#991b1b";
  p.style.borderColor = ok ? "#bbf7d0" : "#fecaca";
}

/* ══════════════════════════════════════════════
   API HELPER
══════════════════════════════════════════════ */
async function api(path, opts = {}) {
  const res  = await fetch(path, { credentials: "include", ...opts });
  const data = await res.json().catch(() => ({}));
  // Sesión expirada → redirigir al login automáticamente
  if (res.status === 401 && !path.includes("/api/auth/")) {
    showView("auth");
    showStep("email");
    return { res, data };
  }
  return { res, data };
}

/** Formatea número o devuelve "—" si es null/undefined */
const fmt  = (v, dec = 1) => (v != null && v !== "") ? Number(v).toFixed(dec) : "—";
const fmtP = (v)           => (v != null && v !== "") ? Number(v).toFixed(1) + "%" : "—";
const fmtH = (v)           => (v != null && v !== "") ? Number(v).toFixed(1) + " h" : "—";

/* ══════════════════════════════════════════════
   TIMER PIN
══════════════════════════════════════════════ */
function startPinTimer() {
  clearInterval(pinInterval);
  pinExpiraSeg = 600;
  updateTimerUI();
  pinInterval = setInterval(() => {
    pinExpiraSeg--;
    updateTimerUI();
    if (pinExpiraSeg <= 0) {
      clearInterval(pinInterval);
      el("pinTimer").textContent = "Código expirado. Solicita uno nuevo.";
      el("pinTimer").style.color = "#dc2626";
      el("btnVerificarPin").disabled = true;
    }
  }, 1000);
}

function updateTimerUI() {
  const m = Math.floor(pinExpiraSeg / 60).toString().padStart(2, "0");
  const s = (pinExpiraSeg % 60).toString().padStart(2, "0");
  const t = el("pinTimer");
  if (!t) return;
  t.textContent = `Expira en ${m}:${s}`;
  t.style.color = pinExpiraSeg < 60 ? "#dc2626" : "";
}

function stopPinTimer() { clearInterval(pinInterval); }

/* ══════════════════════════════════════════════
   PIN INPUTS
══════════════════════════════════════════════ */
function setupPinInputs() {
  const digits = document.querySelectorAll(".pin-digit");
  digits.forEach((input, i) => {
    input.value = "";
    input.classList.remove("filled");
    input.addEventListener("input", (e) => {
      const val = e.target.value.replace(/\D/g, "");
      e.target.value = val.slice(-1);
      e.target.classList.toggle("filled", !!e.target.value);
      syncHiddenPin();
      if (val && i < digits.length - 1) digits[i + 1].focus();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !input.value && i > 0) {
        digits[i - 1].focus();
        digits[i - 1].value = "";
        digits[i - 1].classList.remove("filled");
        syncHiddenPin();
      }
    });
    input.addEventListener("paste", (e) => {
      e.preventDefault();
      const pasted = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 6);
      pasted.split("").forEach((ch, j) => {
        if (digits[j]) { digits[j].value = ch; digits[j].classList.add("filled"); }
      });
      syncHiddenPin();
      const nextEmpty = [...digits].findIndex(d => !d.value);
      if (nextEmpty >= 0) digits[nextEmpty].focus();
      else digits[digits.length - 1].focus();
    });
  });
}

function syncHiddenPin() {
  const digits = document.querySelectorAll(".pin-digit");
  el("inputPin").value = [...digits].map(d => d.value).join("");
}

function clearPinInputs() {
  document.querySelectorAll(".pin-digit").forEach(d => {
    d.value = "";
    d.classList.remove("filled");
  });
  syncHiddenPin();
}

/* ══════════════════════════════════════════════
   SOLICITAR / VERIFICAR PIN
══════════════════════════════════════════════ */
async function solicitarPin(email) {
  const btn = el("btnSolicitarPin");
  const err = el("errorEmail");
  btn.disabled = true;
  btn.querySelector(".btn-label").textContent = "Enviando...";
  err.style.display = "none";
  try {
    const { res, data } = await api("/api/auth/solicitar-pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (res.ok && data.ok) {
      currentEmail = email;
      el("pinEmailLabel").textContent = email;
      clearPinInputs();
      el("errorPin").style.display = "none";
      showStep("pin");
      startPinTimer();
      setTimeout(() => { document.querySelector(".pin-digit")?.focus(); }, 400);
    } else {
      showError(err, data.detail || data.message || "Correo no registrado o sin acceso.");
    }
  } catch {
    showError(err, "Error de conexión. Intenta nuevamente.");
  } finally {
    btn.disabled = false;
    btn.querySelector(".btn-label").textContent = "Enviar código";
  }
}

async function verificarPin(pin) {
  const btn = el("btnVerificarPin");
  const err = el("errorPin");
  btn.disabled = true;
  btn.querySelector(".btn-label").textContent = "Verificando...";
  err.style.display = "none";
  try {
    const { res, data } = await api("/api/auth/verificar-pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: currentEmail, pin }),
    });
    if (res.ok && data.ok) {
      stopPinTimer();
      await cargarPortal();
    } else {
      showError(err, data.detail || data.message || "Código incorrecto. Intenta nuevamente.");
      clearPinInputs();
      document.querySelector(".pin-digit")?.focus();
    }
  } catch {
    showError(err, "Error de conexión. Intenta nuevamente.");
  } finally {
    btn.disabled = false;
    btn.querySelector(".btn-label").textContent = "Verificar acceso";
  }
}

/* ══════════════════════════════════════════════
   CARGAR PORTAL
══════════════════════════════════════════════ */
async function cargarPortal() {
  const me = await api("/api/me");
  if (!me.data?.ok) { showView("denied"); return; }

  isAdmin = me.data.is_admin === true;
  el("clienteNombre").textContent = (me.data.descripcion_cliente || "").trim();
  setPill("Acceso activo", true);

  const r = await api("/api/equipos");
  if (!r.data?.ok) { showView("denied"); return; }

  equipos = r.data.items || [];
  telemetriaCache = null;

  const btnRep = el("btnReporteMes");
  if (btnRep) {
    btnRep.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.3"/>
        <path d="M4 6h8M4 9h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        <path d="M11 11l1.5 1.5L15 10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Reporte ${labelMesActual()}`;
  }

  // Mostrar filtro cliente solo para admins
  if (isAdmin) {
    el("sectionFCliente").style.display = "block";
    renderClienteFilter();
  }

  renderProyectoFilter();
  applyFilters();
  showView("portal");
}

/* ══════════════════════════════════════════════
   FILTROS
══════════════════════════════════════════════ */
function renderClienteFilter() {
  // Construir mapa codigo → descripcion (usando primer equipo que tenga el dato)
  const mapa = {};
  equipos.forEach(x => {
    const cod = (x.codigo_cliente || "").trim();
    if (cod && !mapa[cod]) {
      mapa[cod] = (x.descripcion_cliente || cod).trim();
    }
  });
  const codigos = Object.keys(mapa).sort((a, b) => mapa[a].localeCompare(mapa[b]));
  el("fCliente").innerHTML =
    `<option value="">Todos los clientes</option>` +
    codigos.map(c => `<option value="${c}">${mapa[c]}</option>`).join("");
}

function renderProyectoFilter() {
  // Si hay filtro de cliente activo, acortar proyectos a ese cliente
  const cli = previewCliente ? previewCliente.codigo : (el("fCliente")?.value || "");
  const base = cli ? equipos.filter(x => (x.codigo_cliente || "") === cli) : equipos;
  const proyectos = [...new Set(base.map(x => (x.descripcion_proyecto || "").trim()))].sort();
  el("fProyecto").innerHTML =
    `<option value="">Todos los proyectos</option>` +
    proyectos.map(d => `<option value="${d}">${d || "(Sin proyecto)"}</option>`).join("");
}

function applyFilters() {
  const q    = (el("search")?.value || "").toLowerCase();
  // En modo preview, forzar filtro al cliente simulado
  const cli  = previewCliente ? previewCliente.codigo : (el("fCliente")?.value || "");
  const proj = el("fProyecto")?.value || "";
  const items = equipos.filter(x => {
    const matchQ = (x.equipo || "").toLowerCase().includes(q) || (x.descripcion || "").toLowerCase().includes(q);
    const matchC = !cli  || ((x.codigo_cliente || "").trim() === cli);
    const matchP = !proj || ((x.descripcion_proyecto || "").trim() === proj);
    return matchQ && matchC && matchP;
  });
  animateCount(items.length);
  const grid = el("cardsGrid");
  if (items.length === 0) {
    grid.innerHTML = `<div class="deny-box">No se encontraron equipos con ese criterio.</div>`;
    return;
  }
  grid.innerHTML = items.map(x => `
    <article class="eCard">
      <div class="eCardHead">
        <div class="eEquipo">${x.equipo ?? ""}</div>
        <span class="badge">${x.fabricante ?? ""}</span>
      </div>
      <div class="eMeta">${(x.descripcion_proyecto ?? "")}</div>
      <div class="eDesc">${x.descripcion ?? ""}</div>
      <div class="metaRow">
        <span class="tag">${x.pais ?? "—"}</span>
      </div>
      <div class="rowBtns">
        <button class="btn-detail" data-equipo="${x.equipo ?? ""}">Ver detalle</button>
      </div>
    </article>
  `).join("");
  grid.querySelectorAll("button[data-equipo]").forEach(btn => {
    btn.addEventListener("click", () => {
      const item = equipos.find(e => e.equipo === btn.dataset.equipo);
      if (item) openModal(item);
    });
  });
}

/* ══════════════════════════════════════════════
   MODAL DETALLE BÁSICO
══════════════════════════════════════════════ */
let currentModalEquipo = null;

function openModal(item) {
  currentModalEquipo = item;
  el("mEquipo").textContent   = item.equipo ?? "—";
  el("mProyecto").textContent = (item.descripcion_proyecto ?? "").trim() || "—";
  el("mDesc").textContent     = item.descripcion ?? "—";
  el("mFab").textContent      = item.fabricante ?? "—";
  el("mPais").textContent     = item.pais ?? "—";
  el("modalBack").style.display = "flex";
}

function closeModal() {
  el("modalBack").style.display = "none";
  currentModalEquipo = null;
}

/* ══════════════════════════════════════════════
   MODAL TELEMETRÍA — EQUIPO INDIVIDUAL
══════════════════════════════════════════════ */
/* ══════════════════════════════════════════════
   MODAL TELEMETRÍA — PESTAÑAS
══════════════════════════════════════════════ */
let currentTelEquipo = null;
let diarioCache      = {};
let mensualCache     = {};
let diaSeleccionado  = null;

function switchTab(tabName) {
  document.querySelectorAll(".tel-tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach(p => {
    p.style.display = "none";
    p.classList.remove("active");
  });
  document.querySelector(`.tel-tab[data-tab="${tabName}"]`)?.classList.add("active");
  const panel = el(`tab${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`);
  if (panel) { panel.style.display = "block"; panel.classList.add("active"); }

  if (tabName === "monthly" && currentTelEquipo) cargarDiario(currentTelEquipo);
  if (tabName === "history" && currentTelEquipo) cargarMensual(currentTelEquipo);
}

async function openTelemetria(equipo, descripcion, proyecto) {
  el("modalBack").style.display = "none";
  currentTelEquipo = equipo;

  // Reset tabs → mostrar pestaña 1
  switchTab("realtime");

  el("tLoading").style.display = "flex";
  el("tNoData").style.display  = "none";
  el("tData").style.display    = "none";

  el("tEquipo").textContent   = equipo;
  el("tProyecto").textContent = proyecto || "";
  el("tEngineState").textContent = "";
  el("tEngineState").className   = "engine-badge";

  el("modalTelBack").style.display = "flex";

  try {
    const { res, data } = await api(`/api/telemetria/${encodeURIComponent(equipo)}`);
    el("tLoading").style.display = "none";
    if (!res.ok || !data.ok || !data.sync_ok) {
      el("tNoData").style.display = "flex";
      return;
    }
    renderTelemetria(data);
    el("tData").style.display = "block";
  } catch {
    el("tLoading").style.display = "none";
    el("tNoData").style.display  = "flex";
  }
}

function renderTelemetria(d) {
  const badge = el("tEngineState");
  if (d.engine_state === 1) { badge.textContent = "● Encendido"; badge.className = "engine-badge on"; }
  else { badge.textContent = "○ Apagado"; badge.className = "engine-badge off"; }

  el("tPeriodo").textContent   = `Período: ${labelMesActual()}`;
  el("tSync").textContent      = d.fecha_sync ? `Sync: ${fmtDateTime(d.fecha_sync)}` : "Sin sync";
  el("tHorometro").textContent = d.horometro_total !== null
    ? `Horómetro: ${d.horometro_total.toLocaleString("es-PE")} h` : "Sin horómetro";

  el("tHorasOn").textContent   = d.horas_on !== null ? `${d.horas_on.toFixed(1)}h` : "—";
  el("tHorasOff").textContent  = d.horas_off !== null ? `${d.horas_off.toFixed(1)}h apagado` : "";
  el("tPctUtil").textContent   = d.pct_utilizacion !== null ? `${d.pct_utilizacion.toFixed(1)}%` : "—";
  el("tPctRalenti").textContent  = d.pct_ralenti !== null ? `${d.pct_ralenti.toFixed(1)}%` : "—";
  el("tPctTrabajo").textContent  = d.pct_trabajo_efectivo !== null ? `${d.pct_trabajo_efectivo.toFixed(1)}%` : "—";

  const idle = d.horas_ralenti || 0, low = d.horas_carga_baja || 0;
  const med  = d.horas_carga_media || 0, high = d.horas_carga_alta || 0;
  const keyOn = d.horas_key_on || 0;
  const total = idle + low + med + high + keyOn || 1;
  const pct   = v => `${Math.round(v / total * 100)}%`;
  el("tBarIdle").style.width  = pct(idle);
  el("tBarLow").style.width   = pct(low);
  el("tBarMed").style.width   = pct(med);
  el("tBarHigh").style.width  = pct(high);
  el("tBarKeyOn").style.width = pct(keyOn);
  el("lIdle").textContent = `${idle.toFixed(1)}h`;
  el("lLow").textContent  = `${low.toFixed(1)}h`;
  el("lMed").textContent  = `${med.toFixed(1)}h`;
  el("lHigh").textContent = `${high.toFixed(1)}h`;

  const gpsSection = el("tGpsSection");
  if (d.gps_lat && d.gps_lon) {
    el("tGpsCoords").textContent = `${d.gps_lat.toFixed(6)}, ${d.gps_lon.toFixed(6)}`;
    el("tGpsFecha").textContent  = d.gps_fecha ? `Actualizado: ${fmtDateTime(d.gps_fecha)}` : "";
    el("tGpsLink").href = `https://www.google.com/maps?q=${d.gps_lat},${d.gps_lon}`;
    gpsSection.style.display = "block";
  } else { gpsSection.style.display = "none"; }

  const fuelSection = el("tFuelSection");
  if (d.fuel_remaining_pct != null || d.fuel_consumed_mes != null || d.fuel_litros_x_hora != null) {
    const fp = d.fuel_remaining_pct;
    el("tFuelPct").textContent = fp != null ? `${fp.toFixed(1)}%` : "—";
    el("tFuelMes").textContent = d.fuel_consumed_mes != null ? `${d.fuel_consumed_mes.toFixed(0)} L` : "—";
    el("tFuelLxH").textContent = d.fuel_litros_x_hora != null ? `${d.fuel_litros_x_hora.toFixed(2)} L/h` : "—";
    if (fp != null) {
      const bar = el("tFuelBar");
      bar.style.width      = `${Math.min(fp, 100)}%`;
      bar.style.background = fp < 20 ? "#ef4444" : fp < 40 ? "#f59e0b" : "#22c55e";
    }
    fuelSection.style.display = "block";
  } else { fuelSection.style.display = "none"; }
}

/* ══════════════════════════════════════════════
   PESTAÑA 2 — ESTE MES (diario + sesiones)
══════════════════════════════════════════════ */
async function cargarDiario(equipo) {
  if (diarioCache[equipo]) { renderDiario(diarioCache[equipo]); return; }

  el("mLoading").style.display = "flex";
  el("mData").style.display    = "none";

  const hoy = new Date();
  const mes = `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,"0")}`;

  try {
    const { res, data } = await api(`/api/equipo/${encodeURIComponent(equipo)}/diario?mes=${mes}`);
    el("mLoading").style.display = "none";
    if (!res.ok || !data.ok) { el("mData").innerHTML = `<p style="color:var(--muted);padding:24px;text-align:center;">Sin datos para este mes.</p>`; el("mData").style.display="block"; return; }
    diarioCache[equipo] = data;
    renderDiario(data);
  } catch {
    el("mLoading").style.display = "none";
  }
}

function renderDiario(data) {
  const { dias, kpis, label } = data;
  el("mData").style.display = "block";

  // KPIs
  el("mKpis").innerHTML = `
    <div class="tel-kpi">
      <div class="tel-kpi-label">Horas ON ${label}</div>
      <div class="tel-kpi-val">${kpis.total_horas_on.toFixed(1)}h</div>
      <div class="tel-kpi-sub">${kpis.dias_activos} días activos</div>
    </div>
    <div class="tel-kpi tel-kpi-green">
      <div class="tel-kpi-label">Promedio diario</div>
      <div class="tel-kpi-val">${kpis.prom_horas_dia.toFixed(1)}h</div>
      <div class="tel-kpi-sub">en días activos</div>
    </div>
    ${kpis.total_fuel > 0 ? `
    <div class="tel-kpi tel-kpi-blue">
      <div class="tel-kpi-label">Combustible mes</div>
      <div class="tel-kpi-val">${kpis.total_fuel.toFixed(0)} L</div>
      <div class="tel-kpi-sub">${kpis.fuel_lxh_promedio ? kpis.fuel_lxh_promedio.toFixed(2)+" L/h" : "—"}</div>
    </div>` : ""}
    <div class="tel-kpi tel-kpi-amber">
      <div class="tel-kpi-label">Días con datos</div>
      <div class="tel-kpi-val">${kpis.dias_con_datos}</div>
      <div class="tel-kpi-sub">registros este mes</div>
    </div>
  `;

  // Gráfico barras por día
  if (!dias.length) {
    el("mBarChart").innerHTML = `<p style="color:var(--muted);font-size:13px;">Sin datos diarios aún.</p>`;
  } else {
    const maxH = Math.max(...dias.map(d => d.horas_on || 0), 0.1);
    el("mBarChart").innerHTML = dias.map(d => {
      const pct  = Math.round((d.horas_on || 0) / maxH * 100);
      const val  = (d.horas_on || 0) > 0 ? `${d.horas_on.toFixed(1)}h` : "";
      const zero = (d.horas_on || 0) === 0 ? " zero" : "";
      return `
        <div class="day-col" data-fecha="${d.fecha}" data-dia="${d.dia}">
          <div class="day-bar-wrap">
            <div class="day-bar${zero}" style="height:${Math.max(pct,3)}%"></div>
          </div>
          <div class="day-num">${d.dia}</div>
          <div class="day-val">${val}</div>
        </div>`;
    }).join("");

    // Click en día → cargar sesiones
    el("mBarChart").querySelectorAll(".day-col").forEach(col => {
      col.addEventListener("click", () => {
        el("mBarChart").querySelectorAll(".day-col").forEach(c => c.classList.remove("active"));
        col.classList.add("active");
        cargarSesiones(currentTelEquipo, col.dataset.fecha, col.dataset.dia);
      });
    });

    // Auto-seleccionar último día con datos
    const ultimo = [...dias].reverse().find(d => d.horas_on > 0);
    if (ultimo) {
      const col = el("mBarChart").querySelector(`[data-fecha="${ultimo.fecha}"]`);
      if (col) { col.classList.add("active"); cargarSesiones(currentTelEquipo, ultimo.fecha, ultimo.dia); }
    }
  }
}

async function cargarSesiones(equipo, fecha, dia) {
  diaSeleccionado = fecha;
  el("mDiaLabel").textContent = `día ${dia}`;
  el("mSesionesLoading").style.display = "flex";
  el("mSesionesList").innerHTML = "";
  el("mSesionesEmpty").style.display = "none";
  el("mSesionesCount").textContent = "";
  el("mSesionesSection").style.display = "block";

  try {
    const { res, data } = await api(`/api/equipo/${encodeURIComponent(equipo)}/sesiones?fecha=${fecha}`);
    el("mSesionesLoading").style.display = "none";
    if (!res.ok || !data.ok) { el("mSesionesEmpty").style.display = "block"; return; }

    const { sesiones, resumen } = data;
    el("mSesionesCount").textContent = `${resumen.total_sesiones} sesiones · ${resumen.total_horas.toFixed(1)}h`;

    if (!sesiones.length) { el("mSesionesEmpty").style.display = "block"; return; }

    el("mSesionesList").innerHTML = sesiones.map(s => {
      const ini  = new Date(s.inicio).toLocaleTimeString("es-PE", {hour:"2-digit", minute:"2-digit"});
      const fin  = new Date(s.fin).toLocaleTimeString("es-PE", {hour:"2-digit", minute:"2-digit"});
      const dur  = s.duracion_h < 1
        ? `${Math.round(s.duracion_h * 60)} min`
        : `${s.duracion_h.toFixed(2)} h`;
      const turnoClass = s.turno === "MAÑANA" ? "turno-manana" : s.turno === "TARDE" ? "turno-tarde" : "turno-noche";
      const fh = s.fuera_horario ? `<span class="sesion-alerta">⚠ Fuera de horario</span>` : "";
      return `
        <div class="sesion-item${s.fuera_horario ? " fuera-horario" : ""}">
          <span class="sesion-turno ${turnoClass}">${s.turno}</span>
          <span class="sesion-tiempo">${ini} – ${fin}</span>
          <span class="sesion-dur">${dur}</span>
          ${fh}
        </div>`;
    }).join("");
  } catch {
    el("mSesionesLoading").style.display = "none";
    el("mSesionesEmpty").style.display   = "block";
  }
}

/* ══════════════════════════════════════════════
   PESTAÑA 3 — HISTORIAL MENSUAL
══════════════════════════════════════════════ */
let mensualMesIdx = 0;
let mensualMeses  = [];

async function cargarMensual(equipo) {
  if (mensualCache[equipo]) { renderMensual(mensualCache[equipo]); return; }

  el("hLoading").style.display = "flex";
  el("hData").style.display    = "none";
  el("hNoData").style.display  = "none";

  try {
    const { res, data } = await api(`/api/equipo/${encodeURIComponent(equipo)}/mensual`);
    el("hLoading").style.display = "none";
    if (!res.ok || !data.ok || !data.meses.length) { el("hNoData").style.display = "flex"; return; }
    mensualCache[equipo] = data;
    renderMensual(data);
  } catch {
    el("hLoading").style.display = "none";
    el("hNoData").style.display  = "flex";
  }
}

function renderMensual(data) {
  mensualMeses  = data.meses;
  mensualMesIdx = 0;
  el("hData").style.display = "block";

  // Banner tendencia L/h
  const tendBanner = el("hTendencia");
  if (data.tendencia_lxh !== null) {
    const t = data.tendencia_lxh;
    const cls  = t < -5 ? "mejora" : t > 5 ? "empeora" : "neutro";
    const icon = t < -5 ? "📉" : t > 5 ? "📈" : "➡️";
    const txt  = t < -5
      ? `Eficiencia mejorando: consumo ${Math.abs(t).toFixed(1)}% menor que hace ${mensualMeses.length} meses`
      : t > 5
      ? `Alerta: consumo ${t.toFixed(1)}% mayor que hace ${mensualMeses.length} meses — revisar motor`
      : `Consumo estable en los últimos meses`;
    tendBanner.className = `tendencia-banner ${cls}`;
    tendBanner.innerHTML = `<span>${icon}</span><span>${txt}</span>`;
    tendBanner.style.display = "flex";
  } else {
    tendBanner.style.display = "none";
  }

  // Tabs de meses
  const tabs = el("hMesTabs");
  tabs.innerHTML = mensualMeses.map((m, i) => `
    <button class="hist-tab ${i===0?"active":""}" data-idx="${i}">${m.label}${m.es_mes_actual?" ●":""}</button>
  `).join("");
  tabs.querySelectorAll(".hist-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      mensualMesIdx = parseInt(btn.dataset.idx);
      tabs.querySelectorAll(".hist-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderMesDetalle(mensualMeses[mensualMesIdx]);
    });
  });

  // Comparativo barras
  renderComparativoMensual(mensualMeses);

  // Gráfico L/h
  renderFuelTrend(mensualMeses);

  // Detalle del primer mes
  renderMesDetalle(mensualMeses[0]);
}

function renderMesDetalle(m) {
  el("hMesKpis").innerHTML = `
    <div class="tel-kpi">
      <div class="tel-kpi-label">Horas motor</div>
      <div class="tel-kpi-val">${m.horas_motor != null ? m.horas_motor.toFixed(1)+"h" : "—"}</div>
      <div class="tel-kpi-sub">${m.dias_activos || 0} días activos</div>
    </div>
    <div class="tel-kpi tel-kpi-green">
      <div class="tel-kpi-label">Utilización</div>
      <div class="tel-kpi-val">${m.pct_util != null ? m.pct_util.toFixed(1)+"%" : "—"}</div>
      <div class="tel-kpi-sub">del tiempo encendido</div>
    </div>
    <div class="tel-kpi tel-kpi-amber">
      <div class="tel-kpi-label">Ralentí</div>
      <div class="tel-kpi-val">${m.pct_ralenti != null ? m.pct_ralenti.toFixed(1)+"%" : "—"}</div>
      <div class="tel-kpi-sub">tiempo en espera</div>
    </div>
    ${m.fuel_mes > 0 ? `
    <div class="tel-kpi tel-kpi-blue">
      <div class="tel-kpi-label">Combustible</div>
      <div class="tel-kpi-val">${m.fuel_mes.toFixed(0)} L</div>
      <div class="tel-kpi-sub">${m.fuel_lxh ? m.fuel_lxh.toFixed(2)+" L/h" : "—"}</div>
    </div>` : ""}
    ${m.sesiones > 0 ? `
    <div class="tel-kpi">
      <div class="tel-kpi-label">Sesiones</div>
      <div class="tel-kpi-val">${m.sesiones}</div>
      <div class="tel-kpi-sub">${m.fuera_horario > 0 ? `⚠ ${m.fuera_horario} fuera horario` : "sin alertas"}</div>
    </div>` : ""}
  `;

  // Barra desglose
  const total = (m.horas_ralenti||0)+(m.horas_baja||0)+(m.horas_media||0)+(m.horas_alta||0)||1;
  const p = v => `${Math.max(Math.round((v||0)/total*100),0)}%`;
  el("hBarDesglose").innerHTML = `
    <div class="tel-bar-seg tel-bar-amber"      style="width:${p(m.horas_ralenti)}" title="Ralentí"></div>
    <div class="tel-bar-seg tel-bar-blue-light" style="width:${p(m.horas_baja)}"    title="Carga baja"></div>
    <div class="tel-bar-seg tel-bar-blue"       style="width:${p(m.horas_media)}"   title="Carga media"></div>
    <div class="tel-bar-seg tel-bar-green"      style="width:${p(m.horas_alta)}"    title="Carga alta"></div>
  `;
  el("hBarLegend").innerHTML = `
    <span class="tel-legend-item"><span class="dot dot-amber"></span>Ralentí <strong>${fmtH(m.horas_ralenti)}</strong></span>
    <span class="tel-legend-item"><span class="dot dot-blue-light"></span>Carga baja <strong>${fmtH(m.horas_baja)}</strong></span>
    <span class="tel-legend-item"><span class="dot dot-blue"></span>Carga media <strong>${fmtH(m.horas_media)}</strong></span>
    <span class="tel-legend-item"><span class="dot dot-green"></span>Carga alta <strong>${fmtH(m.horas_alta)}</strong></span>
  `;
}

function renderComparativoMensual(meses) {
  const maxH = Math.max(...meses.map(m => m.horas_motor || 0), 0.1);
  el("hComparativo").innerHTML = `
    <div class="comparativo-bars">
      ${meses.map((m, i) => {
        const h   = m.horas_motor || 0;
        const pct = Math.round(h / maxH * 100);
        const act = i === mensualMesIdx ? "active" : "";
        return `
          <div class="comp-col ${act}" data-idx="${i}">
            <div class="comp-bar-wrap"><div class="comp-bar" style="height:${pct}%"></div></div>
            <div class="comp-val">${h > 0 ? h.toFixed(0)+"h" : "—"}</div>
            <div class="comp-label">${m.label}${m.es_mes_actual ? " ●" : ""}</div>
          </div>`;
      }).join("")}
    </div>`;
  el("hComparativo").querySelectorAll(".comp-col").forEach(col => {
    col.addEventListener("click", () => {
      const idx = parseInt(col.dataset.idx);
      el("hMesTabs").querySelectorAll(".hist-tab")[idx]?.click();
      el("hComparativo").querySelectorAll(".comp-col").forEach(c => c.classList.remove("active"));
      col.classList.add("active");
    });
  });
}

function renderFuelTrend(meses) {
  const conFuel = meses.filter(m => (m.fuel_lxh || 0) > 0);
  const fuelSection = el("hFuelSection");
  if (!conFuel.length) { fuelSection.style.display = "none"; return; }
  fuelSection.style.display = "block";

  const maxLxH = Math.max(...conFuel.map(m => m.fuel_lxh), 0.1);
  // Determinar rango para color: bueno < promedio, malo > promedio
  const prom = conFuel.reduce((a, m) => a + m.fuel_lxh, 0) / conFuel.length;

  el("hFuelChart").innerHTML = meses.map(m => {
    if (!m.fuel_lxh) return `
      <div class="fuel-col">
        <div class="fuel-bar-wrap"><div class="fuel-bar none" style="height:4%"></div></div>
        <div class="fuel-label">${m.label}</div>
        <div class="fuel-val">—</div>
      </div>`;
    const pct  = Math.round(m.fuel_lxh / maxLxH * 100);
    const cls  = m.fuel_lxh < prom * 0.95 ? "good" : m.fuel_lxh > prom * 1.05 ? "bad" : "medium";
    return `
      <div class="fuel-col">
        <div class="fuel-bar-wrap"><div class="fuel-bar ${cls}" style="height:${Math.max(pct,5)}%"></div></div>
        <div class="fuel-label">${m.label}</div>
        <div class="fuel-val">${m.fuel_lxh.toFixed(2)}</div>
      </div>`;
  }).join("");
}

function closeTelemetria() {
  el("modalTelBack").style.display = "none";
  // Limpiar cache del equipo actual para que el siguiente open tenga datos frescos
  if (currentTelEquipo) {
    delete diarioCache[currentTelEquipo];
    delete mensualCache[currentTelEquipo];
  }
  currentTelEquipo = null;
  mensualMeses     = [];
}



/* ══════════════════════════════════════════════
   MODAL REPORTE FLOTA
══════════════════════════════════════════════ */
async function openReporteFlota() {
  // Reset
  el("fLoading").style.display = "flex";
  el("fData").style.display    = "none";
  el("modalFlotaBack").style.display = "flex";

  // KPIs en blanco
  ["fTotalOn","fPctUtil","fMasUtil","fMasRalenti"].forEach(id => {
    el(id).textContent = "—";
  });

  // Inicializar filtros de descarga
  _initPdfFilters();

  try {
    // Usar cache si está disponible
    let resp;
    if (telemetriaCache) {
      resp = telemetriaCache;
    } else {
      const { res, data } = await api("/api/telemetria");
      if (!res.ok || !data.ok) throw new Error("Error API");
      telemetriaCache = data;
      resp = data;
    }

    el("fLoading").style.display = "none";

    // Período — usar label del mes anterior directamente
    el("fPeriodo").textContent = labelMesActual();

    // KPIs globales
    const kpis = resp.kpis || {};
    el("fTotalOn").textContent   = kpis.total_horas_on !== undefined ? `${kpis.total_horas_on.toLocaleString("es-PE")}h` : "—";
    el("fPctUtil").textContent   = kpis.pct_utilizacion_flota !== undefined ? `${kpis.pct_utilizacion_flota}%` : "—";
    el("fMasUtil").textContent   = kpis.mas_utilizada ? `${kpis.mas_utilizada} (${kpis.mas_utilizada_pct}%)` : "—";
    el("fMasRalenti").textContent = kpis.mas_ralenti ? `${kpis.mas_ralenti} (${kpis.mas_ralenti_pct}%)` : "—";

    // Tabla
    // En modo preview, mostrar solo equipos del cliente simulado
    const itemsFiltrados = previewCliente
      ? (resp.items || []).filter(x => (x.codigo_cliente || "") === previewCliente.codigo)
      : (resp.items || []);
    renderTablaFlota(itemsFiltrados);
    _actualizarKpisModal(itemsFiltrados);
    el("fData").style.display = "block";

  } catch {
    el("fLoading").style.display = "none";
    el("fData").style.display    = "block";
    el("fTableBody").innerHTML   = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px;">No se pudo cargar la telemetría.</td></tr>`;
  }
}

function renderTablaFlota(items) {
  const tbody = el("fTableBody");
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px;">Sin equipos con datos.</td></tr>`;
    return;
  }

  tbody.innerHTML = items.map(item => {
    const sinDatos = !item.sync_ok || item.horas_on === null;

    const horasOn   = sinDatos ? "—" : `<span class="ft-num">${item.horas_on.toFixed(1)}h</span>`;
    const pctUtil   = sinDatos ? `<span class="ft-nodata">—</span>` : pctCell(item.pct_utilizacion);
    const pctRal    = sinDatos ? `<span class="ft-nodata">—</span>` : pctCell(item.pct_ralenti);
    const horometro = item.horometro_total !== null ? `${item.horometro_total.toLocaleString("es-PE")}h` : "—";
    const estado    = item.engine_state === 1
      ? `<span class="ft-state-on" title="Encendido"></span>`
      : `<span class="ft-state-off" title="Apagado"></span>`;

    return `
      <tr data-equipo="${item.equipo}" data-desc="${item.descripcion || ""}" data-proy="${item.descripcion_proyecto || ""}">
        <td><span class="ft-equipo">${item.equipo}</span></td>
        <td><span class="ft-desc">${item.descripcion || "—"}</span></td>
        <td>${horasOn}</td>
        <td>${pctUtil}</td>
        <td>${pctRal}</td>
        <td>${horometro}</td>
        <td>${estado}</td>
      </tr>
    `;
  }).join("");

  // Click en fila → abrir telemetría individual
  tbody.querySelectorAll("tr[data-equipo]").forEach(row => {
    row.addEventListener("click", () => {
      closeReporteFlota();
      openTelemetria(row.dataset.equipo, row.dataset.desc, row.dataset.proy);
    });
  });
}

function pctCell(val) {
  if (val === null || val === undefined) return `<span class="ft-nodata">—</span>`;
  const cls = val >= 60 ? "ft-pct-high" : val >= 30 ? "ft-pct-mid" : "ft-pct-low";
  return `<span class="${cls}">${val.toFixed(1)}%</span>`;
}

/* ══════════════════════════════════════════════
   KPIs DEL MODAL — actualiza según filtro activo
══════════════════════════════════════════════ */
function _actualizarKpisModal(items) {
  const conD   = items.filter(x => x.sync_ok && x.horas_on !== null);
  const totON  = conD.reduce((s, x) => s + (x.horas_on  || 0), 0);
  const totOFF = conD.reduce((s, x) => s + (x.horas_off || 0), 0);
  const pctU   = totON + totOFF > 0 ? (totON / (totON + totOFF) * 100) : 0;
  const masU   = conD.length
    ? conD.reduce((a, b) => (b.pct_utilizacion||0) > (a.pct_utilizacion||0) ? b : a, conD[0])
    : null;
  const masR   = conD.length
    ? conD.reduce((a, b) => (b.pct_ralenti||0) > (a.pct_ralenti||0) ? b : a, conD[0])
    : null;
  el("fTotalOn").textContent    = totON > 0 ? `${totON.toFixed(1)}h` : "—";
  el("fPctUtil").textContent    = pctU  > 0 ? `${pctU.toFixed(1)}%`  : "—";
  el("fMasUtil").textContent    = masU ? `${masU.equipo} (${(masU.pct_utilizacion||0).toFixed(1)}%)` : "—";
  el("fMasRalenti").textContent = masR ? `${masR.equipo} (${(masR.pct_ralenti||0).toFixed(1)}%)`    : "—";
}

/* ══════════════════════════════════════════════
   FILTROS PDF — inicializa selects del modal
══════════════════════════════════════════════ */
function _initPdfFilters() {
  const tipoSel  = el("pdfTipo");
  const grupoSub = el("pdfGrupoSub");
  const subSel   = el("pdfSubVal");
  const subLbl   = el("pdfSubLabel");

  // Ocultar "Por cliente" si no es admin
  const optCli = tipoSel.querySelector('option[value="cliente"]');
  // Ocultar 'Por cliente' si es admin en modo preview (se comporta como cliente)
  if (optCli) optCli.style.display = (isAdmin && !previewCliente) ? "" : "none";

  tipoSel.value = "general";
  grupoSub.style.display = "none";

  const _actualizarTabla = () => {
    const tipo2 = tipoSel.value;
    const sub2  = subSel.value;
    if (!telemetriaCache) return;
    let filtered = [...(telemetriaCache.items || [])];
    if (tipo2 === "cliente" && sub2)   filtered = filtered.filter(x => (x.codigo_cliente || "") === sub2);
    if (tipo2 === "proyecto" && sub2)  filtered = filtered.filter(x => (x.descripcion_proyecto || "").trim() === sub2);
    renderTablaFlota(filtered);
    // Actualizar KPIs del modal según filtro
    _actualizarKpisModal(filtered);
  };

  subSel.onchange = _actualizarTabla;

  tipoSel.onchange = () => {
    const tipo = tipoSel.value;
    if (tipo === "general") {
      grupoSub.style.display = "none";
      // Restaurar tabla completa
      renderTablaFlota(telemetriaCache?.items || []);
      _actualizarKpisModal(telemetriaCache?.items || []);
      return;
    }
    grupoSub.style.display = "flex";
    if (tipo === "cliente") {
      subLbl.textContent = "Cliente";
      const mapa = {};
      (telemetriaCache?.items || []).forEach(x => {
        const cod = (x.codigo_cliente || "").trim();
        if (cod && !mapa[cod]) mapa[cod] = (x.descripcion_cliente || cod).trim();
      });
      const codigos = Object.keys(mapa).sort((a,b) => mapa[a].localeCompare(mapa[b]));
      subSel.innerHTML = `<option value="">Todos los clientes</option>` +
        codigos.map(c => `<option value="${c}">${mapa[c]}</option>`).join("");
    } else if (tipo === "proyecto") {
      subLbl.textContent = "Proyecto";
      const lista = [...new Set(
        (telemetriaCache?.items || []).map(x => (x.descripcion_proyecto || "").trim())
      )].sort();
      subSel.innerHTML = `<option value="">Todos</option>` +
        lista.map(p => `<option value="${p}">${p || "(Sin proyecto)"}</option>`).join("");
    }
  };
}

/* ══════════════════════════════════════════════
   GENERACIÓN PDF CON jsPDF + autoTable
══════════════════════════════════════════════ */
function descargarPDF() {
  if (!telemetriaCache) { alert("Carga el reporte primero."); return; }

  const tipo    = el("pdfTipo")?.value   || "general";
  const subVal  = el("pdfSubVal")?.value || "";
  const periodo = labelMesActual();
  const btnPDF  = el("btnDescargarPDF");
  if (btnPDF) { btnPDF.disabled = true; btnPDF.textContent = "Generando..."; }

  // ── filtrar items ──────────────────────────────────────────
  // En modo preview, siempre filtrar al cliente simulado
  let items = previewCliente
    ? [...(telemetriaCache.items || [])].filter(x => (x.codigo_cliente || "") === previewCliente.codigo)
    : [...(telemetriaCache.items || [])];
  let titulo   = previewCliente ? `Informe de ${previewCliente.nombre}` : "Informe General de Flota";
  let subtitulo = previewCliente ? previewCliente.nombre : "";

  if (!previewCliente && tipo === "cliente" && subVal) {
    items     = items.filter(x => (x.codigo_cliente || "") === subVal);
    titulo    = "Informe por Cliente";
    subtitulo = subVal;
  } else if (tipo === "proyecto" && subVal) {
    items     = items.filter(x => (x.descripcion_proyecto || "").trim() === subVal);
    titulo    = "Informe por Proyecto";
    subtitulo = subVal;
  }

  const { jsPDF } = window.jspdf;
  const doc   = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  const VERDE  = [12, 83, 76];
  const AMARIL = [197, 232, 108];
  const BLANCO = [255, 255, 255];
  const GRIS   = [40, 60, 55];
  const MUTED  = [120, 148, 144];
  const BG     = [240, 247, 244];

  // ── HEADER ────────────────────────────────────────────────
  doc.setFillColor(...VERDE);
  doc.rect(0, 0, pageW, 28, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(...BLANCO);
  doc.text("CGM RENTAL", 12, 11);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(200, 225, 220);
  doc.text("Portal de Equipos John Deere", 12, 17);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(...BLANCO);
  doc.text(titulo, pageW / 2, 12, { align: "center" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...AMARIL);
  if (subtitulo) {
    doc.text(subtitulo, pageW / 2, 19, { align: "center" });
    doc.text(`Período: ${periodo}`, pageW / 2, 24, { align: "center" });
  } else {
    doc.text(`Período: ${periodo}`, pageW / 2, 19, { align: "center" });
  }

  const ahora = new Date().toLocaleString("es-PE", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" });
  doc.setFontSize(7.5);
  doc.setTextColor(200, 225, 220);
  doc.text(`Generado: ${ahora}`, pageW - 12, 24, { align: "right" });

  // ── KPIs RESUMEN ──────────────────────────────────────────
  const conD  = items.filter(x => x.sync_ok && x.horas_on !== null);
  const totON = conD.reduce((s, x) => s + (x.horas_on  || 0), 0);
  const totOF = conD.reduce((s, x) => s + (x.horas_off || 0), 0);
  const util  = totON + totOF > 0 ? (totON / (totON + totOF) * 100) : 0;
  const masU  = conD.length ? conD.reduce((a, b) => (b.pct_utilizacion||0) > (a.pct_utilizacion||0) ? b : a, conD[0]) : null;

  const kpiY = 32;  const kpiH = 14;  const kpiW = (pageW - 24) / 4;
  [
    { l: "Total Equipos",        v: items.length.toString() },
    { l: "Total Horas ON",       v: totON > 0 ? `${totON.toFixed(1)} h` : "—" },
    { l: "Utilización Promedio", v: util > 0  ? `${util.toFixed(1)}%`  : "—" },
    { l: "Más Utilizada",        v: masU ? `${masU.equipo} (${(masU.pct_utilizacion||0).toFixed(1)}%)` : "—" },
  ].forEach((k, i) => {
    const x = 12 + i * kpiW;
    doc.setFillColor(...BG);
    doc.roundedRect(x, kpiY, kpiW - 3, kpiH, 2, 2, "F");
    doc.setDrawColor(...VERDE);
    doc.setLineWidth(0.3);
    doc.roundedRect(x, kpiY, kpiW - 3, kpiH, 2, 2, "S");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.text(k.l.toUpperCase(), x + (kpiW-3)/2, kpiY + 4.5, { align: "center" });
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(...GRIS);
    doc.text(k.v, x + (kpiW-3)/2, kpiY + 10.5, { align: "center" });
  });

  // ── TABLA ─────────────────────────────────────────────────
  const fN = (v, d=1) => (v !== null && v !== undefined) ? Number(v).toFixed(d) : "—";
  const fP = v => (v !== null && v !== undefined) ? Number(v).toFixed(1) + "%" : "—";

  doc.autoTable({
    startY: kpiY + kpiH + 4,
    columns: [
      { header: "Equipo",       dataKey: "equipo" },
      { header: "Descripción",  dataKey: "desc" },
      { header: "Proyecto",     dataKey: "proy" },
      { header: "Hrs ON",       dataKey: "hon" },
      { header: "Hrs OFF",      dataKey: "hoff" },
      { header: "% Util.",      dataKey: "putil" },
      { header: "% Ralentí",   dataKey: "pral" },
      { header: "Horómetro",   dataKey: "horo" },
      { header: "Combust.",     dataKey: "fuel" },
      { header: "Estado",       dataKey: "est" },
    ],
    body: items.map(x => ({
      equipo: x.equipo || "—",
      desc:   x.descripcion || "—",
      proy:   (x.descripcion_proyecto || "").trim() || "—",
      hon:    x.horas_on  !== null ? fN(x.horas_on)  + " h" : "—",
      hoff:   x.horas_off !== null ? fN(x.horas_off) + " h" : "—",
      putil:  fP(x.pct_utilizacion),
      pral:   fP(x.pct_ralenti),
      horo:   x.horometro_total !== null ? fN(x.horometro_total, 0) + " h" : "—",
      fuel:   x.fuel_litros_x_hora !== null ? fN(x.fuel_litros_x_hora, 2) + " L/h" : "—",
      est:    x.engine_state === 1 ? "ON" : "OFF",
    })),
    theme: "grid",
    styles: { fontSize: 7.5, cellPadding: 2.2, valign: "middle" },
    headStyles: { fillColor: VERDE, textColor: BLANCO, fontStyle: "bold", halign: "center" },
    alternateRowStyles: { fillColor: BG },
    columnStyles: {
      equipo: { fontStyle:"bold", textColor:VERDE, halign:"center", cellWidth:20 },
      desc:   { cellWidth: 38 },
      proy:   { cellWidth: 44, fontSize: 7 },
      hon:    { halign:"right", cellWidth:16 },
      hoff:   { halign:"right", cellWidth:16 },
      putil:  { halign:"center", cellWidth:15 },
      pral:   { halign:"center", cellWidth:15 },
      horo:   { halign:"right",  cellWidth:20 },
      fuel:   { halign:"right",  cellWidth:20 },
      est:    { halign:"center", cellWidth:14 },
    },
    didParseCell: data => {
      if (data.section !== "body") return;
      if (data.column.dataKey === "est") {
        data.cell.styles.textColor = data.cell.raw === "ON" ? [5,120,80] : MUTED;
        data.cell.styles.fontStyle = "bold";
      }
      if (data.column.dataKey === "putil") {
        const v = parseFloat(data.cell.raw);
        if (!isNaN(v)) {
          data.cell.styles.textColor = v>=60 ? [5,120,80] : v>=30 ? [180,120,0] : [180,40,40];
          data.cell.styles.fontStyle = "bold";
        }
      }
    },
    margin: { left:12, right:12 },
    didDrawPage: data => {
      const pg  = doc.internal.getCurrentPageInfo().pageNumber;
      const tot = doc.internal.getNumberOfPages();
      doc.setFontSize(7);
      doc.setTextColor(...MUTED);
      doc.text(`CGM Rental · Portal de Equipos John Deere · ${periodo}`, 12, pageH - 5);
      doc.text(`Página ${pg} de ${tot}`, pageW - 12, pageH - 5, { align: "right" });
      doc.setDrawColor(...VERDE);
      doc.setLineWidth(0.3);
      doc.line(12, pageH - 8, pageW - 12, pageH - 8);
    },
  });

  const sfx = tipo === "cliente" && subVal  ? `_cliente_${subVal}`
            : tipo === "proyecto" && subVal ? `_proy_${subVal.replace(/[^a-zA-Z0-9]/g,"_").slice(0,25)}`
            : "";
  doc.save(`CGM_Reporte_${periodo.replace(/ /g,"_")}${sfx}.pdf`);

  const ico = `<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M7.5 1v9M4 7l3.5 3.5L11 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M1 12h13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  if (btnPDF) { btnPDF.disabled = false; btnPDF.innerHTML = `${ico} Descargar PDF`; }
}

/* ══════════════════════════════════════════════
   MODO PREVIEW — simula vista de cliente real
══════════════════════════════════════════════ */
function entrarModoPreview() {
  const sel     = el("fCliente");
  const codigo  = sel?.value;
  const nombre  = sel?.options[sel.selectedIndex]?.text || codigo;
  if (!codigo) return;

  previewCliente = { codigo, nombre };

  // 1. Barra naranja visible
  el("previewNombre").textContent = nombre;
  el("previewBar").style.display  = "block";
  document.body.classList.add("preview-activo");

  // 2. Ocultar todo lo admin del sidebar
  el("sectionFCliente").style.display = "none";

  // 3. Filtrar equipos solo a ese cliente
  renderProyectoFilter();
  applyFilters();

  // 4. Invalidar cache de telemetría para que recargue filtrado
  telemetriaCache = null;
}

function salirModoPreview() {
  previewCliente = null;

  // 1. Ocultar barra naranja
  el("previewBar").style.display = "none";
  document.body.classList.remove("preview-activo");

  // 2. Restaurar sidebar admin
  el("sectionFCliente").style.display = "block";
  el("fCliente").value = "";
  el("btnVerComoCliente").style.display = "none";

  // 3. Restaurar proyectos y cards
  renderProyectoFilter();
  applyFilters();

  // 4. Invalidar cache
  telemetriaCache = null;
}

function closeReporteFlota() {
  el("modalFlotaBack").style.display = "none";
}

/* ══════════════════════════════════════════════
   HELPERS FECHA
══════════════════════════════════════════════ */
function fmtMes(dateStr) {
  const meses = ["Enero","Febrero","Marzo","Abril","Mayo","Junio",
                 "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  const d = new Date(dateStr + "T00:00:00");
  return `${meses[d.getMonth()]} ${d.getFullYear()}`;
}

function labelMesActual() {
  const meses = ["Enero","Febrero","Marzo","Abril","Mayo","Junio",
                 "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  const hoy = new Date();
  return `${meses[hoy.getMonth()]} ${hoy.getFullYear()}`;
}

function fmtDateTime(str) {
  if (!str) return "";
  const d = new Date(str);
  return d.toLocaleString("es-PE", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

/* ══════════════════════════════════════════════
   HELPERS UI
══════════════════════════════════════════════ */
function showError(node, msg) {
  node.textContent = msg;
  node.style.display = "block";
}

function animateCount(target) {
  const elCount = el("countEquipos");
  if (!elCount) return;
  const suffix = target === 1 ? " equipo" : " equipos";
  let current = 0;
  const steps = 20;
  const increment = target / steps;
  const timer = setInterval(() => {
    current += increment;
    if (current >= target) {
      clearInterval(timer);
      elCount.textContent = target + suffix;
    } else {
      elCount.textContent = Math.floor(current) + suffix;
    }
  }, 30);
}

async function ping() {
  const me = await api("/api/me");
  if (!me.data?.ok) setPill("Sesión expirada", false);
}

/* ══════════════════════════════════════════════
   INIT
══════════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", async () => {

  setupPinInputs();

  // Auth
  el("formEmail").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = el("inputEmail").value.trim();
    if (!email) return showError(el("errorEmail"), "Por favor ingresa tu correo.");
    await solicitarPin(email);
  });

  el("formPin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pin = el("inputPin").value;
    if (pin.length !== 6) return showError(el("errorPin"), "Ingresa los 6 dígitos del código.");
    await verificarPin(pin);
  });

  el("btnVolverEmail").addEventListener("click", () => {
    stopPinTimer();
    el("errorEmail").style.display = "none";
    el("errorPin").style.display   = "none";
    el("inputEmail").value = "";
    showStep("email");
  });

  el("btnReenviarPin").addEventListener("click", async () => {
    if (!currentEmail) return;
    el("btnReenviarPin").disabled = true;
    await solicitarPin(currentEmail);
    setTimeout(() => { el("btnReenviarPin").disabled = false; }, 30000);
  });

  el("btnLogout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    telemetriaCache = null;
    showView("auth");
  });

  // Modal básico
  el("mClose").addEventListener("click", closeModal);
  el("mOk").addEventListener("click", closeModal);
  el("modalBack").addEventListener("click", (e) => {
    if (e.target === el("modalBack")) closeModal();
  });

  // Botón "Ver telemetría" en modal básico
  el("mVerTelemetria").addEventListener("click", () => {
    if (currentModalEquipo) {
      openTelemetria(
        currentModalEquipo.equipo,
        currentModalEquipo.descripcion,
        currentModalEquipo.descripcion_proyecto
      );
    }
  });

  // Modal telemetría
  el("tClose").addEventListener("click", closeTelemetria);
  el("tClose2").addEventListener("click", closeTelemetria);
  el("modalTelBack").addEventListener("click", (e) => {
    if (e.target === el("modalTelBack")) closeTelemetria();
  });

  // Pestañas de telemetría
  document.querySelectorAll(".tel-tab").forEach(tab => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // Modal reporte flota
  el("btnReporteMes").addEventListener("click", openReporteFlota);
  el("fClose").addEventListener("click", closeReporteFlota);
  el("fClose2").addEventListener("click", closeReporteFlota);
  el("modalFlotaBack").addEventListener("click", (e) => {
    if (e.target === el("modalFlotaBack")) closeReporteFlota();
  });

  // Filtros
  // Botón PDF
  el("btnDescargarPDF")?.addEventListener("click", descargarPDF);

  // Filtros sidebar
  el("search")?.addEventListener("input", applyFilters);
  el("fCliente")?.addEventListener("change", () => {
    renderProyectoFilter();
    applyFilters();
    // Mostrar/ocultar botón ver-como
    const cod = el("fCliente").value;
    const btn = el("btnVerComoCliente");
    if (btn) btn.style.display = cod ? "flex" : "none";
  });
  el("fProyecto")?.addEventListener("change", applyFilters);

  // Vista inicial
  // Cargar portal (detecta isAdmin y activa filtro cliente)
  const { data } = await api("/api/me");
  if (data?.ok) {
    await cargarPortal();
  } else if (window.location.pathname === "/acceso-denegado") {
    showView("denied");
  } else {
    showView("auth");
  }

  // Ver como cliente
  el("btnVerComoCliente")?.addEventListener("click", entrarModoPreview);
  el("btnSalirPreview")?.addEventListener("click", salirModoPreview);

  setInterval(ping, 10 * 60 * 1000);
});