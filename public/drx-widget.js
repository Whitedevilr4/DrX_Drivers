/**
 * DrX Consult — Ambulance Tracking Widget
 * =========================================
 * Drop this script on any DrX Consult page to get live ambulance tracking.
 *
 * USAGE — Hospital Admin Page:
 *   <script src="https://your-ambulance-server.com/drx-widget.js"></script>
 *   <div id="drx-ambulance-tracker"></div>
 *   <script>
 *     DrxAmbulance.initHospital({
 *       hospitalId: 'HOSP-001',
 *       containerId: 'drx-ambulance-tracker'
 *     });
 *   </script>
 *
 * USAGE — Patient Tracking Page:
 *   <script src="https://your-ambulance-server.com/drx-widget.js"></script>
 *   <div id="drx-ambulance-tracker"></div>
 *   <script>
 *     DrxAmbulance.initPatient({
 *       bookingId: 'BOOKING-123',
 *       containerId: 'drx-ambulance-tracker'
 *     });
 *   </script>
 *
 * USAGE — Send dispatch request from hospital admin:
 *   DrxAmbulance.dispatch({
 *     requestId: 'REQ-001',
 *     patientName: 'John Doe',
 *     patientPhone: '+968 9000 0000',
 *     patientAge: 45,
 *     condition: 'Chest Pain',
 *     priority: 'critical',
 *     pickupAddress: 'Al Khuwair, Muscat',
 *     pickupLat: 23.5957,
 *     pickupLng: 58.3927,
 *     hospitalName: 'Royal Hospital',
 *     hospitalId: 'HOSP-001',
 *     bookingId: 'BOOKING-123',
 *     notes: 'Patient is conscious'
 *   });
 */

(function (global) {
  'use strict';

  const SERVER_URL = (typeof window !== 'undefined' && window.DRX_AMBULANCE_SERVER)
    || 'http://localhost:3000';

  let _socket = null;
  let _map = null;
  let _ambulanceMarker = null;
  let _mode = null; // 'hospital' | 'patient'
  let _config = {};

  // ── Load dependencies ────────────────────────────────────────────────────

  function loadScript(src, cb) {
    if (document.querySelector(`script[src="${src}"]`)) { cb && cb(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = cb;
    document.head.appendChild(s);
  }

  function loadCSS(href) {
    if (document.querySelector(`link[href="${href}"]`)) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href;
    document.head.appendChild(l);
  }

  function loadDeps(cb) {
    loadCSS('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css');
    loadScript(`${SERVER_URL}/socket.io/socket.io.js`, () => {
      loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', cb);
    });
  }

  // ── Widget HTML ──────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('drx-widget-styles')) return;
    const style = document.createElement('style');
    style.id = 'drx-widget-styles';
    style.textContent = `
      .drx-widget { font-family: 'Segoe UI', sans-serif; background: #0d1117; border-radius: 12px; overflow: hidden; border: 1px solid #30363d; color: #e6edf3; }
      .drx-widget-header { background: #161b22; padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #30363d; }
      .drx-widget-header h3 { font-size: 15px; font-weight: 700; color: #e63946; margin: 0; }
      .drx-widget-header .badge { font-size: 11px; padding: 3px 10px; border-radius: 20px; font-weight: 600; }
      .drx-badge-waiting { background: rgba(210,153,34,0.2); color: #d29922; border: 1px solid rgba(210,153,34,0.4); }
      .drx-badge-active { background: rgba(63,185,80,0.2); color: #3fb950; border: 1px solid rgba(63,185,80,0.4); animation: drx-pulse 1.5s infinite; }
      .drx-badge-delivered { background: rgba(88,166,255,0.2); color: #58a6ff; border: 1px solid rgba(88,166,255,0.4); }
      @keyframes drx-pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
      .drx-widget-body { padding: 16px 18px; }
      .drx-map { height: 260px; border-radius: 8px; margin-bottom: 14px; border: 1px solid #30363d; }
      .drx-info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
      .drx-info-item .drx-label { font-size: 10px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 3px; }
      .drx-info-item .drx-value { font-size: 13px; color: #e6edf3; font-weight: 500; }
      .drx-status-bar { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 10px 14px; font-size: 12px; color: #8b949e; display: flex; align-items: center; gap: 8px; }
      .drx-status-bar .drx-dot { width: 7px; height: 7px; border-radius: 50%; background: #3fb950; animation: drx-pulse 1s infinite; flex-shrink: 0; }
      .drx-waiting-msg { text-align: center; padding: 40px 20px; color: #8b949e; }
      .drx-waiting-msg .drx-icon { font-size: 40px; margin-bottom: 10px; }
      .drx-waiting-msg p { font-size: 13px; }
      .drx-jobs-list { margin-top: 12px; }
      .drx-job-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 14px; margin-bottom: 8px; cursor: pointer; transition: border-color 0.2s; }
      .drx-job-card:hover { border-color: #e63946; }
      .drx-job-card.drx-selected { border-color: #3fb950; }
      .drx-job-card .drx-job-name { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
      .drx-job-card .drx-job-meta { font-size: 12px; color: #8b949e; }
      .drx-dispatch-btn { width: 100%; background: #e63946; color: #fff; border: none; border-radius: 8px; padding: 11px; font-size: 14px; font-weight: 700; cursor: pointer; margin-top: 12px; transition: opacity 0.2s; }
      .drx-dispatch-btn:hover { opacity: 0.85; }
      .drx-dispatch-btn:disabled { background: #30363d; color: #8b949e; cursor: not-allowed; }
    `;
    document.head.appendChild(style);
  }

  // ── Socket connection ────────────────────────────────────────────────────

  function connectSocket(onReady) {
    if (_socket && _socket.connected) { onReady && onReady(); return; }
    _socket = io(SERVER_URL);
    _socket.on('connect', () => { onReady && onReady(); });
  }

  // ── Map helpers ──────────────────────────────────────────────────────────

  function initMap(containerId, lat, lng) {
    const center = (lat && lng) ? [lat, lng] : [23.5880, 58.3829];
    _map = L.map(containerId).setView(center, 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(_map);
    return _map;
  }

  function updateAmbulanceOnMap(lat, lng) {
    if (!_map) return;
    const pos = [lat, lng];
    if (!_ambulanceMarker) {
      _ambulanceMarker = L.marker(pos, {
        icon: L.divIcon({ html: '🚑', className: '', iconSize: [32, 32] })
      }).addTo(_map).bindPopup('Ambulance Location');
    } else {
      _ambulanceMarker.setLatLng(pos);
    }
    _map.panTo(pos);
  }

  // ── Hospital Mode ────────────────────────────────────────────────────────

  function initHospital(config) {
    _mode = 'hospital';
    _config = config;
    const container = document.getElementById(config.containerId);
    if (!container) { console.error('DrxAmbulance: container not found'); return; }

    injectStyles();
    container.innerHTML = `
      <div class="drx-widget">
        <div class="drx-widget-header">
          <h3>🚑 Ambulance Dispatch — DrX Consult</h3>
          <span class="badge drx-badge-waiting" id="drx-hosp-badge">Waiting for Driver</span>
        </div>
        <div class="drx-widget-body">
          <div id="drx-hosp-waiting" class="drx-waiting-msg">
            <div class="drx-icon">📡</div>
            <p>Dispatch request sent.<br/>Waiting for ambulance driver to accept…</p>
          </div>
          <div id="drx-hosp-active" style="display:none;">
            <div id="drx-hosp-map" class="drx-map"></div>
            <div class="drx-info-grid">
              <div class="drx-info-item"><div class="drx-label">Driver</div><div class="drx-value" id="drx-h-driver">—</div></div>
              <div class="drx-info-item"><div class="drx-label">Vehicle</div><div class="drx-value" id="drx-h-vehicle">—</div></div>
              <div class="drx-info-item"><div class="drx-label">Driver Phone</div><div class="drx-value" id="drx-h-phone">—</div></div>
              <div class="drx-info-item"><div class="drx-label">Last Update</div><div class="drx-value" id="drx-h-time">—</div></div>
            </div>
            <div class="drx-status-bar">
              <div class="drx-dot"></div>
              <span id="drx-h-status">En route to patient</span>
            </div>
          </div>
        </div>
      </div>`;

    loadDeps(() => {
      connectSocket(() => {
        _socket.emit('hospital_connect', { hospitalId: config.hospitalId });

        _socket.on('driver_accepted', (data) => {
          document.getElementById('drx-hosp-waiting').style.display = 'none';
          document.getElementById('drx-hosp-active').style.display = 'block';
          document.getElementById('drx-hosp-badge').className = 'badge drx-badge-active';
          document.getElementById('drx-hosp-badge').textContent = 'Driver En Route';
          document.getElementById('drx-h-driver').textContent = data.driver?.driverName || '—';
          document.getElementById('drx-h-vehicle').textContent = data.driver?.vehicleNumber || '—';
          document.getElementById('drx-h-phone').textContent = data.driver?.phone || '—';
          setTimeout(() => {
            initMap('drx-hosp-map', null, null);
          }, 100);
        });

        _socket.on('ambulance_location', (data) => {
          updateAmbulanceOnMap(data.location.lat, data.location.lng);
          document.getElementById('drx-h-time').textContent = new Date(data.location.timestamp).toLocaleTimeString();
        });

        _socket.on('job_status_update', (data) => {
          const labels = {
            en_route_to_patient: '🚗 Driver en route to patient',
            arrived_at_patient: '📍 Driver arrived at patient',
            transporting_to_hospital: '🏥 Transporting patient to hospital',
            delivered: '✅ Patient delivered'
          };
          const el = document.getElementById('drx-h-status');
          if (el) el.textContent = labels[data.status] || data.status;
          if (data.status === 'delivered') {
            document.getElementById('drx-hosp-badge').className = 'badge drx-badge-delivered';
            document.getElementById('drx-hosp-badge').textContent = 'Delivered ✅';
          }
        });
      });
    });
  }

  // ── Patient Mode ─────────────────────────────────────────────────────────

  function initPatient(config) {
    _mode = 'patient';
    _config = config;
    const container = document.getElementById(config.containerId);
    if (!container) { console.error('DrxAmbulance: container not found'); return; }

    injectStyles();
    container.innerHTML = `
      <div class="drx-widget">
        <div class="drx-widget-header">
          <h3>🚑 Your Ambulance</h3>
          <span class="badge drx-badge-waiting" id="drx-pat-badge">Waiting</span>
        </div>
        <div class="drx-widget-body">
          <div id="drx-pat-waiting" class="drx-waiting-msg">
            <div class="drx-icon">🚑</div>
            <p>Your ambulance request has been sent.<br/>A driver will be assigned shortly.</p>
          </div>
          <div id="drx-pat-active" style="display:none;">
            <div id="drx-pat-map" class="drx-map"></div>
            <div class="drx-info-grid">
              <div class="drx-info-item"><div class="drx-label">Driver</div><div class="drx-value" id="drx-p-driver">—</div></div>
              <div class="drx-info-item"><div class="drx-label">Vehicle</div><div class="drx-value" id="drx-p-vehicle">—</div></div>
            </div>
            <div class="drx-status-bar">
              <div class="drx-dot"></div>
              <span id="drx-p-status">Driver is on the way</span>
            </div>
          </div>
        </div>
      </div>`;

    loadDeps(() => {
      connectSocket(() => {
        _socket.emit('patient_connect', { bookingId: config.bookingId });

        _socket.on('driver_accepted', (data) => {
          document.getElementById('drx-pat-waiting').style.display = 'none';
          document.getElementById('drx-pat-active').style.display = 'block';
          document.getElementById('drx-pat-badge').className = 'badge drx-badge-active';
          document.getElementById('drx-pat-badge').textContent = 'On the Way 🚑';
          document.getElementById('drx-p-driver').textContent = data.driver?.driverName || '—';
          document.getElementById('drx-p-vehicle').textContent = data.driver?.vehicleNumber || '—';
          setTimeout(() => { initMap('drx-pat-map', null, null); }, 100);
        });

        _socket.on('ambulance_location', (data) => {
          updateAmbulanceOnMap(data.location.lat, data.location.lng);
        });

        _socket.on('job_status_update', (data) => {
          const labels = {
            en_route_to_patient: '🚗 Driver is on the way to you',
            arrived_at_patient: '📍 Driver has arrived',
            transporting_to_hospital: '🏥 You are being transported',
            delivered: '✅ Arrived at hospital'
          };
          const el = document.getElementById('drx-p-status');
          if (el) el.textContent = labels[data.status] || data.status;
          if (data.status === 'delivered') {
            document.getElementById('drx-pat-badge').className = 'badge drx-badge-delivered';
            document.getElementById('drx-pat-badge').textContent = 'Arrived ✅';
          }
        });
      });
    });
  }

  // ── Dispatch API ─────────────────────────────────────────────────────────

  function dispatch(data) {
    return fetch(`${SERVER_URL}/api/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(r => r.json());
  }

  // ── Public API ────────────────────────────────────────────────────────────

  global.DrxAmbulance = { initHospital, initPatient, dispatch };

})(window);
