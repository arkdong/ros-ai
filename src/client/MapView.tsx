import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, LoaderCircle, Route, Search, X } from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { MapPin, MapView } from '../shared/types';
import { MAX_MAP_PINS, MAX_ROUTE_STOPS, googleMapsLink, googleRouteLink, pointInLink } from '../shared/maps';
import { api } from './api';
import { stop } from './live-block';
import './live-block.css';
import './map-block.css';

type FoundPlace = { name: string; address: string; lat: number; lng: number };

const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>';
/** Where an empty map looks: the whole world, quietly. */
const WORLD: L.LatLngTuple = [30, 0];

const escape = (text: string) => text.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const marker = (index: number, active: boolean) => L.divIcon({ className: `map-pin${active ? ' active' : ''}`, html: `<span>${index + 1}</span>`, iconSize: [24, 24], iconAnchor: [12, 12], tooltipAnchor: [0, -12] });

/** A Map block: numbered pins on an OpenStreetMap map, each opening in Google Maps. On a card the map is still, so the
 * card drags as any other; the block view moves and zooms, looks places up and takes pins away when `onPins` is given. */
export function MapBlock({ view, full = false, onPins }: { view: MapView; full?: boolean; onPins?: (pins: MapPin[]) => Promise<unknown> | void }) {
  const box = useRef<HTMLDivElement>(null), map = useRef<L.Map | null>(null), layer = useRef<L.LayerGroup | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const pins = view.pins, key = JSON.stringify(pins.map(pin => [pin.id, pin.lat, pin.lng, pin.name]));

  useEffect(() => {
    if (!box.current) return;
    const made = L.map(box.current, { zoomControl: full, attributionControl: true, dragging: full, scrollWheelZoom: full, doubleClickZoom: full, touchZoom: full, boxZoom: full, keyboard: full, worldCopyJump: true });
    made.attributionControl.setPrefix(false);
    L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION, referrerPolicy: 'strict-origin-when-cross-origin' }).addTo(made);
    made.setView(WORLD, 1);
    map.current = made; layer.current = L.layerGroup().addTo(made);
    const resized = new ResizeObserver(() => made.invalidateSize());
    resized.observe(box.current);
    return () => { resized.disconnect(); made.remove(); map.current = null; layer.current = null; };
  }, [full]);

  // Pins, and the view that holds them all.
  useEffect(() => {
    const shown = map.current, group = layer.current;
    if (!shown || !group) return;
    group.clearLayers();
    pins.forEach((pin, index) => {
      const dot = L.marker([pin.lat, pin.lng], { icon: marker(index, pin.id === active), keyboard: false, riseOnHover: true, zIndexOffset: pin.id === active ? 1000 : 0 });
      dot.bindTooltip(escape(pin.name), { direction: 'top', className: 'map-pin-tip' });
      if (full) dot.on('click', () => setActive(pin.id));
      group.addLayer(dot);
    });
    if (pins.length === 1) shown.setView([pins[0].lat, pins[0].lng], 15);
    else if (pins.length) shown.fitBounds(L.latLngBounds(pins.map(pin => [pin.lat, pin.lng] as L.LatLngTuple)), { padding: [28, 28], maxZoom: 16 });
    else shown.setView(WORLD, 1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, full]);

  // The chosen pin stands out, and the map moves to it.
  useEffect(() => {
    const group = layer.current;
    if (!group) return;
    group.getLayers().forEach((item, index) => { if (item instanceof L.Marker) { const chosen = pins[index]?.id === active; item.setIcon(marker(index, chosen)); item.setZIndexOffset(chosen ? 1000 : 0); } });
    const pin = pins.find(item => item.id === active);
    if (pin && map.current) map.current.panTo([pin.lat, pin.lng]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const route = googleRouteLink(pins);
  return <div className={`map-block${full ? ' full' : ''}`}>
    <div className={`map-block-map${full ? ' nodrag nowheel' : ''}`} ref={box} aria-label={`Map with ${pins.length} place${pins.length === 1 ? '' : 's'}`}/>
    {!pins.length && !full && <p className="map-block-empty">No places yet. Ask ROS to pin some, or open the block to add them.</p>}
    {full && onPins && <AddPlace pins={pins} onAdd={pin => { setActive(pin.id); return onPins([...pins, pin]); }}/>}
    {full && pins.length > 0 && <ol className="map-block-pins">{pins.map((pin, index) => <li key={pin.id} className={pin.id === active ? 'active' : undefined}>
      <button type="button" className="map-block-pin" onClick={() => setActive(pin.id)}><span className="map-block-number">{index + 1}</span><span className="map-block-name"><b>{pin.name}</b>{pin.place && pin.place !== pin.name && <small>{pin.place}</small>}{pin.note && <span>{pin.note}</span>}</span></button>
      <span className="map-block-links">
        {pin.url && <a href={pin.url} target="_blank" rel="noreferrer">Website</a>}
        <a href={googleMapsLink(pin)} target="_blank" rel="noreferrer">Google Maps <ArrowUpRight size={11}/></a>
        {onPins && <button type="button" className="icon-button" aria-label={`Take ${pin.name} off the map`} title="Take off the map" onClick={() => { if (active === pin.id) setActive(null); void onPins(pins.filter(item => item.id !== pin.id)); }}><X size={13}/></button>}
      </span>
    </li>)}</ol>}
    <footer>
      <span>{pins.length ? `${pins.length} place${pins.length === 1 ? '' : 's'}` : full ? 'No places yet' : 'Map'}</span>
      {route ? <a className="live-block-open" href={route} target="_blank" rel="noreferrer" onClick={stop} title="All places in order as a route in Google Maps"><Route size={12}/> Route in Google Maps</a>
        : pins.length === 1 ? <a className="live-block-open" href={googleMapsLink(pins[0])} target="_blank" rel="noreferrer" onClick={stop}>Open in Google Maps <ArrowUpRight size={12}/></a>
        : pins.length > MAX_ROUTE_STOPS && full ? <span title={`Google Maps routes take at most ${MAX_ROUTE_STOPS} stops`}>Open each place in Google Maps</span> : null}
    </footer>
  </div>;
}

/** Looks a place up on OpenStreetMap, or takes a pasted Google Maps link or "lat, lng", and adds the one chosen. */
function AddPlace({ pins, onAdd }: { pins: MapPin[]; onAdd: (pin: MapPin) => Promise<unknown> | void }) {
  const [query, setQuery] = useState(''), [found, setFound] = useState<FoundPlace[] | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const full = pins.length >= MAX_MAP_PINS;
  const add = async (place: FoundPlace) => {
    setBusy(true);
    try { await onAdd({ id: crypto.randomUUID(), name: place.name.slice(0, 200), lat: place.lat, lng: place.lng, ...(place.address ? { place: place.address.slice(0, 300) } : {}) }); setQuery(''); setFound(null); }
    finally { setBusy(false); }
  };
  const search = async (event: FormEvent) => {
    event.preventDefault();
    const text = query.trim();
    if (!text || busy) return;
    setError('');
    const point = pointInLink(text);
    if (point) { await add({ name: /^https?:/iu.test(text) ? 'Pinned place' : `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`, address: '', ...point }); return; }
    setBusy(true);
    try { const { places } = await api<{ places: FoundPlace[] }>(`/api/places?q=${encodeURIComponent(text)}`); setFound(places); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <div className="map-block-add">
    <form onSubmit={search}>
      <Search size={14} aria-hidden="true"/>
      <input value={query} disabled={full} maxLength={300} placeholder={full ? `A map holds ${MAX_MAP_PINS} places` : 'Add a place: a name, an address or a Google Maps link'} aria-label="Add a place" onChange={event => { setQuery(event.target.value); setFound(null); }}/>
      {busy && <LoaderCircle size={14} className="spin"/>}
    </form>
    {error && <p className="live-block-error">{error}</p>}
    {found && (found.length ? <ul className="map-block-found">{found.map((place, index) => <li key={index}><button type="button" disabled={busy} onClick={() => void add(place)}><b>{place.name}</b><small>{place.address}</small></button></li>)}</ul>
      : <p className="live-block-empty">OpenStreetMap knows no place by that name. Try the street and town.</p>)}
  </div>;
}
