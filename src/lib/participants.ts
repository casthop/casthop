export function backstageCount(people: { onStage: boolean }[]): number {
  return people.filter((p) => !p.onStage).length;
}
