# Gasolio Radar (MIMIT Fuel Tracker)

Monitor desktop ad alte prestazioni per individuare il prezzo del **gasolio in modalità Self Service** più conveniente, confrontando i dati aperti ufficiali del MIMIT.

L'interfaccia è un cruscotto a due colonne: a sinistra una sidebar scorrevole con statistiche live, ricerca e classifica prezzi; a destra la mappa a tutto schermo. Le due viste sono sincronizzate: selezionare una stazione la centra sulla mappa e viceversa.

---

## Architettura

Monorepo leggero composto da due moduli indipendenti e da un artefatto JSON che fa da contratto tra i due.

```
mimit-fuel-tracker/
├── etl/                          # Data pipeline Python (download + parsing + filtro)
│   ├── build_dataset.py          # Entry point: genera il dataset per il frontend
│   └── test_target.py            # Script diagnostico su una lista di impianti sentinella
├── web/                          # Frontend Vite + React
│   ├── public/data/gasolio_focus.json   # Output dell'ETL, consumato dall'app
│   └── src/
│       ├── App.jsx               # Dashboard, stato, logica mappa e filtri
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
- **Fasce di prezzo** calcolate rispetto al minimo assoluto del dataset: `cheap` (≤ +0,05 €), `mid` (≤ +0,15 €), `expensive` (oltre).
- **Click sulla card** → `map.flyTo` sulla stazione e apertura del popup del marker.
- **Click sul marker** → selezione della card corrispondente nella sidebar.
- **Filtri** (provincia + ricerca testuale su comune, gestore, indirizzo) ricalcolano sia la lista sia i marker, con `fitBounds` automatico sull'insieme filtrato.

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

### 2. Avviare la web app in sviluppo

```bash
cd web
npm install
npm run dev
```

Vite espone il server locale (di norma `http://localhost:5173`). Se il JSON non è presente, la dashboard si carica comunque ma mostra "Nessun distributore trovato": eseguire prima l'ETL.

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
