require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Redis } = require('@upstash/redis');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Redis Client (Upstash REST) ---
let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
} else {
  console.warn('⚠️  Variables UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN no configuradas. Redis no estará disponible hasta configurarlas.');
}

function getRedisClient() {
  if (!redis) {
    throw new Error('Base de datos no configurada. Revisa UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN.');
  }
  return redis;
}

// Helpers de claves Redis
const KEY_SALA = (codigo) => `sala:${codigo.toUpperCase()}`;
const KEY_CAPITAN = (pin) => `capitan:${pin.toUpperCase()}`;

function generarCodigo(len = 6) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len).toUpperCase();
}

// =============================================
//  CAPTAIN API
// =============================================

// Registrar capitán — devuelve un PIN de 6 caracteres
app.post('/api/capitanes', async (req, res) => {
  try {
    const db = getRedisClient();
    const { nombre } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ error: 'El nombre es obligatorio' });
    }

    let pin;
    let exists = true;
    while (exists) {
      pin = generarCodigo(6);
      exists = await db.exists(KEY_CAPITAN(pin));
    }

    const capitanData = {
      nombre: nombre.trim(),
      pin,
      salas: [], // Array de room codes
      creadoEn: Date.now()
    };

    await db.set(KEY_CAPITAN(pin), capitanData);
    res.json({ pin, nombre: nombre.trim() });
  } catch (err) {
    console.error('Error registrando capitán:', err);
    res.status(500).json({ error: err.message || 'Error interno del servidor' });
  }
});

// Login capitán — devuelve perfil + sus salas con detalles
app.get('/api/capitanes/:pin', async (req, res) => {
  try {
    const db = getRedisClient();
    const pin = req.params.pin.toUpperCase();
    const cap = await db.get(KEY_CAPITAN(pin));

    if (!cap) {
      return res.status(404).json({ error: 'PIN no encontrado' });
    }

    // Obtener detalles de cada sala asociada
    const codigos = Array.isArray(cap.salas) ? cap.salas : [];
    let salasDetalle = [];

    if (codigos.length > 0) {
      const keys = codigos.map(KEY_SALA);
      // MGET para traer todas las salas en una sola llamada de red
      const rawSalas = await db.mget(...keys);

      salasDetalle = rawSalas
        .filter(Boolean)
        .map(s => ({
          codigo: s.codigo,
          nombre: s.nombre,
          claveAdmin: s.claveAdmin,
          jugadores: (s.jugadores || []).length,
          creadoEn: s.creadoEn
        }));
    }

    res.json({
      nombre: cap.nombre,
      pin: cap.pin,
      salas: salasDetalle
    });
  } catch (err) {
    console.error('Error consultando capitán:', err);
    res.status(500).json({ error: err.message || 'Error interno del servidor' });
  }
});

// =============================================
//  ROOM API
// =============================================

// Crear sala (vinculada opcionalmente al capitán por pin)
app.post('/api/salas', async (req, res) => {
  try {
    const db = getRedisClient();
    const { nombre, pin } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ error: 'El nombre del equipo es obligatorio' });
    }

    let codigo;
    let exists = true;
    while (exists) {
      codigo = generarCodigo(6);
      exists = await db.exists(KEY_SALA(codigo));
    }

    const claveAdmin = generarCodigo(16);

    const salaData = {
      nombre: nombre.trim(),
      codigo,
      claveAdmin,
      jugadores: [],
      capitanPin: pin ? pin.toUpperCase() : null,
      creadoEn: Date.now()
    };

    await db.set(KEY_SALA(codigo), salaData);

    // Si viene asociado a un capitán, actualizar su lista de salas
    if (pin) {
      const capKey = KEY_CAPITAN(pin);
      const cap = await db.get(capKey);
      if (cap) {
        if (!Array.isArray(cap.salas)) cap.salas = [];
        cap.salas.push(codigo);
        await db.set(capKey, cap);
      }
    }

    res.json({ codigo, claveAdmin, nombre: nombre.trim() });
  } catch (err) {
    console.error('Error creando sala:', err);
    res.status(500).json({ error: err.message || 'Error interno del servidor' });
  }
});

// Info pública de la sala (para el jugador al ingresar)
app.get('/api/salas/:codigo', async (req, res) => {
  try {
    const db = getRedisClient();
    const sala = await db.get(KEY_SALA(req.params.codigo));
    if (!sala) return res.status(404).json({ error: 'Sala no encontrada' });

    res.json({
      nombre: sala.nombre,
      codigo: sala.codigo,
      totalJugadores: (sala.jugadores || []).length
    });
  } catch (err) {
    console.error('Error obteniendo sala:', err);
    res.status(500).json({ error: err.message || 'Error interno del servidor' });
  }
});

// Enviar disponibilidad (jugador)
app.post('/api/salas/:codigo/disponibilidad', async (req, res) => {
  try {
    const db = getRedisClient();
    const salaKey = KEY_SALA(req.params.codigo);
    const sala = await db.get(salaKey);
    if (!sala) return res.status(404).json({ error: 'Sala no encontrada' });

    const { nombre, slots } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ error: 'El nombre es obligatorio' });
    }
    if (!Array.isArray(slots)) {
      return res.status(400).json({ error: 'Los slots deben ser un array' });
    }

    if (!Array.isArray(sala.jugadores)) {
      sala.jugadores = [];
    }

    const idx = sala.jugadores.findIndex(j => j.nombre.toLowerCase() === nombre.trim().toLowerCase());
    const jugador = { nombre: nombre.trim(), slots, enviadoEn: Date.now() };

    if (idx !== -1) {
      sala.jugadores[idx] = jugador;
    } else {
      sala.jugadores.push(jugador);
    }

    await db.set(salaKey, sala);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error guardando disponibilidad:', err);
    res.status(500).json({ error: err.message || 'Error interno del servidor' });
  }
});

// Panel del capitán (requiere clave admin)
app.get('/api/salas/:codigo/panel', async (req, res) => {
  try {
    const db = getRedisClient();
    const sala = await db.get(KEY_SALA(req.params.codigo));
    if (!sala) return res.status(404).json({ error: 'Sala no encontrada' });

    if (req.query.clave !== sala.claveAdmin) {
      return res.status(403).json({ error: 'Clave de administrador incorrecta' });
    }

    res.json({
      nombre: sala.nombre,
      codigo: sala.codigo,
      jugadores: (sala.jugadores || []).map(j => ({
        nombre: j.nombre,
        slots: j.slots,
        enviadoEn: j.enviadoEn
      }))
    });
  } catch (err) {
    console.error('Error obteniendo panel:', err);
    res.status(500).json({ error: err.message || 'Error interno del servidor' });
  }
});

// Eliminar jugador de la sala (capitán)
app.delete('/api/salas/:codigo/jugadores/:nombre', async (req, res) => {
  try {
    const db = getRedisClient();
    const salaKey = KEY_SALA(req.params.codigo);
    const sala = await db.get(salaKey);
    if (!sala) return res.status(404).json({ error: 'Sala no encontrada' });

    if (req.query.clave !== sala.claveAdmin) {
      return res.status(403).json({ error: 'Clave de administrador incorrecta' });
    }

    const nombreBuscar = decodeURIComponent(req.params.nombre).toLowerCase();
    sala.jugadores = (sala.jugadores || []).filter(j => j.nombre.toLowerCase() !== nombreBuscar);

    await db.set(salaKey, sala);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error eliminando jugador:', err);
    res.status(500).json({ error: err.message || 'Error interno del servidor' });
  }
});

// Eliminar sala (capitán)
app.delete('/api/salas/:codigo', async (req, res) => {
  try {
    const db = getRedisClient();
    const salaKey = KEY_SALA(req.params.codigo);
    const sala = await db.get(salaKey);
    if (!sala) return res.status(404).json({ error: 'Sala no encontrada' });

    if (req.query.clave !== sala.claveAdmin) {
      return res.status(403).json({ error: 'Clave de administrador incorrecta' });
    }

    // Si tiene capitán asociado, desvincularla de su perfil
    if (sala.capitanPin) {
      const capKey = KEY_CAPITAN(sala.capitanPin);
      const cap = await db.get(capKey);
      if (cap && Array.isArray(cap.salas)) {
        cap.salas = cap.salas.filter(c => c !== sala.codigo);
        await db.set(capKey, cap);
      }
    }

    // Eliminar la clave de la sala
    await db.del(salaKey);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error eliminando sala:', err);
    res.status(500).json({ error: err.message || 'Error interno del servidor' });
  }
});

// SPA fallback para rutas no estáticas y no API
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !path.extname(req.path)) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'No encontrado' });
  }
});

// Condicional para ejecución local vs serverless (Vercel)
if (process.env.VERCEL !== '1' && require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  ⚡ Servidor activo en http://localhost:${PORT}\n`);
  });
}

module.exports = app;
