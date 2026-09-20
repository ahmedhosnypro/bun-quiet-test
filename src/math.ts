export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function average(values: number[]): number {
  if (values.length === 0) throw new Error("average() requires at least one value");
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
