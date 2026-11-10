import type { MapPin } from './types.js';

/** At most this many pins on one Map block. */
export const MAX_MAP_PINS = 200;
/** Google Maps takes at most this many stops in one route link (origin, waypoints and destination). */
export const MAX_ROUTE_STOPS = 10;

/** Google's keyless map embed for a place, or the whole world without one. ros.ai's page shows it through the App
 * server (AppFrames.mapEmbed), so its own frame rules name no site on the web. */
export function googleEmbedLink(place: { lat: number; lng: number; name: string } | null): string {
  if (!place) return 'https://www.google.com/maps?q=&z=2&output=embed';
  return `https://www.google.com/maps?${new URLSearchParams({ q: `${place.lat.toFixed(6)},${place.lng.toFixed(6)} (${place.name})`, z: '16', output: 'embed' })}`;
}

/** A pin's own link, when it is a web page. Any other address (file:, javascript:, a scheme an app on this computer
 * answers) could start something there with one click, so a pin never offers one. */
export const pinLink = (url: string | undefined): string | undefined => url !== undefined && /^https?:\/\/[^\s/]/iu.test(url.trim()) ? url.trim() : undefined;

const at = (pin: Pick<MapPin, 'lat' | 'lng'>) => `${pin.lat.toFixed(6)},${pin.lng.toFixed(6)}`;

/** The pin in Google Maps, through its public link, which needs no key. With a name it searches the name near the
 * point, so Google shows the place's card; without one, the point itself. */
export function googleMapsLink(pin: Pick<MapPin, 'lat' | 'lng' | 'name' | 'place'>): string {
  const query = pin.place?.trim() || pin.name.trim();
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query ? `${query} ${at(pin)}` : at(pin))}`;
}

/** All pins in order as one Google Maps route, when there are two to ten of them. */
export function googleRouteLink(pins: Pick<MapPin, 'lat' | 'lng'>[]): string | undefined {
  if (pins.length < 2 || pins.length > MAX_ROUTE_STOPS) return undefined;
  const middle = pins.slice(1, -1).map(at).join('|');
  return `https://www.google.com/maps/dir/?api=1&origin=${at(pins[0])}&destination=${at(pins[pins.length - 1])}${middle ? `&waypoints=${encodeURIComponent(middle)}` : ''}`;
}


/** A Google Maps link's point, when it carries one (…/@52.37,4.89,15z or ?q=52.37,4.89), so a pasted link becomes a pin. */
export function pointInLink(text: string): { lat: number; lng: number } | undefined {
  const found = /@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/u.exec(text) ?? /[?&](?:q|query|ll|destination)=(-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)/u.exec(text)
    ?? /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/u.exec(text);
  if (!found) return undefined;
  const lat = Number(found[1]), lng = Number(found[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : undefined;
}
