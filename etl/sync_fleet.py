"""
Gasolio Radar — Sprint 1-3: Engine di Sincronizzazione Real-Time per Flotte di Mezzi Pesanti.

Supera la logica dello snapshot batch (`build_dataset.py`) e interroga la Live API MIMIT
(`POST /ospzApi/search/zone`) centrata sui POI aziendali definiti in `config/pois.json`.

Dallo Sprint 3 `config/pois.json` ha struttura a doppio livello:
  - `bases`              basi logistiche con coordinate e raggio di polling (10 km);
  - `monitored_stations` i 10 impianti POI fissi specifici da monitorare stabilmente.

Flusso operativo:
  A. Carica basi, impianti monitorati e overrides manuali.
  B. Anagrafica MIMIT (cache giornaliera locale) mappata per ID impianto.
  C. Polling live della zona per ogni base.
  D. Applicazione degli overrides (coordinate / note).
  E. Classificazione mezzi pesanti (`is_arteria_principale`).
  F. Deduplicazione e associazione all'impianto base piu' vicino.
  G. Output in `web/public/data/fleet_data.json` + `web/public/data/city_index.json`
     (indice citta' -> coordinate per il "Radar Spot Live" del browser) + sintesi.

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
# Indice citta' -> coordinate: alimenta la ricerca spot per citta' lato browser senza
# dipendere da servizi di geocoding esterni (Nominatim & co.).
CITY_INDEX_FILE = ROOT_DIR / "web" / "public" / "data" / "city_index.json"
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
    """
    Legge basi, impianti monitorati e overrides, validando i campi indispensabili.

    Ritorna `(basi, impianti_monitorati, overrides)`:
      - `basi`: elenco di dict con `id`, `nome`, `provincia`, `lat`, `lng`, `radius`;
      - `impianti_monitorati`: elenco di dict con `id`, `nome`, `nome_convenzionale`,
        `provincia` (la `provincia` di una base monitorata diventa la base operativa);
      - `overrides`: patch manuali per ID impianto.

    Formato atteso di `config/pois.json` (Sprint 3): oggetto con le chiavi `bases` e
    `monitored_stations`. Per non rompere eventuali file legacy viene ancora accettata
    una lista piatta di basi.
    """
    raw_config = load_json(POIS_FILE, {})
    if isinstance(raw_config, list):
        raw_basi, raw_monitorati = raw_config, []
    elif isinstance(raw_config, dict):
        raw_basi = raw_config.get("bases", [])
        raw_monitorati = raw_config.get("monitored_stations", [])
    else:
        raise SystemExit(f"Formato non valido in {POIS_FILE}: attesa una lista o un oggetto.")

    if not isinstance(raw_basi, list):
        raise SystemExit(f"Chiave 'bases' non valida in {POIS_FILE}: attesa una lista.")
    if not isinstance(raw_monitorati, list):
        raw_monitorati = []
        log(f"  ! Chiave 'monitored_stations' non valida in {POIS_FILE}: ignorata.")

    basi = []
    for raw in raw_basi:
        if not isinstance(raw, dict):
            log(f"  ! Base ignorata (non e' un oggetto): {raw!r}")
            continue
        pid = str(raw.get("id", "")).strip()
        lat = parse_coord(raw.get("lat"))
        lng = parse_coord(raw.get("lng"))
        if not pid or lat is None or lng is None:
            log(f"  ! Base ignorata (id/lat/lng mancanti): {raw!r}")
            continue
        if not (
            BBOX_ITALIA["lat_min"] <= lat <= BBOX_ITALIA["lat_max"]
            and BBOX_ITALIA["lon_min"] <= lng <= BBOX_ITALIA["lon_max"]
        ):
            log(f"  ! Base ignorata (fuori dal bounding box Italia): {pid} ({lat}, {lng})")
            continue
        try:
            radius = float(raw.get("radius", 10))
        except (TypeError, ValueError):
            radius = 10.0
        radius = max(1.0, min(10.0, radius))  # l'API accetta al massimo 10 km
        basi.append(
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
        basi = [b for b in basi if b["id"] in solo_poi]
        if not basi:
            raise SystemExit(f"Nessuna base corrisponde al filtro {sorted(solo_poi)}.")

    # Provincia per base: permette di dedurre la base operativa di un impianto
    # monitorato (es. "ME" -> Base Roccalumera) senza duplicare la mappa nel config.
    province_basi = {}
    for base in basi:
        if base["provincia"] and base["provincia"] not in province_basi:
            province_basi[base["provincia"]] = base["id"]

    impianti_monitorati = []
    visti = set()
    for raw in raw_monitorati:
        if not isinstance(raw, dict):
            log(f"  ! Impianto monitorato ignorato (non e' un oggetto): {raw!r}")
            continue
        nid = norm_id(raw.get("id"))
        if not nid:
            log(f"  ! Impianto monitorato ignorato (id mancante): {raw!r}")
            continue
        if nid in visti:
            log(f"  ! Impianto monitorato duplicato ignorato: {nid}")
            continue
        visti.add(nid)

        convenzionale = str(raw.get("nome_convenzionale", "")).strip()
        provincia = str(raw.get("provincia", "")).strip().upper()
        impianti_monitorati.append(
            {
                "id": nid,
                "nome_convenzionale": convenzionale or nid,
                # Alias usato da sintesi e fallback anagrafico.
                "nome": convenzionale or f"Impianto {nid}",
                "provincia": provincia,
                "base_id": province_basi.get(provincia),
            }
        )

    raw_overrides = load_json(OVERRIDES_FILE, {})
    if not isinstance(raw_overrides, dict):
        log(f"  ! {OVERRIDES_FILE} non contiene un oggetto: overrides ignorati.")
        raw_overrides = {}

    overrides = {}
    for key, patch in raw_overrides.items():
        nid = norm_id(key)
        if nid and isinstance(patch, dict):
            overrides[nid] = patch

    return basi, impianti_monitorati, overrides


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
            # Coordinate dall'CSV ufficiale: servono ai segnaposto degli impianti
            # monitorati non intercettati dal polling e all'indice citta' (Sprint 3).
            "lat": parse_coord(row.get("Latitudine")),
            "lon": parse_coord(row.get("Longitudine")),
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


def normalizza_record(
    impianto_live, base, anagrafica, overrides, monitored_ids=None, poi_override=None
):
    """Trasforma un risultato live nel record di output; None se non utilizzabile.

    `is_target_monitored` vale True quando l'ID impianto appartiene a
    `monitored_stations` di `config/pois.json` (impianto POI fisso aziendale).
    `poi_override` consente di attribuire il record a un perimetro diverso dalla base
    interrogata (usato dal presidio degli impianti monitorati).
    """
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
        "provincia": anag.get("provincia", "") or base["provincia"],
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "prezzo_gasolio": round(prezzo, 3),
        "data_comunicazione": str(impianto_live.get("insertDate") or "").strip(),
        "distanza_km": round(distanza, 1),
        "tipo_impianto": tipo_impianto,
        "is_arteria_principale": is_arteria_principale(nome, indirizzo, tipo_impianto),
        "is_target_monitored": bool(monitored_ids and nid in monitored_ids),
        "poi_id": (poi_override or {}).get("id", base["id"]),
        "poi_nome": (poi_override or {}).get("nome", base["nome"]),
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
# C-bis. Presidio degli impianti POI fissi (Sprint 3)
# ---------------------------------------------------------------------------
# I 10 impianti target non stanno tutti nel raggio di 10 km di una base (es. gli
# impianti di S.Teresa di Riva e Tremestieri distano 4-18 km da Roccalumera). Perche'
# la vista "Impianti Monitorati" mostri sempre un prezzo live, chi non viene
# intercettato dal polling delle basi viene interrogato attorno alle proprie
# coordinate: il record resta fuori dai perimetri delle basi (poi_id di presidio).
PERIMETRO_MONITORAGGIO = {
    "id": "monitor_sweep",
    "nome": "Presidio impianti monitorati",
}


def presidia_impianti_monitorati(
    impianti_monitorati, risultati, anagrafica, overrides, monitored_ids, session
):
    """
    Interroga la Live API attorno agli impianti monitorati non ancora coperti dal
    polling delle basi. Ritorna `(record_aggiunti, id_coperti)`.
    """
    coperti = {
        str(rec["id"])
        for rec in risultati
        if rec.get("prezzo_gasolio") is not None and str(rec["id"]) in monitored_ids
    }

    aggiunti = []
    for imp in impianti_monitorati:
        nid = imp["id"]
        if nid in coperti:
            continue

        anag = anagrafica.get(nid, {})
        lat, lon = anag.get("lat"), anag.get("lon")
        if lat is None or lon is None:
            log(f"  ! {nid}: coordinate assenti in anagrafica, presidio impossibile.")
            continue
        if not (
            BBOX_ITALIA["lat_min"] <= lat <= BBOX_ITALIA["lat_max"]
            and BBOX_ITALIA["lon_min"] <= lon <= BBOX_ITALIA["lon_max"]
        ):
            log(f"  ! {nid}: coordinate fuori dall'Italia ({lat}, {lon}), presidio saltato.")
            continue

        pseudo_base = {
            "id": PERIMETRO_MONITORAGGIO["id"],
            "nome": PERIMETRO_MONITORAGGIO["nome"],
            "provincia": imp["provincia"],
            "lat": lat,
            "lng": lon,
            "radius": 10.0,
        }
        status, results = interroga_zona(pseudo_base, session)
        if status != 200:
            log(f"  ! Presidio {nid} ({imp['nome_convenzionale']}): status {status}.")
            continue

        for impianto in results:
            if not isinstance(impianto, dict):
                continue
            if norm_id(impianto.get("id")) != nid:
                continue  # il presidio tiene solo l'impianto target
            rec = normalizza_record(
                impianto,
                pseudo_base,
                anagrafica,
                overrides,
                monitored_ids,
                poi_override=PERIMETRO_MONITORAGGIO,
            )
            if rec is not None:
                aggiunti.append(rec)
                coperti.add(nid)
                log(
                    f"  OK presidio {nid} ({imp['nome_convenzionale']}): "
                    f"EUR {rec['prezzo_gasolio']:.3f}"
                )
                break
        else:
            log(
                f"  ! Presidio {nid} ({imp['nome_convenzionale']}): "
                f"nessun Gasolio Self nel raggio di 10 km."
            )

    return aggiunti, coperti


# ---------------------------------------------------------------------------
# F. Deduplicazione e associazione alla base piu' vicina
# ---------------------------------------------------------------------------
def deduplica(records):
    """Un impianto visto da piu' basi viene tenuto una volta sola, sulla base piu' vicina."""
    migliori = {}
    for rec in records:
        nid = rec["id"]
        corrente = migliori.get(nid)
        if corrente is None or rec["distanza_km"] < corrente["distanza_km"]:
            migliori[nid] = rec

    scartati = len(records) - len(migliori)
    if scartati > 0:
        log(f"Deduplicazione: {scartati} duplicati risolti sulla base piu' vicina.")
    return list(migliori.values())


def costruisci_record_monitorati(risultati, impianti_monitorati, anagrafica):
    """
    Garantisce che i 10 impianti POI fissi siano sempre presenti nel dataset, anche
    quando nessuna base li intercetta nel proprio raggio di polling o quando il prezzo
    Gasolio Self non e' comunicato: il frontend deve poterli mostrare tutti.

    Per i record assenti si emette un segnaposto con `prezzo_gasolio: None` (la vista
    mostra "n.d.") e l'anagrafica MIMIT come unica fonte di nome e indirizzo.
    """
    presenti = {str(rec["id"]) for rec in risultati}
    aggiunti = []

    for imp in impianti_monitorati:
        nid = imp["id"]
        if nid in presenti:
            continue

        anag = anagrafica.get(nid, {})
        lat = parse_coord(anag.get("lat"))
        lon = parse_coord(anag.get("lon"))
        aggiunti.append(
            {
                "id": int(nid),
                "nome": imp["nome"] or anag.get("nome", ""),
                "gestore": anag.get("bandiera", ""),
                "indirizzo": anag.get("indirizzo", ""),
                "comune": anag.get("comune", ""),
                "provincia": anag.get("provincia", "") or imp["provincia"],
                "lat": round(lat, 6) if lat is not None else None,
                "lon": round(lon, 6) if lon is not None else None,
                "prezzo_gasolio": None,
                "data_comunicazione": "",
                "distanza_km": None,
                "tipo_impianto": anag.get("tipo_impianto", ""),
                "is_arteria_principale": False,
                "is_target_monitored": True,
                "poi_id": imp.get("base_id"),
                "poi_nome": "",
                "note": "",
                "senza_prezzo_live": True,
            }
        )
        log(
            f"  ! Impianto monitorato {nid} ({imp['nome_convenzionale']}) non rilevato "
            f"nel raggio delle basi: emesso segnaposto senza prezzo."
        )

    return risultati + aggiunti


def normalizza_citta(testo):
    """Chiave di ricerca citta': minuscole, senza accenti né punteggiatura."""
    return re.sub(r"[^a-z0-9]+", " ", str(testo or "").strip().lower()).strip()


def costruisci_indice_citta(risultati, records_grezzi):
    """
    Mappa `citta` -> { provincia: {lat, lon} } per il "Radar Spot Live" del browser.

    La ricerca spot per citta' non puo' usare un servizio di geocoding esterno: il
    Ministero accetta solo coordinate (`POST /ospzApi/search/zone`). Le coordinate
    vengono quindi prese dagli impianti gia' visti dall'engine, scegliendo per ogni
    coppia citta'/provincia il primo impianto in ordine di ID (deterministico).
    """
    indice = {}
    for rec in sorted(records_grezzi, key=lambda r: r["id"]):
        citta = normalizza_citta(rec.get("comune"))
        lat, lon = rec.get("lat"), rec.get("lon")
        if not citta or lat is None or lon is None:
            continue
        provincia = (rec.get("provincia") or "").strip().upper()
        per_provincia = indice.setdefault(citta, {})
        if provincia not in per_provincia:
            per_provincia[provincia] = {"lat": lat, "lon": lon}
    return indice


# ---------------------------------------------------------------------------
# G. Output
# ---------------------------------------------------------------------------
def scrivi_output(risultati):
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as fh:
        json.dump(risultati, fh, ensure_ascii=False, indent=2)
    return OUTPUT_FILE


def scrivi_indice_citta(indice):
    """Serializza l'indice citta' per il "Radar Spot Live" del browser."""
    CITY_INDEX_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generato_il": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "nota": (
            "Coordinate di riferimento per citta', estratte dagli impianti visti "
            "dall'engine: il Radar Spot Live le usa per interrogare /ospzApi/search/zone."
        ),
        "citta": [
            {
                "nome": citta,
                "nome_leggibile": citta.title(),
                "province": [
                    {"provincia": prov, "lat": coord["lat"], "lon": coord["lon"]}
                    for prov, coord in sorted(per_provincia.items())
                ],
            }
            for citta, per_provincia in sorted(indice.items())
        ],
    }
    with open(CITY_INDEX_FILE, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    return CITY_INDEX_FILE


def stampa_sintesi(risultati, basi, impianti_monitorati, totale_live):
    con_prezzo = [r for r in risultati if r.get("prezzo_gasolio") is not None]
    idonei = [r for r in con_prezzo if r["is_arteria_principale"]]
    log("")
    log("=" * 74)
    log("SINTESI SINCRONIZZAZIONE FLOTTA — MEZZI PESANTI")
    log("=" * 74)
    log(f"Basi interrogate ................ {len(basi)}")
    log(f"Distributori live rilevati ...... {totale_live}")
    log(f"Record con Gasolio Self ......... {len(con_prezzo)}")
    log(f"Idonei mezzi pesanti ............ {len(idonei)}")
    log(f"Scartati (urbani/vie strette) ... {len(con_prezzo) - len(idonei)}")
    segnaposto = len(risultati) - len(con_prezzo)
    log(f"Segnaposto senza prezzo ......... {segnaposto}")

    for base in basi:
        gruppo = [r for r in con_prezzo if r["poi_id"] == base["id"]]
        gruppo_idonei = [r for r in gruppo if r["is_arteria_principale"]]
        log("")
        log(f"--- {base['nome']} [{base['id']}] — raggio {base['radius']:.0f} km ---")
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

    if impianti_monitorati:
        per_id = {str(r["id"]): r for r in risultati}
        log("")
        log(f"--- IMPIANTI MONITORATI ({len(impianti_monitorati)}) ---")
        for imp in impianti_monitorati:
            rec = per_id.get(imp["id"])
            if rec is None:
                log(f"    [MANCANTE] {imp['id']:>6} | {imp['nome_convenzionale']}")
                continue
            if rec.get("prezzo_gasolio") is None:
                log(
                    f"    [NO PREZZO] {imp['id']:>5} | {imp['nome_convenzionale']:<24} | "
                    f"{rec['comune'] or 'n.d.'} ({rec['provincia'] or 'n.d.'})"
                )
            else:
                distanza = rec["distanza_km"]
                log(
                    f"    EUR {rec['prezzo_gasolio']:.3f} | "
                    f"{distanza:>4.1f} km | {imp['id']:>6} | "
                    f"{imp['nome_convenzionale']:<24} | "
                    f"{rec['comune']} ({rec['provincia']})"
                )

    stampato_il = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    log("")
    log(f"File generato: {OUTPUT_FILE}")
    if CITY_INDEX_FILE.exists():
        log(f"Indice citta': {CITY_INDEX_FILE}")
    log(f"Sincronizzazione completata il {stampato_il}")


# ---------------------------------------------------------------------------
def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Sincronizza i distributori attorno alle basi aziendali (Live API MIMIT)."
    )
    parser.add_argument(
        "--refresh-anagrafica",
        action="store_true",
        help="Ignora la cache giornaliera e riscarica il CSV anagrafica MIMIT.",
    )
    parser.add_argument(
        "--solo-poi",
        "--solo-base",
        dest="solo_poi",
        nargs="+",
        metavar="ID",
        help="Limita la sincronizzazione a una o piu' basi di config/pois.json.",
    )
    parser.add_argument(
        "--no-monitor-sweep",
        action="store_true",
        help=(
            "Salta il presidio degli impianti monitorati fuori dai raggi delle basi: "
            "la vista a 10 impianti mostra i segnaposto senza prezzo."
        ),
    )
    args = parser.parse_args(argv)

    stampato_il = datetime.now().strftime("%d/%m/%Y %H:%M")
    log("=" * 74)
    log(f"SYNC FLEET — Live API MIMIT — avvio {stampato_il}")
    log("=" * 74)

    # A. Configurazione
    log("\n[A] Caricamento configurazione...")
    basi, impianti_monitorati, overrides = carica_configurazione(args.solo_poi)
    monitored_ids = {imp["id"] for imp in impianti_monitorati}
    log(f"Basi attive: {len(basi)} | impianti monitorati: {len(monitored_ids)}")
    log(f"Overrides manuali: {len(overrides)}")
    for base in basi:
        log(f"  - {base['nome']} ({base['lat']}, {base['lng']}) raggio {base['radius']:.0f} km")

    # B. Anagrafica
    log("\n[B] Anagrafica impianti MIMIT...")
    anagrafica = carica_anagrafica(refresh=args.refresh_anagrafica)

    # C. Polling live
    log("\n[C] Interrogazione Live API per base...")
    records = []
    totale_live = 0
    esiti = []

    with requests.Session() as session:
        for base in basi:
            status, results = interroga_zona(base, session)
            esiti.append((base, status))
            if status != 200:
                log(f"  ! {base['nome']}: nessuna risposta valida (status {status}).")
                continue
            totale_live += len(results)
            log(f"  OK {base['nome']}: HTTP 200 — {len(results)} distributori nel raggio.")
            for impianto in results:
                if not isinstance(impianto, dict):
                    continue
                rec = normalizza_record(
                    impianto, base, anagrafica, overrides, monitored_ids
                )
                if rec is not None:
                    records.append(rec)

        # C-bis. Presidio dei 10 impianti POI fissi fuori dai raggi delle basi
        coperti_dal_polling = {
            str(r["id"]) for r in records if str(r["id"]) in monitored_ids
        }
        da_presidiare = len(monitored_ids - coperti_dal_polling)
        if args.no_monitor_sweep:
            log("\n[C2] Presidio impianti monitorati: disattivato (--no-monitor-sweep).")
        elif monitored_ids and da_presidiare:
            log(f"\n[C2] Presidio impianti monitorati ({da_presidiare} fuori raggio)...")
            presidiati, _ = presidia_impianti_monitorati(
                impianti_monitorati, records, anagrafica, overrides, monitored_ids, session
            )
            records.extend(presidiati)
            totale_live += len(presidiati)
        else:
            log("\n[C2] Presidio impianti monitorati: nessuno da presidiare.")

    # F. Deduplicazione
    log("\n[F] Deduplicazione e associazione base...")
    risultati = deduplica(records)

    # F-bis. I 10 impianti POI fissi devono essere sempre presenti in output
    log("\n[F2] Completamento presidio impianti monitorati...")
    risultati = costruisci_record_monitorati(risultati, impianti_monitorati, anagrafica)

    # G. Output ordinato per prezzo crescente (i segnaposto senza prezzo in coda)
    def chiave_ordinamento(rec):
        prezzo = rec.get("prezzo_gasolio")
        return (
            prezzo is None,
            prezzo if prezzo is not None else 0.0,
            rec.get("distanza_km") if rec.get("distanza_km") is not None else 0.0,
            rec["id"],
        )

    risultati.sort(key=chiave_ordinamento)
    scrivi_output(risultati)
    indice = costruisci_indice_citta(risultati, records)
    scrivi_indice_citta(indice)
    log(f"Indice citta' generato: {len(indice)} citta' per la ricerca spot.")
    stampa_sintesi(risultati, basi, impianti_monitorati, totale_live)

    falliti = [b["id"] for b, status in esiti if status != 200]
    if falliti:
        log(f"\n[!] Basi senza risposta 200: {', '.join(falliti)}")
        return 1
    if not any(r.get("prezzo_gasolio") is not None for r in risultati):
        log("\n[!] Nessun distributore con Gasolio Self trovato: dataset vuoto.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
