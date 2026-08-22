export function parseDuration(input: string): number {
  const match = /^(\d+)(ms|s|m)$/.exec(input.trim());
  if (match === null) throw new TypeError("Duration must be a non-negative integer followed by ms, s, or m.");

  const value = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "ms" ? 1 : 1_000;
  return value * multiplier;
}
