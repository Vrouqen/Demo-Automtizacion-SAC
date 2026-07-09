export function normalizar(texto) {
  if (texto === null || texto === undefined) return '';
  return String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita tildes (marcas diacríticas tras NFD)
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
