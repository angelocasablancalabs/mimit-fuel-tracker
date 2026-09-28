"""
Gasolio Radar — Sprint 1: Engine di Sincronizzazione Real-Time per Flotte di Mezzi Pesanti.

Supera la logica dello snapshot batch (`build_dataset.py`) e interroga la Live API MIMIT
(`POST /ospzApi/search/zone`) centrata sui POI aziendali definiti in `config/pois.json`.

Flusso operativo:
  A. Carica i POI e gli overrides manuali.
  B. Anagrafica MIMIT (cache giornaliera locale) mappata per ID impianto.
  C. Polling live della zona per ogni POI.
  D. Applicazione degli overrides (coordinate / note).
  E. Classificazione mezzi pesanti (`is_arteria_principale`).
  F. Deduplicazione e associazione all'impianto POI piu' vicino.
  G. Output in `web/public/data/fleet_data.json` + sintesi a terminale.

Uso:  python etl/sync_fleet.py [--refresh-anagrafica] [--solo-poi base_alessandria]
"""

import argparse
import csv
import io
import json
import re
import sys
import time
from datetime import date, datetime
from pathlib import Path

import requests

# La console Windows usa spesso cp1252: senza questo le accentate e i simboli
# (€, —) finiscono in mojibake a terminale.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# --- Percorsi (sempre via pathlib, nessuna concatenazione di stringhe) -------
ROOT_DIR = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT_DIR / "config"
POIS_FILE = CONFIG_DIR / "pois.json"
OVERRIDES_FILE = CONFIG_DIR / "overrides.json"
OUTPUT_FILE = ROOT_DIR / "web" / "public" / "data" / "fleet_data.json"
ANAGRAFICA_CACHE = Path(__file__).resolve().parent / "anagrafica_cache.csv"

# --- Endpoint ufficiali ------------------------------------------------------
URL_ANAGRAFICA = (
    "https://www.mimit.gov.it/images/exportCSV/anagrafica_impianti_attivi.csv"
)
URL_LIVE_ZONE = "https://carburanti.mise.gov.it/ospzApi/search/zone"

# Header mimetici: la Live API del Ministero rifiuta le chiamate senza Origin/Referer.
HEADERS_CSV = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )
}
HEADERS_LIVE = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "User-Agent": HEADERS_CSV["User-Agent"],
    "Origin": "https://carburanti.mise.gov.it",
    "Referer": "https://carburanti.mise.gov.it/ospzSearch/zona",
}

# Gasolio: fuelId 2 (standard). La chiave "2-1" = Gasolio Self Service per la zona.
FUEL_ID_GASOLIO = 2
FUEL_TYPE_ZONE = "2-1"

# Bounding box Italia: nessuna coordinata valida puo' stare fuori da qui.
BBOX_ITALIA = {"lat_min": 35.0, "lat_max": 48.0, "lon_min": 6.0, "lon_max": 19.0}

# Tipo Impianto = "Autostradale" basta da solo a classificare l'arteria principale.
TIPO_AUTOSTRADALE = "autostradale"

# Grandi arterie / aree logistiche compatibili con mezzi pesanti.
# NB: per S.S./S.P./S.R. e per le autostrade (A1..A99) il pattern pretende che il
# riferimento sia SEGUITO da un numero: cosi' "S.R.L.", "S.R." senza numero e la
# sigla merceologica "A2A" non generano falsi positivi.
PATTERN_ARTERIA = re.compile(
    r"\b(?:"
    r"S\.?\s?S\.?\s?\d+"
    r"|S\.?\s?P\.?\s?\d+"
    r"|S\.?\s?R\.?\s?\d+"
    r"|A\d{1,2}\b"
    r"|Autostrada"
    r"|Tangenziale"
    r"|Raccordo"
    r"|Circonvallazione"
    r"|Interporto"
    r"|Zona\s+Industriale"
    r"|Area\s+PIP"
    r")",
    re.IGNORECASE,
)


def log(msg):
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# A. Configurazione
# ---------------------------------------------------------------------------
def load_json(path, default):
    """Legge un file JSON; se assente o corrotto torna il default con un avviso."""
    if not path.exists():
        log(f"  ! File assente: {path} — uso il default {default!r}")
        return default
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError) as exc:
        log(f"  ! Impossibile leggere {path} ({exc}) — uso il default {default!r}")
        return default


def norm_id(value):
    """Normalizza un ID impianto a stringa, tollerando int, float e None."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else str(value)
    text = str(value).strip()
    if not text:
        return None
    if text.endswith(".0") and text[:-2].isdigit():
        text = text[:-2]
    return text


def parse_coord(value):
    """Converte una coordinata in float; None se non interpretabile."""
    try:
        return float(str(value).replace(",", ".").strip())
    except (TypeError, ValueError):
        return None


def carica_configurazione(solo_poi=None):
    """Legge POI e overrides, validando i campi indispensabili."""
    raw_pois = load_json(POIS_FILE, [])
    if not isinstance(raw_pois, list):
        raise SystemExit(f"Formato non valido in {POIS_FILE}: attesa una lista di POI.")

    pois = []
    for raw in raw_pois:
        if not isinstance(raw, dict):
            log(f"  ! POI ignorato (non e' un oggetto): {raw!r}")
            continue
        pid = str(raw.get("id", "")).strip()
        lat = parse_coord(raw.get("lat"))
        lng = parse_coord(raw.get("lng"))
        if not pid or lat is None or lng is None:
            log(f"  ! POI ignorato (id/lat/lng mancanti): {raw!r}")
            continue
        if not (
            BBOX_ITALIA["lat_min"] <= lat <= BBOX_ITALIA["lat_max"]
            and BBOX_ITALIA["lon_min"] <= lng <= BBOX_ITALIA["lon_max"]
        ):
            log(f"  ! POI ignorato (fuori dal bounding box Italia): {pid} ({lat}, {lng})")
            continue
        try:
            radius = float(raw.get("radius", 10))
        except (TypeError, ValueError):
            radius = 10.0
        radius = max(1.0, min(10.0, radius))  # l'API accetta al massimo 10 km
        pois.append(
            {
                "id": pid,
                "nome": str(raw.get("nome", pid)).strip() or pid,
                "provincia": str(raw.get("provincia", "")).strip().upper(),
                "lat": lat,
                "lng": lng,
                "radius": radius,
            }
        )

    if solo_poi:
        pois = [p for p in pois if p["id"] in solo_poi]
        if not pois:
            raise SystemExit(f"Nessun POI corrisponde al filtro {sorted(solo_poi)}.")

    raw_overrides = load_json(OVERRIDES_FILE, {})
    if not isinstance(raw_overrides, dict):
        log(f"  ! {OVERRIDES_FILE} non contiene un oggetto: overrides ignorati.")
        raw_overrides = {}

    overrides = {}
    for key, patch in raw_overrides.items():
        nid = norm_id(key)
        if nid and isinstance(patch, dict):
            overrides[nid] = patch

    return pois, overrides


# ---------------------------------------------------------------------------
# B. Anagrafica MIMIT (con cache giornaliera locale)
# ---------------------------------------------------------------------------
def _scarica_anagrafica():
    log(f"Download anagrafica MIMIT: {URL_ANAGRAFICA} ...")
    resp = requests.get(URL_ANAGRAFICA, headers=HEADERS_CSV, timeout=90)
    resp.raise_for_status()
    resp.encoding = "utf-8"
    return resp.text


def carica_anagrafica(refresh=False):
    """
    Restituisce {ID_IMPIANTO: {bandiera, indirizzo, comune, provincia, tipo_impianto, nome}}.

    Se la cache locale `etl/anagrafica_cache.csv` e' stata scritta oggi viene riusata,
    altrimenti si riscarica il CSV ufficiale (o si ripiega sulla cache stantia in caso
    di rete non disponibile).
    """
    testo = None
    oggi = date.today()

    cache_fresca = (
        not refresh
        and ANAGRAFICA_CACHE.exists()
        and date.fromtimestamp(ANAGRAFICA_CACHE.stat().st_mtime) == oggi
    )

    if cache_fresca:
        try:
            testo = ANAGRAFICA_CACHE.read_text(encoding="utf-8")
            log(f"Anagrafica da cache giornaliera: {ANAGRAFICA_CACHE.name}")
        except OSError as exc:
            log(f"  ! Cache illeggibile ({exc}), riscarico.")
            testo = None

    if testo is None:
        try:
            testo = _scarica_anagrafica()
            ANAGRAFICA_CACHE.write_text(testo, encoding="utf-8")
            log(f"Anagrafica salvata in cache: {ANAGRAFICA_CACHE.name}")
        except (requests.RequestException, OSError) as exc:
            log(f"  ! Download anagrafica fallito: {exc}")
            if ANAGRAFICA_CACHE.exists():
                testo = ANAGRAFICA_CACHE.read_text(encoding="utf-8")
                log("  -> Ripiego sulla cache locale (potenzialmente non aggiornata).")
            else:
                raise SystemExit(
                    "Anagrafica MIMIT non disponibile: impossibile classificare i mezzi pesanti."
                )

    # La prima riga del CSV e' un metadato ("Estrazione del ..."): la intestazione
    # reale (idImpianto|Gestore|Bandiera|Tipo Impianto|...) e' la seconda.
    righe = testo.splitlines()
    if righe and righe[0].lower().startswith("estrazione"):
        righe = righe[1:]

    anagrafica = {}
    lettore = csv.DictReader(io.StringIO("\n".join(righe)), delimiter="|")
    for row in lettore:
        nid = norm_id(row.get("idImpianto"))
        if not nid:
            continue
        anagrafica[nid] = {
            "bandiera": (row.get("Bandiera") or "").strip(),
            "gestore": (row.get("Gestore") or "").strip(),
            "indirizzo": " ".join((row.get("Indirizzo") or "").split()),
            "comune": (row.get("Comune") or "").strip(),
            "provincia": (row.get("Provincia") or "").strip().upper(),
            "tipo_impianto": (row.get("Tipo Impianto") or "").strip(),
            "nome": " ".join((row.get("Nome Impianto") or "").split()),
        }

    log(f"Anagrafica MIMIT mappata: {len(anagrafica)} impianti per ID.")
    return anagrafica


# ---------------------------------------------------------------------------
# C. Polling Live API per zona
# ---------------------------------------------------------------------------
def interroga_zona(poi, session, tentativi=3):
    """POST /ospzApi/search/zone per un singolo POI. Ritorna (status_code, results)."""
    payload = {
        "points": [{"lat": poi["lat"], "lng": poi["lng"]}],
        "radius": poi["radius"],
        "fuelType": FUEL_TYPE_ZONE,
    }

    for tentativo in range(1, tentativi + 1):
        try:
            resp = session.post(
                URL_LIVE_ZONE, json=payload, headers=HEADERS_LIVE, timeout=30
            )
            if resp.status_code == 200:
                return 200, resp.json().get("results", []) or []
            if tentativo == tentativi:
                return resp.status_code, []
            log(
                f"  ! {poi['id']}: HTTP {resp.status_code}, "
                f"ritento ({tentativo}/{tentativi - 1})..."
            )
        except (requests.RequestException, ValueError) as exc:
            if tentativo == tentativi:
                log(f"  ! {poi['id']}: errore di rete definitivo ({exc}).")
                return None, []
            log(f"  ! {poi['id']}: {exc} — ritento ({tentativo}/{tentativi - 1})...")
        time.sleep(1.5 * tentativo)

    return None, []


def estrai_prezzo_gasolio(fuels):
    """Prezzo Gasolio Self Service: fuelId == 2 (o name 'Gasolio') con isSelf True."""
    if not isinstance(fuels, list):
        return None, None

    candidati = []
    for indice, fuel in enumerate(fuels):
        if not isinstance(fuel, dict):
            continue
        nome = str(fuel.get("name") or "").strip().lower()
        if fuel.get("fuelId") != FUEL_ID_GASOLIO and nome != "gasolio":
            continue
        if fuel.get("isSelf") is not True:
            continue
        prezzo = parse_coord(fuel.get("price"))
        if prezzo is None:
            continue
        candidati.append((prezzo, indice))

    if not candidati:
        return None, None
    # Se il listino riporta piu' voci Gasolio Self, vince la piu' economica.
    prezzo, indice = min(candidati, key=lambda c: c[0])
    return prezzo, indice


def normalizza_record(impianto_live, poi, anagrafica, overrides):
    """Trasforma un risultato live nel record di output; None se non utilizzabile."""
    nid = norm_id(impianto_live.get("id"))
    if not nid:
        return None

    prezzo, _ = estrai_prezzo_gasolio(impianto_live.get("fuels"))
    if prezzo is None:
        return None  # niente Gasolio Self: impianto inutile per la flotta

    location = impianto_live.get("location") or {}
    lat = parse_coord(location.get("lat"))
    lon = parse_coord(location.get("lng"))

    distanza = parse_coord(impianto_live.get("distance"))
    if distanza is None:
        distanza = 0.0

    anag = anagrafica.get(nid, {})
    nome = (
        str(impianto_live.get("name") or "").strip()
        or anag.get("nome", "")
        or str(impianto_live.get("brand") or "").strip()
    )
    indirizzo = anag.get("indirizzo", "")
    tipo_impianto = anag.get("tipo_impianto", "")

    # D. Overrides manuali: coordinate, note e (se serve) anagrafica.
    note = ""
    patch = overrides.get(nid)
    if patch:
        if "lat" in patch:
            override_lat = parse_coord(patch.get("lat"))
            if override_lat is not None:
                lat = override_lat
        if "lon" in patch:
            override_lon = parse_coord(patch.get("lon"))
            if override_lon is not None:
                lon = override_lon
        if "lng" in patch:  # alias tollerato
            override_lng = parse_coord(patch.get("lng"))
            if override_lng is not None:
                lon = override_lng
        if patch.get("nome"):
            nome = str(patch["nome"]).strip()
        if patch.get("indirizzo"):
            indirizzo = " ".join(str(patch["indirizzo"]).split())
        note = str(patch.get("note", "")).strip()

    if lat is None or lon is None:
        return None
    if not (
        BBOX_ITALIA["lat_min"] <= lat <= BBOX_ITALIA["lat_max"]
        and BBOX_ITALIA["lon_min"] <= lon <= BBOX_ITALIA["lon_max"]
    ):
        log(f"  ! Impianto {nid} scartato: coordinate fuori dall'Italia ({lat}, {lon}).")
        return None

    return {
        "id": int(nid),
        "nome": nome,
        "gestore": anag.get("bandiera", "") or str(impianto_live.get("brand") or "").strip(),
        "indirizzo": indirizzo,
        "comune": anag.get("comune", ""),
        "provincia": anag.get("provincia", "") or poi["provincia"],
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "prezzo_gasolio": round(prezzo, 3),
        "data_comunicazione": str(impianto_live.get("insertDate") or "").strip(),
        "distanza_km": round(distanza, 1),
        "tipo_impianto": tipo_impianto,
        "is_arteria_principale": is_arteria_principale(nome, indirizzo, tipo_impianto),
        "poi_id": poi["id"],
        "poi_nome": poi["nome"],
        "note": note,
    }


# ---------------------------------------------------------------------------
# E. Classificazione mezzi pesanti / grandi arterie
# ---------------------------------------------------------------------------
def is_arteria_principale(nome, indirizzo, tipo_impianto=""):
    """
    True se l'impianto e' accessibile a mezzi pesanti:
      - Tipo Impianto == "Autostradale", oppure
      - nome/indirizzo contengono un riferimento a grande arteria o area logistica.
    """
    if (tipo_impianto or "").strip().lower() == TIPO_AUTOSTRADALE:
        return True

    testo = f"{nome or ''} {indirizzo or ''}"
    if not testo.strip():
        return False
    return bool(PATTERN_ARTERIA.search(testo))


# ---------------------------------------------------------------------------
# F. Deduplicazione e associazione al POI piu' vicino
# ---------------------------------------------------------------------------
def deduplica(records):
    """Un impianto visto da piu' POI viene tenuto una volta sola, sul POI piu' vicino."""
    migliori = {}
    for rec in records:
        nid = rec["id"]
        corrente = migliori.get(nid)
        if corrente is None or rec["distanza_km"] < corrente["distanza_km"]:
            migliori[nid] = rec

    scartati = len(records) - len(migliori)
    if scartati > 0:
        log(f"Deduplicazione: {scartati} duplicati risolti sul POI piu' vicino.")
    return list(migliori.values())


# ---------------------------------------------------------------------------
# G. Output
# ---------------------------------------------------------------------------
def scrivi_output(risultati):
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as fh:
        json.dump(risultati, fh, ensure_ascii=False, indent=2)
    return OUTPUT_FILE


def stampa_sintesi(risultati, pois, totale_live):
    idonei = [r for r in risultati if r["is_arteria_principale"]]
    log("")
    log("=" * 74)
    log("SINTESI SINCRONIZZAZIONE FLOTTA — MEZZI PESANTI")
    log("=" * 74)
    log(f"POI interrogati ................. {len(pois)}")
    log(f"Distributori live rilevati ...... {totale_live}")
    log(f"Record con Gasolio Self ......... {len(risultati)}")
    log(f"Idonei mezzi pesanti ............ {len(idonei)}")
    log(f"Scartati (urbani/vie strette) ... {len(risultati) - len(idonei)}")

    for poi in pois:
        gruppo = [r for r in risultati if r["poi_id"] == poi["id"]]
        gruppo_idonei = [r for r in gruppo if r["is_arteria_principale"]]
        log("")
        log(f"--- {poi['nome']} [{poi['id']}] — raggio {poi['radius']:.0f} km ---")
        log(f"    rilevati {len(gruppo)} | idonei mezzi pesanti {len(gruppo_idonei)}")
        top = gruppo_idonei if gruppo_idonei else gruppo
        etichetta = "Top 3 idonei" if gruppo_idonei else "Top 3 (nessun idoneo)"
        if not top:
            log(f"    {etichetta}: nessun distributore rilevato nel raggio.")
            continue
        log(f"    {etichetta} (piu' convenienti):")
        for rec in top[:3]:
            log(
                f"      EUR {rec['prezzo_gasolio']:.3f} | {rec['distanza_km']:>4.1f} km | "
                f"{rec['gestore'] or 'N/D'} - {rec['comune']} ({rec['provincia']}) | "
                f"{rec['indirizzo'] or rec['nome']}"
            )

    stampato_il = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    log("")
    log(f"File generato: {OUTPUT_FILE}")
    log(f"Sincronizzazione completata il {stampato_il}")


# ---------------------------------------------------------------------------
def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Sincronizza i distributori attorno ai POI aziendali (Live API MIMIT)."
    )
    parser.add_argument(
        "--refresh-anagrafica",
        action="store_true",
        help="Ignora la cache giornaliera e riscarica il CSV anagrafica MIMIT.",
    )
    parser.add_argument(
        "--solo-poi",
        nargs="+",
        metavar="ID",
        help="Limita la sincronizzazione a uno o piu' ID POI di config/pois.json.",
    )
    args = parser.parse_args(argv)

    stampato_il = datetime.now().strftime("%d/%m/%Y %H:%M")
    log("=" * 74)
    log(f"SYNC FLEET — Live API MIMIT — avvio {stampato_il}")
    log("=" * 74)

    # A. Configurazione
    log("\n[A] Caricamento configurazione...")
    pois, overrides = carica_configurazione(args.solo_poi)
    log(f"POI attivi: {len(pois)} | overrides manuali: {len(overrides)}")
    for poi in pois:
        log(f"  - {poi['nome']} ({poi['lat']}, {poi['lng']}) raggio {poi['radius']:.0f} km")

    # B. Anagrafica
    log("\n[B] Anagrafica impianti MIMIT...")
    anagrafica = carica_anagrafica(refresh=args.refresh_anagrafica)

    # C. Polling live
    log("\n[C] Interrogazione Live API per POI...")
    records = []
    totale_live = 0
    esiti = []

    with requests.Session() as session:
        for poi in pois:
            status, results = interroga_zona(poi, session)
            esiti.append((poi, status))
            if status != 200:
                log(f"  ! {poi['nome']}: nessuna risposta valida (status {status}).")
                continue
            totale_live += len(results)
            log(f"  OK {poi['nome']}: HTTP 200 — {len(results)} distributori nel raggio.")
            for impianto in results:
                if not isinstance(impianto, dict):
                    continue
                rec = normalizza_record(impianto, poi, anagrafica, overrides)
                if rec is not None:
                    records.append(rec)

    # F. Deduplicazione
    log("\n[F] Deduplicazione e associazione POI...")
    risultati = deduplica(records)

    # G. Output ordinato per prezzo crescente
    risultati.sort(key=lambda r: (r["prezzo_gasolio"], r["distanza_km"], r["id"]))
    scrivi_output(risultati)
    stampa_sintesi(risultati, pois, totale_live)

    falliti = [p["id"] for p, status in esiti if status != 200]
    if falliti:
        log(f"\n[!] POI senza risposta 200: {', '.join(falliti)}")
        return 1
    if not risultati:
        log("\n[!] Nessun distributore con Gasolio Self trovato: dataset vuoto.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
