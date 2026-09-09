import { mock } from 'node:test';

// Only documentation child processes load this module; real timers keep readiness bounded.
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-15T10:30:00Z') });
