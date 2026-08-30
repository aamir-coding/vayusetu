import type { GeoPoint } from '@vayusetu/shared-types';

export type GeoResult =
  | { status: 'success'; geo: GeoPoint; accuracyMeters?: number }
  | { status: 'denied' }
  | { status: 'unavailable' };

/** Product Spec Feature 1: "device GPS, required, manual pin-drop fallback if denied." */
export function getCurrentGeo(): Promise<GeoResult> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve({ status: 'unavailable' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          status: 'success',
          geo: { lat: position.coords.latitude, lng: position.coords.longitude },
          accuracyMeters: position.coords.accuracy,
        });
      },
      (error) => {
        resolve({ status: error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable' });
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  });
}
