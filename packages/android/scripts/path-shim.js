// Simple shim for the 'path' module for browser-based builds
export const resolve = (...args) => {
  // Very basic resolution - just join and normalize separators
  return args.join('/').replace(/\/+/g, '/');
};

export default {
  resolve,
};
