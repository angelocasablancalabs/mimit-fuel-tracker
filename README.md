# Gasolio Radar (MIMIT Fuel Tracker)

Monitor desktop ad alte prestazioni per individuare il prezzo del **gasolio in modalità Self Service** più conveniente, confrontando i dati aperti ufficiali del MIMIT.

L'interfaccia è un cruscotto a due colonne: a sinistra una sidebar scorrevole con statistiche live, ricerca e classifica prezzi; a destra la mappa a tutto schermo. Le due viste sono sincronizzate: selezionare una stazione la centra sulla mappa e viceversa.

---

## Architettura

Monorepo leggero composto da due moduli indipendenti e da un artefatto JSON che fa da contratto tra i due.

```
mimit-fuel-tracker/
├── config/
│   ├── pois.json                 # Basi operative + 10 impianti POI fissi monitorati
│   └── overrides.json            # Patch manuali per ID impianto (coordinate, nome, note)
├── etl/                          # Data pipeline Python (download + parsing + filtro)
│   ├── build_dataset.py          # Snapshot batch: genera gasolio_focus.json
│   ├── sync_fleet.py             # Engine live: genera fleet_data.json + city_index.json
│   └── test_target.py            # Script diagnostico su una lista di impianti sentinella
├── web/                          # Frontend Vite + React
│   ├── vite.config.js            # Reverse proxy /api/mimit → carburanti.mise.gov.it
│   ├── public/data/              # Output dell'ETL: fleet_data.json, city_index.json
│   └── src/
│       ├── App.jsx               # Dashboard, tab, Radar Spot Live, logica mappa
│       ├── App.css               # Design system scuro (layout a due pannelli)
│       └── main.jsx              # Bootstrap React
├── AGENTS.md                     # Costituzione tecnica per agenti AI
└── PROGRESS.md                   # Baseline, milestone e roadmap
```

### Data Pipeline

| Componente | Scelta tecnica |
| --- | --- |
| Linguaggio | Python 3.12+ |
| HTTP | `requests` con `User-Agent` esplicito e timeout a 60s |
| Parsing | `csv.DictReader` con delimitatore pipe `\|` |
| Filtro carburante | `descCarburante == "gasolio"` **e** `isSelf == "1"` (esclude Premium/Plus) |
| Filtro geografico | `TARGET_PROVINCE = ["ME", "AL"]` (lista vuota = tutta Italia) |
| Validazione | Coordinate scartate se fuori dal bounding box Italia (lat 35–48, lon 6–19) |
| Output | JSON ordinato per prezzo crescente in `web/public/data/gasolio_focus.json` |

I CSV MIMIT hanno una riga di metadati in testa: la pipeline la scarta e legge le intestazioni dalla riga successiva.

Schema di ogni record prodotto:

```json
{
  "id": 54148,
  "gestore": "Agip Eni",
  "nome": "GIAMBO RICCARDO",
  "indirizzo": "STRADA STATALE 149 98042",
  "comune": "PACE DEL MELA",
  "provincia": "ME",
  "lat": 37.634048,
  "lon": 14.8570112,
  "prezzo_gasolio": 1.999,
  "data_aggiornamento": "26/09/2026 22:02:39"
}
```

Sorgenti ufficiali:
- Anagrafica impianti: `https://www.mimit.gov.it/images/exportCSV/anagrafica_impianti_attivi.csv`
- Prezzi comunicati: `https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv`

### Fleet Engine e POI Fissi (vista attiva)

La vista operativa della dashboard non consuma `gasolio_focus.json`, ma `fleet_data.json`, prodotto da `etl/sync_fleet.py`: un engine che interroga la **Live API MIMIT** (`POST /ospzApi/search/zone`) attorno alle basi aziendali e presidia i **10 Impianti POI Fissi Specifici** definiti in `config/pois.json`.

```json
{
  "bases":              [ { "id": "base_roccalumera", "nome": "…", "provincia": "ME", "lat": …, "lng": …, "radius": 10 } ],
  "monitored_stations": [ { "id": 4835, "nome_convenzionale": "ESSO S.Teresa", "provincia": "ME" } ]
}
```

Ogni record di `fleet_data.json` porta `is_target_monitored: true` se l'ID appartiene a `monitored_stations`. Gli impianti target fuori dai raggi delle basi vengono interrogati attorno alle proprie coordinate (presidio) ed emessi comunque, anche senza prezzo comunicato (`prezzo_gasolio: null`), così la vista mostra sempre tutti e 10.

```bash
cd etl
python sync_fleet.py                      # sincronizza basi + presidio dei 10 target
python sync_fleet.py --no-monitor-sweep   # salta il presidio fuori raggio
```

Oltre a `web/public/data/fleet_data.json`, l'engine genera `web/public/data/city_index.json`: l'indice città → coordinate usato dal **Radar Spot Live** per la ricerca per zona.

### Reverse proxy verso il Ministero (`/api/mimit`)

Il browser non può chiamare direttamente `carburanti.mise.gov.it` (CORS e header `Origin`/`Referer` obbligatori). `web/vite.config.js` espone la rotta:

```
/api/mimit/ospzApi/search/zone  →  https://carburanti.mise.gov.it/ospzApi/search/zone
```

Il proxy rimuove il prefisso, imposta `changeOrigin: true` e riscrive `Origin`, `Referer` e `User-Agent`. È configurato sia in `server` (dev) sia in `preview`, quindi il Radar Spot Live funziona in entrambi i comandi locali. **Attenzione:** il proxy esiste solo nel server Vite; un deploy statico del bundle richiede un reverse proxy equivalente lato hosting.

### UI Web

| Componente | Scelta tecnica |
| --- | --- |
| Build | Vite (ES Modules, `"type": "module"`) |
| UI | React 19 con hooks (`useState`, `useEffect`, `useMemo`, `useRef`) |
| Mappa | Leaflet su tile OpenStreetMap, marker `divIcon` a pillola colorata per fascia di prezzo |
| Icone | `lucide-react` |
| Styling | CSS custom dark, nessun framework UI |
| Lint | Oxlint |

Logica di interfaccia rilevante:
- **Vista di default `Impianti Monitorati (10)`**: i 10 POI fissi aziendali con ID, badge dorato `★` e distanza dalla base più vicina. Un impianto senza prezzo comunicato resta visibile come `n.d.`.
- **Tab** `Base Roccalumera (ME)`, `Base Alessandria` (perimetro di 10 km) e il tab dinamico `Risultati Spot Live (N)`.
- **Radar Spot Live**: ricerca per ID impianto o città, oppure `Punta Radar sulla Mappa` e click su un punto qualsiasi per disegnare il cerchio di 10 km e interrogare il Ministero in tempo reale. I risultati spot sono temporanei (badge `SPOT LIVE`, pill ambra sulla mappa) e non sostituiscono i 10 POI monitorati; `Chiudi Spot` li rimuove.
- **Fasce di prezzo** calcolate rispetto al minimo del dataset in vista: `cheap` (≤ +0,05 €), `mid` (≤ +0,15 €), `expensive` (oltre).
- **Click sulla riga** → `map.flyTo` sull'impianto e apertura del popup del marker.
- **Click sul marker** → selezione della riga corrispondente nella sidebar.
- **Filtri** (base + ricerca testuale su arteria, gestore, comune) ricalcolano sia la lista sia i marker, con `fitBounds` automatico sull'insieme filtrato.

---

## Quickstart

### 1. Aggiornare i dati (ETL)

Da eseguire ogni volta che si vogliono prezzi freschi. Richiede una connessione a Internet.

```bash
cd etl

# Windows (PowerShell)
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# macOS / Linux
python3 -m venv .venv
source .venv/bin/activate

pip install requests
python build_dataset.py
```

Al termine lo script stampa il numero di impianti con prezzo Self attivo, il percorso del file generato e i 3 distributori più economici rilevati.

Per la dashboard di flotta (la vista attiva) si usa invece l'engine live, che non richiede il passaggio precedente:

```bash
cd etl
.\.venv\Scripts\Activate.ps1      # oppure: source .venv/bin/activate
python sync_fleet.py
```

### 2. Avviare la web app in sviluppo

```bash
cd web
npm install
npm run dev
```

Vite espone il server locale (di norma `http://localhost:5173`) e attiva il reverse proxy `/api/mimit` usato dal Radar Spot Live. Se `fleet_data.json` non è presente, la dashboard si carica comunque ma segnala "Dataset di flotta non disponibile": eseguire prima `etl/sync_fleet.py`.

### 3. Compilare per la produzione

```bash
cd web
npm run build     # bundle ottimizzato in web/dist/
npm run preview   # verifica locale del bundle compilato
```

Comandi accessori:

```bash
cd web
npm run lint      # Oxlint
```

---

## Manutenzione

- I CSV grezzi del MIMIT non vanno mai committati: sono già esclusi da `.gitignore` (`*.csv`, `etl/raw/`), insieme a `.venv/`, `node_modules/` e `dist/`.
- La lista delle province monitorate è la costante `TARGET_PROVINCE` in `etl/build_dataset.py`. Per coprire nuove aree basta aggiungere le sigle e rieseguire la pipeline.
- Le regole operative per chi (persona o agente AI) mette mano al codice sono in [AGENTS.md](AGENTS.md); lo stato di avanzamento e la roadmap in [PROGRESS.md](PROGRESS.md).
