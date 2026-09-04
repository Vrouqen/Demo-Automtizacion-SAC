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

/**
 * Credenciales ADCOL: un acceso administrativo POR COLEGIO.
 *
 * Va en su propia colección y no dentro del documento del colegio por dos
 * razones. La primera es que no es lo mismo: el padrón guarda una credencial
 * por persona, y esta es una del plantel entero. La segunda es más terca —
 * buena parte de los colegios con credencial ADCOL no están en el padrón,
 * porque el padrón solo tiene aquellos a los que se les cargó un Excel de
 * alumnos. Si esto viviera dentro del colegio, esos no tendrían dónde existir.
 *
 * El _id es el id de Pegasus, el mismo que usa la colección de colegios, así
 * que enlazar ambas es inmediato cuando el colegio sí está.
 */
export async function coleccionAdcol() {
  const client = await obtenerClient();
  return client.db(config.mongo.db).collection(config.mongo.coleccionAdcol);
}
