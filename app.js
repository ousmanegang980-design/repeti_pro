/* RépétiPro 1.0 — application offline-first (IndexedDB). Aucune donnée fictive par défaut. */
"use strict";
const L = window.RPLogic;
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10));
const nowISO = () => new Date().toISOString();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MOYENS = { especes: "Espèces", mobile_money: "Mobile Money", virement: "Virement", autre: "Autre" };
const CYCLES = { primaire: "Primaire", college: "Collège", lycee: "Lycée" };

/* ---------------- IndexedDB ---------------- */
const DB_NAME = "repetipro", DB_VERSION = 1;
const STORES = ["eleves", "repetitions", "periodes", "paiements", "recus", "syncops", "meta"];
let db = null;
function openDB() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, DB_VERSION);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      for (const name of STORES) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: "id" });
    };
    rq.onsuccess = () => { db = rq.result; res(db); };
    rq.onerror = () => rej(rq.error);
  });
}
function tx(storeNames, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(storeNames, mode);
    const out = fn(...storeNames.map((n) => t.objectStore(n)));
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error("Transaction annulée"));
  });
}
const reqP = (rq) => new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
const getAll = (store) => tx([store], "readonly", (s) => reqP(s.getAll())).then((p) => p);
async function allOf(store) { return await tx([store], "readonly", (s) => reqP(s.getAll())); }
async function putOne(store, obj) { await tx([store], "readwrite", (s) => s.put(obj)); }
async function getOne(store, id) { return await tx([store], "readonly", (s) => reqP(s.get(id))); }

/* ---------------- État + paramètres ---------------- */
let S = { eleves: [], repetitions: [], periodes: [], paiements: [], recus: [], syncops: [] };
let settings = { id: "settings", activite: "", slogan: "", telephone: "", coordonnees: "", devise: "FCFA", formatRecu: "A4",
  notifAvant: true, notifJourJ: true, notifApres: true, delaiApres: 2, rappelsVus: [] };
let currentView = "dashboard", currentEleveId = null, filtreEcheance = "aujourdhui", submitting = false;

async function reload() {
  for (const k of ["eleves", "repetitions", "periodes", "paiements", "recus", "syncops"]) S[k] = await allOf(k);
  const st = await getOne("meta", "settings");
  if (st) settings = Object.assign(settings, st);
}
async function saveSettings() { await putOne("meta", settings); }
async function logSync(typeEntite, entiteId, operation) {
  await putOne("syncops", { id: uid(), typeEntite, entiteId, operation, statut: "en_attente", tentatives: 0, derniereErreur: "", updatedAt: nowISO() });
}

/* ---------------- Calculs ---------------- */
const paiementsValides = (periodeId) => S.paiements.filter((p) => p.periodeId === periodeId && p.statut === "valide");
function calcPeriode(per) {
  const s = L.soldePeriode(per.montantDu, paiementsValides(per.id));
  return { periode: per, ...s, statut: L.statutPeriode(per, s.montantPaye, L.todayISO()) };
}
const toutesPeriodesCalc = () => S.periodes.map(calcPeriode);
function contextePeriode(per) {
  const rep = S.repetitions.find((r) => r.id === per.repetitionId);
  const eleve = rep ? S.eleves.find((e) => e.id === rep.eleveId) : null;
  return { rep, eleve };
}
function soldeEleve(eleveId) {
  let du = 0;
  for (const c of toutesPeriodesCalc()) {
    const { eleve } = contextePeriode(c.periode);
    if (eleve && eleve.id === eleveId && c.statut !== "annulee" && c.statut !== "suspendue") du += Math.max(0, c.solde);
  }
  return du;
}
function situationEleve(eleveId) {
  const calcs = toutesPeriodesCalc().filter((c) => { const { eleve } = contextePeriode(c.periode); return eleve && eleve.id === eleveId; });
  if (calcs.some((c) => c.statut === "en_retard" || c.statut === "partiel_en_retard")) return "en_retard";
  if (calcs.some((c) => c.solde > 0 && c.statut !== "annulee" && c.statut !== "suspendue")) return "dette";
  return "a_jour";
}
const fmt = (v) => L.formatMontant(v, settings.devise);
const badgeStatut = (st) => `<span class="badge b-${st}">${esc(L.LIBELLES_STATUT[st] || st)}</span>`;

/* ---------------- UI générique ---------------- */
function toast(msg, err) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast" + (err ? " err" : "");
  setTimeout(() => t.classList.add("hidden"), err ? 4500 : 3000);
}
function openModal(titre, html) { $("#modalTitle").textContent = titre; $("#modalBody").innerHTML = html; $("#modal").classList.remove("hidden"); }
function closeModal() { $("#modal").classList.add("hidden"); $("#modalBody").innerHTML = ""; }
$("#modalClose").addEventListener("click", closeModal);
function confirmBox(titre, message, labelOk) {
  return new Promise((res) => {
    openModal(titre, `<p>${message}</p><div class="quick-actions">
      <button class="btn btn-primary" id="cfOk" type="button">${esc(labelOk || "Confirmer")}</button>
      <button class="btn btn-light" id="cfNo" type="button">Annuler</button></div>`);
    $("#cfOk").onclick = () => { closeModal(); res(true); };
    $("#cfNo").onclick = () => { closeModal(); res(false); };
  });
}
function emptyState(icone, titre, texte, actionHtml) {
  return `<div class="empty"><div class="big">${icone}</div><p><strong>${esc(titre)}</strong></p><p>${esc(texte)}</p>${actionHtml || ""}</div>`;
}
function erreursHtml(errs) { return errs.length ? `<div class="errors">${errs.map((e) => "• " + esc(e)).join("<br>")}</div>` : ""; }
function download(blob, nom) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = nom;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}
function showView(name) {
  currentView = name;
  $$(".view").forEach((v) => v.classList.add("hidden"));
  $("#view-" + name).classList.remove("hidden");
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.nav === name));
  $("#menuPlus").classList.add("hidden");
  window.scrollTo(0, 0);
  render();
}
async function refresh() { await reload(); render(); verifierRappels(); }
function render() {
  ({ dashboard: renderDashboard, eleves: renderEleves, fiche: renderFiche, echeances: renderEcheances,
     paiements: renderPaiements, recus: renderRecus, rapports: renderRapports, synchro: renderSynchro,
     parametres: renderParams }[currentView] || renderDashboard)();
}

/* ---------------- A. Tableau de bord ---------------- */
function renderDashboard() {
  const jour = L.todayISO(), mois = jour.slice(0, 7);
  const calcs = toutesPeriodesCalc();
  const encaisseMois = S.paiements.filter((p) => p.statut === "valide" && p.datePaiement.startsWith(mois)).reduce((a, p) => a + p.montant, 0);
  const restant = calcs.filter((c) => !["annulee", "suspendue", "payee"].includes(c.statut)).reduce((a, c) => a + Math.max(0, c.solde), 0);
  const retard = calcs.filter((c) => c.statut === "en_retard" || c.statut === "partiel_en_retard");
  const montantRetard = retard.reduce((a, c) => a + Math.max(0, c.solde), 0);
  const annules = S.paiements.filter((p) => p.statut === "annule").reduce((a, p) => a + p.montant, 0);
  $("#kpis").innerHTML = [
    ["Élèves actifs", S.eleves.filter((e) => e.statut === "actif").length, ""],
    ["Élèves archivés", S.eleves.filter((e) => e.statut === "archive").length, ""],
    ["Encaissé ce mois (réel)", fmt(encaisseMois), "positif"],
    ["Reste à recevoir (attendu)", fmt(restant), "attente"],
    ["Échéances aujourd'hui", calcs.filter((c) => c.statut === "aujourd_hui").length, "attente"],
    ["En retard", retard.length + " — " + fmt(montantRetard), "alerte"],
    ["Paiements annulés (non comptés)", fmt(annules), ""],
  ].map(([l, v, c]) => `<div class="kpi ${c}"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
  const prochaines = calcs.filter((c) => !["payee", "annulee", "suspendue"].includes(c.statut))
    .sort((a, b) => a.periode.dateEcheance.localeCompare(b.periode.dateEcheance)).slice(0, 5);
  $("#dashEcheances").innerHTML = prochaines.length ? prochaines.map(ligneEcheance).join("")
    : emptyState("📅", "Aucune échéance en attente", "Créez un élève puis une répétition : la première échéance sera calculée automatiquement (+1 mois calendaire).");
  const derniers = [...S.paiements].sort((a, b) => b.datePaiement.localeCompare(a.datePaiement)).slice(0, 5);
  $("#dashPaiements").innerHTML = derniers.length ? derniers.map(lignePaiement).join("")
    : emptyState("💰", "Aucun paiement enregistré", "Les encaissements réels apparaîtront ici. Une simple échéance n'est jamais comptée comme une recette.");
  bindRowActions($("#view-dashboard"));
}
function ligneEcheance(c) {
  const { eleve, rep } = contextePeriode(c.periode);
  return `<div class="row"><div><div class="t">${esc(eleve ? eleve.nomComplet : "?")} — ${esc(rep ? rep.matière : "")}</div>
    <div class="s">Échéance : ${L.formatDateFR(c.periode.dateEcheance)} · Période débutée le ${L.formatDateFR(c.periode.dateDebut)}</div>
    <div class="s">Dû ${fmt(c.montantDu)} · Payé ${fmt(c.montantPaye)} · Reste <strong>${fmt(Math.max(0, c.solde))}</strong></div></div>
    <div>${badgeStatut(c.statut)}<div class="actions-row">
    <button class="btn btn-teal" data-action="payer-periode" data-id="${c.periode.id}" type="button">Encaisser</button>
    <button class="btn btn-light" data-action="ics-periode" data-id="${c.periode.id}" type="button">📆 Calendrier</button>
    <button class="btn btn-light" data-action="renouveler" data-id="${c.periode.id}" type="button">Renouveler</button></div></div></div>`;
}
function lignePaiement(p) {
  const per = S.periodes.find((x) => x.id === p.periodeId);
  const { eleve, rep } = per ? contextePeriode(per) : {};
  const reçu = S.recus.find((r) => r.paiementId === p.id);
  return `<div class="row"><div><div class="t">${esc(eleve ? eleve.nomComplet : "?")} — ${esc(rep ? rep.matière : "")}</div>
    <div class="s">${L.formatDateFR(p.datePaiement.slice(0, 10))} · ${esc(MOYENS[p.moyenPaiement] || p.moyenPaiement)}${p.reference ? " · Réf. " + esc(p.reference) : ""}${reçu ? " · Reçu " + esc(reçu.numero) : ""}</div>
    ${p.statut === "annule" ? `<div class="s">Annulé : ${esc(p.motifAnnulation || "")}</div>` : ""}</div>
    <div><span class="montant">${fmt(p.montant)}</span> ${p.statut === "annule" ? '<span class="badge b-annule">Annulé</span>' : ""}
    <div class="actions-row">${reçu ? `<button class="btn btn-light" data-action="voir-recu" data-id="${reçu.id}" type="button">Reçu</button>` : ""}
    ${p.statut === "valide" ? `<button class="btn btn-danger" data-action="annuler-paiement" data-id="${p.id}" type="button">Annuler…</button>` : ""}</div></div></div>`;
}

/* ---------------- B. Élèves ---------------- */
function renderEleves() {
  const q = ($("#rechercheEleve").value || "").toLowerCase();
  const cycle = $("#filtreCycle").value, statut = $("#filtreStatut").value, sit = $("#filtrePaiement").value;
  let liste = S.eleves.filter((e) =>
    (!q || (e.nomComplet + " " + e.classe + " " + (e.telephone || "")).toLowerCase().includes(q)) &&
    (!cycle || e.cycle === cycle) && (!statut || e.statut === statut) &&
    (!sit || situationEleve(e.id) === sit));
  liste.sort((a, b) => a.nomComplet.localeCompare(b.nomComplet, "fr"));
  $("#listeEleves").innerHTML = liste.length ? liste.map((e) => {
    const solde = soldeEleve(e.id), sitE = situationEleve(e.id);
    const mats = S.repetitions.filter((r) => r.eleveId === e.id).map((r) => r.matière).join(", ");
    return `<div class="row"><div><div class="t">${esc(e.nomComplet)}</div>
      <div class="s">${esc(e.classe)} · ${esc(CYCLES[e.cycle] || "")}${mats ? " · " + esc(mats) : ""}${e.telephone ? " · " + esc(e.telephone) : ""}</div>
      <div class="s">${solde > 0 ? "Solde dû : <strong>" + fmt(solde) + "</strong>" : "À jour"}</div></div>
      <div><span class="badge b-${e.statut}">${e.statut === "actif" ? "Actif" : "Archivé"}</span>
      ${sitE === "en_retard" ? '<span class="badge b-en_retard">En retard</span>' : ""}
      <div class="actions-row"><button class="btn btn-primary" data-action="fiche" data-id="${e.id}" type="button">Fiche</button></div></div></div>`;
  }).join("") : emptyState("👩🏽‍🎓", "Aucun élève", S.eleves.length ? "Aucun élève ne correspond aux filtres." : "Ajoutez votre premier élève pour commencer.",
    `<button class="btn btn-primary" data-action="new-eleve" type="button">+ Ajouter un élève</button>`);
  bindRowActions($("#view-eleves"));
}
function formEleve(eleve) {
  const e = eleve || { nomComplet: "", classe: "", cycle: "college", etablissement: "", parent: "", telephone: "", matieres: "", tarifMensuel: "", dateDebut: L.todayISO(), notes: "" };
  openModal(eleve ? "Modifier l'élève" : "Nouvel élève", `
  <form id="fEleve" class="stack">
    <div id="fEleveErr"></div>
    <label class="field">Nom complet *<input name="nomComplet" class="input" required value="${esc(e.nomComplet)}"></label>
    <label class="field">Classe / niveau *<input name="classe" class="input" required value="${esc(e.classe)}" placeholder="Ex : 3e, Terminale D, CM2…"></label>
    <label class="field">Cycle *<select name="cycle" class="input">
      ${Object.entries(CYCLES).map(([k, v]) => `<option value="${k}" ${e.cycle === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    <label class="field">Établissement (facultatif)<input name="etablissement" class="input" value="${esc(e.etablissement || "")}"></label>
    <label class="field">Parent / tuteur (facultatif)<input name="parent" class="input" value="${esc(e.parent || "")}"></label>
    <label class="field">Téléphone (facultatif)<input name="telephone" class="input" inputmode="tel" value="${esc(e.telephone || "")}"></label>
    <label class="field">Matière(s) (facultatif, séparées par des virgules)<input name="matieres" class="input" value="${esc(e.matieres || "")}" placeholder="Mathématiques, Physique"></label>
    <label class="field">Tarif mensuel convenu (${esc(settings.devise)}, entier)<input name="tarifMensuel" class="input" inputmode="numeric" value="${e.tarifMensuel === "" || e.tarifMensuel == null ? "" : e.tarifMensuel}" placeholder="Ex : 25000"></label>
    <label class="field">Date de début<input name="dateDebut" class="input" type="date" value="${esc(e.dateDebut || "")}"></label>
    <label class="field">Notes privées<textarea name="notes" class="input" rows="2">${esc(e.notes || "")}</textarea></label>
    ${!eleve ? `<label class="check"><input type="checkbox" name="creerRepetition" checked> Créer aussi la répétition + la 1ʳᵉ période (échéance = début + 1 mois)</label>` : ""}
    <button class="btn btn-primary" type="submit">${eleve ? "Enregistrer" : "Ajouter l'élève"}</button>
  </form>`);
  $("#fEleve").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const tarifBrut = (f.get("tarifMensuel") || "").toString().trim();
    const data = { nomComplet: f.get("nomComplet").trim(), classe: f.get("classe").trim(), cycle: f.get("cycle"),
      etablissement: f.get("etablissement").trim(), parent: f.get("parent").trim(), telephone: f.get("telephone").trim(),
      matieres: f.get("matieres").trim(), tarifMensuel: tarifBrut === "" ? null : Number(tarifBrut),
      dateDebut: f.get("dateDebut") || L.todayISO(), notes: f.get("notes").trim() };
    if (tarifBrut !== "" && !/^\d+$/.test(tarifBrut)) data.tarifMensuel = NaN;
    const errs = L.validerEleve(data);
    if (!eleve && f.get("creerRepetition") && (!data.matieres || data.tarifMensuel == null || !(data.tarifMensuel >= 0)))
      errs.push("Pour créer la 1ʳᵉ période, indiquez au moins une matière et un tarif mensuel.");
    if (errs.length) { $("#fEleveErr").innerHTML = erreursHtml(errs); return; }
    if (eleve) {
      Object.assign(eleve, data, { updatedAt: nowISO() });
      await putOne("eleves", eleve); await logSync("eleve", eleve.id, "modification");
      toast("Élève modifié.");
    } else {
      const nouvel = { id: uid(), ...data, statut: "actif", createdAt: nowISO(), updatedAt: nowISO() };
      await putOne("eleves", nouvel); await logSync("eleve", nouvel.id, "creation");
      if (f.get("creerRepetition")) {
        const rep = { id: uid(), eleveId: nouvel.id, matière: data.matieres, dateDebut: data.dateDebut,
          tarifConvenu: data.tarifMensuel, frequence: "mensuelle", statut: "active", notes: "", createdAt: nowISO(), updatedAt: nowISO() };
        await putOne("repetitions", rep); await logSync("repetition", rep.id, "creation");
        const per = { id: uid(), repetitionId: rep.id, dateDebut: data.dateDebut, dateEcheance: L.addOneMonth(data.dateDebut),
          montantDu: data.tarifMensuel, statutManuel: "active", createdAt: nowISO(), updatedAt: nowISO() };
        await putOne("periodes", per); await logSync("periode", per.id, "creation");
      }
      toast("Élève ajouté" + (f.get("creerRepetition") ? " avec sa première échéance le " + L.formatDateFR(L.addOneMonth(data.dateDebut)) : "") + ".");
    }
    closeModal(); await refresh();
  };
}

/* ---------------- C/D. Fiche élève, répétitions, périodes ---------------- */
function renderFiche() {
  const e = S.eleves.find((x) => x.id === currentEleveId);
  if (!e) { $("#ficheContenu").innerHTML = emptyState("🤷", "Élève introuvable", "Revenez à la liste des élèves."); return; }
  const reps = S.repetitions.filter((r) => r.eleveId === e.id);
  const calcs = toutesPeriodesCalc().filter((c) => { const x = contextePeriode(c.periode); return x.eleve && x.eleve.id === e.id; })
    .sort((a, b) => b.periode.dateDebut.localeCompare(a.periode.dateDebut));
  const prochaine = calcs.filter((c) => !["payee", "annulee", "suspendue"].includes(c.statut)).sort((a, b) => a.periode.dateEcheance.localeCompare(b.periode.dateEcheance))[0];
  const paiesEleve = S.paiements.filter((p) => { const per = S.periodes.find((x) => x.id === p.periodeId); return per && contextePeriode(per).eleve?.id === e.id; })
    .sort((a, b) => b.datePaiement.localeCompare(a.datePaiement));
  const recusEleve = S.recus.filter((r) => r.snapshot.eleveId === e.id).sort((a, b) => b.dateGeneration.localeCompare(a.dateGeneration));
  $("#ficheContenu").innerHTML = `
  <div class="card"><h1>${esc(e.nomComplet)} <span class="badge b-${e.statut}">${e.statut === "actif" ? "Actif" : "Archivé"}</span></h1>
    <p class="s">${esc(e.classe)} · ${esc(CYCLES[e.cycle] || "")}${e.etablissement ? " · " + esc(e.etablissement) : ""}</p>
    <p class="s">${e.parent ? "Parent/tuteur : " + esc(e.parent) + " · " : ""}${e.telephone ? "Tél. : " + esc(e.telephone) + " · " : ""}Début : ${L.formatDateFR(e.dateDebut)}</p>
    ${e.notes ? `<p class="s">📝 ${esc(e.notes)}</p>` : ""}
    <p>Solde dû : <strong>${fmt(soldeEleve(e.id))}</strong> · Prochaine échéance : <strong>${prochaine ? L.formatDateFR(prochaine.periode.dateEcheance) : "—"}</strong></p>
    <div class="actions-row">
      <button class="btn btn-teal" data-action="payer-eleve" data-id="${e.id}" type="button">Enregistrer un paiement</button>
      <button class="btn btn-primary" data-action="new-repetition" data-id="${e.id}" type="button">+ Répétition</button>
      <button class="btn btn-light" data-action="edit-eleve" data-id="${e.id}" type="button">Modifier</button>
      <button class="btn btn-light" data-action="toggle-archive" data-id="${e.id}" type="button">${e.statut === "actif" ? "Archiver" : "Réactiver"}</button>
      <button class="btn btn-danger" data-action="supprimer-eleve" data-id="${e.id}" type="button">Supprimer définitivement…</button>
    </div></div>
  <div class="card"><h2>Répétitions (${reps.length})</h2>
    ${reps.length ? reps.map((r) => `<div class="row"><div><div class="t">${esc(r.matière)}</div>
      <div class="s">Depuis le ${L.formatDateFR(r.dateDebut)} · ${fmt(r.tarifConvenu)} / mois · ${esc(r.statut)}</div></div>
      <div class="actions-row"><button class="btn btn-light" data-action="new-periode" data-id="${r.id}" type="button">+ Nouvelle période</button></div></div>`).join("")
      : emptyState("📚", "Aucune répétition", "Créez une répétition (matière + tarif) pour générer des périodes de facturation.")}</div>
  <div class="card"><h2>Périodes de facturation (${calcs.length})</h2>
    ${calcs.length ? calcs.map((c) => { const { rep } = contextePeriode(c.periode); return `<div class="row"><div>
      <div class="t">${esc(rep ? rep.matière : "")} — du ${L.formatDateFR(c.periode.dateDebut)} au ${L.formatDateFR(c.periode.dateEcheance)}</div>
      <div class="s">Dû ${fmt(c.montantDu)} · Payé ${fmt(c.montantPaye)} · Reste <strong>${fmt(Math.max(0, c.solde))}</strong></div></div>
      <div>${badgeStatut(c.statut)}<div class="actions-row">
      ${c.statut !== "payee" && c.statut !== "annulee" ? `<button class="btn btn-teal" data-action="payer-periode" data-id="${c.periode.id}" type="button">Encaisser</button>` : ""}
      <button class="btn btn-light" data-action="renouveler" data-id="${c.periode.id}" type="button">Renouveler</button>
      ${c.periode.statutManuel === "active" ? `<button class="btn btn-light" data-action="suspendre-periode" data-id="${c.periode.id}" type="button">Suspendre</button>
      <button class="btn btn-danger" data-action="annuler-periode" data-id="${c.periode.id}" type="button">Annuler…</button>`
      : `<button class="btn btn-light" data-action="reactiver-periode" data-id="${c.periode.id}" type="button">Réactiver</button>`}
      </div></div></div>`; }).join("") : '<p class="hint">Aucune période pour le moment.</p>'}</div>
  <div class="card"><h2>Historique des paiements (${paiesEleve.length})</h2>
    ${paiesEleve.length ? paiesEleve.map(lignePaiement).join("") : '<p class="hint">Aucun paiement enregistré pour cet élève.</p>'}</div>
  <div class="card"><h2>Reçus (${recusEleve.length})</h2>
    ${recusEleve.length ? recusEleve.map(ligneRecu).join("") : '<p class="hint">Les reçus sont créés automatiquement à chaque paiement encaissé.</p>'}</div>`;
  bindRowActions($("#view-fiche"));
}
function formRepetition(eleveId) {
  const e = S.eleves.find((x) => x.id === eleveId);
  openModal("Nouvelle répétition — " + e.nomComplet, `
  <form id="fRep" class="stack"><div id="fRepErr"></div>
    <label class="field">Matière / groupe de matières *<input name="matière" class="input" required placeholder="Mathématiques"></label>
    <label class="field">Tarif convenu (${esc(settings.devise)} / mois, entier) *<input name="tarif" class="input" inputmode="numeric" required value="${e.tarifMensuel ?? ""}"></label>
    <label class="field">Date de début *<input name="debut" class="input" type="date" required value="${L.todayISO()}"></label>
    <label class="field">Notes<textarea name="notes" class="input" rows="2"></textarea></label>
    <p class="hint">La première période sera créée avec une échéance à <strong>début + 1 mois calendaire</strong>. Aucune ancienne période ne sera modifiée.</p>
    <button class="btn btn-primary" type="submit">Créer la répétition + 1ʳᵉ période</button></form>`);
  $("#fRep").onsubmit = async (ev) => {
    ev.preventDefault(); const f = new FormData(ev.target);
    const tarif = Number(f.get("tarif")), debut = f.get("debut"), mat = f.get("matière").trim();
    const errs = [];
    if (!mat) errs.push("La matière est obligatoire.");
    if (!Number.isInteger(tarif) || tarif < 0) errs.push("Tarif invalide (entier >= 0).");
    if (!L.parseISODate(debut)) errs.push("Date de début invalide.");
    if (errs.length) { $("#fRepErr").innerHTML = erreursHtml(errs); return; }
    const rep = { id: uid(), eleveId, matière: mat, dateDebut: debut, tarifConvenu: tarif, frequence: "mensuelle", statut: "active", notes: f.get("notes").trim(), createdAt: nowISO(), updatedAt: nowISO() };
    await putOne("repetitions", rep); await logSync("repetition", rep.id, "creation");
    const per = { id: uid(), repetitionId: rep.id, dateDebut: debut, dateEcheance: L.addOneMonth(debut), montantDu: tarif, statutManuel: "active", createdAt: nowISO(), updatedAt: nowISO() };
    await putOne("periodes", per); await logSync("periode", per.id, "creation");
    toast("Répétition créée. Échéance : " + L.formatDateFR(per.dateEcheance) + ".");
    closeModal(); await refresh();
  };
}
function formNouvellePeriode(repetitionId, defautDebut, defautTarif) {
  const rep = S.repetitions.find((r) => r.id === repetitionId);
  const e = S.eleves.find((x) => x.id === rep.eleveId);
  const debut = defautDebut || L.todayISO();
  openModal("Nouvelle période — " + e.nomComplet, `
  <form id="fPer" class="stack"><div id="fPerErr"></div>
    <p class="hint">Matière : <strong>${esc(rep.matière)}</strong>. Confirmez le tarif et la date de début : l'échéance = début + 1 mois calendaire. Les anciennes périodes restent inchangées.</p>
    <label class="field">Date de début *<input name="debut" class="input" type="date" required value="${debut}"></label>
    <label class="field">Montant dû (${esc(settings.devise)}, entier) *<input name="montant" class="input" inputmode="numeric" required value="${defautTarif ?? rep.tarifConvenu}"></label>
    <p class="hint" id="perAperçu"></p>
    <button class="btn btn-primary" type="submit">Confirmer et créer la période</button></form>`);
  const maj = () => { const d = $("#fPer [name=debut]").value; $("#perAperçu").textContent = L.parseISODate(d) ? "Échéance calculée : " + L.formatDateFR(L.addOneMonth(d)) : ""; };
  $("#fPer [name=debut]").addEventListener("change", maj); maj();
  $("#fPer").onsubmit = async (ev) => {
    ev.preventDefault(); const f = new FormData(ev.target);
    const d = f.get("debut"), m = Number(f.get("montant"));
    const errs = [];
    if (!L.parseISODate(d)) errs.push("Date de début invalide.");
    if (!Number.isInteger(m) || m < 0) errs.push("Montant dû invalide (entier >= 0).");
    if (errs.length) { $("#fPerErr").innerHTML = erreursHtml(errs); return; }
    const per = { id: uid(), repetitionId, dateDebut: d, dateEcheance: L.addOneMonth(d), montantDu: m, statutManuel: "active", createdAt: nowISO(), updatedAt: nowISO() };
    await putOne("periodes", per); await logSync("periode", per.id, "creation");
    toast("Période créée. Échéance : " + L.formatDateFR(per.dateEcheance) + ".");
    closeModal(); await refresh();
  };
}

/* ---------------- F. Paiements ---------------- */
function periodesPayables() {
  return toutesPeriodesCalc().filter((c) => c.solde > 0 && c.statut !== "annulee" && c.statut !== "suspendue")
    .sort((a, b) => a.periode.dateEcheance.localeCompare(b.periode.dateEcheance));
}
function formPaiement(periodeIdPreselect, eleveIdPreselect) {
  let payables = periodesPayables();
  if (eleveIdPreselect) payables = payables.filter((c) => contextePeriode(c.periode).eleve?.id === eleveIdPreselect);
  if (!payables.length) { toast("Aucune période avec un solde dû. Créez d'abord une période.", true); return; }
  const sel = periodeIdPreselect || payables[0].periode.id;
  const maintenant = new Date(); maintenant.setMinutes(maintenant.getMinutes() - maintenant.getTimezoneOffset());
  openModal("Enregistrer un paiement", `
  <form id="fPay" class="stack"><div id="fPayErr"></div>
    <label class="field">Élève — période concernée *<select name="periodeId" class="input">
      ${payables.map((c) => { const { eleve, rep } = contextePeriode(c.periode);
        return `<option value="${c.periode.id}" ${c.periode.id === sel ? "selected" : ""}>${esc(eleve ? eleve.nomComplet : "?")} · ${esc(rep ? rep.matière : "")} · éch. ${L.formatDateFR(c.periode.dateEcheance)} · reste ${fmt(c.solde)}</option>`; }).join("")}
      </select></label>
    <p class="hint" id="payDetail"></p>
    <label class="field">Montant reçu (${esc(settings.devise)}, entier) *<input name="montant" class="input" inputmode="numeric" required></label>
    <label class="field">Date et heure du paiement *<input name="datePaiement" class="input" type="datetime-local" required value="${maintenant.toISOString().slice(0, 16)}"></label>
    <label class="field">Moyen de paiement *<select name="moyen" class="input">
      ${Object.entries(MOYENS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
    <label class="field">Référence (n° Mobile Money, etc.)<input name="reference" class="input"></label>
    <label class="field">Note<textarea name="note" class="input" rows="2"></textarea></label>
    <button class="btn btn-teal" type="submit" id="btnPay">Vérifier avant validation →</button></form>`);
  const majDetail = () => {
    const c = payables.find((x) => x.periode.id === $("#fPay [name=periodeId]").value);
    $("#payDetail").textContent = c ? `Dû ${fmt(c.montantDu)} · déjà payé ${fmt(c.montantPaye)} · solde restant ${fmt(c.solde)}.` : "";
    $("#fPay [name=montant]").value = c ? c.solde : "";
  };
  $("#fPay [name=periodeId]").addEventListener("change", majDetail); majDetail();
  $("#fPay").onsubmit = async (ev) => {
    ev.preventDefault();
    if (submitting) return;
    const f = new FormData(ev.target);
    const c = payables.find((x) => x.periode.id === f.get("periodeId"));
    const p = { periodeId: f.get("periodeId"), montant: Number(f.get("montant")), datePaiement: f.get("datePaiement"),
      moyenPaiement: f.get("moyen"), reference: f.get("reference").trim(), note: f.get("note").trim() };
    const errs = L.validerPaiement(p, c ? c.solde : null);
    if (errs.length) { $("#fPayErr").innerHTML = erreursHtml(errs); return; }
    const { eleve, rep } = contextePeriode(c.periode);
    const ok = await confirmBox("Confirmer l'encaissement",
      `Encaisser <strong>${fmt(p.montant)}</strong> de <strong>${esc(eleve.nomComplet)}</strong> (${esc(rep.matière)}) par ${esc(MOYENS[p.moyenPaiement])} ?<br>
       Nouveau solde de la période : <strong>${fmt(c.solde - p.montant)}</strong>.<br>Un reçu numéroté sera généré.`, "Oui, encaisser");
    if (!ok) return;
    submitting = true;
    try { await enregistrerPaiement(p, c); toast("Paiement enregistré et reçu généré."); }
    catch (err) { toast("Erreur : " + err.message, true); }
    finally { submitting = false; }
    await refresh();
  };
}
async function enregistrerPaiement(p, calcAvant) {
  const per = calcAvant.periode, { eleve, rep } = contextePeriode(per);
  const paiement = { id: uid(), ...p, statut: "valide", motifAnnulation: "", createdAt: nowISO() };
  // Numéro de reçu : compteur persistant, jamais réutilisé (transaction dédiée).
  const seq = await tx(["meta"], "readwrite", (s) => reqP(s.get("compteurRecu")).then((cur) => {
    const next = (cur ? cur.valeur : 0) + 1; s.put({ id: "compteurRecu", valeur: next }); return next;
  })).then((p2) => p2);
  const numero = L.numeroRecu(new Date(p.datePaiement).getFullYear(), seq);
  const snapshot = {
    eleveId: eleve.id, eleveNom: eleve.nomComplet, eleveClasse: eleve.classe, matière: rep.matière,
    periodeDebutFR: L.formatDateFR(per.dateDebut), periodeEcheanceFR: L.formatDateFR(per.dateEcheance),
    montantRecu: p.montant, montantDu: per.montantDu, payeAvant: calcAvant.montantPaye,
    soldeApres: calcAvant.solde - p.montant, moyenLibelle: MOYENS[p.moyenPaiement],
    reference: p.reference, note: p.note, datePaiementFR: L.formatDateFR(p.datePaiement.slice(0, 10)),
    activite: settings.activite || "RépétiPro", sloganActivite: settings.slogan || "", telephoneActivite: settings.telephone, coordonneesActivite: settings.coordonnees,
    numero, statut: "valide", devise: settings.devise,
  };
  const reçu = { id: uid(), paiementId: paiement.id, numero, dateGeneration: nowISO(), statut: "valide", snapshot };
  await tx(["paiements", "recus"], "readwrite", (sp, sr) => { sp.put(paiement); sr.put(reçu); });
  await logSync("paiement", paiement.id, "creation"); await logSync("recu", reçu.id, "creation");
  return reçu;
}
async function annulerPaiement(paiementId) {
  const p = S.paiements.find((x) => x.id === paiementId);
  openModal("Annuler ce paiement", `
    <form id="fAnn" class="stack"><p>Montant : <strong>${fmt(p.montant)}</strong> du ${L.formatDateFR(p.datePaiement.slice(0, 10))}.
    L'annulation est <strong>documentée et traçable</strong> : le paiement et son reçu resteront visibles avec la mention « Annulé », et le solde sera recalculé.
    Pour corriger un montant : annulez ici, puis enregistrez le bon paiement.</p>
    <label class="field">Motif de l'annulation *<input name="motif" class="input" required placeholder="Ex : montant saisi par erreur"></label>
    <button class="btn btn-danger" type="submit">Annuler le paiement (traçable)</button></form>`);
  $("#fAnn").onsubmit = async (ev) => {
    ev.preventDefault();
    p.statut = "annule"; p.motifAnnulation = new FormData(ev.target).get("motif").trim() + " (le " + L.formatDateFR(L.todayISO()) + ")";
    const reçu = S.recus.find((r) => r.paiementId === p.id);
    await putOne("paiements", p); await logSync("paiement", p.id, "annulation");
    if (reçu) { reçu.statut = "annule"; reçu.snapshot.statut = "annule"; await putOne("recus", reçu); await logSync("recu", reçu.id, "annulation"); }
    toast("Paiement annulé de façon traçable. Solde recalculé."); closeModal(); await refresh();
  };
}
function renderPaiements() {
  const q = ($("#recherchePaiement").value || "").toLowerCase();
  const liste = [...S.paiements].sort((a, b) => b.datePaiement.localeCompare(a.datePaiement)).filter((p) => {
    if (!q) return true;
    const per = S.periodes.find((x) => x.id === p.periodeId);
    const nom = per ? (contextePeriode(per).eleve?.nomComplet || "") : "";
    return (nom + " " + (p.reference || "") + " " + (MOYENS[p.moyenPaiement] || "")).toLowerCase().includes(q);
  });
  const totalValide = liste.filter((p) => p.statut === "valide").reduce((a, p) => a + p.montant, 0);
  $("#listePaiements").innerHTML = (liste.length ? `<p class="hint">Total encaissé (paiements valides affichés) : <strong>${fmt(totalValide)}</strong></p>` + liste.map(lignePaiement).join("")
    : emptyState("💰", "Aucun paiement", "Enregistrez un premier encaissement depuis le tableau de bord ou une fiche élève."));
  bindRowActions($("#view-paiements"));
}

/* ---------------- E. Échéances ---------------- */
function renderEcheances() {
  const jour = L.todayISO(), calcs = toutesPeriodesCalc();
  const dansSemaine = L.addDays(jour, 7), mois = jour.slice(0, 7);
  const filtres = {
    aujourdhui: (c) => c.statut === "aujourd_hui" || (c.periode.dateEcheance === jour && c.solde > 0),
    semaine: (c) => c.solde > 0 && c.periode.dateEcheance >= jour && c.periode.dateEcheance <= dansSemaine && !["annulee", "suspendue"].includes(c.statut),
    mois: (c) => c.solde > 0 && c.periode.dateEcheance.startsWith(mois) && !["annulee", "suspendue"].includes(c.statut),
    retard: (c) => c.statut === "en_retard" || c.statut === "partiel_en_retard",
    toutes: () => true,
  };
  const liste = calcs.filter(filtres[filtreEcheance]).sort((a, b) => a.periode.dateEcheance.localeCompare(b.periode.dateEcheance));
  $("#listeEcheances").innerHTML = liste.length ? liste.map(ligneEcheance).join("")
    : emptyState("✅", "Rien à signaler", "Aucune échéance dans cette catégorie.");
  bindRowActions($("#view-echeances"));
}

/* ---------------- H. Reçus : aperçu, PDF, PNG, partage, impression ---------------- */
function ligneRecu(r) {
  const s = r.snapshot;
  return `<div class="row"><div><div class="t">${esc(r.numero)} — ${esc(s.eleveNom)}</div>
    <div class="s">${esc(s.datePaiementFR)} · ${esc(s.matière)} · ${esc(s.moyenLibelle)}</div></div>
    <div><span class="montant">${L.formatMontant(s.montantRecu, s.devise)}</span> ${r.statut === "annule" ? '<span class="badge b-annule">Annulé</span>' : ""}
    <div class="actions-row"><button class="btn btn-primary" data-action="voir-recu" data-id="${r.id}" type="button">Aperçu</button>
    <button class="btn btn-light" data-action="recu-pdf" data-id="${r.id}" type="button">PDF</button>
    <button class="btn btn-light" data-action="recu-png" data-id="${r.id}" type="button">PNG</button></div></div></div>`;
}
function renderRecus() {
  const q = ($("#rechercheRecu").value || "").toLowerCase();
  const liste = [...S.recus].sort((a, b) => b.dateGeneration.localeCompare(a.dateGeneration))
    .filter((r) => !q || (r.numero + " " + r.snapshot.eleveNom + " " + r.snapshot.datePaiementFR).toLowerCase().includes(q));
  $("#listeRecus").innerHTML = liste.length ? liste.map(ligneRecu).join("")
    : emptyState("🧾", "Aucun reçu", "Un reçu est créé automatiquement pour chaque paiement réellement encaissé — jamais pour une simple échéance.");
  bindRowActions($("#view-recus"));
}
function aperçuRecuHtml(r) {
  const s = r.snapshot, dev = s.devise;
  const row = (k, v, b) => `<div style="display:flex;justify-content:space-between;gap:14px;padding:7px 0;border-bottom:1px dashed #DFE7EC"><span style="color:#5B7183">${k}</span><span style="text-align:right;${b ? "font-weight:700;" : ""}">${v}</span></div>`;
  const contact = [s.telephoneActivite, s.coordonneesActivite].filter(Boolean).map(esc).join(" · ");
  return `<div class="recu-aperçu" style="overflow:hidden;padding:0;border-radius:16px">
  <div style="background:linear-gradient(135deg,#0F2A43 0%,#0B5563 60%,#0AA696 130%);color:#fff;padding:22px 20px">
    <div style="font-size:23px;font-weight:800;line-height:1.2">${esc(s.activite || "RépétiPro")}</div>
    ${s.sloganActivite ? `<div style="opacity:.9;font-size:13px;font-style:italic">${esc(s.sloganActivite)}</div>` : ""}
    ${contact ? `<div style="opacity:.85;font-size:13px">${contact}</div>` : ""}
  </div>
  <div style="padding:6px 20px 20px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:14px 0 8px">
      <div style="font-size:17px;font-weight:800;color:#0F2A43;letter-spacing:.4px">REÇU DE PAIEMENT</div>
      <div style="background:#0F2A43;color:#fff;border-radius:999px;padding:5px 12px;font-size:13px;font-weight:700;white-space:nowrap">${esc(r.numero)}</div>
    </div>
    ${r.statut === "annule" ? `<div style="color:#B91C1C;font-weight:800;border:2px solid #B91C1C;border-radius:10px;text-align:center;padding:6px;margin-bottom:8px">ANNULÉ</div>` : ""}
    ${row("Date du paiement", esc(s.datePaiementFR))}
    ${row("Reçu de", esc(s.eleveNom), true)}
    ${row("Classe", esc(s.eleveClasse))}
    ${row("Matière", esc(s.matière))}
    ${row("Période", "du " + esc(s.periodeDebutFR) + " au " + esc(s.periodeEcheanceFR))}
    <div style="background:#E6F7F4;border:1.5px solid #0AA696;border-radius:12px;padding:14px 16px;margin:14px 0;display:flex;justify-content:space-between;align-items:center;gap:10px"><span style="font-weight:600">Montant reçu</span><strong style="font-size:21px;color:#087F73;white-space:nowrap">${L.formatMontant(s.montantRecu, dev)}</strong></div>
    ${row("Montant total dû", L.formatMontant(s.montantDu, dev))}
    ${row("Déjà payé avant ce versement", L.formatMontant(s.payeAvant, dev))}
    ${row("Solde restant", L.formatMontant(s.soldeApres, dev), s.soldeApres > 0)}
    ${row("Moyen de paiement", esc(s.moyenLibelle))}
    ${s.reference ? row("Référence", esc(s.reference)) : ""}
    ${s.note ? row("Note", esc(s.note)) : ""}
    <p style="text-align:center;color:#5B7183;font-size:12px;margin:16px 0 0;line-height:1.6">Merci pour votre confiance.<br>Généré par RépétiPro — Tes élèves, tes paiements, zéro oubli.</p>
  </div></div>`;
}
function voirRecu(id) {
  const r = S.recus.find((x) => x.id === id); if (!r) return;
  openModal("Reçu " + r.numero, aperçuRecuHtml(r) + `<div class="quick-actions">
    <button class="btn btn-primary" data-action="recu-pdf" data-id="${r.id}" type="button">⬇ PDF</button>
    <button class="btn btn-teal" data-action="recu-png" data-id="${r.id}" type="button">⬇ PNG</button>
    <button class="btn btn-light" data-action="recu-partage" data-id="${r.id}" type="button">Partager</button>
    <button class="btn btn-light" data-action="recu-imprime" data-id="${r.id}" type="button">Imprimer</button></div>`);
  bindRowActions($("#modalBody"));
}
function pdfRecu(r) { return new Blob([L.genererPDF(r.snapshot.activite || "RépétiPro", L.lignesRecu(r.snapshot, r.snapshot.devise), settings.formatRecu)], { type: "application/pdf" }); }
function pngRecuBlob(r) {
  return new Promise((res) => {
    const s = r.snapshot, dev = s.devise;
    const rows = [
      ["Date du paiement", s.datePaiementFR], ["Reçu de", s.eleveNom], ["Classe", s.eleveClasse],
      ["Matière", s.matière], ["Période", "du " + s.periodeDebutFR + " au " + s.periodeEcheanceFR],
    ];
    const rows2 = [
      ["Montant total dû", L.formatMontant(s.montantDu, dev)],
      ["Déjà payé avant ce versement", L.formatMontant(s.payeAvant, dev)],
      ["Solde restant", L.formatMontant(s.soldeApres, dev)],
      ["Moyen de paiement", s.moyenLibelle],
    ];
    if (s.reference) rows2.push(["Référence", s.reference]);
    if (s.note) rows2.push(["Note", s.note]);
    const W = 1000, ligneH = 52, headerH = 190;
    const H = headerH + 110 + rows.length * ligneH + 120 + rows2.length * ligneH + 130;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const g = cv.getContext("2d");
    const rr = (x, y, w, h, rad) => { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, rad); else g.rect(x, y, w, h); };
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, W, H);
    const grad = g.createLinearGradient(0, 0, W, headerH);
    grad.addColorStop(0, "#0F2A43"); grad.addColorStop(.65, "#0B5563"); grad.addColorStop(1, "#0AA696");
    g.fillStyle = grad; g.fillRect(0, 0, W, headerH);
    g.fillStyle = "#ffffff"; g.textAlign = "left";
    g.font = "800 46px system-ui, Arial"; g.fillText(s.activite || "RépétiPro", 48, 78, W - 96);
    g.font = "italic 26px system-ui, Arial"; g.globalAlpha = .9;
    let hy = 118;
    if (s.sloganActivite) { g.fillText(s.sloganActivite, 48, hy, W - 96); hy += 38; }
    g.font = "26px system-ui, Arial";
    const contact = [s.telephoneActivite, s.coordonneesActivite].filter(Boolean).join("  ·  ");
    if (contact) g.fillText(contact, 48, hy, W - 96);
    g.globalAlpha = 1;
    let y = headerH + 64;
    g.fillStyle = "#0F2A43"; g.font = "800 34px system-ui, Arial"; g.fillText("REÇU DE PAIEMENT", 48, y);
    g.font = "700 27px system-ui, Arial";
    const numW = g.measureText(r.numero).width + 44;
    g.fillStyle = "#0F2A43"; rr(W - 48 - numW, y - 38, numW, 52, 26); g.fill();
    g.fillStyle = "#ffffff"; g.textAlign = "center"; g.fillText(r.numero, W - 48 - numW / 2, y - 3);
    g.textAlign = "left"; y += 30;
    const drawRows = (liste) => {
      for (const [k, v] of liste) {
        y += ligneH;
        g.strokeStyle = "#DFE7EC"; g.setLineDash([6, 6]); g.beginPath(); g.moveTo(48, y - 36); g.lineTo(W - 48, y - 36); g.stroke(); g.setLineDash([]);
        g.fillStyle = "#5B7183"; g.font = "27px system-ui, Arial"; g.textAlign = "left"; g.fillText(k, 48, y, 430);
        g.fillStyle = "#16232E"; g.font = "600 27px system-ui, Arial"; g.textAlign = "right"; g.fillText(String(v), W - 48, y, 460);
      }
      g.textAlign = "left";
    };
    drawRows(rows);
    y += 34;
    g.fillStyle = "#E6F7F4"; rr(48, y, W - 96, 92, 18); g.fill();
    g.strokeStyle = "#0AA696"; g.lineWidth = 3; rr(48, y, W - 96, 92, 18); g.stroke(); g.lineWidth = 1;
    g.fillStyle = "#16232E"; g.font = "600 30px system-ui, Arial"; g.fillText("Montant reçu", 76, y + 58);
    g.fillStyle = "#087F73"; g.font = "800 42px system-ui, Arial"; g.textAlign = "right";
    g.fillText(L.formatMontant(s.montantRecu, dev), W - 76, y + 60); g.textAlign = "left";
    y += 92;
    drawRows(rows2);
    g.fillStyle = "#5B7183"; g.font = "24px system-ui, Arial"; g.textAlign = "center";
    g.fillText("Merci pour votre confiance.", W / 2, y + 74);
    g.font = "22px system-ui, Arial";
    g.fillText("Généré par RépétiPro — Tes élèves, tes paiements, zéro oubli.", W / 2, y + 108);
    g.textAlign = "left";
    if (r.statut === "annule") {
      g.save(); g.translate(W / 2, H / 2); g.rotate(-0.32);
      g.strokeStyle = "rgba(185,28,28,.8)"; g.lineWidth = 6; g.strokeRect(-230, -70, 460, 130);
      g.fillStyle = "rgba(185,28,28,.85)"; g.font = "800 84px system-ui, Arial"; g.textAlign = "center";
      g.fillText("ANNULÉ", 0, 22); g.restore();
    }
    cv.toBlob(res, "image/png");
  });
}
async function partagerRecu(r) {
  const png = await pngRecuBlob(r);
  const fichier = new File([png], r.numero + ".png", { type: "image/png" });
  if (navigator.canShare && navigator.canShare({ files: [fichier] })) { try { await navigator.share({ files: [fichier], title: "Reçu " + r.numero }); return; } catch { /* annulé par l'utilisateur */ return; } }
  download(png, r.numero + ".png"); toast("Partage de fichier non disponible ici : l'image du reçu a été téléchargée.");
}
function imprimerRecu(r) { $("#printArea").innerHTML = aperçuRecuHtml(r); window.print(); }

/* ---------------- I. Rapports ---------------- */
function donneesRapport(mois) {
  const valides = S.paiements.filter((p) => p.statut === "valide" && p.datePaiement.startsWith(mois));
  const parEleve = {}, parMoyen = {}, parJour = {};
  for (const p of valides) {
    const per = S.periodes.find((x) => x.id === p.periodeId);
    const nom = per ? (contextePeriode(per).eleve?.nomComplet || "?") : "?";
    parEleve[nom] = (parEleve[nom] || 0) + p.montant;
    parMoyen[MOYENS[p.moyenPaiement] || p.moyenPaiement] = (parMoyen[MOYENS[p.moyenPaiement] || p.moyenPaiement] || 0) + p.montant;
    parJour[p.datePaiement.slice(0, 10)] = (parJour[p.datePaiement.slice(0, 10)] || 0) + p.montant;
  }
  const calcs = toutesPeriodesCalc();
  return { valides, parEleve, parMoyen, parJour,
    total: valides.reduce((a, p) => a + p.montant, 0),
    soldes: calcs.filter((c) => c.solde > 0 && !["annulee", "suspendue"].includes(c.statut)).reduce((a, c) => a + c.solde, 0),
    retards: calcs.filter((c) => c.statut === "en_retard" || c.statut === "partiel_en_retard"),
    partiels: calcs.filter((c) => c.statut === "partiel" || c.statut === "partiel_en_retard") };
}
function renderRapports() {
  const input = $("#moisRapport"); if (!input.value) input.value = L.todayISO().slice(0, 7);
  const d = donneesRapport(input.value);
  const table = (titre, obj, fmtKey) => `<div class="card"><h2>${titre}</h2>${Object.keys(obj).length ?
    `<table>${Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(fmtKey ? fmtKey(k) : k)}</td><td class="montant">${fmt(v)}</td></tr>`).join("")}</table>` : '<p class="hint">Aucune donnée.</p>'}</div>`;
  $("#rapportContenu").innerHTML = `
    <div class="kpi-grid">
      <div class="kpi positif"><div class="v">${fmt(d.total)}</div><div class="l">Encaissé (réel) sur le mois</div></div>
      <div class="kpi attente"><div class="v">${fmt(d.soldes)}</div><div class="l">Soldes à recevoir (toutes périodes)</div></div>
      <div class="kpi alerte"><div class="v">${d.retards.length}</div><div class="l">Périodes en retard</div></div>
      <div class="kpi attente"><div class="v">${d.partiels.length}</div><div class="l">Paiements partiels en cours</div></div>
    </div>
    ${table("Encaissements journaliers (mois choisi)", d.parJour, (k) => L.formatDateFR(k))}
    ${table("Encaissements par élève (mois choisi)", d.parEleve)}
    ${table("Répartition par moyen de paiement", d.parMoyen)}`;
}
function exporterCSV() {
  const mois = $("#moisRapport").value, d = donneesRapport(mois);
  const lignes = [["Date", "Élève", "Matière", "Montant", "Moyen", "Référence", "Reçu"]];
  for (const p of d.valides.sort((a, b) => a.datePaiement.localeCompare(b.datePaiement))) {
    const per = S.periodes.find((x) => x.id === p.periodeId); const { eleve, rep } = per ? contextePeriode(per) : {};
    const reçu = S.recus.find((r) => r.paiementId === p.id);
    lignes.push([L.formatDateFR(p.datePaiement.slice(0, 10)), eleve?.nomComplet || "?", rep?.matière || "", p.montant, MOYENS[p.moyenPaiement], p.reference || "", reçu?.numero || ""]);
  }
  lignes.push(["", "", "TOTAL ENCAISSÉ", d.total, "", "", ""]);
  const csv = "﻿" + lignes.map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
  download(new Blob([csv], { type: "text/csv;charset=utf-8" }), "repetipro-rapport-" + mois + ".csv");
  toast("Rapport CSV exporté (encaissements réels uniquement).");
}
function exporterRapportPDF() {
  const mois = $("#moisRapport").value, d = donneesRapport(mois);
  const lines = [{ text: "Rapport financier RépétiPro — " + mois, size: 14, bold: true },
    { text: "Encaissé (réel) : " + fmt(d.total), size: 12, bold: true },
    { text: "Soldes à recevoir : " + fmt(d.soldes), size: 11 }, { rule: true }];
  for (const [k, v] of Object.entries(d.parEleve).sort((a, b) => b[1] - a[1])) lines.push({ text: k + " : " + fmt(v), size: 11 });
  lines.push({ rule: true }, { text: "Les montants attendus ne sont pas des recettes. Généré par RépétiPro.", size: 9 });
  download(new Blob([L.genererPDF("RépétiPro — Rapport", lines, "A4")], { type: "application/pdf" }), "repetipro-rapport-" + mois + ".pdf");
}

/* ---------------- Export calendrier (.ics) ---------------- */
function exporterICS(calcs) {
  const evts = calcs.filter((c) => !["payee", "annulee", "suspendue"].includes(c.statut)).map((c) => {
    const { eleve, rep } = contextePeriode(c.periode);
    return { uid: c.periode.id + "@repetipro", dateEcheance: c.periode.dateEcheance,
      titre: "Échéance RépétiPro : " + (eleve ? eleve.nomComplet : "") + " (" + (rep ? rep.matière : "") + ")",
      description: "Reste à payer : " + fmt(Math.max(0, c.solde)) + " sur " + fmt(c.montantDu) + ". Période débutée le " + L.formatDateFR(c.periode.dateDebut) + "." };
  });
  if (!evts.length) { toast("Aucune échéance active à mettre au calendrier.", true); return; }
  download(new Blob([L.genererICS(evts)], { type: "text/calendar;charset=utf-8" }), "repetipro-echeances.ics");
  toast("Fichier calendrier téléchargé : ouvrez-le pour ajouter les rappels à l'agenda du téléphone.");
}

/* ---------------- K. Sauvegarde / restauration / synchro ---------------- */
function renderSynchro() {
  const enAttente = S.syncops.filter((o) => o.statut === "en_attente").length;
  $("#syncEtat").innerHTML = `<p>Connexion : <strong>${navigator.onLine ? "En ligne" : "Hors ligne"}</strong> ·
    Opérations journalisées : <strong>${S.syncops.length}</strong> · En attente d'export : <strong>${enAttente}</strong></p>`;
  const derniers = [...S.syncops].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30);
  $("#syncJournal").innerHTML = derniers.length ? `<table><tr><th>Date</th><th>Opération</th><th>Statut</th></tr>` +
    derniers.map((o) => `<tr><td>${L.formatDateFR(o.updatedAt.slice(0, 10))}</td><td>${esc(o.operation)} ${esc(o.typeEntite)}</td><td>${esc(o.statut)}</td></tr>`).join("") + "</table>"
    : '<p class="hint">Aucune opération pour le moment. Chaque création/modification sera journalisée ici.</p>';
}
async function exporterSauvegarde() {
  await reload();
  const data = { eleves: S.eleves, repetitions: S.repetitions, periodes: S.periodes, paiements: S.paiements, recus: S.recus, settings };
  const sauvegarde = { app: "RépétiPro", version: 1, exporteLe: nowISO(), data, checksum: L.checksum(JSON.stringify(data)) };
  download(new Blob([JSON.stringify(sauvegarde, null, 2)], { type: "application/json" }), "repetipro-sauvegarde-" + L.todayISO() + ".json");
  toast("Sauvegarde exportée. Conservez-la en lieu sûr (ex. Google Drive).");
}
async function importerSauvegarde(fichier) {
  const zone = $("#importResultat");
  let obj;
  try { obj = JSON.parse(await fichier.text()); } catch { zone.innerHTML = erreursHtml(["Fichier illisible : ce n'est pas du JSON valide. Aucune donnée n'a été modifiée."]); return; }
  const errs = L.validerSauvegarde(obj);
  if (errs.length) { zone.innerHTML = erreursHtml(errs.concat("Aucune donnée n'a été modifiée.")); return; }
  const ok = await confirmBox("Restaurer cette sauvegarde ?",
    `Sauvegarde valide (${obj.data.eleves.length} élèves, ${obj.data.paiements.length} paiements, ${obj.data.recus.length} reçus).<br>
     <strong>Les données actuelles de cet appareil seront remplacées.</strong> Pensez à exporter d'abord une sauvegarde de l'état actuel.`, "Oui, restaurer");
  if (!ok) return;
  await tx(STORES, "readwrite", (...stores) => {
    const parNom = Object.fromEntries(STORES.map((n, i) => [n, stores[i]]));
    for (const k of ["eleves", "repetitions", "periodes", "paiements", "recus"]) { parNom[k].clear(); for (const item of obj.data[k]) parNom[k].put(item); }
    if (obj.data.settings) parNom.meta.put(obj.data.settings);
    const maxSeq = obj.data.recus.reduce((m, r) => Math.max(m, parseInt((r.numero.split("-")[2] || "0"), 10) || 0), 0);
    parNom.meta.put({ id: "compteurRecu", valeur: maxSeq });
  });
  await logSync("sauvegarde", "import", "restauration");
  zone.innerHTML = `<p>✅ Restauration réussie : ${obj.data.eleves.length} élèves, ${obj.data.paiements.length} paiements. Identifiants préservés.</p>`;
  toast("Sauvegarde restaurée."); await refresh();
}
async function marquerSynchronise() {
  const enAttente = S.syncops.filter((o) => o.statut === "en_attente");
  if (!enAttente.length) { toast("Aucune opération en attente."); return; }
  const ok = await confirmBox("Marquer comme synchronisé", "Ne faites ceci qu'après avoir exporté une sauvegarde et vérifié qu'elle est bien conservée (Drive, e-mail…). Continuer ?", "Oui, c'est fait");
  if (!ok) return;
  for (const o of enAttente) { o.statut = "synchronise_manuel"; o.updatedAt = nowISO(); await putOne("syncops", o); }
  toast("Journal mis à jour."); await refresh();
}

/* ---------------- J. Paramètres ---------------- */
function renderParams() {
  $("#pActivite").value = settings.activite; $("#pSlogan").value = settings.slogan || ""; $("#pTel").value = settings.telephone; $("#pCoords").value = settings.coordonnees;
  $("#pDevise").value = settings.devise; $("#pFormat").value = settings.formatRecu;
  $("#pNotifAvant").checked = settings.notifAvant; $("#pNotifJourJ").checked = settings.notifJourJ;
  $("#pNotifApres").checked = settings.notifApres; $("#pDelaiApres").value = settings.delaiApres;
}

/* ---------------- Rappels (locaux, anti-doublons) ---------------- */
async function verifierRappels() {
  const prefs = { avant: settings.notifAvant, jourJ: settings.notifJourJ, apres: settings.notifApres, delaiApres: settings.delaiApres };
  const dus = L.rappelsDus(toutesPeriodesCalc(), prefs, L.todayISO()).filter((r) => !settings.rappelsVus.includes(r.cle));
  if (!dus.length) return;
  for (const r of dus) {
    const per = S.periodes.find((p) => p.id === r.periodeId); if (!per) continue;
    const { eleve, rep } = contextePeriode(per);
    const msg = { avant: "Échéance dans 3 jours", jourJ: "Échéance aujourd'hui", apres: "Échéance dépassée" }[r.type] +
      ` : ${eleve ? eleve.nomComplet : "?"} (${rep ? rep.matière : ""}) — ${L.formatDateFR(per.dateEcheance)}`;
    if ("Notification" in window && Notification.permission === "granted") { try { new Notification("RépétiPro", { body: msg, icon: "icon.svg" }); } catch {} }
    toast("🔔 " + msg);
    settings.rappelsVus.push(r.cle);
  }
  settings.rappelsVus = settings.rappelsVus.slice(-500);
  await saveSettings();
}

/* ---------------- Actions globales ---------------- */
function bindRowActions(root) {
  $$("[data-action]", root).forEach((b) => { if (!b._bound) { b._bound = true; b.addEventListener("click", () => handleAction(b.dataset.action, b.dataset.id)); } });
}
async function handleAction(action, id) {
  if (action === "new-eleve") formEleve(null);
  else if (action === "fiche") { currentEleveId = id; showView("fiche"); }
  else if (action === "back-eleves") showView("eleves");
  else if (action === "edit-eleve") formEleve(S.eleves.find((e) => e.id === id));
  else if (action === "new-repetition") formRepetition(id);
  else if (action === "new-periode") formNouvellePeriode(id);
  else if (action === "new-paiement") formPaiement(null, null);
  else if (action === "payer-periode") formPaiement(id, null);
  else if (action === "payer-eleve") formPaiement(null, id);
  else if (action === "annuler-paiement") annulerPaiement(id);
  else if (action === "voir-recu") voirRecu(id);
  else if (action === "recu-pdf") { const r = S.recus.find((x) => x.id === id); download(pdfRecu(r), r.numero + ".pdf"); }
  else if (action === "recu-png") { const r = S.recus.find((x) => x.id === id); download(await pngRecuBlob(r), r.numero + ".png"); }
  else if (action === "recu-partage") partagerRecu(S.recus.find((x) => x.id === id));
  else if (action === "recu-imprime") imprimerRecu(S.recus.find((x) => x.id === id));
  else if (action === "ics-periode") { const c = toutesPeriodesCalc().find((x) => x.periode.id === id); if (c) exporterICS([c]); }
  else if (action === "renouveler") {
    const per = S.periodes.find((p) => p.id === id);
    formNouvellePeriode(per.repetitionId, per.dateEcheance, per.montantDu);
  } else if (action === "suspendre-periode" || action === "reactiver-periode") {
    const per = S.periodes.find((p) => p.id === id);
    per.statutManuel = action === "suspendre-periode" ? "suspendue" : "active"; per.updatedAt = nowISO();
    await putOne("periodes", per); await logSync("periode", per.id, per.statutManuel); toast("Période " + per.statutManuel + "."); await refresh();
  } else if (action === "annuler-periode") {
    const per = S.periodes.find((p) => p.id === id);
    if (await confirmBox("Annuler cette période ?", "La période restera dans l'historique avec le statut « Annulée » et ne comptera plus dans les montants dus. Les paiements déjà enregistrés ne sont pas supprimés.", "Annuler la période")) {
      per.statutManuel = "annulee"; per.updatedAt = nowISO(); await putOne("periodes", per);
      await logSync("periode", per.id, "annulation"); toast("Période annulée (conservée dans l'historique)."); await refresh();
    }
  } else if (action === "toggle-archive") {
    const e = S.eleves.find((x) => x.id === id);
    e.statut = e.statut === "actif" ? "archive" : "actif"; e.updatedAt = nowISO();
    await putOne("eleves", e); await logSync("eleve", e.id, e.statut === "archive" ? "archivage" : "reactivation");
    toast(e.statut === "archive" ? "Élève archivé (historique financier conservé)." : "Élève réactivé."); await refresh();
  } else if (action === "supprimer-eleve") {
    const e = S.eleves.find((x) => x.id === id);
    const aPaiements = S.paiements.some((p) => { const per = S.periodes.find((x) => x.id === p.periodeId); return per && contextePeriode(per).eleve?.id === id; });
    if (aPaiements) { toast("Suppression refusée : cet élève a un historique de paiements. Archivez-le plutôt.", true); return; }
    if (await confirmBox("Suppression définitive", `Supprimer définitivement <strong>${esc(e.nomComplet)}</strong> et ses répétitions/périodes (sans aucun paiement) ? Cette action est irréversible.`, "Supprimer")) {
      const reps = S.repetitions.filter((r) => r.eleveId === id);
      const pers = S.periodes.filter((p) => reps.some((r) => r.id === p.repetitionId));
      await tx(["eleves", "repetitions", "periodes"], "readwrite", (se, sr, sp) => { se.delete(id); reps.forEach((r) => sr.delete(r.id)); pers.forEach((p) => sp.delete(p.id)); });
      await logSync("eleve", id, "suppression"); toast("Élève supprimé."); showView("eleves"); await refresh();
    }
  }
}

/* ---------------- Démonstration & réinitialisation ---------------- */
async function chargerDemo() {
  if (S.eleves.length && !(await confirmBox("Données de démonstration", "Des données existent déjà. Ajouter quand même les élèves fictifs de démonstration ?", "Ajouter"))) return;
  const jour = L.todayISO();
  const exemples = [
    { nom: "Aïcha Martin (démo)", classe: "3e", cycle: "college", mat: "Mathématiques", tarif: 25000, debut: L.addDays(jour, -40), paiement: 25000 },
    { nom: "Jean Leroy (démo)", classe: "Terminale D", cycle: "lycee", mat: "Physique-Chimie", tarif: 30000, debut: L.addDays(jour, -20), paiement: 10000 },
    { nom: "Fatou Diallo (démo)", classe: "CM2", cycle: "primaire", mat: "Français, Calcul", tarif: 15000, debut: jour, paiement: 0 },
  ];
  for (const x of exemples) {
    const e = { id: uid(), nomComplet: x.nom, classe: x.classe, cycle: x.cycle, etablissement: "", parent: "", telephone: "90 00 00 00", matieres: x.mat, tarifMensuel: x.tarif, dateDebut: x.debut, notes: "Donnée de démonstration", statut: "actif", createdAt: nowISO(), updatedAt: nowISO() };
    await putOne("eleves", e);
    const rep = { id: uid(), eleveId: e.id, matière: x.mat, dateDebut: x.debut, tarifConvenu: x.tarif, frequence: "mensuelle", statut: "active", notes: "", createdAt: nowISO(), updatedAt: nowISO() };
    await putOne("repetitions", rep);
    const per = { id: uid(), repetitionId: rep.id, dateDebut: x.debut, dateEcheance: L.addOneMonth(x.debut), montantDu: x.tarif, statutManuel: "active", createdAt: nowISO(), updatedAt: nowISO() };
    await putOne("periodes", per);
    if (x.paiement > 0) { await reload(); await enregistrerPaiement({ periodeId: per.id, montant: x.paiement, datePaiement: x.debut + "T10:00", moyenPaiement: "mobile_money", reference: "DÉMO", note: "Démonstration" }, calcPeriode(per)); }
  }
  await logSync("demo", "demo", "chargement");
  toast("Données de démonstration chargées (fictives)."); await refresh(); showView("dashboard");
}
async function effacerTout() {
  if (!(await confirmBox("Tout effacer ?", "Toutes les données RépétiPro de cet appareil seront supprimées. Exportez d'abord une sauvegarde si besoin. Continuer ?", "Tout effacer"))) return;
  await tx(STORES, "readwrite", (...stores) => stores.forEach((s) => s.clear()));
  toast("Données effacées."); await refresh(); showView("dashboard");
}

/* ---------------- Événements ---------------- */
$$(".nav-btn").forEach((b) => b.addEventListener("click", () => b.dataset.nav === "plus" ? $("#menuPlus").classList.toggle("hidden") : showView(b.dataset.nav)));
$$("#menuPlus [data-nav]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.nav)));
$("#fermerPlus").addEventListener("click", () => $("#menuPlus").classList.add("hidden"));
$$("#view-dashboard [data-action], #view-eleves [data-action], #view-paiements [data-action]").forEach((b) => b.addEventListener("click", () => handleAction(b.dataset.action, b.dataset.id)));
$("#rechercheEleve").addEventListener("input", renderEleves);
["filtreCycle", "filtreStatut", "filtrePaiement"].forEach((id) => $("#" + id).addEventListener("change", renderEleves));
$("#recherchePaiement").addEventListener("input", renderPaiements);
$("#rechercheRecu").addEventListener("input", renderRecus);
$$("#chipsEcheances .chip").forEach((c) => c.addEventListener("click", () => { filtreEcheance = c.dataset.filtre; $$("#chipsEcheances .chip").forEach((x) => x.classList.toggle("active", x === c)); renderEcheances(); }));
$("#btnIcsAll").addEventListener("click", () => exporterICS(toutesPeriodesCalc()));
$("#moisRapport").addEventListener("change", renderRapports);
$("#btnCsv").addEventListener("click", exporterCSV);
$("#btnRapportPdf").addEventListener("click", exporterRapportPDF);
$("#btnExport").addEventListener("click", exporterSauvegarde);
$("#btnMarquerSync").addEventListener("click", marquerSynchronise);
$("#fileImport").addEventListener("change", (e) => { if (e.target.files[0]) importerSauvegarde(e.target.files[0]); e.target.value = ""; });
$("#formParams").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  Object.assign(settings, { activite: $("#pActivite").value.trim(), slogan: $("#pSlogan").value.trim(), telephone: $("#pTel").value.trim(), coordonnees: $("#pCoords").value.trim(),
    devise: $("#pDevise").value.trim() || "FCFA", formatRecu: $("#pFormat").value, notifAvant: $("#pNotifAvant").checked,
    notifJourJ: $("#pNotifJourJ").checked, notifApres: $("#pNotifApres").checked, delaiApres: Math.max(1, Number($("#pDelaiApres").value) || 2) });
  await saveSettings(); toast("Paramètres enregistrés."); await refresh();
});
$("#btnNotif").addEventListener("click", async () => {
  if (!("Notification" in window)) { toast("Les notifications système ne sont pas disponibles dans ce navigateur. Les rappels restent visibles dans l'app.", true); return; }
  const r = await Notification.requestPermission();
  toast(r === "granted" ? "Notifications autorisées." : "Notifications refusées : les rappels resteront visibles dans l'application.");
});
$("#btnDemo").addEventListener("click", chargerDemo);
$("#btnReset").addEventListener("click", effacerTout);
function majReseau() { const b = $("#netBadge"); b.textContent = navigator.onLine ? "● En ligne" : "● Hors ligne"; b.className = "net-badge " + (navigator.onLine ? "online" : "offline"); }
window.addEventListener("online", () => { majReseau(); toast("Connexion rétablie. Pensez à exporter une sauvegarde (écran Sauvegarde)."); render(); });
window.addEventListener("offline", () => { majReseau(); toast("Hors ligne : tout continue de fonctionner localement."); });
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; $("#btnInstall").classList.remove("hidden"); });
$("#btnInstall").addEventListener("click", async () => { if (installPrompt) { installPrompt.prompt(); await installPrompt.userChoice; $("#btnInstall").classList.add("hidden"); } });

/* ---------------- Démarrage ---------------- */
(async function init() {
  try {
    await openDB(); await reload(); majReseau(); showView("dashboard"); verifierRappels();
    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
  } catch (err) {
    document.body.innerHTML = `<main><div class="errors">RépétiPro n'a pas pu démarrer : ${esc(err.message)}. Vérifiez que le stockage du navigateur n'est pas bloqué (navigation privée stricte) puis rechargez.</div></main>`;
  }
})();
