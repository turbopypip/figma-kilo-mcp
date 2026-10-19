// Benchmark-only instrumentation. Never imported during normal MCP operation.
process.on('message', message => {
  if (message?.type === 'metrics') process.send?.({ id: message.id, memory: process.memoryUsage(),
    cpu: process.cpuUsage(), usage: process.resourceUsage() });
});
process.stdin.once('end', () => { if (process.connected) process.disconnect(); });
