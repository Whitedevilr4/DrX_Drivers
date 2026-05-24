const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*', // Allow DrX Consult website to connect
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory store ──────────────────────────────────────────────────────────

// Active dispatch requests sent from DrX Consult hospital admin
const dispatchRequests = {};

// Active jobs (accepted by driver)
const activeJobs = {};

// ─── REST API ─────────────────────────────────────────────────────────────────

/**
 * POST /api/dispatch
 * Called by DrX Consult hospital admin to send a new ambulance request.
 * DrX Consult sends patient + booking details here.
 */
app.post('/api/dispatch', (req, res) => {
  const {
    requestId,
    patientName,
    patientPhone,
    patientAge,
    condition,
    priority,           // 'critical' | 'high' | 'medium'
    pickupAddress,
    pickupLat,
    pickupLng,
    hospitalName,
    hospitalId,
    bookingId,
    notes
  } = req.body;

  if (!requestId || !patientName || !hospitalId) {
    return res.status(400).json({ success: false, message: 'requestId, patientName, hospitalId are required' });
  }

  const request = {
    requestId,
    patientName,
    patientPhone: patientPhone || 'N/A',
    patientAge: patientAge || 'N/A',
    condition: condition || 'Emergency',
    priority: priority || 'high',
    pickupAddress: pickupAddress || 'See coordinates',
    pickupLat: pickupLat || null,
    pickupLng: pickupLng || null,
    hospitalName: hospitalName || 'Hospital',
    hospitalId,
    bookingId: bookingId || requestId,
    notes: notes || '',
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  dispatchRequests[requestId] = request;

  // Notify all connected ambulance drivers
  io.to('drivers').emit('new_dispatch', request);

  console.log(`[Dispatch] New request from ${hospitalName}: ${patientName} (${priority})`);
  res.json({ success: true, requestId });
});

/**
 * GET /api/dispatch/pending
 * Ambulance driver fetches all pending requests on page load.
 */
app.get('/api/dispatch/pending', (req, res) => {
  const pending = Object.values(dispatchRequests).filter(r => r.status === 'pending');
  res.json({ success: true, requests: pending });
});

/**
 * GET /api/dispatch/:requestId
 * Get a single dispatch request (used by DrX Consult to check status).
 */
app.get('/api/dispatch/:requestId', (req, res) => {
  const req2 = dispatchRequests[req.params.requestId];
  if (!req2) return res.status(404).json({ success: false, message: 'Not found' });
  res.json({ success: true, request: req2 });
});

/**
 * GET /api/jobs/:requestId
 * DrX Consult polls this to get live job info including last known location.
 */
app.get('/api/jobs/:requestId', (req, res) => {
  const job = activeJobs[req.params.requestId];
  if (!job) return res.status(404).json({ success: false, message: 'No active job for this request' });
  res.json({ success: true, job });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // ── Ambulance driver connects ──
  socket.on('driver_connect', ({ driverId, driverName, vehicleNumber, phone }) => {
    socket.join('drivers');
    socket.driverInfo = { driverId, driverName, vehicleNumber, phone };
    console.log(`[Driver] Online: ${driverName} | ${vehicleNumber}`);

    // Send all pending requests immediately
    const pending = Object.values(dispatchRequests).filter(r => r.status === 'pending');
    socket.emit('pending_requests', pending);
  });

  // ── Driver accepts a dispatch request ──
  socket.on('accept_request', ({ requestId }) => {
    const request = dispatchRequests[requestId];
    if (!request || request.status !== 'pending') {
      socket.emit('accept_error', { message: 'Request no longer available' });
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

    // Confirm to driver
    socket.emit('request_accepted', { requestId, request });

    // Notify DrX Consult hospital room
    io.to(`hospital-${request.hospitalId}`).emit('driver_accepted', {
      requestId,
      bookingId: request.bookingId,
      driver: socket.driverInfo,
      status: 'en_route_to_patient'
    });

    // Notify DrX Consult patient room
    io.to(`patient-${request.bookingId}`).emit('driver_accepted', {
      requestId,
      driver: socket.driverInfo,
      status: 'en_route_to_patient'
    });

    // Remove from pending for other drivers
    io.to('drivers').emit('request_taken', { requestId });

    console.log(`[Accept] ${socket.driverInfo?.driverName} accepted request ${requestId}`);
  });

  // ── Driver sends location update (every 5 seconds) ──
  socket.on('location_update', ({ requestId, lat, lng, heading, speed }) => {
    const job = activeJobs[requestId];
    if (!job) return;

    const locationData = {
      lat,
      lng,
      heading: heading || 0,
      speed: speed || 0,
      timestamp: new Date().toISOString()
    };

    job.currentLocation = locationData;
    job.locationHistory.push(locationData);
    if (job.locationHistory.length > 200) {
      job.locationHistory = job.locationHistory.slice(-200);
    }

    const payload = {
      requestId,
      bookingId: job.request.bookingId,
      hospitalId: job.request.hospitalId,
      location: locationData,
      driver: job.driver,
      jobStatus: job.status
    };

    // Push to DrX Consult hospital admin
    io.to(`hospital-${job.request.hospitalId}`).emit('ambulance_location', payload);

    // Push to DrX Consult patient
    io.to(`patient-${job.request.bookingId}`).emit('ambulance_location', payload);
  });

  // ── Driver updates job status ──
  socket.on('update_job_status', ({ requestId, status }) => {
    const job = activeJobs[requestId];
    if (!job) return;

    job.status = status;
    dispatchRequests[requestId].status = status;

    const payload = { requestId, bookingId: job.request.bookingId, status };

    io.to(`hospital-${job.request.hospitalId}`).emit('job_status_update', payload);
    io.to(`patient-${job.request.bookingId}`).emit('job_status_update', payload);

    console.log(`[Status] Job ${requestId} → ${status}`);
  });

  // ── DrX Consult hospital admin connects ──
  socket.on('hospital_connect', ({ hospitalId }) => {
    socket.join(`hospital-${hospitalId}`);
    console.log(`[Hospital] Admin connected for hospital: ${hospitalId}`);
  });

  // ── DrX Consult patient connects ──
  socket.on('patient_connect', ({ bookingId }) => {
    socket.join(`patient-${bookingId}`);
    console.log(`[Patient] Connected for booking: ${bookingId}`);
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
  });
});

// ─── Page routes ──────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'driver.html')));
app.get('/driver', (req, res) => res.sendFile(path.join(__dirname, 'public', 'driver.html')));

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚑  DrX Ambulance Driver Portal`);
  console.log(`    Driver App  →  http://localhost:${PORT}/`);
  console.log(`    API Base    →  http://localhost:${PORT}/api\n`);
  console.log(`    DrX Consult integration:`);
  console.log(`    Socket URL  →  http://localhost:${PORT}`);
  console.log(`    Dispatch    →  POST http://localhost:${PORT}/api/dispatch\n`);
});
