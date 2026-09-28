import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Fuel, Search, MapPin, Calendar, AlertTriangle } from 'lucide-react';
import './App.css';

// Oltre questa soglia (in giorni) un dato si considera non recente
const STALE_THRESHOLD_DAYS = 7;

// Soglie dei livelli di freschezza
const FRESH_MAX_DAYS = 2;

// Classi CSS del badge freschezza dentro i popup Leaflet
const POPUP_FRESHNESS_CLASS = {
  fresh: 'popup-freshness freshness-fresh',
  standard: 'popup-freshness freshness-standard',
  stale: 'popup-freshness freshness-stale',
};

/**
 * Parsing sicuro del formato data ministeriale "DD/MM/YYYY HH:mm:ss".
 * Restituisce null se la stringa è assente o non interpretabile.
 */
function parseItalianDate(dateStr) {
  if (typeof dateStr !== 'string') return null;

  const match = dateStr
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);

  if (!match) return null;

  const [, dd, mm, yyyy, hh = '0', min = '0', ss = '0'] = match;

  const date = new Date(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    Number(hh),
    Number(min),
    Number(ss),
  );

  // Scarta i rollover di Date (es. 31/02/2026 diventa 03/03/2026)
  if (
    date.getFullYear() !== Number(yyyy) ||
    date.getMonth() !== Number(mm) - 1 ||
    date.getDate() !== Number(dd)
  ) {
    return null;
  }

  return date;
}

/**
 * Giorni interi trascorsi dalla comunicazione del prezzo.
 * Restituisce null se la data non è disponibile o non è valida.
 */
function getDaysAgo(dateStr) {
  const date = parseItalianDate(dateStr);
  if (!date) return null;

  const diffMs = Date.now() - date.getTime();
  // Una data nel futuro viene trattata come "oggi"
  return Math.max(0, Math.floor(diffMs / 86400000));
}

/**
 * Livello di freschezza e etichetta da mostrare in card e popup.
 */
function getFreshness(dateStr) {
  const daysAgo = getDaysAgo(dateStr);

  if (daysAgo === null) {
    return { daysAgo: null, level: 'standard', label: 'Data non disponibile' };
  }

  if (daysAgo <= FRESH_MAX_DAYS) {
    const label =
      daysAgo === 0 ? 'Oggi' : daysAgo === 1 ? 'Ieri' : `${daysAgo} giorni fa`;
    return { daysAgo, level: 'fresh', label };
  }

  if (daysAgo <= STALE_THRESHOLD_DAYS) {
    return { daysAgo, level: 'standard', label: `${daysAgo} giorni fa` };
  }

  return { daysAgo, level: 'stale', label: `${daysAgo} gg fa (non recente)` };
}

export default function App() {
  const [stations, setStations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedProvince, setSelectedProvince] = useState('ALL');
  const [selectedStation, setSelectedStation] = useState(null);
  const [excludeStale, setExcludeStale] = useState(true);

  const mapRef = useRef(null);
  const markersRef = useRef({});

  // 1. Caricamento del dataset generato dall'ETL
  useEffect(() => {
    fetch('/data/gasolio_focus.json')
      .then((res) => {
        if (!res.ok) throw new Error('File dati non trovato');
        return res.json();
      })
      .then((data) => {
        setStations(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Errore nel caricamento dati:', err);
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

  // 3. Calcolo metriche e filtri
  const minOverallPrice = useMemo(() => {
    if (!stations.length) return 0;
    return Math.min(...stations.map((s) => s.prezzo_gasolio));
  }, [stations]);

  // Conteggio degli impianti "dormienti" (> 7 giorni), calcolato sul dataset completo
  const staleCount = useMemo(
    () => stations.filter((s) => (getDaysAgo(s.data_aggiornamento) ?? 0) > STALE_THRESHOLD_DAYS).length,
    [stations],
  );

  const filteredStations = useMemo(() => {
    return stations.filter((s) => {
      const matchProv =
        selectedProvince === 'ALL' || s.provincia === selectedProvince;
      const matchSearch =
        s.comune.toLowerCase().includes(searchTerm.toLowerCase()) ||
        s.gestore.toLowerCase().includes(searchTerm.toLowerCase()) ||
        s.indirizzo.toLowerCase().includes(searchTerm.toLowerCase());
      const matchFresh =
        !excludeStale ||
        (getDaysAgo(s.data_aggiornamento) ?? 0) <= STALE_THRESHOLD_DAYS;
      return matchProv && matchSearch && matchFresh;
    });
  }, [stations, selectedProvince, searchTerm, excludeStale]);

  // Helper per classe colore del prezzo
  // (useCallback: la funzione è usata dentro l'useEffect dei marker)
  const getPriceTier = useCallback(
    (price) => {
      const diff = price - minOverallPrice;
      if (diff <= 0.05) return 'cheap';
      if (diff <= 0.15) return 'mid';
      return 'expensive';
    },
    [minOverallPrice],
  );

  // 4. Aggiornamento Marker sulla mappa
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
      const freshness = getFreshness(s.data_aggiornamento);

      // Marker badge personalizzato con il prezzo in evidenza
      const icon = L.divIcon({
        className: 'custom-leaflet-marker',
        html: `<div class="custom-price-marker marker-${tier}">€ ${s.prezzo_gasolio.toFixed(3)}</div>`,
        iconSize: [60, 24],
        iconAnchor: [30, 12],
      });

      const marker = L.marker([s.lat, s.lon], { icon }).addTo(map);

      marker.bindPopup(`
        <div style="font-family: inherit; font-size: 13px; color: #0f172a; line-height: 1.4;">
          <strong>${s.gestore}</strong><br/>
          <span>${s.indirizzo}, ${s.comune} (${s.provincia})</span><br/>
          <div style="margin-top: 6px; font-size: 15px; font-weight: 800; color: #0284c7;">
            € ${s.prezzo_gasolio.toFixed(3)} <span style="font-size: 11px; color: #64748b;">(Self)</span>
          </div>
          <div style="font-size: 10px; color: #64748b; margin-top: 4px;">
            Rilevato: ${s.data_aggiornamento}
          </div>
          <div style="margin-top: 6px;">
            <span class="${POPUP_FRESHNESS_CLASS[freshness.level]}">
              ${freshness.level === 'fresh' ? '&#10003;' : freshness.level === 'stale' ? '&#9888;' : '&#8226;'} ${freshness.label}
            </span>
          </div>
        </div>
      `);

      marker.on('click', () => {
        setSelectedStation(s);
      });

      markersRef.current[s.id] = marker;
      bounds.extend([s.lat, s.lon]);
    });

    // Adatta lo zoom per mostrare tutti i risultati filtrati
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    }
  }, [filteredStations, getPriceTier]);

  // Centra la mappa su un distributore selezionato dalla lista
  const handleSelectStation = (station) => {
    setSelectedStation(station);
    const map = mapRef.current;
    if (map) {
      map.flyTo([station.lat, station.lon], 15, { duration: 1.2 });
      const marker = markersRef.current[station.id];
      if (marker) marker.openPopup();
    }
  };

  const avgPrice = useMemo(() => {
    if (!filteredStations.length) return 0;
    const sum = filteredStations.reduce((acc, s) => acc + s.prezzo_gasolio, 0);
    return (sum / filteredStations.length).toFixed(3);
  }, [filteredStations]);

  return (
    <div className="dashboard-container">
      {/* PANNELLO SINISTRO: LISTA & CONTROLLI */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="app-title">
            <Fuel size={24} />
            <span>Gasolio Radar</span>
          </div>
          <p className="app-subtitle">MIMIT Open Data • Focus ME & AL</p>

          <div className="stats-bar">
            <div className="stat-card">
              <div className="stat-label">Minimo</div>
              <div className="stat-value green">€ {minOverallPrice.toFixed(3)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Medio Zona</div>
              <div className="stat-value">€ {avgPrice}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Impianti</div>
              <div className="stat-value">{filteredStations.length}</div>
            </div>
          </div>
        </div>

        <div className="controls-container">
          <div className="search-box">
            <Search size={16} className="search-icon" />
            <input
              type="text"
              className="search-input"
              placeholder="Cerca comune, brand, via..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          <div className="tab-group">
            <button
              className={`tab-btn ${selectedProvince === 'ALL' ? 'active' : ''}`}
              onClick={() => setSelectedProvince('ALL')}
            >
              Tutte
            </button>
            <button
              className={`tab-btn ${selectedProvince === 'ME' ? 'active' : ''}`}
              onClick={() => setSelectedProvince('ME')}
            >
              Messina (ME)
            </button>
            <button
              className={`tab-btn ${selectedProvince === 'AL' ? 'active' : ''}`}
              onClick={() => setSelectedProvince('AL')}
            >
              Alessandria (AL)
            </button>
          </div>

          {/* Filtro freschezza: attivo di default, nasconde i dati dormienti */}
          <label className="freshness-toggle">
            <input
              type="checkbox"
              className="freshness-toggle-input"
              checked={excludeStale}
              onChange={(e) => setExcludeStale(e.target.checked)}
            />
            <span className="toggle-track" aria-hidden="true">
              <span className="toggle-thumb" />
            </span>
            <span className="toggle-label">
              Escludi dati non recenti (&gt; 7 giorni)
              {staleCount > 0 && (
                <span className="toggle-count">({staleCount} esclusi)</span>
              )}
            </span>
          </label>
        </div>

        {/* LISTA RISULTATI */}
        <div className="station-list">
          {loading ? (
            <p style={{ padding: 20, color: '#94a3b8' }}>Caricamento dati in corso...</p>
          ) : filteredStations.length === 0 ? (
            <p style={{ padding: 20, color: '#94a3b8' }}>Nessun distributore trovato con questi filtri.</p>
          ) : (
            filteredStations.map((s, index) => {
              const tier = getPriceTier(s.prezzo_gasolio);
              const freshness = getFreshness(s.data_aggiornamento);
              const isSelected = selectedStation?.id === s.id;

              return (
                <div
                  key={s.id}
                  className={`station-card ${isSelected ? 'selected' : ''}`}
                  onClick={() => handleSelectStation(s)}
                >
                  <div className="card-top">
                    <span className="brand-badge">{s.gestore}</span>
                    <span className={`price-tag ${tier}`}>
                      € {s.prezzo_gasolio.toFixed(3)}
                    </span>
                  </div>

                  <div className="card-body">
                    <strong>{s.nome || s.gestore}</strong>
                    <div className="station-location">
                      <MapPin size={12} />
                      <span>{s.indirizzo}, {s.comune} ({s.provincia})</span>
                    </div>
                  </div>

                  <div className="card-footer">
                    <span>#{index + 1} più economico</span>
                    <span
                      className={`freshness-badge badge-${freshness.level}`}
                      title={`Comunicazione del ${s.data_aggiornamento}`}
                    >
                      {freshness.level === 'stale' && <AlertTriangle size={11} />}
                      {freshness.level === 'fresh' && <Calendar size={11} />}
                      {freshness.label}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* PANNELLO DESTRO: MAPPA */}
      <div className="map-panel">
        <div id="map-container"></div>
      </div>
    </div>
  );
}