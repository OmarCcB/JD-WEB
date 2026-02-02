const el = (id) => document.getElementById(id);

let equipos = [];

function setPill(text, ok=true){
  const p = el("statusPill");
  p.textContent = text;
  p.style.background = ok ? "#ecfdf5" : "#fef2f2";
  p.style.color = ok ? "#065f46" : "#991b1b";
  p.style.borderColor = ok ? "#bbf7d0" : "#fecaca";
}

async function api(path, opts={}){
  const res = await fetch(path, { credentials:"include", ...opts });
  const data = await res.json().catch(()=> ({}));
  return { res, data };
}

function uniqueAll(arr){
  return [...new Set(arr.map(x => (x ?? "").toString().trim()))];
}

function renderProyectoFilter(){
  const proyectosRaw = equipos.map(x => (x.descripcion_proyecto || "").trim());
  const proyectos = uniqueAll(proyectosRaw);

  const fP = el("fProyecto");
  fP.innerHTML =
    `<option value="">Todos los proyectos</option>` +
    proyectos.map(d => `<option value="${d}">${d || "(Sin proyecto)"}</option>`).join("");
}

function applyFilters(){
  const q = (el("search").value || "").toLowerCase();
  const proj = el("fProyecto").value;

  const items = equipos.filter(x => {
    const matchQ =
      (x.equipo || "").toLowerCase().includes(q) ||
      (x.descripcion || "").toLowerCase().includes(q);

    const matchP = !proj || ((x.descripcion_proyecto || "").trim() === proj);

    return matchQ && matchP;
  });

  el("countEquipos").textContent = `${items.length} equipo(s)`;

  const grid = el("cardsGrid");

  if(items.length === 0){
    grid.innerHTML = `<div class="deny-box">Sin resultados</div>`;
    return;
  }

  grid.innerHTML = items.map(x => `
    <article class="eCard">
      <div class="eTop">
        <div>
          <div class="eEquipo">${x.equipo ?? ""}</div>
          <div class="meta">${(x.descripcion_proyecto ?? "")}</div>
        </div>
        <div class="badge">${x.fabricante ?? ""}</div>
      </div>

      <div class="eDesc">${x.descripcion ?? ""}</div>

      <div class="metaRow">
        <span class="tag">País de origen: ${x.pais ?? "—"}</span>
      </div>

      <div class="rowBtns">
        <button class="btn primary" data-equipo="${x.equipo ?? ""}">Ver detalle</button>
      </div>
    </article>
  `).join("");

  grid.querySelectorAll("button[data-equipo]").forEach(btn => {
    btn.addEventListener("click", () => {
      const eq = btn.getAttribute("data-equipo");
      const item = equipos.find(e => e.equipo === eq);
      if(item) openModal(item);
    });
  });
}

function openModal(item){
  el("mEquipo").textContent = item.equipo ?? "—";
  el("mProyecto").textContent = (item.descripcion_proyecto ?? "").trim();
  el("mDesc").textContent = item.descripcion ?? "—";
  el("mFab").textContent = item.fabricante ?? "—";
  el("mPais").textContent = item.pais ?? "—";
  el("modalBack").style.display = "flex";
}

function closeModal(){
  el("modalBack").style.display = "none";
}

async function load(){
  const me = await api("/api/me");
  if(!me.data?.ok){
    el("denyBox").style.display = "block";
    setPill("Acceso no disponible", false);
    el("cardsGrid").innerHTML = `<div class="deny-box">Acceso no disponible</div>`;
    return;
  }

  el("clienteNombre").textContent = `${me.data.descripcion_cliente || ""}`.trim();
  setPill("Acceso activo", true);

  const r = await api("/api/equipos");
  if(!r.data?.ok){
    el("denyBox").style.display = "block";
    setPill("Acceso no disponible", false);
    el("cardsGrid").innerHTML = `<div class="deny-box">Acceso no disponible</div>`;
    return;
  }

  equipos = r.data.items || [];
  renderProyectoFilter();
  applyFilters();
}

async function ping(){
  const me = await api("/api/me");
  if(!me.data?.ok){
    setPill("Acceso no disponible", false);
    el("denyBox").style.display = "block";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  el("search").addEventListener("input", applyFilters);
  el("fProyecto").addEventListener("change", applyFilters);

  el("btnLogout").addEventListener("click", async () => {
    await api("/api/logout", { method:"POST" });
    location.href = "/acceso-denegado";
  });

  el("mClose").addEventListener("click", closeModal);
  el("mOk").addEventListener("click", closeModal);
  el("modalBack").addEventListener("click", (e) => {
    if(e.target === el("modalBack")) closeModal();
  });

  load();
  setInterval(ping, 10 * 60 * 1000);
});
