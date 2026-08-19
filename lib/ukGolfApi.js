/**
 * Thin wrapper around the "UK Golf Course Data API" (RapidAPI), used to let
 * admins search real club/course data instead of typing every hole in by
 * hand. Requires RAPIDAPI_KEY to be set — callers should be ready for this
 * to throw (missing key, network error, rate limit) and fall back gracefully.
 */
const BASE_URL = 'https://uk-golf-course-data-api.p.rapidapi.com';

async function apiGet(path, params = {}) {
  if (!process.env.RAPIDAPI_KEY) {
    throw new Error('RAPIDAPI_KEY is not set');
  }
  const url = new URL(BASE_URL + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  const res = await fetch(url, {
    headers: {
      'x-rapidapi-key': process.env.RAPIDAPI_KEY,
      'x-rapidapi-host': 'uk-golf-course-data-api.p.rapidapi.com',
    },
  });
  if (!res.ok) {
    throw new Error(`UK Golf Course API request failed: ${res.status}`);
  }
  return res.json();
}

// Full-text search across UK golf clubs by name.
async function searchClubs(query) {
  const data = await apiGet('/clubs', { search: query, per_page: 15 });
  return data.clubs || [];
}

// Courses (and their tee sets, with course/slope rating) belonging to a club.
async function getClubCourses(clubId) {
  return apiGet(`/clubs/${clubId}/courses`);
}

// Hole-by-hole par + stroke index for a course. Note: this API always
// returns one fixed tee's card per course (a tee_set_id filter was tested
// and confirmed to be ignored) — so the tee_set embedded in the response is
// whichever one the API considers canonical, not a choice we get to make.
// We use its course/slope rating from that same response, never a rating
// looked up for a different tee, so the numbers always describe one tee.
async function getScorecard(courseId) {
  return apiGet(`/courses/${courseId}/scorecard`);
}

module.exports = { searchClubs, getClubCourses, getScorecard };
