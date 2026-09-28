# PROGRESS.md — Baseline, Milestone e Roadmap

Registro di bordo del progetto **Gasolio Radar (MIMIT Fuel Tracker)**. Ogni sessione di lavoro significativa aggiorna questo file.

- **Ultimo aggiornamento:** Sprint 1 — Backend & Live Engine Mezzi Pesanti (completato).
- **Stato complessivo:** 🟢 operativo — pipeline dati e dashboard funzionanti end-to-end, lint pulito (0 warning, 0 errori), nuovo engine di sincronizzazione flotta live attivo su 2 POI aziendali.

---

## 1. Baseline dello Stato Attuale (Funzionante)

Tutto quanto segue è verificato e in esercizio.

### Pipeline dati (`etl/build_dataset.py`)
- [x] Download via `requests` dei due CSV ufficiali MIMIT con `User-Agent` esplicito e timeout a 60s.
- [x] Parsing in streaming con `csv.DictReader` e delimitatore pipe `|`; scarto della riga di metadati in testa al file.
- [x] Filtro geografico su `TARGET_PROVINCE = ["ME", "AL"]` (lista vuota ⇒ tutta Italia).
- [x] Validazione coordinate: scarto degli impianti fuori dal bounding box Italia (lat 35–48, lon 6–19).
- [x] Join tra anagrafica impianti e listino prezzi sulla chiave `idImpianto`.
- [x] Selezione esclusiva di **Gasolio Self Service** (`descCarburante == "gasolio"` e `isSelf == "1"`), con esclusione di Premium/Plus.
- [x] Scarto finale degli impianti privi di prezzo comunicato e ordinamento per prezzo crescente.
- [x] Generazione automatica di `web/public/data/gasolio_focus.json` (percorso costruito con `pathlib`, creazione della cartella se assente).
- [x] Report a fine esecuzione: conteggio impianti validi, percorso del file, top 3 più economici.
- [x] Script diagnostico `etl/test_target.py` su una lista di impianti sentinella (ME + AL).

**Stato dataset corrente:** 396 impianti con prezzo Gasolio Self attivo, ~131 KB di JSON, ordinati dal più economico. Con il filtro freschezza attivo (default) ne restano visibili **390**.

### Dashboard web (`web/`)
- [x] Frontend Vite + React 19 avviabile con `npm run dev` e compilabile con `npm run build`.
- [x] Layout Desktop Split-Screen: sidebar scorrevole a sinistra, mappa a tutto schermo a destra.
- [x] Statistiche live reattive ai filtri: **Minimo**, **Medio Zona**, **Impianti**.
- [x] Filtro per provincia con tab: Tutte, Messina (ME), Alessandria (AL).
- [x] Ricerca testuale istantanea su comune, gestore e indirizzo, combinata in AND col filtro provincia.
- [x] Mappa Leaflet su tile OpenStreetMap con custom pill marker colorati per fascia di prezzo (`cheap` ≤ +0,05 €, `mid` ≤ +0,15 €, `expensive` oltre), popup con gestore, indirizzo, prezzo e data di rilevazione.
- [x] Interazione bidirezionale: click sulla card → `flyTo` + apertura popup; click sul marker → card selezionata.
- [x] `fitBounds` automatico sull'insieme filtrato, con `maxZoom` di sicurezza.
- [x] Styling custom dark in `src/App.css`, icone Lucide.
- [x] Freschezza del dato: badge `fresh` / `standard` / `stale` in card e popup, toggle "Escludi dati non recenti (> 7 giorni)" attivo di default (dettaglio in Milestone 1).
- [x] Configurazione Oxlint attiva (`npm run lint`).

### Igiene del repository
- [x] `.gitignore` a copertura di ambiente e segreti (`.env`), Python (`.venv/`, `__pycache__/`), Node (`node_modules/`, `dist/`) e dati grezzi (`*.csv`, `etl/raw/`, `*.tmp`).

---

## 2. Milestone 0 — Fondamenta (Completata)

- [x] Ispezione architetturale e pulizia del repository.
- [x] Setup della pipeline dati Python (venv + `requests`) e della web app Vite.
- [x] Istituzione della triade di governance: `README.md`, `AGENTS.md`, `PROGRESS.md`.
- [x] Verifica di integrità dell'ambiente: `cd web && npm run build` completato senza errori (1887 moduli, bundle ~379 KB / 115 KB gzip in 1,16 s).
- [x] `npm run lint` (Oxlint): **0 errori, 0 warning** — pulito dopo la sanificazione preliminare.

---

## 3. Milestone 1 — Freshness Warning & Filtro Impianti Attivi (Completata)

- [x] **Task 1 - Freshness Warning & Filtro Impianti Attivi**.
- [x] Utility di parsing sicuro di `data_aggiornamento` (`"DD/MM/YYYY HH:mm:ss"`): regex ancorata a formato italiano con parti non valide scartate, controllo anti-rollover (es. `31/02` rifiutato), fallback a `null` su stringa assente o non interpretabile. Le date nel futuro sono trattate come "Oggi".
- [x] Tre livelli di freschezza: **Fresh** (≤ 2 giorni, badge verde), **Standard** (3–7 giorni, badge neutro), **Stale** (> 7 giorni, badge rosso con icona `AlertTriangle`).
- [x] Toggle `excludeStale` in `.controls-container` con **default `true`**: "Escludi dati non recenti (> 7 giorni)", con conteggio dinamico degli impianti esclusi.
- [x] Gli impianti dormienti spariscono simultaneamente da lista card e pin Leaflet; badge di freschezza nel footer della card e nel popup della mappa.
- [x] Sanificazione preliminare: import `ExternalLink` rimosso, `getPriceTier` avvolto in `useCallback` (chiude il warning `exhaustive-deps`), eliminato il duplicato legacy `etl/gasolio_focus.json` (verificato identico via SHA-256 prima della rimozione).
- [x] `npm run lint`: **0 errori, 0 warning**. `npm run build`: completato senza errori né warning.
- [x] Verificati i confini delle soglie: 2 gg → fresh, 3 gg → standard, 7 gg → standard (non escluso), 8 gg → stale (escluso).

### Conteggi sul dataset corrente (2026-09-28)
- Totale 396 impianti → **390 visibili** e **6 esclusi** dal filtro di default.
- Ripartizione livelli: 320 fresh, 70 standard, 6 stale.
- Impianti dormienti esclusi dal filtro: `50211` e `60420` (10 gg), `21051` (9 gg), `38931` (50 gg), `16328` e `55585` (66 gg).

> Nota di design: un record con data non interpretabile viene classificato **standard** e resta **visibile**, per non far sparire in silenzio un impianto a causa di un formato inatteso.

---

## 3.5 Sprint 1 — Backend & Live Engine Mezzi Pesanti (Completata)

Obiettivo: superare lo snapshot batch statico (`build_dataset.py`) con un engine che interroga la **Live API MIMIT** centrata sui POI aziendali e isola i distributori realmente accessibili a mezzi pesanti.

### Nuovi artefatti

| File | Ruolo |
| --- | --- |
| `config/pois.json` | Punti di interesse della flotta (ID, nome, provincia, lat/lng, raggio km). Contiene `base_roccalumera` (ME) e `base_alessandria` (AL). |
| `config/overrides.json` | Patch manuali per ID impianto (`lat`, `lon`, `nome`, `note`): corregge coordinate errate dell'anagrafica senza toccare il codice. Attualmente `{}`. |
| `etl/sync_fleet.py` | Engine di sincronizzazione real-time (fasi A–G, dettaglio sotto). Eseguibile con `cd etl` → `python sync_fleet.py`. |
| `web/public/data/fleet_data.json` | Dataset di output consumabile dal frontend: record ordinati per prezzo crescente. |

### Flusso dell'engine (`etl/sync_fleet.py`)
- [x] **(A)** Caricamento `config/pois.json` + `config/overrides.json`, con validazione dei campi indispensabili, clamp del raggio a 1–10 km (limite dell'API) e scarto dei POI fuori dal bounding box Italia.
- [x] **(B)** Anagrafica MIMIT (`anagrafica_impianti_attivi.csv`, separatore `|`) mappata per ID impianto su Bandiera, Gestore, Indirizzo, Comune, Provincia, Tipo Impianto, Nome. **Cache giornaliera** in `etl/anagrafica_cache.csv`: riusata se scritta oggi, altrimenti riscaricata (con ripiego sulla cache stantia se la rete non risponde).
- [x] **(C)** Polling live per POI: `POST https://carburanti.mise.gov.it/ospzApi/search/zone` con payload `{"points": [...], "radius": ..., "fuelType": "2-1"}` e header mimetici (User-Agent Chrome, `Origin` e `Referer` del Ministero). Fino a 3 tentativi con backoff per POI.
- [x] **(D)** Applicazione overrides: sovrascrittura di coordinate, nome e note per ID impianto.
- [x] **(E)** Classificazione `is_arteria_principale`: `True` se `Tipo Impianto == "Autostradale"`, oppure se nome/indirizzo contengono un riferimento a grande arteria o area logistica (`S.S.`/`S.P.`/`S.R.`+numero, `A1`–`A99`, Autostrada, Tangenziale, Raccordo, Circonvallazione, Interporto, Zona Industriale, Area PIP), altrimenti `False`.
- [x] **(F)** Deduplicazione: un impianto visto da più POI viene tenuto una volta sola, associato al POI con distanza minima.
- [x] **(G)** Output in `web/public/data/fleet_data.json` (ordinato per prezzo) e sintesi a terminale con totale live, conteggio idonei e top 3 per POI.

### Contratto dati di `fleet_data.json`
Array di oggetti, ciascuno con: `id`, `nome`, `gestore`, `indirizzo`, `comune`, `provincia`, `lat`, `lon`, `prezzo_gasolio`, `data_comunicazione` (ISO 8601 da `insertDate`), `distanza_km` (1 decimale), `tipo_impianto`, `is_arteria_principale`, `poi_id`, `poi_nome`, `note`.

### Verifiche eseguite
- [x] `python sync_fleet.py` con venv attivo: **exit code 0**, HTTP **200** su entrambi i POI (Roccalumera, Alessandria).
- [x] `fleet_data.json` generato e rivalidato con `json.loads`: 51 record, ID univoci, tutti i campi anagrafici popolati (zero valori mancanti), coordinate dentro il bounding box Italia, prezzi in ordine crescente.
- [x] Classificazione `is_arteria_principale` verificata su 22 casi sintetici (0 errori), inclusi i falsi positivi da evitare: `S.R.L.` e la sigla merceologica `A2A` **non** classificano come arteria.
- [x] Pipeline overrides verificata end-to-end: patch su un ID impianto applicata correttamente al JSON prodotto, poi rimossa.
- [x] Cache anagrafica verificata: secondo run istantaneo con "Anagrafica da cache giornaliera".

### Conteggi sul run live (2026-09-28)
- **51** distributori live rilevati nei due raggi (14 Roccalumera + 37 Alessandria), **51** con Gasolio Self comunicato.
- **12 impianti idonei** ai mezzi pesanti (2 su Roccalumera, 10 su Alessandria); **39 scartati** come urbani/vie secondarie.
- Top 3 Alessandria: € 2,190 (4,1 km, SS 10 Spinetta Marengo), € 2,190 (8,2 km, S.S. 30), € 2,355 (6,3 km, S.S. 10).
- Top 2 Roccalumera (unico idoneo alla SS 114): € 2,419 (3,8 km, SS.114), € 2,469 (4,1 km, A18 autostradale).

> Nota di design: la regex delle arterie richiede un **numero** dopo `S.S.`/`S.P.`/`S.R.` e dopo la lettera autostradale. Senza questo vincolo `S.R.L.` (ragioni sociali) e sigle come `A2A` verrebbero classificate erroneamente come grandi arterie. Noto falso negativo residuo: le strade indicate solo con il nome (es. "Orientale Sicula", "Consolare Valeria") non vengono riconosciute — candidato a estensione futura se emergerà dai dati reali.

---

## 4. Roadmap / Backlog Prossimi Task

### Sprint 2 — Frontend Minimal Istituzionale Mezzi Pesanti (prossimo)
Vista dedicata alla flotta che consuma `web/public/data/fleet_data.json`:
- Interruttore **"Solo grandi arterie"** che filtra sul flag `is_arteria_principale`, con la mappa limitata ai distributori accessibili ai mezzi pesanti.
- Selettore **POI / base** (`poi_id`) accanto al filtro provincia esistente, con `fitBounds` sul perimetro della base.
- Distanza dal POI visibile in card e popup (`distanza_km`) e ordinamento per prezzo già garantito dal dataset.
- Badge "Accesso mezzi pesanti" e riga `note` quando l'impianto è stato corretto manualmente via `config/overrides.json`.
- Riuso dell'interazione bidirezionale card ↔ marker e del layout split-screen esistenti: nessuna nuova route, nessun tab.
- Preparare lo script di build a servire entrambi i dataset (`gasolio_focus.json` + `fleet_data.json`) senza rompere il contratto attuale.

### Task 2 — Calcolatore Risparmio Ufficio
Box dinamico con stima del risparmio in Euro per singolo pieno (serbatoio standard 50 L) rispetto alla media locale della zona filtrata. Utile per quantificare in modo immediato la convenienza di uno spostamento.

### Task 3 — Clustering Marker / Ottimizzazione Mappa
Gestione avanzata dei pin sovrapposti nelle viste grandangolari, per mantenere la mappa leggibile quando i risultati filtrati sono numerosi.

### Task 4 — CI/CD GitHub Actions
Workflow schedulato ogni mattina alle **08:30** per l'esecuzione automatica dell'ETL e il deploy su GitHub Pages o Cloudflare Pages. Da progettare con attenzione alla persistenza del JSON aggiornato e al rispetto del `.gitignore` sui CSV grezzi.

---

## 5. Debito Tecnico Noto

Nessun debito aperto: i 2 warning Oxlint rilevati sulla baseline sono stati sanati nella Milestone 1 e il lint è pulito. Il file legacy `etl/gasolio_focus.json` è stato rimosso.

---

## 6. Note Sessione Corrente

- Introdotti **3 livelli di freschezza** del dato (`fresh` ≤ 2 giorni, `standard` 3–7 giorni, `stale` > 7 giorni) con badge dedicati nel footer di ogni card e nel popup della mappa.
- Il filtro **"Escludi dati non recenti (> 7 giorni)" è attivo di default (`true`)**: al primo caricamento la dashboard mostra solo i 390 impianti con prezzo comunicato negli ultimi 7 giorni, escludendo i 6 dormienti. Il toggle ripristina l'intero dataset quando disattivato.
- Sanificazione preliminare completata: rimozione dell'import inutilizzato `ExternalLink`, `useCallback` su `getPriceTier`, eliminazione del JSON duplicato legacy. Lint ora pulito (0 warning, 0 errori).
- Layout split-screen e interazione bidirezionale card ↔ marker invariati, come da vincoli in [AGENTS.md](AGENTS.md).

### Sessione 2026-09-28 — Sprint 1: Backend & Live Engine Mezzi Pesanti
- **Obiettivo:** abbandonare lo snapshot batch statico e sincronizzare in tempo reale i distributori attorno ai POI aziendali, isolando quelli accessibili ai mezzi pesanti.
- **Modifiche:** introdotti `config/pois.json`, `config/overrides.json`, `etl/sync_fleet.py` (fasi A–G) e l'output `web/public/data/fleet_data.json`. Nessun file di `web/src/` toccato: layout e interazione bidirezionale invariati.
- **Verifiche eseguite:** `python sync_fleet.py` (exit 0, HTTP 200 su entrambi i POI), rivalidazione del JSON prodotto, 22 casi sintetici sulla regex delle arterie, test end-to-end della pipeline overrides, hit della cache anagrafica al secondo run.
- **Pendenze aperte:** il frontend non consuma ancora `fleet_data.json` (Sprint 2); `etl/build_dataset.py` resta in esercizio e produce in parallelo `gasolio_focus.json`; falsi negativi residui sulle strade citate solo per nome (es. "Orientale Sicula", "Consolare Valeria").

### Template per le prossime sessioni

```markdown
## Sessione YYYY-MM-DD — <titolo>
- Obiettivo:
- Modifiche:
- Verifiche eseguite: (npm run build / sync_fleet.py / build_dataset.py / lint)
- Pendenze aperte:
```
