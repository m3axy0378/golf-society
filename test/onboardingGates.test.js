// Unit tests for lib/onboardingGates.js. Pure middleware-logic tests — no
// HTTP, no DB — with a focus on the composed-chain regression: a real
// production bug where a brand-new self-signup (unconfirmed handicap AND
// zero societies at the same time) redirect-looped forever between
// /welcome/handicap and /societies, because each gate's redirect target
// wasn't exempt from the other gate.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handicapConfirmationGate, societyMembershipGate } = require('../lib/onboardingGates');

// Runs one gate once against a fake request/response, returning where it
// redirected to (or null if it called next() instead).
function runGate(gate, path, locals) {
  const req = { path };
  let redirectedTo = null;
  let calledNext = false;
  const res = { locals, redirect: (to) => { redirectedTo = to; } };
  gate(req, res, () => { calledNext = true; });
  return { redirectedTo, calledNext };
}

test('handicapConfirmationGate redirects an unconfirmed player anywhere except /welcome/handicap and /logout', () => {
  const locals = { currentPlayer: { handicap_confirmed_by_player: false }, mySocieties: [] };
  assert.equal(runGate(handicapConfirmationGate, '/dashboard', locals).redirectedTo, '/welcome/handicap');
  assert.equal(runGate(handicapConfirmationGate, '/welcome/handicap', locals).calledNext, true);
  assert.equal(runGate(handicapConfirmationGate, '/logout', locals).calledNext, true);
});

test('handicapConfirmationGate is a no-op once confirmed, or for a logged-out visitor', () => {
  assert.equal(
    runGate(handicapConfirmationGate, '/dashboard', { currentPlayer: { handicap_confirmed_by_player: true }, mySocieties: [] })
      .calledNext,
    true
  );
  assert.equal(runGate(handicapConfirmationGate, '/dashboard', { currentPlayer: null, mySocieties: [] }).calledNext, true);
});

test('societyMembershipGate redirects a zero-society player anywhere except its exempt paths', () => {
  const locals = { currentPlayer: { handicap_confirmed_by_player: true }, mySocieties: [] };
  assert.equal(runGate(societyMembershipGate, '/dashboard', locals).redirectedTo, '/societies');
  assert.equal(runGate(societyMembershipGate, '/societies', locals).calledNext, true);
  assert.equal(runGate(societyMembershipGate, '/welcome/handicap', locals).calledNext, true);
  assert.equal(runGate(societyMembershipGate, '/logout', locals).calledNext, true);
  assert.equal(runGate(societyMembershipGate, '/join/some-code', locals).calledNext, true);
});

test('societyMembershipGate is a no-op once the player has at least one society', () => {
  const locals = { currentPlayer: { handicap_confirmed_by_player: true }, mySocieties: [{ society_id: 1 }] };
  assert.equal(runGate(societyMembershipGate, '/dashboard', locals).calledNext, true);
});

test('REGRESSION: an unconfirmed, zero-society player reaches a stable page instead of looping between the two gates', () => {
  const locals = { currentPlayer: { handicap_confirmed_by_player: false }, mySocieties: [] };
  const visited = [];
  let path = '/dashboard'; // where a fresh signup's first request lands

  for (let hop = 0; hop < 6; hop++) {
    visited.push(path);

    const first = runGate(handicapConfirmationGate, path, locals);
    let redirectedTo = first.redirectedTo;
    if (redirectedTo === null) {
      const second = runGate(societyMembershipGate, path, locals);
      redirectedTo = second.redirectedTo;
    }

    if (redirectedTo === null) return; // both gates passed — stable page reached, test passes
    assert.ok(!visited.includes(redirectedTo), `redirect loop detected: ${visited.concat(redirectedTo).join(' -> ')}`);
    path = redirectedTo;
  }

  assert.fail(`gates never stabilized within 6 hops: ${visited.join(' -> ')}`);
});
