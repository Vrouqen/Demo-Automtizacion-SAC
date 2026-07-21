import { MongoClient } from 'mongodb';
import { config } from '../config.js';

// En Lambda, este módulo persiste en memoria entre invocaciones "calientes"
// del mismo contenedor — cachear la conexión evita reconectar en cada llamada.
let clientPromise = null;

function crearClient() {
  return new MongoClient(config.mongo.uri, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 8000,
  }).connect();
}

async function obtenerClient() {
  if (!clientPromise) clientPromise = crearClient();
  try {
    return await clientPromise;
  } catch (err) {
    clientPromise = null; // si falló la conexión, reintenta en la próxima invocación
    throw err;
  }
}

export async function coleccionColegios() {
  const client = await obtenerClient();
  return client.db(config.mongo.db).collection(config.mongo.coleccionColegios);
}

export async function coleccionConversaciones() {
  const client = await obtenerClient();
  return client.db(config.mongo.db).collection(config.mongo.coleccionConversaciones);
}

export async function coleccionEscalamientos() {
  const client = await obtenerClient();
  return client.db(config.mongo.db).collection(config.mongo.coleccionEscalamientos);
}

/**
 * Correos descartados por el filtro de basura. No son conversaciones (no se
 * responden ni se atienden), pero sí son una métrica del piloto: cuánto ruido
 * absorbe el sistema y con qué señal lo detectó — que es lo que permite afinar
 * el filtro sin adivinar.
 */
export async function coleccionDescartes() {
  const client = await obtenerClient();
  return client.db(config.mongo.db).collection(config.mongo.coleccionDescartes);
}
