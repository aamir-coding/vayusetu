import { latLngToCell as h3LatLngToCell, gridDisk } from 'h3-js';
import { H3_RESOLUTIONS, type H3Resolution } from './constants';

export * from './constants';

export function latLngToCell(
  lat: number,
  lng: number,
  resolution: number = H3_RESOLUTIONS.OPERATIONAL
): string {
  if (lat < -90 || lat > 90) {
    throw new RangeError(`Latitude must be between -90 and 90. Received: ${lat}`);
  }
  if (lng < -180 || lng > 180) {
    throw new RangeError(`Longitude must be between -180 and 180. Received: ${lng}`);
  }
  return h3LatLngToCell(lat, lng, resolution);
}

export function kRing(h3Index: string, k: number = 1): string[] {
  if (k < 0) {
    throw new RangeError(`k must be a non-negative integer. Received: ${k}`);
  }
  return gridDisk(h3Index, k);
}