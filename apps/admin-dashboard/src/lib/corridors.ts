/** Map framing per corridor: where to open, and the bbox the Federation
 *  cross-state view queries (minLat,minLng,maxLat,maxLng). */
export const CORRIDOR_VIEW: Record<string, { center: { lat: number; lng: number }; zoom: number; bbox: string }> = {
  'ncr-airshed': { center: { lat: 28.61, lng: 77.21 }, zoom: 9, bbox: '27.0,75.5,30.5,79.0' },
  'mumbai-pune-corridor': { center: { lat: 18.8, lng: 73.4 }, zoom: 9, bbox: '17.8,72.6,19.8,74.8' },
};

export const DEFAULT_CORRIDORS = [
  { id: 'ncr-airshed', name: 'Delhi-NCR Airshed' },
  { id: 'mumbai-pune-corridor', name: 'Mumbai–Pune Industrial Corridor' },
];

export function corridorView(id: string) {
  return CORRIDOR_VIEW[id] ?? CORRIDOR_VIEW['ncr-airshed']!;
}
