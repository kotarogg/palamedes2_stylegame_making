export type MovementMode = 'buttons' | 'flick';
export const MOBILE_PREFERENCES_KEY = 'kotaro_mobile_controls_v1';
export interface PreferenceStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export function readMovementMode(storage: PreferenceStorage): MovementMode {
  try { return storage.getItem(MOBILE_PREFERENCES_KEY) === 'flick' ? 'flick' : 'buttons'; }
  catch { return 'buttons'; }
}
export function writeMovementMode(storage: PreferenceStorage, mode: MovementMode): boolean {
  try { storage.setItem(MOBILE_PREFERENCES_KEY, mode); return true; }
  catch { return false; }
}
