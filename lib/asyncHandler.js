// Express 4 doesn't catch rejected promises from async route handlers on its
// own — wrap every async handler with this so errors reach the error middleware
// instead of hanging the request or crashing the function.
module.exports = function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
};
