/**
 * DB-aware layer on top of lib/weather.js: resolves and caches a course's
 * lat/lon (one-time geocode), and caches its weather per day so a page never
 * has to hit Open-Meteo more than once for the same course/date. Historical
 * rows are permanent; forecast rows are treated as stale after 12 hours
 * since the forecast itself changes as the date approaches, and eventually
 * gets replaced by real historical data once the date has passed.
 */
const db = require('../db');
const weather = require('./weather');

const FORECAST_STALE_MS = 12 * 60 * 60 * 1000;

async function ensureCoordinates(course) {
  if (course.latitude != null && course.longitude != null) {
    return { latitude: course.latitude, longitude: course.longitude };
  }

  // Try progressively broader candidates, most specific first. Never join
  // multiple fields into one query (e.g. "city, county") — Open-Meteo's
  // geocoder matches a single real place name, and a combined/qualified
  // string reliably fails to match even when the plain name alone would.
  const nameFirstSegment = course.name.split(/\s*[-–—]\s*/)[0].trim();
  const candidates = [course.city, course.county, nameFirstSegment, course.name].filter(Boolean);

  for (const candidate of candidates) {
    const coords = await weather.geocode(candidate, { countryCode: 'GB' });
    if (coords) {
      await db.query('UPDATE courses SET latitude = $1, longitude = $2 WHERE id = $3', [
        coords.latitude,
        coords.longitude,
        course.id,
      ]);
      return coords;
    }
  }
  return null;
}

function rowToResult(row) {
  return {
    tempMaxC: row.temp_max_c,
    tempMinC: row.temp_min_c,
    precipitationMm: row.precipitation_mm,
    windSpeedMaxKph: row.wind_speed_max_kph,
    label: row.weather_label,
    emoji: row.weather_emoji,
    isForecast: row.is_forecast,
  };
}

// Returns the same shape as weather.getWeatherForDate, or null if the
// course's location couldn't be resolved or no weather data is available
// for that date yet (too far in the future, or too recent for the archive).
async function getWeatherForCourse(course, date) {
  const coords = await ensureCoordinates(course);
  if (!coords) return null;

  const dateStr = weather.toISODate(date);
  const { rows } = await db.query('SELECT * FROM course_weather WHERE course_id = $1 AND weather_date = $2', [
    course.id,
    dateStr,
  ]);
  const cached = rows[0];
  const cacheIsFresh = cached && (!cached.is_forecast || Date.now() - new Date(cached.fetched_at).getTime() < FORECAST_STALE_MS);
  if (cacheIsFresh) return rowToResult(cached);

  const fresh = await weather.getWeatherForDate(coords.latitude, coords.longitude, dateStr);
  if (!fresh) return cached ? rowToResult(cached) : null; // fall back to a stale cache rather than nothing

  await db.query(
    `INSERT INTO course_weather (course_id, weather_date, temp_max_c, temp_min_c, precipitation_mm, wind_speed_max_kph, weather_label, weather_emoji, is_forecast, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (course_id, weather_date) DO UPDATE SET
       temp_max_c = EXCLUDED.temp_max_c, temp_min_c = EXCLUDED.temp_min_c,
       precipitation_mm = EXCLUDED.precipitation_mm, wind_speed_max_kph = EXCLUDED.wind_speed_max_kph,
       weather_label = EXCLUDED.weather_label, weather_emoji = EXCLUDED.weather_emoji,
       is_forecast = EXCLUDED.is_forecast, fetched_at = NOW()`,
    [course.id, dateStr, fresh.tempMaxC, fresh.tempMinC, fresh.precipitationMm, fresh.windSpeedMaxKph, fresh.label, fresh.emoji, fresh.isForecast]
  );
  return fresh;
}

module.exports = { getWeatherForCourse };
