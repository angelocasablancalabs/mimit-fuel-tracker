# AGENTS.md — Costituzione Tecnica

Regolamento vincolante per qualsiasi agente AI o assistente automatico che opera su questo repository. Le regole hanno priorità sulle preferenze stilistiche dell'agente.

## 1. Missione

Mantenere **Gasolio Radar** scattante, affidabile e focalizzato sui bisogni reali dell'ufficio: rispondere in pochi secondi alla domanda "dove faccio gasolio Self spendendo meno, oggi?". Ogni modifica deve servire questo scopo o essere invisibile all'utente finale.

Il progetto è un monorepo leggero: `etl/` (pipeline Python) produce `web/public/data/gasolio_focus.json`, che `web/` (Vite + React + Leaflet) consuma. Il JSON è il contratto tra i due moduli.

## 2. Mappa Comandi

Comandi canonici. Non inventarne di alternativi: se un comando manca, proponilo prima di aggiungerlo.

| Ambito | Comando | Note |
| --- | --- | --- |
| ETL (setup) | `cd etl` → `python -m venv .venv` → attivazione venv → `pip install requests` | Il venv non è versionato |
| ETL (run) | `cd etl` → `python build_dataset.py` | Richiede rete; scrive in `web/public/data/` |
| ETL (diagnostica) | `cd etl` → `python test_target.py` | Verifica impianti sentinella |
| Web (dev) | `cd web` → `npm install` → `npm run dev` | Server Vite su `http://localhost:5173` |
| Web (validazione) | `cd web` → `npm run build` | **Obbligatorio** prima di chiudere un task |
| Web (lint) | `cd web` → `npm run lint` | Oxlint |
| Web (preview) | `cd web` → `npm run preview` | Verifica del bundle di produzione |

## 3. Zero Unintended Regressions

Il valore dell'app sta nel layout e nell'interazione. Preservali rigorosamente:

1. **Layout a due pannelli.** Sidebar a sinistra, scorrevole in autonomia, con header, statistiche, controlli e lista risultati. Mappa a destra, a tutto schermo, sempre visibile. Non trasformare la dashboard in una pagina a scorrimento singolo, non introdurre tab o route che nascondano la mappa.
2. **Interazione bidirezionale.** Click su una card → la mappa vola sulla stazione e apre il popup. Click su un marker → la card corrispondente risulta selezionata. Rompere uno dei due versi è una regressione bloccante.
3. **Statistiche live.** Minimo, Medio Zona e conteggio impianti devono reagire ai filtri, non restare ancorati al dataset completo.
4. **Filtri combinati.** Provincia e ricerca testuale agiscono in AND su comune, gestore e indirizzo, e ricalcolano anche i marker con `fitBounds`.
5. **Codifica colore prezzi.** Le fasce (`cheap` / `mid` / `expensive`) sono relative al minimo del dataset corrente: mantieni la soglia a +0,05 € e +0,15 € salvo richiesta esplicita.
6. **Contratto JSON.** I nomi dei campi (`prezzo_gasolio`, `data_aggiornamento`, `provincia`, `lat`, `lon`, …) sono consumati direttamente dal frontend. Rinominarli richiede l'aggiornamento coordinato di `etl/build_dataset.py` e `web/src/App.jsx`.

## 4. Protocollo Chirurgico di Modifica

- **Divieto assoluto di riscrivere interi file** da centinaia di righe per modifiche minori. `web/src/App.jsx`, `web/src/App.css` ed `etl/build_dataset.py` vanno toccati con diff localizzati, in stile Search & Replace, che lascino intatto tutto il resto.
- Una modifica = un'intenzione. Niente riformattazioni massive, riordini di import o rinomine di variabili non richieste nello stesso intervento.
- Non cancellare commenti esistenti che spiegano scelte non ovvie (indici di riga dei CSV MIMIT, filtri su `isSelf`, bounding box Italia).
- Prima di modificare, leggi il file interessato. Dopo aver modificato, rileggi il blocco per verificare l'integrità sintattica.

## 5. Stack Moderno & Anti-Obsolescenza

- **React moderno**: componenti funzione e hooks puliti (`useState`, `useEffect`, `useMemo`, `useRef`). Nessuna API legacy, nessuna classe componente.
- **ES Modules ovunque**: `import`/`export`, `package.json` con `"type": "module"`. Nessun `require`.
- **Dipendenze minime**: React, React DOM, Leaflet, Lucide. Non aggiungere librerie di state management, UI kit o utility per problemi già risolti in poche righe.
- **Percorsi e portabilità**: usa `pathlib` nell'ETL per costruire i percorsi, mai concatenazioni di stringhe con separatori hardcoded. Nel codice web usa path assoluti da root (`/data/gasolio_focus.json`).
- **Niente debito silenzioso**: se introduci un `TODO`, annota anche la condizione che lo chiude.

## 6. Three-Tier Boundaries

### ALWAYS
- Eseguire `cd web && npm run build` prima di considerare concluso un task; se fallisce, il task non è finito.
- Aggiornare `PROGRESS.md` (milestone, backlog, note di sessione) al termine delle modifiche.
- Mantenere `.gitignore` allineato: `.env`, `.venv/`, `node_modules/`, `dist/`, `*.csv` e dump grezzi non devono mai essere tracciati.
- Conservare le coordinate `lat`/`lon` validate dal bounding box Italia.

### ASK FIRST
- Installare nuove dipendenze npm pesanti o qualsiasi libreria non strettamente necessaria.
- Alterare la struttura o i nomi dei campi del JSON prodotto dall'ETL (rompe il contratto col frontend).
- Cambiare la lista `TARGET_PROVINCE` o il perimetro dei carburanti inclusi.
- Introdurre build step, bundler aggiuntivi, TypeScript o framework CSS.

### NEVER
- Tracciare file `.env`, segreti o dump CSV grezzi del MIMIT.
- Rimuovere o "arrotondare" le coordinate lat/lon validate, né allentare il filtro geografico senza motivo.
- Committare `node_modules/`, `dist/`, `.venv/` o file temporanei.
- Riscrivere interi file per modifiche puntuali.
- Rompere il layout a due pannelli o l'interazione bidirezionale card ↔ marker.
