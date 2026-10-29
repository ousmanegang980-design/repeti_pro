/* RépétiPro — logique métier pure (testable sous Node, utilisable dans le navigateur).
   Aucune dépendance. Montants = entiers (FCFA sans centimes). Dates = "AAAA-MM-JJ" locales. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RPLogic = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------- Dates (sans fuseau : on travaille sur des chaînes AAAA-MM-JJ) ---------- */
  function pad(n) { return String(n).padStart(2, "0"); }
  function toISODate(y, m, d) { return y + "-" + pad(m) + "-" + pad(d); }
  function parseISODate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return null;
    const [y, m, d] = s.split("-").map(Number);
    if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
    return { y, m, d };
  }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function todayISO(now) {
    const t = now ? new Date(now) : new Date();
    return toISODate(t.getFullYear(), t.getMonth() + 1, t.getDate());
  }
  /* Ajoute 1 mois calendaire. 31/01 -> dernier jour de février ; 31/03 -> 30/04. */
  function addOneMonth(iso) {
    const p = parseISODate(iso);
    if (!p) throw new Error("Date invalide : " + iso);
    let y = p.y, m = p.m + 1;
    if (m > 12) { m = 1; y += 1; }
    const d = Math.min(p.d, daysInMonth(y, m));
    return toISODate(y, m, d);
  }
  function addDays(iso, n) {
    const p = parseISODate(iso);
    if (!p) throw new Error("Date invalide : " + iso);
    const dt = new Date(Date.UTC(p.y, p.m - 1, p.d) + n * 86400000);
    return toISODate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  function diffDays(a, b) { // b - a en jours
    const pa = parseISODate(a), pb = parseISODate(b);
    return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
  }
  function formatDateFR(iso) {
    const p = parseISODate(iso);
    return p ? pad(p.d) + "/" + pad(p.m) + "/" + p.y : "—";
  }

  /* ---------- Argent (entiers uniquement) ---------- */
  function assertMontant(v, libelle) {
    if (!Number.isInteger(v) || v < 0) throw new Error((libelle || "Montant") + " invalide : entier >= 0 requis (reçu : " + v + ").");
    return v;
  }
  function formatMontant(v, devise) {
    assertMontant(v);
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " " + (devise || "FCFA");
  }
  function soldePeriode(montantDu, paiementsValides) {
    assertMontant(montantDu, "Montant dû");
    let paye = 0;
    for (const p of paiementsValides || []) { assertMontant(p.montant, "Paiement"); paye += p.montant; }
    return { montantDu, montantPaye: paye, solde: montantDu - paye };
  }

  /* ---------- Statuts de période ----------
     Entrée : { dateEcheance, montantDu, montantPaye, statutManuel: 'active'|'suspendue'|'annulee' }, dateDuJour */
  function statutPeriode(per, montantPaye, jour) {
    if (per.statutManuel === "annulee") return "annulee";
    if (per.statutManuel === "suspendue") return "suspendue";
    const solde = per.montantDu - montantPaye;
    if (solde <= 0 && per.montantDu >= 0 && montantPaye >= per.montantDu && per.montantDu > 0) return "payee";
    if (per.montantDu === 0) return "payee";
    if (montantPaye > 0) return diffDays(per.dateEcheance, jour) > 0 ? "partiel_en_retard" : "partiel";
    const delta = diffDays(jour, per.dateEcheance); // >0 : échéance future
    if (delta > 0) return (per.dateDebut && jour >= per.dateDebut) ? "en_cours" : "a_venir";
    if (delta === 0) return "aujourd_hui";
    return "en_retard";
  }
  const LIBELLES_STATUT = {
    a_venir: "À venir", en_cours: "En cours", aujourd_hui: "À payer aujourd'hui", en_retard: "En retard",
    partiel: "Paiement partiel", partiel_en_retard: "Partiel — en retard",
    payee: "Payée", suspendue: "Suspendue", annulee: "Annulée",
  };

  /* ---------- Numéros de reçu : RP-AAAA-000001, jamais réutilisés ---------- */
  function numeroRecu(annee, sequence) {
    if (!Number.isInteger(sequence) || sequence < 1) throw new Error("Séquence de reçu invalide.");
    return "RP-" + annee + "-" + String(sequence).padStart(6, "0");
  }

  /* ---------- Validation élève ---------- */
  function validerEleve(e) {
    const erreurs = [];
    if (!e.nomComplet || !e.nomComplet.trim()) erreurs.push("Le nom complet est obligatoire.");
    if (!e.classe || !e.classe.trim()) erreurs.push("La classe est obligatoire.");
    if (!["primaire", "college", "lycee"].includes(e.cycle)) erreurs.push("Cycle invalide (primaire, collège ou lycée).");
    if (e.telephone && !/^[+0-9][0-9 .-]{5,19}$/.test(e.telephone.trim())) erreurs.push("Téléphone invalide.");
    if (e.telephoneParent && !/^[+0-9][0-9 .-]{5,19}$/.test(e.telephoneParent.trim())) erreurs.push("Téléphone du parent/tuteur invalide.");
    if (e.tarifMensuel != null && e.tarifMensuel !== "" && (!Number.isInteger(e.tarifMensuel) || e.tarifMensuel < 0))
      erreurs.push("Le tarif mensuel doit être un entier >= 0.");
    if (e.dateDebut && !parseISODate(e.dateDebut)) erreurs.push("Date de début invalide (AAAA-MM-JJ).");
    return erreurs;
  }
  function validerPaiement(p, soldeRestant) {
    const erreurs = [];
    if (!p.periodeId) erreurs.push("Choisissez la période concernée.");
    if (!Number.isInteger(p.montant) || p.montant <= 0) erreurs.push("Le montant reçu doit être un entier supérieur à 0.");
    if (Number.isInteger(p.montant) && soldeRestant != null && p.montant > soldeRestant)
      erreurs.push("Le montant (" + p.montant + ") dépasse le solde restant (" + soldeRestant + "). Corrigez ou créez la période suivante.");
    if (!["especes", "mobile_money", "virement", "autre"].includes(p.moyenPaiement)) erreurs.push("Moyen de paiement invalide.");
    if (!p.datePaiement || isNaN(Date.parse(p.datePaiement))) erreurs.push("Date de paiement invalide.");
    return erreurs;
  }

  /* ---------- Rappels : clés uniques anti-doublons ---------- */
  function rappelsDus(periodesCalculees, prefs, jour) {
    const dus = [];
    for (const c of periodesCalculees) {
      if (["payee", "annulee", "suspendue"].includes(c.statut)) continue;
      const delta = diffDays(jour, c.periode.dateEcheance); // jours avant échéance
      if (prefs.avant && delta === 3) dus.push({ cle: c.periode.id + ":avant3:" + c.periode.dateEcheance, type: "avant", periodeId: c.periode.id });
      if (prefs.jourJ && delta === 0) dus.push({ cle: c.periode.id + ":jourJ:" + c.periode.dateEcheance, type: "jourJ", periodeId: c.periode.id });
      if (prefs.apres && delta === -(prefs.delaiApres || 2)) dus.push({ cle: c.periode.id + ":apres:" + c.periode.dateEcheance, type: "apres", periodeId: c.periode.id });
    }
    return dus;
  }

  /* ---------- PDF minimal mais valide (PDF 1.4, Helvetica, Latin-1) ----------
     lines: [{text, size, bold, gap}] ; format: 'A4' | 'compact' */
  function pdfEscape(text) {
    let out = "";
    for (const ch of String(text)) {
      const code = ch.codePointAt(0);
      if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
      else if (code >= 32 && code <= 126) out += ch;
      else if (code === 0x202f || code === 0x00a0) out += " ";
      else if (code === 0x2014 || code === 0x2013) out += "-";
      else if (code === 0x2019) out += "'";
      else if (code <= 255) out += "\\" + code.toString(8).padStart(3, "0");
      else out += "?";
    }
    return out;
  }
  function genererPDF(titre, lines, format) {
    const W = format === "compact" ? 420 : 595, H = format === "compact" ? 595 : 842;
    let content = "";
    let y = H - 56;
    const x = 48;
    content += "0.06 0.16 0.26 rg 0 " + (H - 40) + " " + W + " 40 re f\n"; // bandeau bleu marine
    content += "1 1 1 rg BT /F2 15 Tf " + x + " " + (H - 27) + " Td (" + pdfEscape(titre) + ") Tj ET\n";
    content += "0 0 0 rg\n";
    y -= 24;
    for (const ln of lines) {
      const size = ln.size || 11;
      y -= (ln.gap != null ? ln.gap : size + 7);
      if (ln.rule) { content += "0.85 0.88 0.90 RG 1 w " + x + " " + (y + 4) + " m " + (W - x) + " " + (y + 4) + " l S\n"; continue; }
      if (ln.box) content += "0.90 0.97 0.95 rg " + (x - 8) + " " + (y - 7) + " " + (W - 2 * x + 16) + " " + (size + 14) + " re f 0.04 0.50 0.45 RG 1.2 w " + (x - 8) + " " + (y - 7) + " " + (W - 2 * x + 16) + " " + (size + 14) + " re S 0 0 0 rg\n";
      content += "BT " + (ln.bold ? "/F2 " : "/F1 ") + size + " Tf " + x + " " + y + " Td (" + pdfEscape(ln.text || "") + ") Tj ET\n";
    }
    const enc = (s) => { const b = []; for (const ch of s) { const c = ch.codePointAt(0); b.push(c <= 255 ? c : 63); } return b; };
    const stream = "stream\n" + content + "endstream";
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + W + " " + H + "] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
      "<< /Length " + enc(content).length + " >>\n" + stream,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    const bytes = [];
    const push = (s) => { for (const b of enc(s)) bytes.push(b); };
    push(pdf);
    objs.forEach((body, i) => {
      offsets.push(bytes.length);
      push((i + 1) + " 0 obj\n" + body + "\nendobj\n");
    });
    const xrefPos = bytes.length;
    let xref = "xref\n0 " + (objs.length + 1) + "\n0000000000 65535 f \n";
    for (let i = 1; i < offsets.length; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    push(xref + "trailer\n<< /Size " + (objs.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefPos + "\n%%EOF\n");
    return new Uint8Array(bytes);
  }

  /* ---------- Lignes d'un reçu (partagées PDF / PNG / aperçu) ---------- */
  function lignesRecu(snap, devise) {
    const L = [];
    L.push({ text: snap.activite || "RépétiPro", size: 17, bold: true });
    if (snap.sloganActivite) L.push({ text: snap.sloganActivite, size: 10 });
    const contact = [snap.telephoneActivite ? "Tél. : " + snap.telephoneActivite : "", snap.coordonneesActivite || ""].filter(Boolean).join("  ·  ");
    if (contact) L.push({ text: contact, size: 10 });
    L.push({ rule: true });
    L.push({ text: "REÇU DE PAIEMENT", size: 14, bold: true });
    L.push({ text: "N° " + snap.numero + (snap.statut === "annule" ? "  —  ANNULÉ" : ""), size: 11, bold: true });
    L.push({ text: "Date du paiement : " + snap.datePaiementFR, size: 11 });
    L.push({ rule: true });
    L.push({ text: "Reçu de : " + snap.eleveNom, size: 12, bold: true });
    L.push({ text: "Classe : " + snap.eleveClasse, size: 11 });
    L.push({ text: "Matière : " + snap.matière, size: 11 });
    L.push({ text: "Période : du " + snap.periodeDebutFR + " au " + snap.periodeEcheanceFR, size: 11 });
    L.push({ rule: true });
    L.push({ text: "Montant reçu : " + formatMontant(snap.montantRecu, devise), size: 14, bold: true, box: true });
    L.push({ text: "Montant total dû : " + formatMontant(snap.montantDu, devise), size: 11 });
    L.push({ text: "Déjà payé avant ce versement : " + formatMontant(snap.payeAvant, devise), size: 11 });
    L.push({ text: "Solde restant : " + formatMontant(snap.soldeApres, devise), size: 11, bold: snap.soldeApres > 0 });
    L.push({ text: "Moyen de paiement : " + snap.moyenLibelle, size: 11 });
    if (snap.reference) L.push({ text: "Référence : " + snap.reference, size: 11 });
    if (snap.note) L.push({ text: "Note : " + snap.note, size: 11 });
    L.push({ rule: true });
    L.push({ text: "Merci pour votre confiance.", size: 10 });
    L.push({ text: "Généré par RépétiPro — Tes élèves, tes paiements, zéro oubli.", size: 9 });
    return L;
  }

  /* ---------- Sauvegarde : somme de contrôle simple (FNV-1a, synchrone, testable) ---------- */
  function checksum(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ("00000000" + h.toString(16)).slice(-8);
  }
  function validerSauvegarde(obj) {
    if (!obj || obj.app !== "RépétiPro") return ["Ce fichier n'est pas une sauvegarde RépétiPro."];
    const erreurs = [];
    for (const k of ["eleves", "repetitions", "periodes", "paiements", "recus"])
      if (!Array.isArray(obj.data && obj.data[k])) erreurs.push("Section manquante ou invalide : " + k + ".");
    if (erreurs.length) return erreurs;
    const attendu = checksum(JSON.stringify(obj.data));
    if (obj.checksum !== attendu) erreurs.push("Somme de contrôle invalide : fichier corrompu ou modifié (attendu " + attendu + ").");
    const idsPeriodes = new Set(obj.data.periodes.map((p) => p.id));
    for (const p of obj.data.paiements) if (!idsPeriodes.has(p.periodeId)) erreurs.push("Paiement orphelin (période introuvable) : " + p.id);
    if (obj.data.seances != null) {
      if (!Array.isArray(obj.data.seances)) erreurs.push("Section invalide : seances.");
      else { const idsEleves = new Set(obj.data.eleves.map((e) => e.id));
        for (const s of obj.data.seances) if (!idsEleves.has(s.eleveId)) erreurs.push("Séance orpheline (élève introuvable) : " + s.id); }
    }
    const nums = obj.data.recus.map((r) => r.numero);
    if (new Set(nums).size !== nums.length) erreurs.push("Numéros de reçu en double détectés.");
    return erreurs;
  }

  /* ---------- Export calendrier (.ics) : l'agenda du téléphone gère les alarmes ---------- */
  function icsEscape(t) { return String(t || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n"); }
  function genererICS(evenements, dtstamp) {
    const stamp = dtstamp || new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const lignes = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//RépétiPro//Échéances//FR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
    for (const ev of evenements || []) {
      const p = parseISODate(ev.dateEcheance); if (!p) continue;
      const debut = String(p.y) + pad(p.m) + pad(p.d);
      const fp = parseISODate(addDays(ev.dateEcheance, 1));
      const fin = String(fp.y) + pad(fp.m) + pad(fp.d);
      lignes.push("BEGIN:VEVENT", "UID:" + ev.uid, "DTSTAMP:" + stamp,
        "DTSTART;VALUE=DATE:" + debut, "DTEND;VALUE=DATE:" + fin,
        "SUMMARY:" + icsEscape(ev.titre), "DESCRIPTION:" + icsEscape(ev.description || ""),
        "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsEscape(ev.titre), "TRIGGER:-P3D", "END:VALARM",
        "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsEscape(ev.titre), "TRIGGER:PT9H", "END:VALARM",
        "END:VEVENT");
    }
    lignes.push("END:VCALENDAR");
    return lignes.join("\r\n") + "\r\n";
  }

  /* ---------- Règle d'échéance configurable ---------- */
  function calculerEcheance(dateDebut, regle) {
    const r = regle || { type: "mois_calendaire" };
    if (!parseISODate(dateDebut)) throw new Error("Date de début invalide : " + dateDebut);
    if (r.type === "mois_calendaire") return addOneMonth(dateDebut);
    if (r.type === "jour_fixe") {
      const jf = r.jourFixe;
      if (!Number.isInteger(jf) || jf < 1 || jf > 31) throw new Error("Jour fixe invalide (1 à 31).");
      const p = parseISODate(dateDebut);
      let y = p.y, m = p.m;
      let cand = toISODate(y, m, Math.min(jf, daysInMonth(y, m)));
      if (cand <= dateDebut) { m += 1; if (m > 12) { m = 1; y += 1; } cand = toISODate(y, m, Math.min(jf, daysInMonth(y, m))); }
      return cand;
    }
    if (r.type === "duree_jours") {
      if (!Number.isInteger(r.dureeJours) || r.dureeJours < 1) throw new Error("Durée en jours invalide (>= 1).");
      return addDays(dateDebut, r.dureeJours);
    }
    if (r.type === "manuelle") {
      if (!parseISODate(r.dateManuelle)) throw new Error("Date d'échéance manuelle invalide.");
      return r.dateManuelle;
    }
    throw new Error("Règle d'échéance inconnue : " + r.type);
  }

  /* ---------- Séances & suivi pédagogique ---------- */
  const STATUTS_SEANCE = ["prevue", "faite", "absent", "annulee"];
  function validerSeance(s) {
    const erreurs = [];
    if (!s.eleveId) erreurs.push("Séance sans élève.");
    if (!parseISODate(s.date)) erreurs.push("Date de séance invalide (AAAA-MM-JJ).");
    if (!Number.isInteger(s.dureeMinutes) || s.dureeMinutes < 1 || s.dureeMinutes > 720) erreurs.push("Durée invalide (minutes entières, 1 à 720).");
    if (!s.matière || !String(s.matière).trim()) erreurs.push("La matière est obligatoire.");
    if (!STATUTS_SEANCE.includes(s.statut)) erreurs.push("Statut de séance invalide (prévue, faite, absent, annulée).");
    return erreurs;
  }
  function statsSeances(seances) {
    const st = { prevue: 0, faite: 0, absent: 0, annulee: 0, minutesFaites: 0 };
    for (const s of seances || []) {
      if (st[s.statut] != null) st[s.statut] += 1;
      if (s.statut === "faite" && Number.isInteger(s.dureeMinutes)) st.minutesFaites += s.dureeMinutes;
    }
    return st;
  }
  /* Bilan d'un mois construit UNIQUEMENT à partir d'entrées réellement enregistrées. */
  function bilanMensuel(seancesEleve, paiementsEleveValides, mois) {
    const duMois = (seancesEleve || []).filter((s) => s.date && s.date.startsWith(mois));
    const faites = duMois.filter((s) => s.statut === "faite");
    const uniq = (arr) => [...new Set(arr.filter(Boolean))];
    return {
      mois,
      nbFaites: faites.length,
      nbAbsences: duMois.filter((s) => s.statut === "absent").length,
      nbAnnulees: duMois.filter((s) => s.statut === "annulee").length,
      nbPrevues: duMois.filter((s) => s.statut === "prevue").length,
      minutes: faites.reduce((a, s) => a + (Number.isInteger(s.dureeMinutes) ? s.dureeMinutes : 0), 0),
      chapitres: uniq(faites.map((s) => (s.chapitre || "").trim())),
      progrès: faites.filter((s) => s.progrès && s.progrès.trim()).map((s) => ({ date: s.date, texte: s.progrès.trim() })),
      difficultes: faites.filter((s) => s.difficultes && s.difficultes.trim()).map((s) => ({ date: s.date, matière: s.matière, texte: s.difficultes.trim() })),
      encaisse: (paiementsEleveValides || []).filter((p) => p.datePaiement.startsWith(mois)).reduce((a, p) => a + p.montant, 0),
    };
  }

  /* ---------- Document Word (.docx) généré nativement (ZIP stocké + XML OOXML) ---------- */
  function xmlEscape(t) { return String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  const CRC_TABLE = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  function crc32(bytes) { let c = 0xFFFFFFFF; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zipStore(fichiers) {
    const enc = new TextEncoder();
    const u16 = (v) => [v & 255, (v >> 8) & 255];
    const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    const morceaux = [], central = [];
    let offset = 0;
    for (const f of fichiers) {
      const nomB = enc.encode(f.nom), crc = crc32(f.bytes);
      const local = [...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(f.bytes.length), ...u32(f.bytes.length), ...u16(nomB.length), ...u16(0)];
      morceaux.push(local, nomB, f.bytes);
      central.push([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(f.bytes.length), ...u32(f.bytes.length), ...u16(nomB.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)], nomB);
      offset += local.length + nomB.length + f.bytes.length;
    }
    let centralTaille = 0; for (const c of central) centralTaille += c.length;
    const fin = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(fichiers.length), ...u16(fichiers.length), ...u32(centralTaille), ...u32(offset), ...u16(0)];
    const tout = [...morceaux, ...central, fin];
    let total = 0; for (const m of tout) total += m.length;
    const out = new Uint8Array(total); let pos = 0;
    for (const m of tout) { out.set(m, pos); pos += m.length; }
    return out;
  }
  function genererDOCX(titre, lines) {
    const enc = new TextEncoder();
    const para = (texte, opt) => {
      const o = opt || {}, sz = (o.size || 11) * 2;
      const rPr = "<w:rPr>" + (o.bold ? "<w:b/>" : "") + '<w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/>' + (o.color ? '<w:color w:val="' + o.color + '"/>' : "") + "</w:rPr>";
      const pPr = o.rule ? '<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="B9C9D4"/></w:pBdr></w:pPr>'
        : (o.box ? '<w:pPr><w:shd w:val="clear" w:fill="E6F7F4"/></w:pPr>' : "");
      return "<w:p>" + pPr + "<w:r>" + rPr + '<w:t xml:space="preserve">' + xmlEscape(texte || "") + "</w:t></w:r></w:p>";
    };
    let corps = para(titre, { size: 18, bold: true, color: "0F2A43" });
    for (const ln of lines || []) corps += ln.rule ? para("", { rule: true }) : para(ln.text, ln);
    const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + corps + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:bottom="1134" w:left="1134" w:right="1134"/></w:sectPr></w:body></w:document>';
    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>';
    const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>';
    return zipStore([
      { nom: "[Content_Types].xml", bytes: enc.encode(contentTypes) },
      { nom: "_rels/.rels", bytes: enc.encode(rels) },
      { nom: "word/document.xml", bytes: enc.encode(documentXml) },
      { nom: "word/_rels/document.xml.rels", bytes: enc.encode(docRels) },
      { nom: "word/styles.xml", bytes: enc.encode(styles) },
    ]);
  }

  return { pad, toISODate, parseISODate, daysInMonth, todayISO, addOneMonth, addDays, diffDays, formatDateFR,
    assertMontant, formatMontant, soldePeriode, statutPeriode, LIBELLES_STATUT, numeroRecu,
    validerEleve, validerPaiement, rappelsDus, pdfEscape, genererPDF, lignesRecu, checksum, validerSauvegarde, genererICS,
    calculerEcheance, validerSeance, statsSeances, bilanMensuel, genererDOCX };
});
