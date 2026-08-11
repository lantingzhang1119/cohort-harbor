export function normalizeE2eArgs(args) {
  return args[0] === "--" ? args.slice(1) : [...args];
}
