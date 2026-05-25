const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// ─── CORS: allow DrX Consult frontend + driver app itself ────────────────────
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:4000'];

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true
  },
  // Tune for low-latency location streaming
  pingTimeout: 20000,
  pingInterval: 10000,
  transports: ['websocket', 'polling']
});

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory store ──────────────────────────────────────────────────────────

// Active dispatch requests sent from DrX Consult hospital admin
// key: requestId (= dispatchId from DrX backend)
const dispatchRequests = {};

// Active jobs (accepted by driver)
// key: requestId
const activeJobs = {};

// ─── Internal secret — read lazily so dotenv values are always current ────────
const verifySecret = (req, res, next) => {
  const expected = process.env.INTERNAL_SECRET || 'drx-internal-secret';
  const received  = req.headers['x-internal-secret'];
  if (received !== expected) {
    console.warn(`[Auth] ❌ Invalid secret. Expected="${expected}" Got="${received}"`);
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
};

// ─── REST API ─────────────────────────────────────────────────────────────────

/**
 * POST /api/dispatch
 * Called by DrX Consult backend when hospital admin dispatches an ambulance.
 * Protected by x-internal-secret header.
 */
app.post('/api/dispatch', verifySecret, (req, res) => {
  const {
    requestId,      // = dispatchId from DrX backend (e.g. "DISP-L8X9K2")
    patientName,
    patientPhone,
    patientAge,
    condition,
    priority,       // 'icu_ambulance' | 'advanced' | 'basic'
    pickupAddress,
    pickupLat,
    pickupLng,
    hospitalName,
    hospitalId,
    bookingId,      // MongoDB _id of the HospitalBooking
    notes
  } = req.body;

  if (!requestId || !patientName || !hospitalId || !bookingId) {
    return res.status(400).json({ success: false, message: 'requestId, patientName, hospitalId, bookingId are required' });
  }

  // Overwrite if re-dispatched
  const request = {
    requestId,
    patientName,
    patientPhone: patientPhone || 'N/A',
    patientAge: patientAge || 'N/A',
    condition: condition || 'Emergency',
    priority: priority || 'basic',
    pickupAddress: pickupAddress || 'See coordinates',
    pickupLat: pickupLat || null,
    pickupLng: pickupLng || null,
    hospitalName: hospitalName || 'Hospital',
    hospitalId,
    bookingId,
    notes: notes || '',
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  dispatchRequests[requestId] = request;

  // Instantly notify all online drivers
  io.to('drivers').emit('new_dispatch', request);

  console.log(`[Dispatch] ✅ ${hospitalName} → ${patientName} (${priority}) | bookingId: ${bookingId}`);
  res.json({ success: true, requestId, driversOnline: io.sockets.adapter.rooms.get('drivers')?.size || 0 });
});

/**
 * GET /api/dispatch/pending
 * Driver fetches all pending requests on page load / reconnect.
 */
app.get('/api/dispatch/pending', (req, res) => {
  const pending = Object.values(dispatchRequests).filter(r => r.status === 'pending');
  res.json({ success: true, requests: pending });
});

/**
 * GET /api/jobs/:requestId
 * DrX Consult can poll this to get last known location (fallback for reconnect).
 */
app.get('/api/jobs/:requestId', (req, res) => {
  const job = activeJobs[req.params.requestId];
  if (!job) return res.status(404).json({ success: false, message: 'No active job' });
  res.json({ success: true, job });
});

/**
 * GET /api/health
 * Health check.
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    driversOnline: io.sockets.adapter.rooms.get('drivers')?.size || 0,
    activeJobs: Object.keys(activeJobs).length,
    pendingRequests: Object.values(dispatchRequests).filter(r => r.status === 'pending').length
  });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // ── Ambulance driver goes online ──────────────────────────────────────────
  socket.on('driver_connect', ({ driverId, driverName, vehicleNumber, phone }) => {
    socket.join('drivers');
    socket.driverInfo = { driverId, driverName, vehicleNumber, phone };
    console.log(`[Driver] 🟢 Online: ${driverName} | ${vehicleNumber}`);

    // Send all currently pending requests immediately so driver sees them on load
    const pending = Object.values(dispatchRequests).filter(r => r.status === 'pending');
    socket.emit('pending_requests', pending);
  });

  // ── Driver accepts a dispatch request ─────────────────────────────────────
  socket.on('accept_request', ({ requestId }) => {
    const request = dispatchRequests[requestId];
    if (!request || request.status !== 'pending') {
      socket.emit('accept_error', { message: 'Request no longer available — another driver may have taken it.' });
      return;
    }

    request.status = 'accepted';
    request.acceptedAt = new Date().toISOString();
    request.driver = socket.driverInfo;

    activeJobs[requestId] = {
      requestId,
      request,
      driver: socket.driverInfo,
      currentLocation: null,
      locationHistory: [],
      status: 'en_route_to_patient',
      acceptedAt: new Date().toISOString()
    };

    socket.currentJobId = requestId;

    // ① Confirm to the accepting driver
    socket.emit('request_accepted', { requestId, request });

    // ② Tell other drivers this job is taken (remove from their list)
    socket.to('drivers').emit('request_taken', { requestId });

    // ③ Notify DrX Consult patient room — patient sees "driver accepted"
    io.to(`patient-${request.bookingId}`).emit('driver_accepted', {
      requestId,
      bookingId: request.bookingId,
      driver: socket.driverInfo,
      status: 'en_route_to_patient'
    });

    // ④ Notify DrX Consult hospital admin room
    io.to(`hospital-${request.hospitalId}`).emit('driver_accepted', {
      requestId,
      bookingId: request.bookingId,
      driver: socket.driverInfo,
      status: 'en_route_to_patient'
    });

    console.log(`[Accept] ✅ ${socket.driverInfo?.driverName} accepted ${requestId} for booking ${request.bookingId}`);
  });

  // ── Driver streams GPS location (every 3 seconds for fast updates) ─────────
  socket.on('location_update', ({ requestId, lat, lng, heading, speed }) => {
    const job = activeJobs[requestId];
    if (!job) return;

    const locationData = {
      lat,
      lng,
      heading: heading || 0,
      speed: speed || 0,
      timestamp: Date.now() // numeric ms for minimal payload
    };

    // Keep last known location (for reconnect fallback via REST)
    job.currentLocation = locationData;

    // Keep a rolling 100-point breadcrumb trail
    job.locationHistory.push(locationData);
    if (job.locationHistory.length > 100) job.locationHistory.shift();

    const payload = {
      requestId,
      bookingId: job.request.bookingId,
      location: locationData,
      driver: job.driver,
      jobStatus: job.status
    };

    // ── Broadcast to DrX Consult patient (primary consumer) ──
    io.to(`patient-${job.request.bookingId}`).emit('ambulance_location', payload);

    // ── Broadcast to DrX Consult hospital admin ──
    io.to(`hospital-${job.request.hospitalId}`).emit('ambulance_location', payload);
  });

  // ── Driver updates job status ─────────────────────────────────────────────
  socket.on('update_job_status', ({ requestId, status }) => {
    const job = activeJobs[requestId];
    if (!job) return;

    job.status = status;
    dispatchRequests[requestId].status = status;

    const payload = {
      requestId,
      bookingId: job.request.bookingId,
      status,
      timestamp: new Date().toISOString()
    };

    io.to(`patient-${job.request.bookingId}`).emit('job_status_update', payload);
    io.to(`hospital-${job.request.hospitalId}`).emit('job_status_update', payload);

    // Clean up completed jobs after a delay
    if (status === 'delivered') {
      setTimeout(() => {
        delete activeJobs[requestId];
        delete dispatchRequests[requestId];
        console.log(`[Cleanup] Job ${requestId} removed after delivery`);
      }, 30 * 60 * 1000); // 30 min
    }

    console.log(`[Status] Job ${requestId} → ${status}`);
  });

  // ── DrX Consult patient joins to receive live location ────────────────────
  // Called from DrX Consult patient dashboard when they open the tracker
  socket.on('patient_connect', ({ bookingId }) => {
    socket.join(`patient-${bookingId}`);
    console.log(`[Patient] 👤 Joined room patient-${bookingId}`);

    // If there's already an active job for this booking, send last known location immediately
    const job = Object.values(activeJobs).find(j => j.request.bookingId === bookingId);
    if (job?.currentLocation) {
      socket.emit('ambulance_location', {
        requestId: job.requestId,
        bookingId,
        location: job.currentLocation,
        driver: job.driver,
        jobStatus: job.status
      });
    }
    if (job) {
      socket.emit('driver_accepted', {
        requestId: job.requestId,
        bookingId,
        driver: job.driver,
        status: job.status
      });
    }
  });

  socket.on('patient_disconnect', ({ bookingId }) => {
    socket.leave(`patient-${bookingId}`);
  });

  // ── DrX Consult hospital admin joins to monitor ───────────────────────────
  socket.on('hospital_connect', ({ hospitalId }) => {
    socket.join(`hospital-${hospitalId}`);
    console.log(`[Hospital] 🏥 Admin joined room hospital-${hospitalId}`);
  });

  socket.on('disconnect', () => {
    if (socket.driverInfo) {
      console.log(`[Driver] 🔴 Offline: ${socket.driverInfo.driverName}`);
    }
    console.log(`[Socket] Disconnected: ${socket.id}`);
  });
});

// ─── Page routes ──────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'driver.html')));
app.get('/driver', (req, res) => res.sendFile(path.join(__dirname, 'public', 'driver.html')));

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚑  DrX Ambulance Driver Server`);
  console.log(`    Driver App  →  http://localhost:${PORT}/`);
  console.log(`    API Base    →  http://localhost:${PORT}/api`);
  console.log(`    Health      →  http://localhost:${PORT}/api/health`);
  console.log(`\n    DrX Consult integration:`);
  console.log(`    Dispatch    →  POST http://localhost:${PORT}/api/dispatch`);
  console.log(`    Secret hdr  →  x-internal-secret: ${process.env.INTERNAL_SECRET || 'drx-internal-secret'}`);
  console.log(`    Socket URL  →  http://localhost:${PORT}\n`);
});
