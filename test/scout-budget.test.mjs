/**
 * Proplync.mx · Scout budget helpers · unit tests
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  usdFromEnv,
  monthlyBudgetUsd,
  runMaxUsd,
  monthStartUtc,
  sumCosts,
  overRunLimit,
  DEFAULT_MONTHLY_BUDGET_USD,
  DEFAULT_RUN_MAX_USD
} from '../api/_lib/scout-budget.js';

test('usdFromEnv parses positive numbers', (t) => {
  assert.equal(usdFromEnv('50', 999), 50);
  assert.equal(usdFromEnv('2.5', 999), 2.5);
  assert.equal(usdFromEnv('0.01', 999), 0.01);
});

test('usdFromEnv returns fallback for invalid values', (t) => {
  assert.equal(usdFromEnv('', 100), 100);
  assert.equal(usdFromEnv('invalid', 100), 100);
  assert.equal(usdFromEnv('-5', 100), 100);
  assert.equal(usdFromEnv('0', 100), 100);
  assert.equal(usdFromEnv(null, 100), 100);
  assert.equal(usdFromEnv(undefined, 100), 100);
});

test('monthlyBudgetUsd uses env or default', (t) => {
  const envBackup = process.env.SCOUT_MONTHLY_BUDGET_USD;
  try {
    process.env.SCOUT_MONTHLY_BUDGET_USD = '75.5';
    assert.equal(monthlyBudgetUsd(), 75.5);

    process.env.SCOUT_MONTHLY_BUDGET_USD = 'invalid';
    assert.equal(monthlyBudgetUsd(), DEFAULT_MONTHLY_BUDGET_USD);

    delete process.env.SCOUT_MONTHLY_BUDGET_USD;
    assert.equal(monthlyBudgetUsd(), DEFAULT_MONTHLY_BUDGET_USD);
  } finally {
    if (envBackup !== undefined) process.env.SCOUT_MONTHLY_BUDGET_USD = envBackup;
    else delete process.env.SCOUT_MONTHLY_BUDGET_USD;
  }
});

test('runMaxUsd uses env or default', (t) => {
  const envBackup = process.env.SCOUT_RUN_MAX_USD;
  try {
    process.env.SCOUT_RUN_MAX_USD = '3.5';
    assert.equal(runMaxUsd(), 3.5);

    process.env.SCOUT_RUN_MAX_USD = 'invalid';
    assert.equal(runMaxUsd(), DEFAULT_RUN_MAX_USD);

    delete process.env.SCOUT_RUN_MAX_USD;
    assert.equal(runMaxUsd(), DEFAULT_RUN_MAX_USD);
  } finally {
    if (envBackup !== undefined) process.env.SCOUT_RUN_MAX_USD = envBackup;
    else delete process.env.SCOUT_RUN_MAX_USD;
  }
});

test('monthStartUtc returns the first of the current month', (t) => {
  const oct15 = new Date('2026-10-15T10:30:45Z');
  const ms = monthStartUtc(oct15);
  assert.equal(ms.toISOString(), '2026-10-01T00:00:00.000Z');

  const jan1 = new Date('2026-01-01T00:00:00Z');
  const ms2 = monthStartUtc(jan1);
  assert.equal(ms2.toISOString(), '2026-01-01T00:00:00.000Z');
});

test('sumCosts totals cost_usd from rows and rounds to 4 decimals', (t) => {
  const rows = [
    { cost_usd: 0.5 },
    { cost_usd: 1.234 },
    { cost_usd: 2.0 }
  ];
  assert.equal(sumCosts(rows), 3.734);

  // Test with null/undefined/bad data
  assert.equal(sumCosts([{ cost_usd: null }, { cost_usd: 1.5 }]), 1.5);
  assert.equal(sumCosts([]), 0);
  assert.equal(sumCosts(null), 0);
  assert.equal(sumCosts([{ cost_usd: 'not a number' }]), 0);
});

test('overRunLimit checks if cost meets or exceeds limit', (t) => {
  assert.equal(overRunLimit(1.99, 2), false);
  assert.equal(overRunLimit(2, 2), true);
  assert.equal(overRunLimit(2.01, 2), true);
  assert.equal(overRunLimit(0, 2), false);

  // Test with default
  assert.equal(overRunLimit(DEFAULT_RUN_MAX_USD - 0.01), false);
  assert.equal(overRunLimit(DEFAULT_RUN_MAX_USD), true);
});
