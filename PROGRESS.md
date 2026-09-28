# PROGRESS.md — Baseline, Milestone e Roadmap

Registro di bordo del progetto **Gasolio Radar (MIMIT Fuel Tracker)**. Ogni sessione di lavoro significativa aggiorna questo file.

- **Ultimo aggiornamento:** Sprint 2 — Frontend Minimal Istituzionale Mezzi Pesanti (completato).
- **Stato complessivo:** 🟢 operativo — pipeline dati e dashboard di flotta funzionanti end-to-end: il frontend consuma `fleet_data.json` (Sprint 1) e la configurazione POI, build e lint puliti (0 warning, 0 errori) e 36/36 asserzioni end-to-end superate su Chrome headless.

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

### Dashboard web (`web/`) — **Fleet Radar, Sprint 2**
- [x] Frontend Vite + React 19 avviabile con `npm run dev` e compilabile con `npm run build` (1888 moduli, bundle ~387 KB / 118 KB gzip).
- [x] Layout Desktop Split-Screen: sidebar scorrevole a sinistra (controlli + tabella logistica), mappa a tutto schermo a destra. Nessuna route, nessun tab che nasconda la mappa.
- [x] Sorgente dati di flotta: `fetch('/data/fleet_data.json')` (51 impianti live, Sprint 1) e basi aziendali importate da `config/pois.json` (stessa fonte di `etl/sync_fleet.py`).
- [x] Statistiche live reattive ai filtri: **Impianti idonei**, **Prezzo Minimo**, **Prezzo Medio Arterie**.
- [x] Selettore nodi (basi): Tutte le Basi, Base Roccalumera (ME), Base Alessandria → filtra la lista sul `poi_id` e vola sulla base (`flyTo`, zoom 12) mostrando l'anello del raggio operativo.
- [x] Filtro **Solo Grandi Arterie / Mezzi Pesanti** su `is_arteria_principale`, default `true` (12 record) con ripristino a 51 impianti quando disattivato.
- [x] Ricerca testuale istantanea su indirizzo, gestore, nome, comune e tipo impianto, tollerante alla punteggiatura delle arterie ("SS 10" trova anche "S.S. 10" e "SS.10").
- [x] Data Table logistica compatta con righe cliccabili: STATO/TIPO (`SS` verde, `AUTO` azzurro, `URBANO` grigio), BRAND & NOME, DISTANZA (km), PREZZO GASOLIO (3 decimali) e ORA COMU.
- [x] Font monospazio (`ui-monospace`, SFMono-Regular, Consolas) su prezzi, distanze e timestamp; colonne numeriche allineate a destra e minimo in vista evidenziato in verde.
- [x] Mappa Leaflet su tile OpenStreetMap con pill marker del prezzo, marker hub con anello semitrasparente del raggio operativo (10 km) e legenda operativa.
- [x] Interazione bidirezionale: click sulla riga → `flyTo` + apertura popup; click sul marker → riga selezionata e portata in vista (`scrollIntoView`).
- [x] Badge di freschezza del dato nel popup e timestamp in ambra oltre i 7 giorni (segnalazione, senza filtro escludente).
- [x] Configurazione Oxlint attiva (`npm run lint`): 0 warning, 0 errori.

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

## 3.6 Sprint 2 — Frontend Minimal Istituzionale Mezzi Pesanti (Completata)

Obiettivo: ridisegnare la Web App React come **Dashboard Logistica "Minimal Istituzionale"** per la gestione di flotte di mezzi pesanti, alimentata dal dataset live dello Sprint 1.

### File toccati

| File | Intervento |
| --- | --- |
| `web/src/App.jsx` | Redesign completo della vista: sorgente `fleet_data.json`, POI da `config/pois.json`, selettore basi, filtro mezzi pesanti, tabella logistica, anelli raggio 10 km. |
| `web/src/App.css` | Nuovo linguaggio visivo dark/navy industriale, tipografia monospazio contabile, stili tabella e marker/popup in tema scuro. |
| `PROGRESS.md` | Questo registro. |

### Sorgenti dati
- [x] Caricamento di `fetch('/data/fleet_data.json')` con gestione dell'errore di rete (messaggio dedicato in tabella, nessuna schermata bianca).
- [x] Basi aziendali importate direttamente da `config/pois.json` (`import poisConfig from '../../config/pois.json'`): **unica fonte di verità condivisa con `etl/sync_fleet.py`**, nessuna copia da tenere allineata in `web/public/`.
- [x] Normalizzazione difensiva dei POI nel frontend: scarto dei record senza `id` o coordinate valide e clamp del raggio a 1–10 km, coerente con il limite dell'API MIMIT applicato dall'engine.
- [x] Verificato che Vite risolva la configurazione fuori dalla root del progetto sia in build sia in dev (`/@fs/.../config/pois.json` → HTTP 200, nessun blocco `server.fs.allow`).

### Layout, tipografia e header
- [x] Layout split-screen invariato: sidebar autonoma a sinistra, mappa sempre visibile a destra. Nessuna route, nessun tab nascosto.
- [x] Tema dark/navy industriale: fondo `#0b0f19`, pannelli `#111827`, bordi `#1f2937`, accento istituzionale `#38bdf8`/`#1d4ed8`.
- [x] Font monospazio (`ui-monospace`, `SFMono-Regular`, `Consolas`, `monospace`) applicato tassativamente a **prezzi, distanze km e timestamp**, sia in tabella sia nei popup e nelle statistiche.
- [x] Header operativo: titolo `FLEET RADAR • Logistica Mezzi Pesanti`, badge `● LIVE REAL-TIME` con indicatore verde pulsante (tooltip con l'ultima comunicazione MIMIT) e riga di contesto con base attiva, raggio, impianti in vista e orario di sync.
- [x] Statistiche rapide per la base selezionata: **Impianti idonei** (arterie sul totale del perimetro), **Prezzo Minimo** (sul dataset filtrato) e **Prezzo Medio Arterie**.

### Controlli e filtri di flotta
- [x] **Tab selettore nodi**: `Tutte le Basi`, `Base Roccalumera (ME)`, `Base Alessandria` (etichette generate dai `nome` dei POI). Il click filtra la tabella sul `poi_id` ed esegue `flyTo` sulla base a zoom 12; un contatore (`flyToNonce`) consente di rivolare anche ricliccando il nodo già attivo.
- [x] Interazione selettore ↔ `fitBounds`: un flag (`skipFitBoundsRef`) impedisce al `fitBounds` dei marker di annullare il volo appena richiesto, mantenendo il comportamento storico quando si torna su "Tutte le Basi".
- [x] Click sul marker hub della base = stessa azione del tab corrispondente.
- [x] **Filtro MANDATORIO Mezzi Pesanti** su `is_arteria_principale`, **default `true`**: 12 impianti idonei; disattivato mostra tutti i 51 impianti. Il conteggio dinamico è mostrato accanto al toggle.
- [x] **Ricerca testuale** su indirizzo, gestore, nome, comune e tipo impianto, normalizzata (minuscole, rimozione di spazi/punti/separatori) così che `SS 10` trovi anche `S.S. 10`, `SS.10` e `S.S.10`; `A18` isola l'impianto autostradale.

### Tabella logistica compatta (sostituisce le card)
- [x] Data Table densa con righe cliccabili e colonne: **STATO/TIPO** (badge `SS` verde, `AUTO` azzurro, `URBANO` grigio), **BRAND & NOME** (gestore + via sintetica con ellipsis), **DISTANZA** (`4.1 km`), **PREZZO GASOLIO** (`2.190 €/L`) e **ORA COMU** (`GG/MM HH:MM`).
- [x] Colonne numeriche allineate a destra e in monospazio per l'allineamento contabile; prezzo minimo in vista evidenziato in verde (`is-min`), codifica `cheap`/`mid`/`expensive` invariata (+0,05 € / +0,15 € sul minimo del dataset filtrato).
- [x] Riga selezionata evidenziata con barra di accento; in vista aggregata un accento colorato distingue la base di appartenenza di ogni impianto.
- [x] Accessibilità: righe raggiungibili da tastiera (`Enter`/`Spazio`), `scope="col"` sulle intestazioni, `title` su indirizzo, distanza e timestamp.
- [x] Timestamp in ambra con icona di avviso oltre i 7 giorni (segnalazione del dato non recente, senza filtro escludente: nel dataset live il record `55585` del 24/07/2026 resta visibile e tracciabile).
- [x] Click sulla riga → `flyTo` sul distributore + apertura popup; click sul marker → riga selezionata e portata in vista con `scrollIntoView`.

### Mappa
- [x] Marker hub dedicato per ogni base aziendale (glifo sede su fondo cyan) con tooltip e popup descrittivo.
- [x] Anello semitrasparente tratteggiato del **raggio operativo** (10 km da configurazione POI) attorno a ogni base.
- [x] Pill marker del prezzo invariati nella forma, ricentrati (60×24 px) e in monospazio; popup riscritto in tema scuro con badge arteria/mezzi pesanti, distanza dalla base e freschezza del dato.
- [x] Legenda operativa sovrapposta alla mappa (base aziendale, raggio, fasce di prezzo) con raggio derivato dalla configurazione.
- [x] `fitBounds` con `maxZoom` di sicurezza sull'insieme filtrato quando non è attivo un volo verso una base.

### Verifiche eseguite (2026-09-28)
- [x] `cd web && npm run build`: **0 errori, 0 warning** (1888 moduli, CSS 28,5 KB, JS 387,6 KB / 118 KB gzip).
- [x] `cd web && npm run lint` (Oxlint): **0 errori, 0 warning**.
- [x] Test end-to-end su Chrome headless + DevTools Protocol contro il bundle di produzione e contro il dev server: **36/36 asserzioni superate**. Coperti: 12 righe e 12 marker con toggle attivo / 51 e 51 con toggle disattivato; 2 basi e 2 anelli sulla mappa; statistiche live (`12/51 · 2.190 € · 2.354 €` → `51 · 2.159 € · 2.354 €` con toggle off → `10/37 · 2.336 €` su Alessandria → `2/14 · 2.444 €` su Roccalumera); `flyTo` a zoom 12 sulla base e `fitBounds` aggregato a zoom ≤ 7; ricerche `SS 10` → 6, `A18` → 1, `q8` → 5, `alessandria` → 36; stato vuoto; click riga → popup coerente per prezzo e distanza; click marker → riga selezionata, coerente di prezzo e visibile nel viewport della tabella.
- [x] Console del browser pulita in entrambe le modalità: nessun errore né warning (solo i messaggi informativi di Vite e React DevTools), una sola istanza di mappa con React StrictMode attivo.
- [x] Ispezione visiva con screenshot headless: vista aggregata, Base Alessandria (10 idonei), Base Roccalumera (2 idonei), popup aperto da riga, selezione da marker.

> Nota di verifica: i conteggi attesi sono stati **predetti** con un mirror Node dei predicati di filtro e poi **confermati** sul DOM del componente reale, così che un'eventuale divergenza tra logica e dati emergesse come fallimento del test. L'harness headless è rimasto in `%TEMP%` (non versionato): il suo porting in CI è il candidato naturale per lo Sprint 3 (Task 4).

### Sostituzioni deliberate rispetto alla vista Milestone 1
- Il filtro per **provincia** (ME/AL) è sostituito dal **selettore basi**: nel dataset di flotta la provincia è implicita nel POI (`poi_id`), e il perimetro operativo è il raggio di 10 km.
- Il toggle **"Escludi dati non recenti (> 7 giorni)"** è sostituito dalla **segnalazione** della freschezza (timestamp in ambra + badge nel popup): sul dataset di flotta l'esclusione dei dormienti nasconderebbe impianti idonei il cui prezzo è semplicemente fermo da più di una settimana. La funzione resta disponibile nel codice storico se il requisito dovesse tornare.
- Il parsing delle date italiane `DD/MM/YYYY` è stato rimpiazzato dal parsing ISO 8601 richiesto da `data_comunicazione`; la vista non consuma più `gasolio_focus.json`.

---

## 4. Roadmap / Backlog Prossimi Task

### Task 2 — Calcolatore Risparmio Flotta
Box dinamico con stima del risparmio in Euro per rifornimento (serbatoio mezzo pesante 400–600 L, configurabile) rispetto alla media delle arterie del perimetro filtrato. Quantifica in modo immediato la convenienza di uno spostamento verso la base o l'impianto più economico.

### Task 3 — Clustering Marker / Ottimizzazione Mappa
Gestione avanzata dei pin sovrapposti nelle viste grandangolari (evidente nella vista "Tutte le Basi", dove 12 pill di prezzo si accavallano sul nodo di Alessandria), per mantenere la mappa leggibile quando i risultati filtrati sono numerosi.

### Task 4 — CI/CD GitHub Actions
Workflow schedulato ogni mattina alle **08:30** per l'esecuzione automatica dell'ETL e il deploy su GitHub Pages o Cloudflare Pages. Da progettare con attenzione alla persistenza del JSON aggiornato e al rispetto del `.gitignore` sui CSV grezzi. Candidato naturale per ospitare anche l'harness headless di verifica dello Sprint 2 (build + lint + asserzioni end-to-end).

### Task 5 — Decisione sul dataset batch `gasolio_focus.json`
La vista di flotta non consuma più `web/public/data/gasolio_focus.json`, che `etl/build_dataset.py` continua a produrre. Da decidere se (a) mantenere la pipeline batch come vista "ufficio auto" separata, (b) ritirarla, oppure (c) fonderla nel dataset di flotta. Da chiudere prima di toccare `etl/build_dataset.py`.

---

## 5. Debito Tecnico Noto

Nessun debito bloccante. Build e lint sono puliti (0 warning, 0 errori) dopo lo Sprint 2.

- **Dataset batch orfano:** `gasolio_focus.json` non è più letto dal frontend mentre `etl/build_dataset.py` continua a produrlo (Task 5). Nessuna rottura, ma è una pipeline da riconfermare o ritirare.
- **Harness di verifica non versionato:** lo script headless (Chrome + DevTools Protocol) usato per le 36 asserzioni dello Sprint 2 vive in `%TEMP%`; va portato in CI nel Task 4 per diventare una rete di sicurezza permanente.
- **Falsi negativi sulle arterie:** restano le strade citate solo per nome (es. "Orientale Sicula", "Consolare Valeria") non riconosciute dalla regex di `etl/sync_fleet.py` (eredità Sprint 1, nessuna azione richiesta finché non emerge dai dati).
- **Vista Milestone 1 rimossa dal codice:** filtro provincia, toggle freschezza escludente e parsing date `DD/MM/YYYY` non sono più presenti in `web/src/App.jsx`; la logica resta ricostruibile dalla cronologia git se il requisito tornasse (dettaglio in §3.6).

---

## 6. Note Sessione Corrente

### Sessione 2026-09-28 — Sprint 2: Frontend Minimal Istituzionale Mezzi Pesanti
- **Obiettivo:** trasformare la Web App React in una dashboard logistica "Minimal Istituzionale" per flotte di mezzi pesanti, alimentata da `web/public/data/fleet_data.json` e dalle basi aziendali di `config/pois.json`.
- **Modifiche:** riscritti `web/src/App.jsx` e `web/src/App.css` — tabella logistica densa al posto delle card, selettore nodi con `flyTo` sulla base, filtro mezzi pesanti su `is_arteria_principale` (default attivo), ricerca tollerante sulla punteggiatura delle arterie, marker hub con anello del raggio operativo da 10 km, tipografia monospazio su prezzi/distanze/timestamp e tema dark-navy `#0b0f19` / `#111827` / `#1f2937`. Aggiornato `PROGRESS.md`.
- **Verifiche eseguite:** `npm run build` (0 errori, 0 warning), `npm run lint` (0 errori, 0 warning), test end-to-end su Chrome headless + DevTools Protocol (36/36 asserzioni: 12↔51 record, statistiche live, voli base, ricerche `SS 10`/`A18`/`q8`, stato vuoto, interazione bidirezionale riga ↔ marker), console browser pulita in dev e in produzione, ispezione visiva con screenshot headless.
- **Pendenze aperte:** decidere il destino di `gasolio_focus.json` (Task 5); clustering dei marker nella vista aggregata (Task 3); portare l'harness headless in CI (Task 4).

### Sessione 2026-09-28 — Sprint 1: Backend & Live Engine Mezzi Pesanti
- **Obiettivo:** abbandonare lo snapshot batch statico e sincronizzare in tempo reale i distributori attorno ai POI aziendali, isolando quelli accessibili ai mezzi pesanti.
- **Modifiche:** introdotti `config/pois.json`, `config/overrides.json`, `etl/sync_fleet.py` (fasi A–G) e l'output `web/public/data/fleet_data.json`. Nessun file di `web/src/` toccato: layout e interazione bidirezionale invariati.
- **Verifiche eseguite:** `python sync_fleet.py` (exit 0, HTTP 200 su entrambi i POI), rivalidazione del JSON prodotto, 22 casi sintetici sulla regex delle arterie, test end-to-end della pipeline overrides, hit della cache anagrafica al secondo run.
- **Pendenze aperte:** il frontend non consuma ancora `fleet_data.json` (**chiusa nello Sprint 2**); `etl/build_dataset.py` resta in esercizio e produce in parallelo `gasolio_focus.json`; falsi negativi residui sulle strade citate solo per nome (es. "Orientale Sicula", "Consolare Valeria").

### Template per le prossime sessioni

```markdown
## Sessione YYYY-MM-DD — <titolo>
- Obiettivo:
- Modifiche:
- Verifiche eseguite: (npm run build / sync_fleet.py / build_dataset.py / lint)
- Pendenze aperte:
```
