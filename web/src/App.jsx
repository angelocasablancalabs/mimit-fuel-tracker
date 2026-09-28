import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Radar, Search, Truck, AlertTriangle, Crosshair, X, MapPin, Loader } from 'lucide-react';
import poisConfig from '../../config/pois.json';
import './App.css';

// Oltre questa soglia (in giorni) la comunicazione del prezzo si evidenzia come non recente
const STALE_THRESHOLD_DAYS = 7;

// Soglie di codifica colore del prezzo, relative al minimo del dataset filtrato
const PRICE_TIER_CHEAP = 0.05;
const PRICE_TIER_MID = 0.15;

// Raggio operativo di fallback (km) quando la base non lo specifica
const DEFAULT_POI_RADIUS_KM = 10;

// Raggio di ricerca del "Radar Spot Live" (limite massimo accettato dall'API MIMIT)
const SPOT_RADIUS_KM = 10;

// Valore del selettore nodi che disattiva il filtro per base
const ALL_POIS = 'ALL';

/** Chiavi dei tab logistici (viste della sidebar). */
const TAB_MONITORED = 'TAB_MONITORED';
const TAB_SPOT = 'TAB_SPOT';

/** `poi_id` di presidio: record degli impianti monitorati fuori dai raggi delle basi. */
const MONITOR_SWEEP_POI = 'monitor_sweep';

/** Indice citta' -> coordinate generato da etl/sync_fleet.py per la ricerca spot. */
const CITY_INDEX_URL = '/data/city_index.json';

/** Fase di consultazione del Ministero, mostrata nella barra di stato dello spot. */
const SPOT_PHASE_LABEL = {
  fleet: 'consultazione dataset locale',
  zone: 'interrogazione live per area',
  id: 'interrogazione live per ID',
  city: 'interrogazione live per citta\'',
};

// Tinte di riconoscimento delle basi (usate come accento di riga in vista aggregata)
const POI_ACCENTS = ['#22d3ee', '#f59e0b', '#a78bfa', '#4ade80'];

// Glifo hub/sede iniettato nel marker delle basi aziendali (Leaflet divIcon)
const POI_GLYPH_SVG = `
  <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M18 21V10a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1v11" />
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 1.132-1.803l7.95-3.974a2 2 0 0 1 1.837 0l7.948 3.974A2 2 0 0 1 22 8z" />
    <path d="M6 13h12" />
    <path d="M6 17h12" />
  </svg>
`;

// Glifo mirino del centro radar (Leaflet divIcon)
const RADAR_GLYPH_SVG = `
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3v4" />
    <path d="M12 17v4" />
    <path d="M3 12h4" />
    <path d="M17 12h4" />
  </svg>
`;

// Classi CSS del badge freschezza dentro i popup Leaflet
const POPUP_FRESHNESS_CLASS = {
  fresh: 'popup-freshness freshness-fresh',
  standard: 'popup-freshness freshness-standard',
  stale: 'popup-freshness freshness-stale',
};

/**
 * Normalizzazione delle basi aziendali da `config/pois.json` (stessa fonte di
 * sync_fleet.py): scarto dei record privi di coordinate e clamp del raggio operativo
 * entro il limite API (1-10 km).
 */
const BASES = (Array.isArray(poisConfig?.bases) ? poisConfig.bases : [])
  .filter(
    (base) =>
      base &&
      typeof base.id === 'string' &&
      Number.isFinite(Number(base.lat)) &&
      Number.isFinite(Number(base.lng)),
  )
  .map((base) => ({
    id: base.id,
    nome: base.nome || base.id,
    provincia: base.provincia || '',
    lat: Number(base.lat),
    lng: Number(base.lng),
    radius: Math.min(
      Math.max(Number(base.radius) || DEFAULT_POI_RADIUS_KM, 1),
      DEFAULT_POI_RADIUS_KM,
    ),
  }));

/**
 * I 10 Impianti POI Fissi Specifici da monitorare stabilmente (Sprint 3), normalizzati
 * con lo stesso criterio dell'engine. L'ordine di `config/pois.json` e' l'ordine della
 * vista "Impianti Monitorati (10)".
 */
const MONITORED_STATIONS = (Array.isArray(poisConfig?.monitored_stations)
  ? poisConfig.monitored_stations
  : []
)
  .map((station) => ({
    id: String(station?.id ?? '').trim(),
    nome: station?.nome_convenzionale || String(station?.id ?? ''),
    provincia: String(station?.provincia || '').toUpperCase(),
  }))
  .filter((station) => station.id);

const MONITORED_IDS = new Set(MONITORED_STATIONS.map((station) => station.id));

/** Tinta associata a una base (accento di riga in vista aggregata). */
function getPoiAccent(poiId) {
  const index = BASES.findIndex((base) => base.id === poiId);
  return index >= 0 ? POI_ACCENTS[index % POI_ACCENTS.length] : '#475569';
}

/** Nome leggibile della base a cui appartiene un impianto. */
function getPoiLabel(poiId) {
  if (poiId === MONITOR_SWEEP_POI) return 'Presidio monitorati';
  return BASES.find((base) => base.id === poiId)?.nome || 'Base non nota';
}

/** Etichetta del presidio: gli impianti monitorati non stanno nei raggi delle basi. */
function isMonitorSweep(poiId) {
  return poiId === MONITOR_SWEEP_POI;
}

/** True se il record rappresenta un impianto POI fisso aziendale. */
function isTargetStation(station) {
  if (!station) return false;
  return Boolean(station.is_target_monitored) || MONITORED_IDS.has(String(station.id));
}

/** Prezzo assente o non numerico (segnaposto senza Gasolio Self comunicato). */
function hasPrice(station) {
  return Number.isFinite(Number(station?.prezzo_gasolio));
}

/** Prezzo formattato per l'allineamento contabile (3 decimali, monospazio in CSS). */
function formatPrice(price) {
  return `${Number(price).toFixed(3)} €/L`;
}

/** Distanza dalla base in km, con un decimale. */
function formatDistance(km) {
  const value = Number(km);
  return Number.isFinite(value) ? `${value.toFixed(1)} km` : '—';
}

/** Distanza in km fra due coordinate (formula dell'emisenoverso, raggio 6371 km). */
function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Base più vicina a una coppia di coordinate: alimenta la colonna DISTANZA della vista
 * "Impianti Monitorati", dove il perimetro di riferimento è la base logistica.
 */
function nearestBase(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  let best = null;
  BASES.forEach((base) => {
    const km = distanceKm(lat, lon, base.lat, base.lng);
    if (!best || km < best.km) best = { base, km };
  });
  return best;
}

/**
 * Parsing sicuro della comunicazione MIMIT (`data_comunicazione`, ISO 8601 con offset).
 * Restituisce null se la stringa è assente o non interpretabile.
 */
function parseComunicazione(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Orario di comunicazione del prezzo in formato contabile `GG/MM HH:MM`.
 * Le date non interpretabili mostrano `n.d.` senza far sparire la riga.
 */
function formatComunicazione(value) {
  const date = parseComunicazione(value);
  if (!date) return 'n.d.';

  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Etichetta temporale completa (tooltip di riga). */
function formatComunicazioneFull(value) {
  const date = parseComunicazione(value);
  if (!date) return 'Comunicazione non disponibile';

  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Campi su cui agisce la ricerca testuale (arteria, brand, comune)
const SEARCH_FIELDS = ['indirizzo', 'gestore', 'nome', 'comune', 'tipo_impianto'];

/**
 * Normalizzazione per la ricerca su arterie, brand e comuni: minuscole e rimozione di
 * spazi, punti e separatori, così che "SS 10" trovi anche "S.S. 10" e "SS.10".
 */
function normalizeSearch(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s.\-_/]/g, '');
}

/** Giorni interi trascorsi dalla comunicazione del prezzo (null se non interpretabile). */
function getDaysAgo(value) {
  const date = parseComunicazione(value);
  if (!date) return null;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
}

/** Livello di freschezza del dato (badge nel popup della mappa). */
function getFreshness(value) {
  const daysAgo = getDaysAgo(value);

  if (daysAgo === null) {
    return { daysAgo: null, level: 'standard', label: 'Data non disponibile' };
  }
  if (daysAgo <= 2) {
    const label = daysAgo === 0 ? 'Oggi' : daysAgo === 1 ? 'Ieri' : `${daysAgo} giorni fa`;
    return { daysAgo, level: 'fresh', label };
  }
  if (daysAgo <= STALE_THRESHOLD_DAYS) {
    return { daysAgo, level: 'standard', label: `${daysAgo} giorni fa` };
  }
  return { daysAgo, level: 'stale', label: `${daysAgo} gg fa (non recente)` };
}

/**
 * Etichetta STATO / TIPO della riga logistica:
 * `AUTO` (impianto autostradale), `SS` (grande arteria non autostradale), `URBANO` (resto).
 */
function getRouteBadge(station) {
  if (station.is_arteria_principale) {
    return station.tipo_impianto === 'Autostradale'
      ? { label: 'AUTO', className: 'route-auto' }
      : { label: 'SS', className: 'route-ss' };
  }
  return { label: 'URBANO', className: 'route-urbano' };
}

/** Badge STATO/TIPO a partire da una riga della tabella (fleet, monitorata o spot). */
function getRowRouteBadge(row) {
  return getRouteBadge({
    is_arteria_principale: row.arteria,
    tipo_impianto: row.tipoImpianto,
  });
}

/** Escape HTML: i valori di anagrafica e API finiscono in template di popup Leaflet. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Radar Spot Live — client della Live API MIMIT via reverse proxy Vite
// ---------------------------------------------------------------------------
/** Endpoint del Ministero esposto dal proxy `/api/mimit` di `web/vite.config.js`. */
const MIMIT_ZONE_URL = '/api/mimit/ospzApi/search/zone';

// Gasolio: fuelId 2 (standard). La chiave "2-1" = Gasolio Self Service per la zona.
const FUEL_ID_GASOLIO = 2;
const FUEL_TYPE_ZONE = '2-1';

/** Estrazione del prezzo Gasolio Self (fuelId 2 o nome "Gasolio" con isSelf). */
function extractGasolioSelf(fuels) {
  if (!Array.isArray(fuels)) return null;

  const candidates = [];
  fuels.forEach((fuel, index) => {
    if (!fuel || typeof fuel !== 'object') return;
    const name = String(fuel.name || '').trim().toLowerCase();
    if (fuel.fuelId !== FUEL_ID_GASOLIO && name !== 'gasolio') return;
    if (fuel.isSelf !== true) return;
    const price = Number(fuel.price);
    if (!Number.isFinite(price)) return;
    candidates.push({ price, index });
  });

  if (!candidates.length) return null;
  return candidates.reduce((best, cur) => (cur.price < best.price ? cur : best));
}

/**
 * Interroga la Live API del Ministero per un'area: `POST /ospzApi/search/zone`.
 * Il proxy Vite rimuove `/api/mimit`, riscrive Origin/Referer/User-Agent e aggira il CORS.
 */
async function fetchZone({ lat, lng, radius = SPOT_RADIUS_KM, signal }) {
  const response = await fetch(MIMIT_ZONE_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
    },
    body: JSON.stringify({
      points: [{ lat, lng }],
      radius,
      fuelType: FUEL_TYPE_ZONE,
    }),
  });

  if (!response.ok) {
    throw new Error(`Live API MIMIT non raggiungibile (HTTP ${response.status})`);
  }

  const payload = await response.json();
  return Array.isArray(payload?.results) ? payload.results : [];
}

/**
 * Normalizza i risultati live nel formato del dataset di flotta, così la tabella e la
 * mappa riusano lo stesso percorso di rendering senza toccare i 10 POI monitorati.
 */
function spotRecordsFrom(rawResults, origin) {
  const records = [];

  rawResults.forEach((raw) => {
    if (!raw || typeof raw !== 'object') return;
    const gasolio = extractGasolioSelf(raw.fuels);
    if (!gasolio) return;

    const lat = Number(raw.location?.lat);
    const lon = Number(raw.location?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const distance = Number(raw.distance);
    records.push({
      id: Number(raw.id),
      nome: String(raw.name || raw.brand || '').trim(),
      gestore: String(raw.brand || raw.name || '').trim(),
      indirizzo: '',
      comune: '',
      provincia: '',
      lat,
      lon,
      prezzo_gasolio: gasolio.price,
      data_comunicazione: String(raw.insertDate || ''),
      distanza_km: Number.isFinite(distance) ? Math.round(distance * 10) / 10 : null,
      tipo_impianto: '',
      is_arteria_principale: false,
      is_target_monitored: MONITORED_IDS.has(String(raw.id)),
      poi_id: null,
      poi_nome: '',
      note: '',
      is_spot: true,
      spot_origin: origin,
    });
  });

  return records;
}

/** Indice citta' -> coordinate per la ricerca spot per zona (fetch pigro, una volta). */
async function fetchCityIndex(signal) {
  const response = await fetch(CITY_INDEX_URL, { signal });
  if (!response.ok) throw new Error(`Indice città non disponibile (HTTP ${response.status})`);
  const payload = await response.json();
  return Array.isArray(payload?.citta) ? payload.citta : [];
}

/**
 * Indice locale `id -> record` dal dataset di flotta: l'API del Ministero per zona
 * restituisce `address: null`, quindi indirizzo e comune degli impianti noti vengono
 * recuperati da qui (l'anagrafica MIMIT già mappata da etl/sync_fleet.py).
 */
async function fetchFleetIndex(signal) {
  const payload = await fetch('/data/fleet_data.json', { signal })
    .then((res) => (res.ok ? res.json() : []))
    .catch(() => []);

  const index = new Map();
  (Array.isArray(payload) ? payload : []).forEach((station) => {
    index.set(String(station.id), station);
  });
  return index;
}

/** Chiave di ricerca citta': minuscole, senza accenti né punteggiatura. */
function normalizeCity(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Arricchisce una riga spot con l'anagrafica locale (indirizzo, comune, provincia). */
function enrichSpotRow(record, fleetIndex, cityName) {
  const known = fleetIndex.get(String(record.id));
  return {
    ...record,
    indirizzo: known?.indirizzo || record.indirizzo || '',
    comune: known?.comune || cityName || '',
    provincia: known?.provincia || record.provincia || '',
  };
}

/**
 * Ricerca spot. Due modalità:
 *   - input numerico  -> risoluzione dell'ID nel dataset locale e interrogazione live
 *     dell'area attorno all'impianto;
 *   - input testuale  -> risoluzione della citta' via indice locale e interrogazione live.
 * Ritorna `{ records, label }`.
 */
async function runSpotSearch(rawTerm, { signal, getCityIndex }) {
  const term = rawTerm.trim();
  const fleetIndex = await fetchFleetIndex(signal);

  if (/^\d{1,8}$/.test(term)) {
    const targetId = Number(term);
    const known = fleetIndex.get(term);

    if (!known || !Number.isFinite(Number(known.lat)) || !Number.isFinite(Number(known.lon))) {
      throw new Error(
        `ID ${targetId}: nessun impianto noto con questo numero. Verifica l'ID o cerca per città.`,
      );
    }

    const raw = await fetchZone({ lat: Number(known.lat), lng: Number(known.lon), signal });
    const records = spotRecordsFrom(raw, 'id').map((rec) => enrichSpotRow(rec, fleetIndex));
    const match = records.filter((rec) => rec.id === targetId);
    return {
      records: match.length ? match : records,
      label: `ID ${targetId} · ${known.gestore || known.nome} · ${known.comune} (${known.provincia})`,
    };
  }

  const key = normalizeCity(term);
  if (!key) throw new Error('Inserisci un ID impianto numerico oppure il nome di una città.');

  const cities = await getCityIndex();
  const city = cities.find((entry) => normalizeCity(entry.nome) === key);

  if (!city) {
    throw new Error(`Città "${term}": nessuna corrispondenza nell'indice locale.`);
  }

  const records = [];
  for (const area of city.province || []) {
    const raw = await fetchZone({ lat: area.lat, lng: area.lon, signal });
    records.push(
      ...spotRecordsFrom(raw, 'city').map((rec) =>
        enrichSpotRow(rec, fleetIndex, city.nome_leggibile || term),
      ),
    );
  }

  const unique = [...new Map(records.map((rec) => [rec.id, rec])).values()];
  return {
    records: unique.sort((a, b) => a.prezzo_gasolio - b.prezzo_gasolio),
    label: `${city.nome_leggibile || term} · ${(city.province || [])
      .map((p) => p.provincia)
      .join('/')}`,
  };
}

export default function App() {
  const [stations, setStations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedPoi, setSelectedPoi] = useState(ALL_POIS);
  // Vista di default dello Sprint 3: i 10 impianti POI fissi aziendali
  const [activeTab, setActiveTab] = useState(TAB_MONITORED);
  const [onlyArterie, setOnlyArterie] = useState(true);
  const [selectedStation, setSelectedStation] = useState(null);
  // Contatore che permette di rivolare sulla stessa base a ogni click sul nodo
  const [flyToNonce, setFlyToNonce] = useState(0);

  // --- Radar Spot Live -----------------------------------------------------
  const [spotArmed, setSpotArmed] = useState(false);
  const [spotCenter, setSpotCenter] = useState(null);
  const [spotRows, setSpotRows] = useState([]);
  const [spotLoading, setSpotLoading] = useState(false);
  const [spotError, setSpotError] = useState(null);
  const [spotQuery, setSpotQuery] = useState('');
  const [spotLabel, setSpotLabel] = useState('');
  const [spotPhase, setSpotPhase] = useState(null);

  const mapRef = useRef(null);
  const markersRef = useRef({});
  const rowsRef = useRef({});
  // Impedisce al fitBounds dei marker di annullare il volo verso una base appena selezionata
  const skipFitBoundsRef = useRef(false);
  // Centro radar: marker + cerchio dei 10 km dello spot in corso
  const spotLayerRef = useRef({ group: null, marker: null, circle: null });
  const spotMarkersRef = useRef({});
  // Primo uso dell'indice citta': fetch pigro e memoizzato
  const cityIndexRef = useRef(null);
  // Annullamento della ricerca spot precedente quando ne parte una nuova
  const spotAbortRef = useRef(null);

  // 1. Caricamento del dataset di flotta generato da etl/sync_fleet.py (Sprint 1-3)
  useEffect(() => {
    fetch('/data/fleet_data.json')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setStations(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Errore nel caricamento del dataset di flotta:', err);
        setLoadError('Dataset di flotta non disponibile.');
        setLoading(false);
      });
  }, []);

  // 2. Inizializzazione Mappa Leaflet
  useEffect(() => {
    if (!mapRef.current) {
      // Inizializza la mappa centrata sull'Italia centrale
      const map = L.map('map-container', {
        zoomControl: false,
      }).setView([41.9028, 12.4964], 6);

      L.control.zoom({ position: 'topright' }).addTo(map);

      // OpenStreetMap Tiles con stile pulito
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19,
      }).addTo(map);

      mapRef.current = map;
    }

    return () => {
      // Cleanup mappa su smontaggio
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // 3. Azioni mappa ↔ tabella (riferimenti stabili: usate anche dagli effect dei layer)
  /** Selettore nodi: filtra la lista sulla base e vola sul suo raggio operativo. */
  const handleSelectPoi = useCallback((poiId) => {
    // Il volo verso la base non deve essere sovrascritto dal fitBounds dei marker
    skipFitBoundsRef.current = poiId !== ALL_POIS;
    setActiveTab(poiId);
    setSelectedPoi(poiId);
    setFlyToNonce((nonce) => nonce + 1);
  }, []);

  /** Click su una riga (o su un marker): evidenzia la riga e vola sull'impianto. */
  const handleRowClick = useCallback((row) => {
    if (!row) return;
    const station = row.station;
    if (station) setSelectedStation(station);

    const map = mapRef.current;
    if (!map || !row.hasCoords) return;

    map.flyTo([row.lat, row.lon], 15, { duration: 1.2 });
    const marker = markersRef.current[row.id] || spotMarkersRef.current[row.id];
    if (marker) marker.openPopup();

    const tableRow = rowsRef.current[row.key];
    if (tableRow) tableRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  /** Click su un marker: seleziona la riga corrispondente nella tabella logistica. */
  const handleMarkerClick = useCallback(
    (row) => {
      handleRowClick(row);
    },
    [handleRowClick],
  );

  /** Click su un marker spot: evidenzia l'impianto senza cambiare tab. */
  const handleSpotMarkerClick = useCallback((row) => {
    setSelectedStation(row.station);
    const map = mapRef.current;
    if (map && row.hasCoords) map.flyTo([row.lat, row.lon], 15, { duration: 1 });
  }, []);

  // 4. Basi aziendali: marker hub + anello semitrasparente del raggio operativo
  useEffect(() => {
    const map = mapRef.current;
    if (!map || BASES.length === 0) return;

    const poiLayer = L.layerGroup().addTo(map);

    BASES.forEach((base) => {
      // Raggio operativo (default 10 km): definisce il perimetro di ricerca della flotta
      L.circle([base.lat, base.lng], {
        radius: base.radius * 1000,
        color: '#22d3ee',
        weight: 1.5,
        opacity: 0.55,
        dashArray: '5 6',
        fillColor: '#22d3ee',
        fillOpacity: 0.07,
        interactive: false,
      }).addTo(poiLayer);

      const icon = L.divIcon({
        className: 'custom-leaflet-marker',
        html: `<div class="poi-marker">${POI_GLYPH_SVG}</div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      });

      const marker = L.marker([base.lat, base.lng], { icon, zIndexOffset: 900 })
        .addTo(poiLayer)
        .bindTooltip(`${base.nome} · raggio ${base.radius} km`, {
          direction: 'top',
          offset: [0, -14],
        })
        .bindPopup(`
          <div class="popup-body">
            <strong>${escapeHtml(base.nome)}</strong><br/>
            <span class="popup-muted">Base logistica · provincia ${escapeHtml(base.provincia) || 'n.d.'}</span>
            <div class="popup-muted popup-radius">Raggio operativo ${base.radius} km</div>
          </div>
        `);

      // Click sulla base: seleziona il nodo e vola sul perimetro operativo
      marker.on('click', () => handleSelectPoi(base.id));
    });

    return () => {
      poiLayer.remove();
    };
  }, [handleSelectPoi]);

  // 4-bis. Presidio spot: il cursore della mappa diventa un mirino quando il radar è armato
  useEffect(() => {
    const map = mapRef.current;
    const container = map?.getContainer();
    if (!container) return undefined;

    container.classList.toggle('radar-armed', spotArmed);
    return () => container.classList.remove('radar-armed');
  }, [spotArmed]);

  // 5. Perimetri: dataset di flotta (per base) e 10 impianti POI fissi monitorati
  const scopeStations = useMemo(() => {
    const query = normalizeSearch(searchTerm);

    return stations.filter((s) => {
      const matchPoi = selectedPoi === ALL_POIS || s.poi_id === selectedPoi;
      const matchSearch =
        !query || SEARCH_FIELDS.some((field) => normalizeSearch(s[field]).includes(query));

      return matchPoi && matchSearch;
    });
  }, [stations, selectedPoi, searchTerm]);

  // Filtro MANDATORIO mezzi pesanti: solo impianti su grandi arterie (SS, SP, autostrade, interporti)
  const filteredStations = useMemo(
    () => (onlyArterie ? scopeStations.filter((s) => s.is_arteria_principale) : scopeStations),
    [scopeStations, onlyArterie],
  );

  const arterieStations = useMemo(
    () => scopeStations.filter((s) => s.is_arteria_principale),
    [scopeStations],
  );

  const stationsById = useMemo(() => {
    const index = new Map();
    stations.forEach((s) => index.set(String(s.id), s));
    return index;
  }, [stations]);

  /**
   * Vista "Impianti Monitorati (10)": i dieci POI fissi aziendali nell'ordine di
   * `config/pois.json`, arricchiti con i dati live quando disponibili. Un impianto
   * assente dal dataset resta visibile con prezzo `n.d.` (nessun silenzio sui target).
   */
  const monitoredRows = useMemo(
    () =>
      MONITORED_STATIONS.map((target) => {
        const record = stationsById.get(target.id) || null;
        const lat = Number(record?.lat);
        const lon = Number(record?.lon);
        return {
          key: `mon-${target.id}`,
          id: target.id,
          station: record,
          target: true,
          monitored: true,
          spot: false,
          hidden: false,
          nome: target.nome,
          gestore: record?.gestore || record?.nome || target.nome,
          indirizzo: record?.indirizzo || '',
          comune: record?.comune || '',
          provincia: record?.provincia || target.provincia,
          prezzo: hasPrice(record) ? Number(record.prezzo_gasolio) : null,
          comunicazione: record?.data_comunicazione || '',
          distanzaKm: record?.distanza_km ?? null,
          tipoImpianto: record?.tipo_impianto || '',
          arteria: Boolean(record?.is_arteria_principale),
          poiId: record?.poi_id || null,
          lat: Number.isFinite(lat) ? lat : null,
          lon: Number.isFinite(lon) ? lon : null,
          hasCoords: Number.isFinite(lat) && Number.isFinite(lon),
        };
      }),
    [stationsById],
  );

  /**
   * Radar Spot Live: impianti intercettati dal Ministero attorno a un punto scelto
   * dall'utente o a una citta'/ID cercato. Restano separati dai 10 POI monitorati.
   */
  const liveSpotRows = useMemo(
    () =>
      spotRows.map((record) => {
        const nearest = nearestBase(record.lat, record.lon);
        const lat = Number(record.lat);
        const lon = Number(record.lon);
        return {
          key: `spot-${record.id}`,
          id: String(record.id),
          station: record,
          target: isTargetStation(record),
          monitored: false,
          spot: true,
          hidden: false,
          nome: record.nome || record.gestore,
          gestore: record.gestore || record.nome,
          indirizzo: record.indirizzo || '',
          comune: record.comune || '',
          provincia: record.provincia || '',
          prezzo: Number(record.prezzo_gasolio),
          comunicazione: record.data_comunicazione || '',
          distanzaKm: record.distanza_km ?? (nearest ? Number(nearest.km.toFixed(1)) : null),
          tipoImpianto: record.tipo_impianto || '',
          arteria: Boolean(record.is_arteria_principale),
          poiId: record.poi_id || null,
          lat: Number.isFinite(lat) ? lat : null,
          lon: Number.isFinite(lon) ? lon : null,
          hasCoords: Number.isFinite(lat) && Number.isFinite(lon),
        };
      }),
    [spotRows],
  );

  /** Righe effettivamente in tabella per il tab attivo. */
  const visibleRows = useMemo(() => {
    if (activeTab === TAB_MONITORED) return monitoredRows;
    if (activeTab === TAB_SPOT) return liveSpotRows;
    return filteredStations.map((s) => ({
      key: `fleet-${s.id}`,
      id: String(s.id),
      station: s,
      target: isTargetStation(s),
      monitored: isTargetStation(s),
      spot: false,
      hidden: !hasPrice(s),
      nome: s.nome,
      gestore: s.gestore,
      indirizzo: s.indirizzo,
      comune: s.comune,
      provincia: s.provincia,
      prezzo: hasPrice(s) ? Number(s.prezzo_gasolio) : null,
      comunicazione: s.data_comunicazione,
      distanzaKm: s.distanza_km,
      tipoImpianto: s.tipo_impianto,
      arteria: Boolean(s.is_arteria_principale),
      poiId: s.poi_id,
      lat: Number(s.lat),
      lon: Number(s.lon),
      hasCoords: Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon)),
    }));
  }, [activeTab, monitoredRows, liveSpotRows, filteredStations]);

  // Righe mostrate in tabella: i segnaposto senza prezzo non hanno un pin da colorare
  const tableRows = useMemo(() => visibleRows.filter((row) => !row.hidden), [visibleRows]);

  // Minimo del dataset in vista: guida la codifica colore e l'evidenziazione di riga
  const minPrice = useMemo(() => {
    const prices = tableRows.map((row) => row.prezzo).filter(Number.isFinite);
    return prices.length ? Math.min(...prices) : null;
  }, [tableRows]);

  const arterieRows = useMemo(() => tableRows.filter((row) => row.arteria), [tableRows]);

  const arterieAvgPrice = useMemo(() => {
    if (!arterieRows.length) return null;
    const sum = arterieRows.reduce((acc, row) => acc + row.prezzo, 0);
    return sum / arterieRows.length;
  }, [arterieRows]);

  // Ultima comunicazione MIMIT presente nel dataset (badge LIVE)
  const lastSyncLabel = useMemo(() => {
    const timestamps = stations
      .map((s) => parseComunicazione(s.data_comunicazione))
      .filter(Boolean)
      .map((d) => d.getTime());

    if (!timestamps.length) return 'n.d.';

    const pad = (n) => String(n).padStart(2, '0');
    const last = new Date(Math.max(...timestamps));
    return `${pad(last.getDate())}/${pad(last.getMonth() + 1)} ${pad(last.getHours())}:${pad(last.getMinutes())}`;
  }, [stations]);

  // Helper per classe colore del prezzo
  // (useCallback: la funzione è usata dentro l'useEffect dei marker)
  const getPriceTier = useCallback(
    (price) => {
      if (!Number.isFinite(price)) return 'nd';
      const diff = price - (minPrice ?? 0);
      if (diff <= PRICE_TIER_CHEAP) return 'cheap';
      if (diff <= PRICE_TIER_MID) return 'mid';
      return 'expensive';
    },
    [minPrice],
  );

  // 6. Aggiornamento Marker dei distributori sulla mappa
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Rimuovi vecchi marker
    Object.values(markersRef.current).forEach((marker) => marker.remove());
    markersRef.current = {};

    // I risultati del Radar Spot Live hanno un layer dedicato (pill ambra): qui si
    // disegnano solo gli impianti del dataset di flotta e i 10 POI monitorati.
    const fleetRows = tableRows.filter((row) => !row.spot);
    if (fleetRows.length === 0) return;

    const bounds = L.latLngBounds([]);

    fleetRows.forEach((row) => {
      if (!row.hasCoords) return;
      const tier = getPriceTier(row.prezzo);
      const freshness = getFreshness(row.comunicazione);
      const route = getRowRouteBadge(row);

      // Marker badge personalizzato con il prezzo in evidenza.
      // I 10 impianti POI fissi aziendali portano un anello dorato di riconoscimento.
      const icon = L.divIcon({
        className: 'custom-leaflet-marker',
        html: `<div class="custom-price-marker marker-${tier}${row.target ? ' is-target-marker' : ''}">€ ${row.prezzo.toFixed(3)}</div>`,
        iconSize: [60, 24],
        iconAnchor: [30, 12],
      });

      const marker = L.marker([row.lat, row.lon], { icon }).addTo(map);

      marker.bindPopup(`
        <div class="popup-body">
          <div class="popup-head">
            <span class="popup-route ${route.className}">${route.label}</span>
            <strong>${escapeHtml(row.gestore)}</strong>
          </div>
          <span class="popup-muted">${escapeHtml(row.indirizzo)}, ${escapeHtml(row.comune)} (${escapeHtml(row.provincia)})</span>
          <div class="popup-price">
            ${formatPrice(row.prezzo)}
            <span class="popup-muted">Self</span>
          </div>
          <div class="popup-muted popup-mono">
            ${formatDistance(row.distanzaKm)} da ${escapeHtml(getPoiLabel(row.poiId))}
          </div>
          <div class="popup-muted popup-mono">
            Comunicato: ${formatComunicazioneFull(row.comunicazione)}
          </div>
          <div class="popup-badges">
            <span class="${POPUP_FRESHNESS_CLASS[freshness.level]}">
              ${freshness.level === 'fresh' ? '&#10003;' : freshness.level === 'stale' ? '&#9888;' : '&#8226;'} ${freshness.label}
            </span>
            ${
              row.target
                ? '<span class="popup-freshness popup-target">&#9733; Impianto monitorato</span>'
                : ''
            }
            ${
              row.arteria
                ? '<span class="popup-freshness popup-heavy">&#10003; Mezzi pesanti</span>'
                : ''
            }
          </div>
        </div>
      `);

      marker.on('click', () => handleMarkerClick(row));

      markersRef.current[row.id] = marker;
      bounds.extend([row.lat, row.lon]);
    });

    // Adatta lo zoom per mostrare tutti i risultati filtrati,
    // tranne quando l'utente ha appena chiesto il volo verso una base
    if (skipFitBoundsRef.current) {
      skipFitBoundsRef.current = false;
    } else if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    }
  }, [tableRows, getPriceTier, handleMarkerClick]);

  // 7. Volo verso la base selezionata (perimetro operativo)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || selectedPoi === ALL_POIS || activeTab !== selectedPoi) return;

    const base = BASES.find((b) => b.id === selectedPoi);
    if (!base) return;

    map.flyTo([base.lat, base.lng], 12, { duration: 1.2 });
  }, [selectedPoi, activeTab, flyToNonce]);

  const activePoi = useMemo(
    () => BASES.find((base) => base.id === selectedPoi) || null,
    [selectedPoi],
  );

  // Etichetta della legenda: il raggio è quello configurato in config/pois.json
  const ringLabel = useMemo(() => {
    const radii = [...new Set(BASES.map((base) => base.radius))];
    return radii.length === 1 ? `Raggio operativo ${radii[0]} km` : 'Raggi operativi per base';
  }, []);

  // -------------------------------------------------------------------------
  // Radar Spot Live — azioni
  // -------------------------------------------------------------------------
  /** Indice citta' con fetch pigro e memoizzato (una sola richiesta per sessione). */
  const getCityIndex = useCallback(async (signal) => {
    if (!cityIndexRef.current) {
      cityIndexRef.current = fetchCityIndex(signal).catch((err) => {
        cityIndexRef.current = null;
        throw err;
      });
    }
    return cityIndexRef.current;
  }, []);

  /**
   * Disegna il centro radar (marker + cerchio tratteggiato di 10 km) e interroga
   * la Live API del Ministero tramite il proxy Vite.
   */
  const runRadarQuery = useCallback(
    async (lat, lng) => {
      const map = mapRef.current;
      if (!map) return;

      // Reset del layer spot precedente
      const layer = spotLayerRef.current;
      if (layer.group) layer.group.remove();

      const group = L.layerGroup().addTo(map);
      const centerMarker = L.marker([lat, lng], {
        icon: L.divIcon({
          className: 'custom-leaflet-marker',
          html: `<div class="radar-center-marker">${RADAR_GLYPH_SVG}</div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
        interactive: false,
        zIndexOffset: 800,
      })
        .addTo(group)
        .bindTooltip('Centro Radar Spot · raggio 10 km', { direction: 'top', offset: [0, -12] });

      const circle = L.circle([lat, lng], {
        radius: SPOT_RADIUS_KM * 1000,
        color: '#fbbf24',
        weight: 2,
        opacity: 0.9,
        dashArray: '7 7',
        fillColor: '#fbbf24',
        fillOpacity: 0.06,
        interactive: false,
      }).addTo(group);

      spotLayerRef.current = { group, marker: centerMarker, circle };

      setSpotCenter({ lat, lng });
      setSpotArmed(false);
      setActiveTab(TAB_SPOT);

      spotAbortRef.current?.abort();
      const controller = new AbortController();
      spotAbortRef.current = controller;

      setSpotLoading(true);
      setSpotError(null);
      setSpotPhase('zone');
      setSpotLabel(`Punto ${lat.toFixed(5)}, ${lng.toFixed(5)} · raggio ${SPOT_RADIUS_KM} km`);

      try {
        const raw = await fetchZone({
          lat,
          lng,
          radius: SPOT_RADIUS_KM,
          signal: controller.signal,
        });
        const records = spotRecordsFrom(raw, 'zone');
        records.sort((a, b) => a.prezzo_gasolio - b.prezzo_gasolio);
        setSpotRows(records);
        if (!records.length) {
          setSpotError('Nessun Gasolio Self comunicato nel raggio di 10 km da questo punto.');
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('Radar Spot Live — interrogazione zona fallita:', err);
        setSpotError(err.message || 'Interrogazione live non riuscita.');
        setSpotRows([]);
      } finally {
        if (!controller.signal.aborted) setSpotLoading(false);
      }
    },
    [],
  );

  // Click sulla mappa con radar armato: posiziona il centro e interroga il Ministero
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !spotArmed) return undefined;

    const handleClick = (event) => {
      runRadarQuery(event.latlng.lat, event.latlng.lng);
    };

    map.on('click', handleClick);
    return () => {
      map.off('click', handleClick);
    };
  }, [spotArmed, runRadarQuery]);

  /** Ricerca spot per ID impianto o città (barra strumenti). */
  const handleSpotSearch = useCallback(
    async (event) => {
      event.preventDefault();
      const term = spotQuery.trim();

      spotAbortRef.current?.abort();
      const controller = new AbortController();
      spotAbortRef.current = controller;

      setSpotLoading(true);
      setSpotError(null);
      setSpotPhase(/^\d{1,8}$/.test(term) ? 'id' : 'city');
      setSpotLabel('');

      try {
        const { records, label } = await runSpotSearch(term, {
          signal: controller.signal,
          getCityIndex,
        });
        setSpotRows(records);
        setSpotLabel(label);
        setActiveTab(TAB_SPOT);
        if (!records.length) {
          setSpotError('Nessun Gasolio Self comunicato nel raggio di 10 km.');
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('Radar Spot Live — ricerca fallita:', err);
        setSpotError(err.message || 'Ricerca spot non riuscita.');
        setSpotRows([]);
      } finally {
        if (!controller.signal.aborted) setSpotLoading(false);
      }
    },
    [spotQuery, getCityIndex],
  );

  /** Chiude lo spot: cerchio, centro radar e risultati temporanei spariscono. */
  const handleCloseSpot = useCallback(() => {
    spotAbortRef.current?.abort();
    spotAbortRef.current = null;

    const layer = spotLayerRef.current;
    if (layer.group) layer.group.remove();
    spotLayerRef.current = { group: null, marker: null, circle: null };
    Object.values(spotMarkersRef.current).forEach((marker) => marker.remove());
    spotMarkersRef.current = {};

    setSpotRows([]);
    setSpotCenter(null);
    setSpotArmed(false);
    setSpotError(null);
    setSpotLabel('');
    setSpotLoading(false);
    setSpotPhase(null);
    setActiveTab((tab) => (tab === TAB_SPOT ? TAB_MONITORED : tab));
  }, []);

  // 8. Marker temporanei dei risultati spot (ambra: non inquinano i 10 POI monitorati)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    Object.values(spotMarkersRef.current).forEach((marker) => marker.remove());
    spotMarkersRef.current = {};

    liveSpotRows.forEach((row) => {
      const icon = L.divIcon({
        className: 'custom-leaflet-marker',
        html: `<div class="custom-price-marker marker-spot${row.target ? ' is-target-marker' : ''}">SPOT € ${row.prezzo.toFixed(3)}</div>`,
        iconSize: [86, 24],
        iconAnchor: [43, 26],
      });

      const marker = L.marker([row.lat, row.lon], { icon, zIndexOffset: 1200 }).addTo(map);

      marker.bindPopup(`
        <div class="popup-body">
          <div class="popup-head">
            <span class="popup-route route-spot">SPOT LIVE</span>
            <strong>${escapeHtml(row.gestore)}</strong>
          </div>
          <span class="popup-muted">${escapeHtml(row.indirizzo)} ${escapeHtml(row.comune)} (${escapeHtml(row.provincia)})</span>
          <div class="popup-price">
            ${formatPrice(row.prezzo)}
            <span class="popup-muted">Self</span>
          </div>
          <div class="popup-muted popup-mono">
            ${formatDistance(row.distanzaKm)} ${isMonitorSweep(row.poiId) ? 'dal centro radar' : `da ${escapeHtml(getPoiLabel(row.poiId))}`}
          </div>
          <div class="popup-muted popup-mono">
            Comunicato: ${formatComunicazioneFull(row.comunicazione)}
          </div>
          <div class="popup-badges">
            <span class="popup-freshness popup-spot">&#9679; Risultato spot live</span>
            ${
              row.target
                ? '<span class="popup-freshness popup-target">&#9733; Impianto monitorato</span>'
                : ''
            }
          </div>
        </div>
      `);

      marker.on('click', () => handleSpotMarkerClick(row));
      spotMarkersRef.current[row.id] = marker;
    });
  }, [liveSpotRows, handleSpotMarkerClick]);

  // 8-bis. Inquadra l'area dello spot quando arriva un nuovo risultato (una volta per
  // interrogazione: lo zoom scelto dall'utente non viene poi più forzato)
  const lastSpotQueryRef = useRef(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const signature = [
      spotRows.length,
      spotRows[0]?.id ?? 'x',
      spotCenter ? spotCenter.lat.toFixed(5) : 'n',
      spotCenter ? spotCenter.lng.toFixed(5) : 'n',
    ].join('|');

    if (lastSpotQueryRef.current === signature) return;
    lastSpotQueryRef.current = signature;
    if (!spotRows.length) return;

    // Il centro del radar fa parte dell'inquadratura: il cerchio dei 10 km resta visibile
    const bounds = L.latLngBounds(spotRows.map((rec) => [rec.lat, rec.lon]));
    if (spotCenter) bounds.extend([spotCenter.lat, spotCenter.lng]);
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
  }, [spotRows, spotCenter]);

  // 9. Pulizia delle risorse spot su smontaggio del componente
  useEffect(
    () => () => {
      spotAbortRef.current?.abort();
      const layer = spotLayerRef.current;
      if (layer.group) layer.group.remove();
    },
    [],
  );

  const spotTabLabel = spotLoading ? 'Spot Live…' : `Risultati Spot Live (${liveSpotRows.length})`;
  const monitoredTabLabel = `Impianti Monitorati (${MONITORED_STATIONS.length})`;

  return (
    <div className="dashboard-container" data-active-tab={activeTab}>
      {/* PANNELLO SINISTRO: CONTROLLI & TABELLA LOGISTICA */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="app-title-row">
            <div className="app-title">
              <Radar size={20} />
              <span>FLEET RADAR</span>
              <span className="app-title-sep">•</span>
              <span className="app-title-sub">POI Fissi &amp; Radar Spot Live</span>
            </div>
            <span
              className="live-badge"
              title={`Ultima comunicazione MIMIT nel dataset: ${lastSyncLabel}`}
            >
              <span className="live-dot" aria-hidden="true" />LIVE REAL-TIME
            </span>
          </div>

          <div className="stats-bar">
            <div className="stat-card">
              <div className="stat-label">Impianti idonei</div>
              <div className="stat-value mono green">
                {arterieRows.length}
                <span className="stat-unit">/ {tableRows.length}</span>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Prezzo minimo</div>
              <div className="stat-value mono">
                {minPrice === null ? '—' : `${minPrice.toFixed(3)} €`}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Prezzo medio arterie</div>
              <div className="stat-value mono">
                {arterieAvgPrice === null ? '—' : `${arterieAvgPrice.toFixed(3)} €`}
              </div>
            </div>
          </div>

          <div className="header-note mono">
            {activeTab === TAB_MONITORED
              ? `${MONITORED_STATIONS.length} impianti POI fissi aziendali`
              : activeTab === TAB_SPOT
                ? `Radar Spot Live · ${liveSpotRows.length} impianti`
                : activePoi
                  ? `${activePoi.nome} · raggio ${activePoi.radius} km`
                  : 'Tutte le basi · perimetri aggregati'}
            <span className="header-note-sep">|</span>
            {tableRows.length} impianti in vista
            <span className="header-note-sep">|</span>
            sync {lastSyncLabel}
          </div>
        </div>

        <div className="controls-container">
          {/* RADAR SPOT LIVE: ricerca immediata per ID o città + puntamento sulla mappa */}
          <div className={`spot-radar ${spotArmed ? 'armed' : ''}`}>
            <div className="spot-tools">
              <form className="spot-search" onSubmit={handleSpotSearch}>
                <Crosshair size={15} className="spot-search-icon" />
                <input
                  type="text"
                  className="spot-input"
                  placeholder="Verifica ID Impianto o Zona (es. 4835 o Messina)"
                  value={spotQuery}
                  onChange={(e) => setSpotQuery(e.target.value)}
                  aria-label="Ricerca spot per ID impianto o città"
                />
                <button type="submit" className="spot-submit" disabled={spotLoading}>
                  {spotLoading ? <Loader size={13} className="spot-spin" /> : 'Cerca'}
                </button>
              </form>

              <button
                type="button"
                className={`radar-btn ${spotArmed ? 'active' : ''}`}
                onClick={() => setSpotArmed((armed) => !armed)}
                title="Punta il radar su un punto della mappa: un click disegna il cerchio di 10 km e interroga il Ministero"
                aria-pressed={spotArmed}
              >
                <Crosshair size={13} className="radar-btn-icon" />
                {spotArmed ? 'Radar Armato' : 'Punta Radar sulla Mappa'}
              </button>

              {(spotRows.length > 0 || spotCenter || spotError) && (
                <button
                  type="button"
                  className="spot-close"
                  onClick={handleCloseSpot}
                  title="Chiudi lo spot e rimuovi cerchio e risultati temporanei"
                >
                  <X size={12} />
                  Chiudi Spot
                </button>
              )}
            </div>

            {(spotArmed || spotLoading || spotError || spotLabel || spotRows.length > 0) && (
              <div className="spot-status">
                {spotArmed && (
                  <span className="spot-hint">
                    <MapPin size={11} /> Click sulla mappa per centrare il radar (raggio{' '}
                    {SPOT_RADIUS_KM} km)
                  </span>
                )}
                {spotLoading && (
                  <span className="spot-hint live">
                    <Loader size={11} className="spot-spin" />
                    {SPOT_PHASE_LABEL[spotPhase] || 'interrogazione live'} in corso…
                  </span>
                )}
                {!spotLoading && spotLabel && <span className="spot-hint live">{spotLabel}</span>}
                {!spotLoading && spotError && <span className="spot-hint error">{spotError}</span>}
              </div>
            )}
          </div>

          {/* TAB: impianti POI fissi, risultati spot live, basi logistiche */}
          <div className="tab-group" role="group" aria-label="Viste logistiche">
            <button
              type="button"
              aria-pressed={activeTab === TAB_MONITORED}
              className={`tab-btn ${activeTab === TAB_MONITORED ? 'active' : ''}`}
              onClick={() => {
                setActiveTab(TAB_MONITORED);
                setSelectedPoi(ALL_POIS);
                skipFitBoundsRef.current = false;
              }}
              title="I 10 impianti POI fissi specifici monitorati"
            >
              {monitoredTabLabel}
            </button>
            {BASES.map((base) => (
              <button
                type="button"
                key={base.id}
                aria-pressed={activeTab === base.id}
                className={`tab-btn ${activeTab === base.id ? 'active' : ''}`}
                onClick={() => handleSelectPoi(base.id)}
              >
                {base.nome}
              </button>
            ))}
            {(spotRows.length > 0 || spotLoading || spotError) && (
              <button
                type="button"
                aria-pressed={activeTab === TAB_SPOT}
                className={`tab-btn tab-spot ${activeTab === TAB_SPOT ? 'active' : ''}`}
                onClick={() => setActiveTab(TAB_SPOT)}
                title="Risultati temporanei del Radar Spot Live"
              >
                {spotTabLabel}
              </button>
            )}
          </div>

          {activeTab === TAB_SPOT ? (
            <div className="spot-toolbar">
              <span className="spot-toolbar-note">
                <Crosshair size={11} /> Risultati temporanei: non sostituiscono i{' '}
                {MONITORED_STATIONS.length} POI monitorati.
              </span>
            </div>
          ) : (
            <>
              <div className="search-box">
                <Search size={15} className="search-icon" />
                <input
                  type="text"
                  className="search-input"
                  placeholder="Cerca arteria (SS 10, A18), brand o comune..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>

              {/* Filtro MANDATORIO mezzi pesanti: attivo di default */}
              <label className="heavy-toggle">
                <input
                  type="checkbox"
                  className="heavy-toggle-input"
                  checked={onlyArterie}
                  onChange={(e) => setOnlyArterie(e.target.checked)}
                />
                <span className="toggle-track" aria-hidden="true">
                  <span className="toggle-thumb" />
                </span>
                <span className="toggle-label">
                  <Truck size={13} className="toggle-icon" />
                  Solo Grandi Arterie / Mezzi Pesanti
                  <code className="toggle-flag">is_arteria_principale</code>
                </span>
                <span className="toggle-count mono">
                  {onlyArterie
                    ? `${arterieStations.length} idonei`
                    : `${scopeStations.length} impianti`}
                </span>
              </label>
            </>
          )}
        </div>

        {/* TABELLA LOGISTICA COMPATTA */}
        <div className="table-wrap">
          {loading ? (
            <p className="table-message">Caricamento dataset di flotta in corso...</p>
          ) : loadError ? (
            <p className="table-message error">{loadError}</p>
          ) : tableRows.length === 0 ? (
            <p className="table-message">
              {activeTab === TAB_SPOT
                ? 'Nessun risultato spot live.'
                : 'Nessun impianto trovato con questi filtri.'}
            </p>
          ) : (
            <table className="fleet-table">
              <thead>
                <tr>
                  <th scope="col" className="col-route">Stato / Tipo</th>
                  <th scope="col" className="col-id">ID</th>
                  <th scope="col" className="col-brand">Brand &amp; Nome</th>
                  <th scope="col" className="col-dist">
                    {activeTab === TAB_MONITORED ? 'Dist. Base' : 'Distanza'}
                  </th>
                  <th scope="col" className="col-price">Prezzo Gasolio</th>
                  <th scope="col" className="col-time">Ora Comu</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((row) => {
                  const route = getRowRouteBadge(row);
                  const tier = getPriceTier(row.prezzo);
                  const isSelected =
                    selectedStation != null && String(selectedStation.id) === row.id;
                  const isMin = row.prezzo !== null && minPrice !== null && row.prezzo === minPrice;
                  const daysAgo = getDaysAgo(row.comunicazione);
                  const isStale = daysAgo !== null && daysAgo > STALE_THRESHOLD_DAYS;
                  const nearest = nearestBase(row.lat, row.lon);
                  const baseKm =
                    isMonitorSweep(row.poiId) || !Number.isFinite(Number(row.distanzaKm))
                      ? nearest
                        ? Number(nearest.km.toFixed(1))
                        : null
                      : Number(row.distanzaKm);
                  const baseLabel = nearest ? nearest.base.nome : getPoiLabel(row.poiId);

                  return (
                    <tr
                      key={row.key}
                      ref={(el) => {
                        if (el) rowsRef.current[row.key] = el;
                        else delete rowsRef.current[row.key];
                      }}
                      className={`fleet-row ${isSelected ? 'selected' : ''} ${
                        row.target ? 'is-target' : ''
                      } ${row.spot ? 'is-spot' : ''}`}
                      style={{
                        '--row-accent': row.spot
                          ? '#fbbf24'
                          : selectedPoi === ALL_POIS && activeTab !== TAB_MONITORED
                            ? getPoiAccent(row.poiId)
                            : 'transparent',
                      }}
                      tabIndex={0}
                      onClick={() => handleRowClick(row)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleRowClick(row);
                        }
                      }}
                    >
                      <td className="cell-route">
                        <span className={`route-badge ${route.className}`}>{route.label}</span>
                        {row.spot && <span className="spot-badge">SPOT LIVE</span>}
                      </td>
                      <td className="cell-id mono">{row.id}</td>
                      <td className="cell-brand">
                        <span className="brand-name" title={row.gestore}>
                          {row.target && <span className="target-star" aria-hidden="true">★</span>}
                          {row.target && row.monitored ? row.nome : row.gestore}
                        </span>
                        <span
                          className="brand-street"
                          title={`${row.indirizzo} — ${row.comune} (${row.provincia}) · ${getPoiLabel(row.poiId)}`}
                        >
                          {row.target && row.monitored && row.gestore !== row.nome
                            ? `${row.gestore} · ${row.indirizzo || row.comune}`
                            : row.indirizzo
                              ? `${row.indirizzo}, ${row.comune}`
                              : row.comune || 'Anagrafica non disponibile'}
                        </span>
                      </td>
                      <td
                        className="cell-dist"
                        title={`Distanza da ${baseLabel}`}
                      >
                        {formatDistance(baseKm)}
                      </td>
                      <td className={`cell-price tier-${tier} ${isMin ? 'is-min' : ''}`}>
                        {row.prezzo === null ? 'n.d.' : formatPrice(row.prezzo)}
                      </td>
                      <td
                        className={`cell-time ${isStale ? 'stale' : ''}`}
                        title={`Comunicazione MIMIT: ${formatComunicazioneFull(row.comunicazione)}`}
                      >
                        {isStale && <AlertTriangle size={11} className="time-warning" />}
                        {formatComunicazione(row.comunicazione)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* PANNELLO DESTRO: MAPPA */}
      <div className="map-panel">
        <div id="map-container"></div>
        {spotArmed && (
          <div className="radar-hint">
            <Crosshair size={13} />
            Radar armato — click sulla mappa per centrare lo spot (raggio {SPOT_RADIUS_KM} km)
          </div>
        )}
        <div className="map-legend">
          <div className="legend-row">
            <span className="legend-hub" aria-hidden="true">
              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 21V10a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1v11" />
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 1.132-1.803l7.95-3.974a2 2 0 0 1 1.837 0l7.948 3.974A2 2 0 0 1 22 8z" />
                <path d="M6 13h12" />
                <path d="M6 17h12" />
              </svg>
            </span>
            <span>Base aziendale</span>
          </div>
          <div className="legend-row">
            <span className="legend-target" aria-hidden="true">★</span>
            <span>Impianto POI fisso monitorato</span>
          </div>
          <div className="legend-row">
            <span className="legend-ring" aria-hidden="true" />
            <span>{ringLabel}</span>
          </div>
          <div className="legend-row">
            <span className="legend-spot" aria-hidden="true" />
            <span>Radar Spot Live (10 km)</span>
          </div>
          <div className="legend-row legend-tiers">
            <span className="legend-pill marker-cheap">cheap</span>
            <span className="legend-pill marker-mid">mid</span>
            <span className="legend-pill marker-expensive">expensive</span>
          </div>
          <div className="legend-note">Soglie +0,05 € / +0,15 € sul minimo in vista</div>
        </div>
      </div>
    </div>
  );
}
