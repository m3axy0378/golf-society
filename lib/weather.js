/**
 * Thin wrapper around Open-Meteo — free and keyless (unlike the RapidAPI golf
 * course integration), so weather works with zero configuration. Geocoding
 * resolves a place name to a lat/lon; forecast/archive give the day's
 * conditions for a lat/lon. Every function here is self-resilient (network
 * error, bad response, no data for that date) and resolves to null rather
 * than throwing, since weather is a nice-to-have that should never be able
 * to break a page that also needs to show real competition data.
 */

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const DAILY_FIELDS = 'weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max';

// WMO weather codes -> a short label + emoji (per Open-Meteo's docs).
const WEATHER_CODES = {
  0: ['Clear sky', '☀️'],
  1: ['Mainly clear', '🌤️'],
  2: ['Partly cloudy', '⛅'],
  3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'],
  48: ['Fog', '🌫️'],
  51: ['Light drizzle', '🌦️'],
  53: ['Drizzle', '🌦️'],
  55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'],
  57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'],
  63: ['Rain', '🌧️'],
  65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'],
  67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'],
  73: ['Snow', '🌨️'],
  75: ['Heavy snow', '❄️'],
  77: ['Snow grains', '🌨️'],
  80: ['Light showers', '🌦️'],
  81: ['Showers', '🌧️'],
  82: ['Heavy showers', '⛈️'],
  85: ['Snow showers', '🌨️'],
  86: ['Heavy snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'],
  96: ['Thunderstorm, hail', '⛈️'],
  99: ['Thunderstorm, hail', '⛈️'],
};

function describeCode(code) {
  const entry = WEATHER_CODES[code];
  return entry ? { label: entry[0], emoji: entry[1] } : { label: 'Unknown', emoji: '🌡️' };
}

function toISODate(date) {
  return new Date(date).toISOString().slice(0, 10);
}

// Resolves a free-text place name to a lat/lon, or null if nothing matched.
async function geocode(query) {
  try {
    const url = new URL(GEOCODE_URL);
    url.searchParams.set('name', query);
    url.searchParams.set('count', '1');
    url.searchParams.set('language', 'en');
    url.searchParams.set('format', 'json');
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const hit = data.results && data.results[0];
    return hit ? { latitude: hit.latitude, longitude: hit.longitude } : null;
  } catch {
    return null;
  }
}

// Day's weather for a lat/lon — uses the forecast API for a future date
// (only ever available ~16 days out) and the historical archive API for
// today or the past (the most recent few days may not be published yet).
// Returns null if the API has no data for that date either way.
async function getWeatherForDate(latitude, longitude, date) {
  try {
    const dateStr = toISODate(date);
    const isFuture = dateStr > toISODate(new Date());

    const url = new URL(isFuture ? FORECAST_URL : ARCHIVE_URL);
    url.searchParams.set('latitude', latitude);
    url.searchParams.set('longitude', longitude);
    url.searchParams.set('start_date', dateStr);
    url.searchParams.set('end_date', dateStr);
    url.searchParams.set('daily', DAILY_FIELDS);
    url.searchParams.set('timezone', 'Europe/London');

    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const daily = data.daily;
    if (!daily || !daily.time || daily.time.length === 0 || daily.weathercode[0] == null) return null;

    const { label, emoji } = describeCode(daily.weathercode[0]);
    return {
      tempMaxC: daily.temperature_2m_max[0],
      tempMinC: daily.temperature_2m_min[0],
      precipitationMm: daily.precipitation_sum[0],
      windSpeedMaxKph: daily.windspeed_10m_max[0],
      label,
      emoji,
      isForecast: isFuture,
    };
  } catch {
    return null;
  }
}

module.exports = { geocode, getWeatherForDate, toISODate };
