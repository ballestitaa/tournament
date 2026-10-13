const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Persistent JSON store ---
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Load existing data or start fresh
let db = { salas: {}, capitanes: {} };
try {
  if (fs.existsSync(DATA_FILE)) {
    db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) };
    console.log(`  📂 Cargados ${Object.keys(db.capitanes).length} capitán(es) y ${Object.keys(db.salas).length} sala(s)`);
  }
  // Migrate from old format (salas.json) if db.json doesn't exist
  const OLD_FILE = path.join(DATA_DIR, 'salas.json');
  if (!fs.existsSync(DATA_FILE) && fs.existsSync(OLD_FILE)) {
    const oldSalas = JSON.parse(fs.readFileSync(OLD_FILE, 'utf-8'));
    db.salas = oldSalas;
    console.log(`  🔄 Migradas ${Object.keys(oldSalas).length} sala(s) desde formato anterior`);
  }
} catch (err) {
  console.error('  ⚠️  Error leyendo datos, empezando de cero:', err.message);
}

const salas = new Map(Object.entries(db.salas));
const capitanes = new Map(Object.entries(db.capitanes));

// Save to disk (atomic: write tmp then rename)
let saveTimer = null;
function guardarDatos() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = {
      salas: Object.fromEntries(salas),
      capitanes: Object.fromEntries(capitanes)
    };
    const tmp = DATA_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmp, DATA_FILE);
    } catch (err) {
      console.error('  ⚠️  Error guardando datos:', err.message);
    }
  }, 200);
}

function generarCodigo(len = 6) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len).toUpperCase();
}

// =============================================
//  CAPTAIN API
// =============================================

// Registrar capitán — devuelve un PIN de 6 caracteres
app.post('/api/capitanes', (req, res) => {
  const { nombre } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: 'El nombre es obligatorio' });
  }

  let pin;
  do { pin = generarCodigo(6); } while (capitanes.has(pin));

  capitanes.set(pin, {
    nombre: nombre.trim(),
    pin,
    salas: [],        // array of room codes
    creadoEn: Date.now()
  });

  guardarDatos();
  res.json({ pin, nombre: nombre.trim() });
});

// Login capitán — devuelve perfil + sus salas con detalles
app.get('/api/capitanes/:pin', (req, res) => {
  const cap = capitanes.get(req.params.pin.toUpperCase());
  if (!cap) return res.status(404).json({ error: 'PIN no encontrado' });

  // Build room list with live info
  const salasDetalle = cap.salas
    .map(codigo => salas.get(codigo))
    .filter(Boolean)
    .map(s => ({
      codigo: s.codigo,
      nombre: s.nombre,
      claveAdmin: s.claveAdmin,
      jugadores: s.jugadores.length,
      creadoEn: s.creadoEn
    }));

  res.json({
    nombre: cap.nombre,
    pin: cap.pin,
    salas: salasDetalle
  });
});

// =============================================
//  ROOM API
// =============================================

// Crear sala (optionally linked to a captain via pin)
app.post('/api/salas', (req, res) => {
  const { nombre, pin } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: 'El nombre del equipo es obligatorio' });
  }

  let codigo;
  do { codigo = generarCodigo(6); } while (salas.has(codigo));

  const claveAdmin = generarCodigo(16);

  salas.set(codigo, {
    nombre: nombre.trim(),
    codigo,
    claveAdmin,
    jugadores: [],
    capitanPin: pin || null,
    creadoEn: Date.now()
  });

  // Link to captain if pin provided
  if (pin) {
    const cap = capitanes.get(pin.toUpperCase());
    if (cap) {
      cap.salas.push(codigo);
    }
  }

  guardarDatos();
  res.json({ codigo, claveAdmin, nombre: nombre.trim() });
});

// Info pública de la sala
app.get('/api/salas/:codigo', (req, res) => {
  const sala = salas.get(req.params.codigo.toUpperCase());
  if (!sala) return res.status(404).json({ error: 'Sala no encontrada' });

  res.json({
    nombre: sala.nombre,
    codigo: sala.codigo,
    totalJugadores: sala.jugadores.length
  });
});

// Enviar disponibilidad (jugador)
app.post('/api/salas/:codigo/disponibilidad', (req, res) => {
  const sala = salas.get(req.params.codigo.toUpperCase());
  if (!sala) return res.status(404).json({ error: 'Sala no encontrada' });

  const { nombre, slots } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: 'El nombre es obligatorio' });
  }
  if (!Array.isArray(slots)) {
    return res.status(400).json({ error: 'Los slots deben ser un array' });
  }

  const idx = sala.jugadores.findIndex(j => j.nombre.toLowerCase() === nombre.trim().toLowerCase());
  const jugador = { nombre: nombre.trim(), slots, enviadoEn: Date.now() };

  if (idx !== -1) {
    sala.jugadores[idx] = jugador;
  } else {
    sala.jugadores.push(jugador);
  }

  guardarDatos();
  res.json({ ok: true });
});

// Panel del capitán (requiere clave admin)
app.get('/api/salas/:codigo/panel', (req, res) => {
  const sala = salas.get(req.params.codigo.toUpperCase());
  if (!sala) return res.status(404).json({ error: 'Sala no encontrada' });

  if (req.query.clave !== sala.claveAdmin) {
    return res.status(403).json({ error: 'Clave de administrador incorrecta' });
  }

  res.json({
    nombre: sala.nombre,
    codigo: sala.codigo,
    jugadores: sala.jugadores.map(j => ({
      nombre: j.nombre,
      slots: j.slots,
      enviadoEn: j.enviadoEn
    }))
  });
});

// Eliminar jugador (capitán)
app.delete('/api/salas/:codigo/jugadores/:nombre', (req, res) => {
  const sala = salas.get(req.params.codigo.toUpperCase());
  if (!sala) return res.status(404).json({ error: 'Sala no encontrada' });

  if (req.query.clave !== sala.claveAdmin) {
    return res.status(403).json({ error: 'Clave de administrador incorrecta' });
  }

  const nombreBuscar = decodeURIComponent(req.params.nombre).toLowerCase();
  sala.jugadores = sala.jugadores.filter(j => j.nombre.toLowerCase() !== nombreBuscar);

  guardarDatos();
  res.json({ ok: true });
});

// Eliminar sala (capitán)
app.delete('/api/salas/:codigo', (req, res) => {
  const sala = salas.get(req.params.codigo.toUpperCase());
  if (!sala) return res.status(404).json({ error: 'Sala no encontrada' });

  if (req.query.clave !== sala.claveAdmin) {
    return res.status(403).json({ error: 'Clave de administrador incorrecta' });
  }

  // Remove from captain's list
  if (sala.capitanPin) {
    const cap = capitanes.get(sala.capitanPin);
    if (cap) {
      cap.salas = cap.salas.filter(c => c !== sala.codigo);
    }
  }

  salas.delete(sala.codigo);
  guardarDatos();
  res.json({ ok: true });
});

// SPA fallback
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !path.extname(req.path)) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'No encontrado' });
  }
});

app.listen(PORT, () => {
  console.log(`\n  ⚡ Servidor activo en http://localhost:${PORT}\n`);
});
