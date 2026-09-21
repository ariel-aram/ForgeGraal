export const greet = (who: string): string => `hello ${who}`;
export interface Shape {
	kind: "a" | "b";
}
export default function double(n: number): number {
	return n * 2;
}
