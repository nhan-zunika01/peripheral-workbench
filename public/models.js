import { models } from './assets/models/catalog.js';
const normalize = name => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
export function resolveModel(device) {
  return models.find(model => model.aliases.some(name => normalize(name) === normalize(device?.name || device?.model))) || null;
}
