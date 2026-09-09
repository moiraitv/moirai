// Import completion includes the real server's successful bind and scanner startup.
await import('../../../apps/server/dist/main.js');
process.send?.({ type: 'documentation-ready' });
