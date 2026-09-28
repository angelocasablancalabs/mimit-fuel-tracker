import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Radar, Search, Truck, AlertTriangle } from 'lucide-react';
import poisConfig from '../../config/pois.json';
import './App.css';

// Oltre questa soglia (in giorni) la comunicazione del prezzo si evidenzia come non recente
const STALE_THRESHOLD_DAYS = 7;

// Soglie di codifica colore del prezzo, relative al minimo del dataset filtrato
const PRICE_TIER_CHEAP = 0.05;
const PRICE_TIER_MID = 0.15;

// Raggio operativo di fallback (km) quando il POI non lo specifica
const DEFAULT_POI_RADIUS_KM = 10;

// Valore del selettore nodi che disattiva il filtro per base
const ALL_POIS = 'ALL';

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

// Classi CSS del badge freschezza dentro i popup Leaflet
const POPUP_FRESHNESS_CLASS = {
  fresh: 'popup-freshness freshness-fresh',
  standard: 'popup-freshness freshness-standard',
  stale: 'popup-freshness freshness-stale',
};

/**
 * Normalizzazione dei POI aziendali da `config/pois.json` (stessa fonte di sync_fleet.py):
 * scarto dei record privi di coordinate e clamp del raggio operativo entro il limite API (1-10 km).
 */
const POIS = (Array.isArray(poisConfig) ? poisConfig : [])
  .filter(
    (poi) =>
      poi &&
      typeof poi.id === 'string' &&
      Number.isFinite(Number(poi.lat)) &&
      Number.isFinite(Number(poi.lng)),
  )
  .map((poi) => ({
    id: poi.id,
    nome: poi.nome || poi.id,
    provincia: poi.provincia || '',
    lat: Number(poi.lat),
    lng: Number(poi.lng),
    radius: Math.min(
      Math.max(Number(poi.radius) || DEFAULT_POI_RADIUS_KM, 1),
      DEFAULT_POI_RADIUS_KM,
    ),
  }));

/** Tinta associata a una base (accento di riga in vista aggregata). */
function getPoiAccent(poiId) {
  const index = POIS.findIndex((poi) => poi.id === poiId);
  return index >= 0 ? POI_ACCENTS[index % POI_ACCENTS.length] : '#475569';
}

/** Nome leggibile della base a cui appartiene un impianto. */
function getPoiLabel(poiId) {
  return POIS.find((poi) => poi.id === poiId)?.nome || 'Base non nota';
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

export default function App() {
  const [stations, setStations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedPoi, setSelectedPoi] = useState(ALL_POIS);
  const [onlyArterie, setOnlyArterie] = useState(true);
  const [selectedStation, setSelectedStation] = useState(null);
  // Contatore che permette di rivolare sulla stessa base a ogni click sul nodo
  const [flyToNonce, setFlyToNonce] = useState(0);

  const mapRef = useRef(null);
  const markersRef = useRef({});
  const rowsRef = useRef({});
  // Impedisce al fitBounds dei marker di annullare il volo verso una base appena selezionata
  const skipFitBoundsRef = useRef(false);

  // 1. Caricamento del dataset di flotta generato da etl/sync_fleet.py (Sprint 1)
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
    setSelectedPoi(poiId);
    setFlyToNonce((nonce) => nonce + 1);
  }, []);

  /** Click su una riga della tabella logistica: evidenzia e vola sul marker. */
  const handleRowClick = useCallback((station) => {
    setSelectedStation(station);

    const map = mapRef.current;
    if (!map) return;

    map.flyTo([station.lat, station.lon], 15, { duration: 1.2 });
    const marker = markersRef.current[station.id];
    if (marker) marker.openPopup();
  }, []);

  /** Click su un marker: seleziona la riga corrispondente nella tabella logistica. */
  const handleMarkerClick = useCallback((station) => {
    setSelectedStation(station);
    rowsRef.current[station.id]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  // 4. Basi aziendali: marker hub + anello semitrasparente del raggio operativo
  useEffect(() => {
    const map = mapRef.current;
    if (!map || POIS.length === 0) return;

    const poiLayer = L.layerGroup().addTo(map);

    POIS.forEach((poi) => {
      // Raggio operativo (default 10 km): definisce il perimetro di ricerca della flotta
      L.circle([poi.lat, poi.lng], {
        radius: poi.radius * 1000,
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

      const marker = L.marker([poi.lat, poi.lng], { icon, zIndexOffset: 900 })
        .addTo(poiLayer)
        .bindTooltip(`${poi.nome} · raggio ${poi.radius} km`, {
          direction: 'top',
          offset: [0, -14],
        })
        .bindPopup(`
          <div class="popup-body">
            <strong>${poi.nome}</strong><br/>
            <span class="popup-muted">Base logistica · provincia ${poi.provincia || 'n.d.'}</span>
            <div class="popup-muted popup-radius">Raggio operativo ${poi.radius} km</div>
          </div>
        `);

      // Click sulla base: seleziona il nodo e vola sul perimetro operativo
      marker.on('click', () => handleSelectPoi(poi.id));
    });

    return () => {
      poiLayer.remove();
    };
  }, [handleSelectPoi]);

  // 5. Perimetro statistico: base selezionata + ricerca testuale (indipendente dal toggle arterie)
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

  // Minimo del dataset filtrato: guida la codifica colore e l'evidenziazione di riga
  const minPrice = useMemo(() => {
    if (!filteredStations.length) return null;
    return Math.min(...filteredStations.map((s) => s.prezzo_gasolio));
  }, [filteredStations]);

  const arterieAvgPrice = useMemo(() => {
    if (!arterieStations.length) return null;
    const sum = arterieStations.reduce((acc, s) => acc + s.prezzo_gasolio, 0);
    return sum / arterieStations.length;
  }, [arterieStations]);

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

    if (filteredStations.length === 0) return;

    const bounds = L.latLngBounds([]);

    filteredStations.forEach((s) => {
      const tier = getPriceTier(s.prezzo_gasolio);
      const freshness = getFreshness(s.data_comunicazione);
      const route = getRouteBadge(s);

      // Marker badge personalizzato con il prezzo in evidenza
      const icon = L.divIcon({
        className: 'custom-leaflet-marker',
        html: `<div class="custom-price-marker marker-${tier}">€ ${s.prezzo_gasolio.toFixed(3)}</div>`,
        iconSize: [60, 24],
        iconAnchor: [30, 12],
      });

      const marker = L.marker([s.lat, s.lon], { icon }).addTo(map);

      marker.bindPopup(`
        <div class="popup-body">
          <div class="popup-head">
            <span class="popup-route ${route.className}">${route.label}</span>
            <strong>${s.gestore}</strong>
          </div>
          <span class="popup-muted">${s.indirizzo}, ${s.comune} (${s.provincia})</span>
          <div class="popup-price">
            ${formatPrice(s.prezzo_gasolio)}
            <span class="popup-muted">Self</span>
          </div>
          <div class="popup-muted popup-mono">
            ${formatDistance(s.distanza_km)} da ${getPoiLabel(s.poi_id)}
          </div>
          <div class="popup-muted popup-mono">
            Comunicato: ${formatComunicazioneFull(s.data_comunicazione)}
          </div>
          <div class="popup-badges">
            <span class="${POPUP_FRESHNESS_CLASS[freshness.level]}">
              ${freshness.level === 'fresh' ? '&#10003;' : freshness.level === 'stale' ? '&#9888;' : '&#8226;'} ${freshness.label}
            </span>
            ${
              s.is_arteria_principale
                ? '<span class="popup-freshness popup-heavy">&#10003; Mezzi pesanti</span>'
                : ''
            }
          </div>
        </div>
      `);

      marker.on('click', () => handleMarkerClick(s));

      markersRef.current[s.id] = marker;
      bounds.extend([s.lat, s.lon]);
    });

    // Adatta lo zoom per mostrare tutti i risultati filtrati,
    // tranne quando l'utente ha appena chiesto il volo verso una base
    if (skipFitBoundsRef.current) {
      skipFitBoundsRef.current = false;
    } else if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    }
  }, [filteredStations, getPriceTier, handleMarkerClick]);

  // 7. Volo verso la base selezionata (perimetro operativo)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || selectedPoi === ALL_POIS) return;

    const poi = POIS.find((p) => p.id === selectedPoi);
    if (!poi) return;

    map.flyTo([poi.lat, poi.lng], 12, { duration: 1.2 });
  }, [selectedPoi, flyToNonce]);

  const activePoi = useMemo(
    () => POIS.find((poi) => poi.id === selectedPoi) || null,
    [selectedPoi],
  );

  // Etichetta della legenda: il raggio è quello configurato in config/pois.json
  const ringLabel = useMemo(() => {
    const radii = [...new Set(POIS.map((poi) => poi.radius))];
    return radii.length === 1 ? `Raggio operativo ${radii[0]} km` : 'Raggi operativi per base';
  }, []);

  return (
    <div className="dashboard-container">
      {/* PANNELLO SINISTRO: CONTROLLI & TABELLA LOGISTICA */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="app-title-row">
            <div className="app-title">
              <Radar size={20} />
              <span>FLEET RADAR</span>
              <span className="app-title-sep">•</span>
              <span className="app-title-sub">Logistica Mezzi Pesanti</span>
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
                {arterieStations.length}
                <span className="stat-unit">/ {scopeStations.length}</span>
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
            {activePoi
              ? `${activePoi.nome} · raggio ${activePoi.radius} km`
              : 'Tutte le basi · perimetri aggregati'}
            <span className="header-note-sep">|</span>
            {filteredStations.length} impianti in vista
            <span className="header-note-sep">|</span>
            sync {lastSyncLabel}
          </div>
        </div>

        <div className="controls-container">
          {/* Selettore nodi: tutte le basi oppure una singola base aziendale */}
          <div className="tab-group" role="group" aria-label="Selettore base logistica">
            <button
              type="button"
              className={`tab-btn ${selectedPoi === ALL_POIS ? 'active' : ''}`}
              onClick={() => handleSelectPoi(ALL_POIS)}
            >
              Tutte le Basi
            </button>
            {POIS.map((poi) => (
              <button
                type="button"
                key={poi.id}
                className={`tab-btn ${selectedPoi === poi.id ? 'active' : ''}`}
                onClick={() => handleSelectPoi(poi.id)}
              >
                {poi.nome}
              </button>
            ))}
          </div>

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
        </div>

        {/* TABELLA LOGISTICA COMPATTA */}
        <div className="table-wrap">
          {loading ? (
            <p className="table-message">Caricamento dataset di flotta in corso...</p>
          ) : loadError ? (
            <p className="table-message error">{loadError}</p>
          ) : filteredStations.length === 0 ? (
            <p className="table-message">Nessun impianto trovato con questi filtri.</p>
          ) : (
            <table className="fleet-table">
              <thead>
                <tr>
                  <th scope="col" className="col-route">Stato / Tipo</th>
                  <th scope="col" className="col-brand">Brand &amp; Nome</th>
                  <th scope="col" className="col-dist">Distanza</th>
                  <th scope="col" className="col-price">Prezzo Gasolio</th>
                  <th scope="col" className="col-time">Ora Comu</th>
                </tr>
              </thead>
              <tbody>
                {filteredStations.map((s) => {
                  const route = getRouteBadge(s);
                  const tier = getPriceTier(s.prezzo_gasolio);
                  const isSelected = selectedStation?.id === s.id;
                  const isMin = minPrice !== null && s.prezzo_gasolio === minPrice;
                  const daysAgo = getDaysAgo(s.data_comunicazione);
                  const isStale = daysAgo !== null && daysAgo > STALE_THRESHOLD_DAYS;

                  return (
                    <tr
                      key={s.id}
                      ref={(el) => {
                        if (el) rowsRef.current[s.id] = el;
                        else delete rowsRef.current[s.id];
                      }}
                      className={`fleet-row ${isSelected ? 'selected' : ''}`}
                      style={{
                        '--row-accent':
                          selectedPoi === ALL_POIS ? getPoiAccent(s.poi_id) : 'transparent',
                      }}
                      tabIndex={0}
                      onClick={() => handleRowClick(s)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleRowClick(s);
                        }
                      }}
                    >
                      <td className="cell-route">
                        <span className={`route-badge ${route.className}`}>{route.label}</span>
                      </td>
                      <td className="cell-brand">
                        <span className="brand-name">{s.gestore}</span>
                        <span
                          className="brand-street"
                          title={`${s.indirizzo} — ${s.comune} (${s.provincia}) · ${getPoiLabel(s.poi_id)}`}
                        >
                          {s.indirizzo}, {s.comune}
                        </span>
                      </td>
                      <td className="cell-dist" title={`Distanza da ${getPoiLabel(s.poi_id)}`}>
                        {formatDistance(s.distanza_km)}
                      </td>
                      <td className={`cell-price tier-${tier} ${isMin ? 'is-min' : ''}`}>
                        {formatPrice(s.prezzo_gasolio)}
                      </td>
                      <td
                        className={`cell-time ${isStale ? 'stale' : ''}`}
                        title={`Comunicazione MIMIT: ${formatComunicazioneFull(s.data_comunicazione)}`}
                      >
                        {isStale && <AlertTriangle size={11} className="time-warning" />}
                        {formatComunicazione(s.data_comunicazione)}
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
            <span className="legend-ring" aria-hidden="true" />
            <span>{ringLabel}</span>
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
