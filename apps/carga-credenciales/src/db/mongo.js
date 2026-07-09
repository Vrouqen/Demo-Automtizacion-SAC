import { MongoClient } from 'mongodb';
import { config } from '../config.js';

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
    clientPromise = null;
    throw err;
  }
}

export async function coleccionColegios() {
  const client = await obtenerClient();
  return client.db(config.mongo.db).collection(config.mongo.coleccion);
}
